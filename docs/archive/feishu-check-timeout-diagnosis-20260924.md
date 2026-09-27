# GA-Hub 飞书 check 经 sidecar 恒 25s 超时 — 诊断报告

日期: 2026-09-24
结论等级: 卡点已物理定位；触发条件已高度收敛；根因机制未100%坐实（见"未坐实"节）

## 1. 用户问题的直接答案

**飞书通路本体是正常的。** 出现故障的只是 sidecar 提供的"探针(check)"接口。

- bot 进程 PID 31312 长连接在线（`wss://msg-frontier.feishu.cn`），`/api/feishu/status` 报 `running:true`
- 凭据有效，配置正常
- 直接跑 `python -X utf8 -u frontends/fsapp.py --check` = **4.8s，ready:true**
- 这说明：**收消息、发消息、登录态都不受影响**；只有 UI 上那个"检查"按钮对应的探针会超时。

## 2. 现象

- `POST http://127.0.0.1:6718/api/feishu/check?force=true` → **8/8 次全部 25.05s 超时**（100% 确定性必现，非偶发）
- 返回 `{"ready":false,"ok":false,"returncode":null,"error":"...timed out after 25 seconds"}`
- 无残留 fsapp 子进程（超时后 kill 生效）

## 3. 关键判据（全部实测）

| # | 判据 | 结果 |
|---|---|---|
| A | 直跑 fsapp.py --check | 4.8s 正常 |
| B | **真实 `FeishuService()._run_check(False,25)` 在我的进程里跑** | **5.45s 正常，ready:true** |
| C | 同上，在 sidecar(31996) 里跑 | 25s 超时 |
| D | py-spy dump sidecar | 卡在 `_run_check(feishu_service.py:428)` → `run` → `communicate` → `_communicate` → `join(reader线程)` |
| E | ctypes 抓卡住子进程主线程 | RIP 恒在 `ntdll!ZwQueryInformationFile` syscall stub，3 轮一致 |
| F | 卡住子进程已加载模块 | 仅 16 个，**无任何 .pyd** |
| G | py-spy dump 卡住子进程 | 报 "Python v3.12.13"（运行时已初始化），主线程无 Python 帧 |
| H | DuplicateHandle 鉴定子进程 std 句柄 | **FILE_TYPE_PIPE(3)** — 是管道，不是文件 |

**B vs C 是最干净的结论**：完全相同的代码、env、kwargs、cwd、解释器，
唯一差异是"父进程是谁" → **差异只在 sidecar 进程上下文**。

## 4. 已排除（均为注入复现实验，全部正常 ≈5.3s）

1. env 74 项（含 `_PYI_*`）原样复跑
2. `hidden_process_kwargs()` 真身（CREATE_NO_WINDOW + STARTUPINFO SW_HIDE）
3. stdin 继承管道（自造管道读端）
4. NULL std 句柄（SetStdHandle 0）
5. 无控制台父进程（DETACHED_PROCESS，GetConsoleWindow=0，std=0）
6. `Job Object`（历史报告已测）
7. 父进程句柄表规模 300/800/1200/1600 个
8. 父进程带 AnyIO + asyncio 事件循环
9. PyInstaller frozen 上下文（`sys.frozen=True`、`_MEIPASS`、`_PYI_*`）
10. 子进程 std 句柄有效性（PEB 读出均为有效管道句柄）
11. 事件循环被阻塞（`routes/feishu.py` 的 `check` 是**同步 def**，
    FastAPI 走 AnyIO 线程池，事件循环未被占用）

## 5. 关键区分点（本次新发现）

**`start()` 成功，`check()` 失败** —— 两者都是 subprocess，但：

- `start()`：子进程输出 **重定向到文件** `D:\study\GA\temp\feishuapp.log` → **成功**
  （日志首行 `========== GA-Hub start feishuapp ... ==========` + Warning 即可证明）
- `check()`：子进程 `stdout=subprocess.PIPE` → **卡死**

即：**"sidecar 环境 + 写 PIPE"的组合会卡；"sidecar 环境 + 写文件"正常；
"普通进程 + 写 PIPE"正常。**

同一文件里另有 2 处同样形状的 PIPE 调用（timeout=20 / timeout=45），
推测受同一问题影响，但**未逐一实测**。

## 6. 观测到的异常（可能是线索，也可能是无关副作用）

- sidecar 句柄数：1196 → 1246 → 1265 **持续增长**（我的 check 期间）
- sidecar 仅运行 **1.0 小时**（15:26 启动），因此**不是"长期累积"导致**
- sidecar：59 线程 / 159MB，onefile 双进程结构（23696 bootloader → 31996 app）

## 7. 未坐实（诚实边界）

- **根因机制未 100% 坐实**。曾用导出表把卡住栈"符号化"出
  `_fflush_nolock → SetFilePointerEx → ZwQueryInformationFile`，
  但 `SetFilePointerEx` 只对可 seek 对象有意义、而句柄实测是管道(FILE_TYPE_PIPE)，
  **二者矛盾 → 中间帧的符号化不可靠**（导出表只给"最近导出"，偏移已越界）。
  唯一可信的是 **RIP = `ntdll!ZwQueryInformationFile`**。
- 因此"卡在什么内核等待"这句话，目前只能说到"某次 `NtQueryInformationFile` 未返回"。
- 曾推测"CRT 未 setmode / 未跑到字节码"，但因 py-spy 能报出 Python 版本
  （运行时已初始化），该推测**已被削弱，不应作为结论**。

## 8. 建议的下一步（按成本从低到高）

1. **重启 sidecar**，重启后再打一次 check。
   - 若恢复 → 与"进程内累积状态/句柄泄漏"有关，且**这是立刻可用的修复动作**
   - 若仍失败 → 是 sidecar 结构性问题，进第 2 步
2. **改探针实现，绕开 PIPE**：把 `check()` 改成输出重定向到临时文件
   （与已验证成功的 `start()` 同构），跑完读文件。
   - 这是**最小改动、最高性价比**的修复；同时可作为对第 5 节判断的直接验证
3. 若需要坐实机制：装 WinDbg/下载微软符号，
   抓 `ZwQueryInformationFile` 的**调用者与目标句柄**，得到精确栈

## 9. 复现/取证脚本（均在 D:\study\GA\temp\projects\GA-Hub-d795c16e\）

- `peb_std_handles.py` — 读子进程 PEB 的 std 句柄值
- `dump_threads.py` — 遍历线程、落盘 RIP/RSP/栈 → `stack_dump.json`
- `child_progress.py` / `probe_parent.py` — 父进程差异注入实验
