# GA-Hub 子进程生命周期统一方案（Job Object + 启动登记）

- 日期：2026-09-15
- 状态：**已实施**（见 §8 实施记录；实现与本文档的差异以 §8 为准）
- 范围：GA-Hub 自己 spawn 的**长驻子进程**（引擎 / 飞书 bot / 外部 worker）
- 不含：外部自动化或其它会话起的进程、一次性命令（打开目录 / 通知）

## 0. 背景（已核实）

GA-Hub 会 spawn 三个长驻子进程，全部是"裸 Popen"：

| 子进程 | spawn 处 | 参数要点 |
|---|---|---|
| 引擎 `gahub_app.py` | `conductor_client.py` | `stdout=文件`、**无 stdin 管道** → 父死无感知 |
| 飞书 bot `fsapp.py` | `feishu_service.py` | `stdin=DEVNULL` + `new_process_group=True` → 更独立 |
| 外部 worker（浏览器工具） | `ga_external_worker.py` | 独立 python 子进程 |

对照：桌面 **sidecar** 用「stdin 管道 + EOF 自退」，所以从不留孤儿。

> **补记（实施期核实，原文遗漏）**：桌面壳 `src-tauri/src/main.rs` 已经建了一个
> `KILL_ON_JOB_CLOSE` 的 job 并把 **sidecar** 放进去（`OwnedProcess::spawn`：
> `CREATE_SUSPENDED` → `job.assign` → `resume_suspended_main_thread`）。因此：
> ① 硬杀 **Tauri 主程序**时，sidecar 连同整棵子树（含引擎）本来就会被回收；
> ② 但硬杀 **sidecar** 时 Tauri 仍持有 job handle，job 不关闭 → 引擎照样成孤儿；
> ③ 开发路径（`start.bat` / `python -m server.run`，无 Tauri）根本没有 job。
> 本方案补的正是 ②③，而且新 job 会**嵌套**在那只 job 里（见 §8 实测）。

实测结果：GA-Hub 只在**优雅关闭**时回收子进程；被硬杀/崩溃时（今天发生过）会留下孤儿（引擎活了 6 天、飞书 bot 3 天、hub.py 3 周）。

## 1. 目标

**GA-Hub 一旦消失（优雅退出 / 崩溃 / 被 taskkill /F），它自己起的子进程必须被回收。**
不依赖子进程配合（GA 侧代码只读，不能改）。

## 2. 方案

### 2.1 主机制：Windows Job Object（"进程笼子"）

- 新建 `server/services/child_job.py`，用 **ctypes** 调 kernel32（仓内已有 ctypes 调 WinAPI 的先例：`session_runtime_factory.py`）：
  - `CreateJobObjectW`
  - `SetInformationJobObject(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)`
  - `AssignProcessToJobObject`
- 单例 `ChildJob`：
  - `spawn(cmd, *, kind, **popen_kwargs)` → `Popen` → `AssignProcessToJobObject` → 登记 `(kind, pid)`。
  - `reap_all(graceful_timeout)`：逐个 `terminate()` → 等待 → `kill()`。
- 关键：job handle 由 GA-Hub 主进程持有 → **主进程一退出（含崩溃/被强杀），OS 关闭 handle → 笼子关闭 → 笼内子进程全部被杀**。

### 2.2 副机制：启动登记表（防历史残留）

- 小文件（`ADMIN_DATA/child_processes.json`）：`{kind, pid, parent, marker, started_at}`。
- spawn 时写入；正常回收后删除。
- **每次 app 启动时扫一遍**：登记项的归属进程（`parent`）已不存在 → 该 pid 若仍活着则回收。
- **`marker` 是安全前提（原文遗漏）**：Windows 会很快复用 pid，只凭「pid 还活着」就
  terminate，等于用一张陈旧登记表去杀别人的进程。扫之前必须用 `marker`（命令行里的
  特征串）核对活着的那个 pid 仍是我们的子进程；核对不上（含 `marker` 为空）**一律不杀**。
- 作用：即便某次没被笼子兜住（旧版本残留、异常路径），下次启动自愈。

### 2.3 逃生口（排障用）

- 环境变量 `GAHUB_KEEP_CHILDREN_ON_EXIT=1` → 本次**不启用** `KILL_ON_JOB_CLOSE`、
  spawn 时**不登记**、退出时不 reap、启动时**不清扫**。
- 默认关闭；仅在需要"GA-Hub 关了仍要留住子进程做调试"时手动打开。
- 不登记是刻意选择：登记了就会在下次正常启动时被扫掉，与逃生口意图自相矛盾。

## 3. 接入点（3 处）

1. `GahubProcessManager`（引擎）→ 改走 `ChildJob.spawn`。
2. `FeishuService`（飞书 bot，**仅当自己 spawn**；`external` 的不管）。
3. `GaExternalWorker`（外部 worker）→ 同上。

关停接线：`services.shutdown_all()` 末尾追加 `ChildJob.reap_all()`；并注册 `atexit` 兜底
（在第一次 spawn 时惰性注册，只注册一次）。

启动接线：`main.py` lifespan 的 `_startup()` 最前面 `await asyncio.to_thread(child_job.sweep_registry)`
—— 早于任何服务 spawn，且不占事件循环（清扫一个僵死孤儿可能要等几秒）。

## 4. 明确不做 / 边界

- 不动外部会话/自动化起的进程；不动一次性命令（`open` / `explorer` / 通知）。
- 不改 GA 仓任何代码（子进程无需配合）。
- 不改现有"附着（adopt）"语义：手动起的引擎/飞书被探测到时仍只附着、不接管 → 不受笼子影响（这正是推荐的手动调试姿势）。

## 5. 验收

1. **优雅关**：关 app → 引擎 / 飞书 / worker 全部消失。
   > 注意这是**行为变更**：`FeishuService.shutdown()` 只停日志 watcher，从不 terminate
   > bot 进程 —— 也就是说改造前「关 app 后飞书 bot 仍在跑」。现在 `reap_all()` 会把它收掉，
   > 符合本方案 §1 的目标（作者原文「现已能做到」不成立，实测如此）。
2. **硬杀**（本次要证明的）：`taskkill /F` 掉 GA-Hub backend → 数秒内三个子进程被系统带走。
   → 实测：0.0s（见 §8）。
3. **逃生口**：`GAHUB_KEEP_CHILDREN_ON_EXIT=1` 时，关 app 后子进程仍在。
4. **手动调试不受影响**：手动起引擎 → GA-Hub 附着 → 关 app 后它仍在。
   （附着路径不经 `ChildJob.spawn`，既不进笼子也不进登记表。）
5. **回归**：既有生命周期测试全绿；`ConductorService.shutdown` 行为不变。
   新增 `tests/test_child_job.py`（30 例）＋ 一条「不许再有裸 `Popen`」的部署契约扫描。

## 6. 成本与性能

| 环节 | 成本 |
|---|---|
| 建笼子（`CreateJobObject` + 设开关） | 微秒级，且**一次性**（每个 GA-Hub 进程一个） |
| 每次 spawn 分配（`AssignProcessToJobObject`） | 亚毫秒/次 |
| 登记表读写 | 启动读一次（毫秒级文件 I/O）、spawn 写一次 |
| 退出 reap | 与现状相同（现在已有 terminate 等待）；硬杀路径由系统立即回收，**更快** |

**结论：对 app 启动速度无可感影响**（微秒级，且引擎是懒启动——app 启动路径本来就不 spawn）。对比之下，引擎冷启动是**秒级**，笼子开销完全淹没在噪声里。

## 7. 回滚

改动集中在一个新模块 + 3 处 spawn 替换 + 关停接线；单提交可 revert。逃生口本身也可作为运行期关停开关。

## 8. 实施记录（2026-09-15）

### 8.1 落点

| 文件 | 改动 |
|---|---|
| `server/services/child_job.py` | **新增**：`ChildJob` 单例（笼子 + 登记表 + 清扫 + 逃生口）＋ 模块级 `spawn/forget/reap_all/sweep_registry` |
| `server/services/conductor_client.py` | 引擎 spawn 走 `child_job.spawn(kind="engine")`；`stop()` / `_terminate_child()` 成功后 `forget` |
| `server/services/feishu_service.py` | 飞书 spawn 走 `kind="feishu"`；`stop()` 后 `forget` |
| `server/services/ga_external_worker.py` | worker spawn 走 `kind="ga_worker"` + `marker="web_execute_js"`；`_stop_locked()` 后 `forget` |
| `server/services/app_services.py` | `shutdown_all()` 末尾 `child_job.reap_all()` |
| `server/main.py` | `_startup()` 开头 `asyncio.to_thread(child_job.sweep_registry)` |
| `server/process_utils.py` | `pid_alive` / `windows_pid_alive` **下沉到此**（笼子与 session 锁共用一套存活判定） |
| `server/services/session_runtime_factory.py` | 删本地副本，改 `from ..process_utils import pid_alive as _pid_alive` |
| `server/_paths.py` | `child_processes_file()` |
| `server/constants.py` + `tests/test_env_registry.py` | 登记 `GAHUB_KEEP_CHILDREN_ON_EXIT` |
| `tests/test_child_job.py` | **新增** 30 例 |

### 8.2 与设计的差异（都是实施期才暴露的）

1. **`marker` 身份核对**（§2.2）：原文登记表只有 `{kind, pid, owns_parent}`。pid 复用会让
   「pid 还活着就回收」变成杀陌生进程，因此增加 `marker`＝命令行特征串，并用 psutil 核对
   活进程的 cmdline。核不上 **不杀**；`marker` 为空同样不杀（无 `-c` 内联脚本的 worker
   因此必须显式传 `marker=`）。
2. **字段改名**：`owns_parent` → `parent`（语义是「spawn 它的那个 GA-Hub 进程 pid」）。
3. **逃生口同时跳过登记与清扫**（§2.3），否则下次正常启动会把刻意留住的进程扫掉。
4. **`pid_alive` 下沉到 `process_utils`**：笼子与 session 锁接管必须用同一套存活判定，
   而且 `child_job` 若反向依赖 `session_runtime_factory` 会把后者的导入链拉进三个 spawn 点。
5. **新增部署契约测试**：`subprocess.Popen(` 不许再出现在那三个模块里 —— 新加长驻子进程
   若用裸 `Popen`，会同时丢掉笼子和登记表，而这在 review 里完全看不见。
6. **Tauri 那层已存在的 job**（§0 补记）：新 job 是嵌套的，不冲突。

### 8.3 真机验证（`temp/cage_verify.py`，真实进程 + 真实 WinAPI + 真实 taskkill）

```
A cage-handle-close: child 37268 gone=True after 0.0s      # 关 job handle ⇒ 成员立刻被杀
B hard-kill:        parent 29484 killed; child 50848 gone=True after 0.0s   # 验收 #2
C startup sweep:    reaped=[45808]; orphan alive=False; foreign 3628 alive=True
C registry after sweep: []                                  # 核对不上身份的 pid 没被动
```

A 就是「GA-Hub 崩溃/被强杀」的等价路径：OS 关掉 job handle → 笼子里的子进程全部被杀，
完全不需要我们这段 Python 还在运行。B 用 `taskkill /F` 打掉模拟的 GA-Hub，
子进程 0.0s 内消失（改造前它会活成孤儿）。

### 8.4 已知边界

- 笼子只在 Windows 生效（POSIX 无 Job Object）；`reap_all` 是按登记的 pid 逐个
  `terminate → wait → kill`，适用于两边；启动清扫也在两边都跑。
- 登记表是「读-改-写 + 原子 replace」，没有跨进程文件锁：两个 GA-Hub 实例同时 spawn
  理论上能丢一行。丢行的后果只是少一次自愈（笼子仍在），因此刻意不做文件锁。
- `spawn` 与 `AssignProcessToJobObject` 之间有一段极短窗口（子进程此刻已能再 spawn 孙子）。
  未走 `CREATE_SUSPENDED` + resume，因为那要绕过 `Popen` 自己造进程；窗口内逃逸的孙子
  由登记表兜底。**引擎那一处把这个窗口显式补上了 —— 见 §8.5。**
- **§0 里当作证据的 `hub.py`（活了 3 周）不在本机制范围内**：GA-Hub 全仓 grep 不到
  任何对 `hub.py` 的 spawn，那三个 spawn 点只有引擎 / 飞书 / worker。GA 仓自己的
  `frontends/hub.py` 是 GA 的 **P2P hub**（见当日日志同名条目），与 GA-Hub 无关 ——
  它要么是手工起的，要么是 GA 自己拉的，本方案不管也不会去管。
- 「附着（adopt）」路径（手动起的引擎/飞书被探测到）不经 `ChildJob.spawn`，
  既不进笼子也不进登记表 → 关 app 后仍在，正是 §4 要保的语义。

### 8.5 引擎改经 cmd.exe 中介启动（2026-09-16）

- 背景：**冻结的桌面 sidecar** 直接 `CreateProcess` 起引擎时 3/3 全挂死（日志只有一行
  `[spawn]`，进程 CPU=0、不监听），同一份 env 换非冻结父进程拉起则 8 秒内正常。
  ⇒ 问题在「冻结父进程直接 spawn」这一步，与引擎和 env 无关。
- 改动（只动引擎那一处）：Windows 下 spawn 形式改为
  `cmd.exe /c ""<python>" -u "<script>" --host … --port …"`（`conductor_client._shell_launch`），
  引擎的直接父进程变成**签名的系统程序**；同时补 `stdin=subprocess.DEVNULL`
  （引擎此前继承 sidecar 的 stdin，即 Tauri owner 管道）。
- 为什么是**字符串**而不是参数列表：cmd 会把 `/c` 后面的命令行**再解析一遍**，并剥掉最外层
  的一对引号，因此需要经典的多包一层引号形式；而 `Popen` 传列表时会把元素里的引号转义成
  `\"`，cmd 不认这个转义（实测：含空格路径下列表形式 3 种全挂，字符串形式可用）。
- 随之而来的两处补偿（**这正是 §8.4 那个窗口的实例**）：
  - `child_job.cage_descendants(pid)`：引擎是 **cmd 的子进程**，cmd 进笼子时它可能已经创建
    （不继承笼子）→ spawn 后立刻、以及 `/health` 通过后各补一次
    `AssignProcessToJobObject`（用 `OpenProcess(PROCESS_SET_QUOTA|PROCESS_TERMINATE)` 拿句柄）。
  - `child_job.terminate_tree(pid)`：回收要连子孙一起收 —— `TerminateProcess(cmd)` 不会
    带走引擎（会留下占着端口和单例锁的孤儿）。失败回收与 `stop()` 都走这条路径。
- 登记行仍记 `self._proc`（cmd）的 pid，`marker` 用脚本路径（`…/frontends/gahub_app.py`，
  就在 cmd 的命令行里，身份校验照旧通过）。
- 真机验证（`temp/verify_engine_intermediary.py`，非冻结父进程）：`/health` 2.6s 变 200；
  引擎 pid 是 cmd 的子进程、`IsProcessInJob` 为 True（cmd 与全部子孙都在笼内）；
  `terminate_tree` 后两者 0.0s 内消失、无残留。
- **仍未验证**：真实「冻结 sidecar」场景本地复现不了，需要重建桌面包后由实机确认。