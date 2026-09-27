# GA-Hub 架构复审（2026-09-27 ~ 09-28）：九问总览与修复记录

> 本轮复审共提出 9 个问题：**7 个已修并提交**（问题 3–9），**1 个判定为不必修**
> （问题 2），**1 个未修但已定量定性**（问题 1）。
>
> 逐条的完整细节见 [`docs/BACKLOG.md`](../BACKLOG.md)（问题 4–9 各有专节）；
> 本文是**总览 + 结论索引**，出现分歧时以 BACKLOG 与提交信息为准。

## 一、这轮复审是什么

**方法**：五路并行深度走读（后端 services / 应用外壳与路由 / 前端 / 桌面壳与构建链 /
仓库卫生），再对其中约 25 处"承重结论"逐条回源码复核，并实跑了测试套件。不是读一遍
代码就下结论——本文件里每一条修复都带实测数字。

**结论分档**（原文用语）：

| 档位 | 条数 | 问题 |
|---|---|---|
| 🔴 必须马上修（"确定可利用"） | 3 | 1 路径穿越 / 2 无鉴权且可对外绑定 / 3 后端挂了壳不知道 |
| 🟠 结构性问题（"收口"，不用重写） | 3 | 4 会话域住在路由文件里 / 5 Conductor 五对象友元团 / 6 一个会话恢复冻结全部会话 |
| 🟡 最深隐患（与 GenericAgent 的耦合） | 1 | 7 宣称的契约与实际触点差很远 |
| 🔵 工程流程 | 2 | 8 CI 只打包不跑测试 / 9 根目录成为垃圾场 |

**一条定位基准决定了处置方式**（用户判定）：

> "必须修的定位要调整，这个 gahub 就是本机客户端，不会接局域网。所以只处理一下后端
> 挂了、桌面壳不知道的问题就行（引问题 3），剩下的 4-9 经过我的审核依次处理。"

所以 🔴 三条里：**问题 3 照修**；**问题 2 取消**（见 §3.2）；**问题 1 降级为遗留项**
（见 §3.1，附"重开条件"）。🟠🟡🔵 七条按用户逐条审核后依次实施。

## 二、总览表

| # | 问题（原话摘要） | 处置 | 提交 | 验证要点 |
|---|---|---|---|---|
| 1 | 读文件的接口能翻整个硬盘 | **未修**（定位下调，附重开条件） | — | `memory.py:336` 仍是弱校验；当前不可远程利用（见 §3.1） |
| 2 | 整套 API 没密码，还允许改成对外开放 | **取消**（定位调整） | — | 默认绑 `127.0.0.1`；`webui_host` 仍可改但零警告（见 §3.2） |
| 3 | 后端挂了，桌面壳不知道 | ✅ 已修 | `a2ccda0` | 就绪后存活监控 + 四态门 + 一键重启；实杀进程验证 |
| 4 | 管会话的核心模块住在"路由文件"里 | ✅ 已修 | `9f52d70` | 单所有者 `SessionLifecycle` + Depends 解析；契约测试当场抓出第二个所有者 |
| 5 | Conductor 五个类互相掏对方口袋 | ✅ 已修 | `d2118f4` | 单所有者接缝 + 窄内核 Protocol；32 条契约测试；68 处去私有 |
| 6 | 一个会话恢复能卡死全部会话 | ✅ 已修 | `5607a36` | 创建/提交移出全局锁；实测 6/6 路径 1.300s → 0.000s |
| 7 | 宣称的"契约"和实际干的事差很远 | ✅ 已修 | `f5f1d1a` | 三层收口；故障注入 13/13；脚手架探针活体 51 项 |
| 8 | CI 只打包，不跑测试 | ✅ 已修（按"云端只打包"取舍） | `962e748` + `01f2736` | 新增 `webui-checks`；修掉 1 条负载敏感 flake |
| 9 | 根目录成了"调查现场垃圾场" | ✅ 已修 | `b41cb0c` | 47 → 0；护栏 2 条故障注入 7/7；**顺带修掉两个入口脚本的静默早退** |

## 三、逐条

### 3.1 问题 1：读文件的接口能翻整个硬盘 —— 未修（定位下调）

**原状（实测仍在）**：`server/routes/memory.py:336`

```python
def _read_skill(path: str) -> dict:
    if ".." in path or path.startswith("/"):
        raise HTTPException(400, "bad path")
    ...
    p = os.path.join(_skill_dir(), path)   # 绝对路径/UNC 会让 join 直接丢弃前缀
```

只挡 `..` 与以 `/` 开头的路径。Windows 上 `C:/xxx.txt`、`\\server\share\x.md` 都能
溜出去（`os.path.join` 遇到绝对路径会丢弃前面的目录）。同一文件里的 SOP 接口
（`_safe_sop_path`，`memory.py:262`）恰恰防得很严：非空、不是 `.`/`..`、不含
`/`、`\`、`:`、`\x00`、且必须以 `.md` 结尾——**这是自家标准下的漏网**。

**为什么本轮没修**（不是遗漏，是定位决定的）：

- GA-Hub 是本机客户端：默认只绑 `127.0.0.1`（`server/run.py:30`）
- CORS 只放开 Tauri 壳的 origin（`server/main.py:285-287`，
  `allow_origins=list(TAURI_UI_ORIGINS)`），不是通配 → 浏览器里的任意网页**读不到**
  这个接口的响应
- WS/SSE 另有一层 `origin_policy` 校验

三者叠加，结论是：**要利用它，得先能在这台机器上发请求**——而那样的本地进程本来就能
直接读文件，提权收益为零。

**重开条件与建议改法**（三行，照 `_safe_sop_path` 抄）：

1. 若哪天 GA-Hub 要给别人用、或要开 `webui_host`（哪怕只是临时调试）→ 立刻修
2. 改法：拒绝含 `\`、`:`、`\x00` 的路径，`..` 按**段**判而不是子串判，并在
   `os.path.join` 之后用 `os.path.realpath` 复核仍在 `_skill_dir()` 内
3. 顺手改掉 `memory.py:338-339` 那句注释——它写着
   "caller can't path-traverse"，与代码实际能力不符，会误导后来的读者

### 3.2 问题 2：整套 API 没有密码，还允许改成对外开放 —— 取消

**原状**：所有接口不需要登录；配置文件里改一行 `webui_host` 就能监听 `0.0.0.0`，
而 `run.py` 对此零警告零拦截（现状复核：`server/run.py:29-37` 仍是"读到什么用什么"，
`server/runtime_endpoint.py:16` 那处 `0.0.0.0` 只是**回调地址归一化**，不是给操作者的
警告）。

**处置**：按"本机客户端、不接局域网"的定位**取消**。理由与该定位自洽：这条问题的全部
伤害都发生在"对外可达"的前提下，前提不存在则无需为之增加复杂度。

**附带结论（值得记住）**：如果将来要把它放到别人机器上或团队内共享，这条会**立刻**
回到 🔴——那时至少要有：绑定非回环地址时的显式警告 + 一份最小鉴权（token）。现在
没有，是**有意的取舍**，不是忘了。

### 3.3 问题 3：后端挂了，桌面壳不知道 ✅ `a2ccda0`

**根因**：`run_sidecar_supervisor` 在 `set_ready()` 成功后**直接 return**（原
`main.rs:948-952`）——启动期监护极其细致，就绪那一刻监护线断了。长会话跑到一半后端崩
掉，壳仍认为"就绪"，界面每个操作都网络报错，只能靠用户自己发现再手动重启。

**修复**：

- `main.rs` 新增 `watch_ready_sidecar` 周期轮询（`LIVENESS_POLL_INTERVAL`）：就绪后子
  进程死亡 → `mark_failed`；`mark_failed` 放宽为也接受 `Ready` 态
- 前端 `DesktopRuntimeGate` 增加 `starting|ready|lost|failed` 四态 + 3s 探测，探测被拒
  即压覆盖层，提示「后端已断开」并提供「重启后端」
- 顺带：`record_startup_diagnostic` 在 `cfg!(test)` 下直接返回，避免单元测试往真实
  `%TEMP%\gahub_desktop_shell.log` 写诊断、污染实测证据

**验证**：Rust 17 passed；`build_all.py` 退出码 0 + 守卫输出；实测 sidecar ready on port
44442（8.2s），杀掉父 bootloader 后日志出现 `sidecar exited after readiness`，解压出的
子进程被 `job.terminate()` 收割（无孤儿、端口释放），壳存活并进入失败态。

### 3.4 问题 4：管会话的核心模块住在"路由文件"里 ✅ `9f52d70`

**根因**：三个进程级单例（会话协调器 / 定时聊天 / 系统通道）住在路由模块里
（`_store` / `_coordinator` / `_get_scheduled_chats` / `_system_channels` /
`_coordinator_stopping`），`main.py` 只能注入回调"借用"，另有 4 个兄弟路由用函数内懒导
入反向取用。谁要一份 store 就再建一份，测试只能靠 monkeypatch 路由全局装配——代码注释
自己承认这是 drift，但只是加测试把歪的形状固定住。

**修复**：新增单所有者 `services/session_lifecycle.py`（store / runtime factory /
coordinator / scheduled-chat / system channels + `prepare→begin_shutdown→stop_runtimes→
finish_shutdown` 与 shutdown 准入门）；组合根 `create_app` 建实例写
`app.state.session_lifecycle`，路由经 `Depends(session_lifecycle_of)` 解析（WS 路由从
`ws.app` 取，且在 origin 校验之后）。**无懒回退**：未绑定即 `RuntimeError`——默认实例会
指向真实用户数据目录，那正是要消灭的漂移。

**护栏**：`test_import_direction.py` 收紧为"任何兄弟路由导入都算违规"（函数内懒导入原本
正是绕过模块级规则的漏洞）；新增 `test_session_domain_contract.py`（路由不得构造
coordinator/factory/scheduler/channels、不得持有模块全局、每个 app 一个域、未绑定必须报
错）。**该契约当场抓出** `conversations.restore` 自建 `SessionRuntimeFactory` 的第二所有
者；`sessions.delete_session` 不再裸读 `_coordinator` 全局（关停期间删会话现在 409）。

**验证**：pytest 1034 passed / 2 skipped（重构前 1028，+6 契约用例）；vitest 517；`tsc -b
--noEmit` exit 0；api:check 通过；`build_all.py` 退出码 0。

### 3.5 问题 5：Conductor 五个类互相掏对方口袋 ✅ `d2118f4`

**根因（实测计数）**：`ConductorStore` 直接改 `WorkflowTracker` 的私有投影 **10 处**；
tracker 反向持有 store（`tracker.store = self` 由 store 自己塞进去，不过构造函数）；
`ConductorCommands`/`ConductorRecovery` 持有整个 `ConductorService` 并直呼其私有成员
**24 处**。后果：同一个 tracker 两个引用却不保证相等（测试装配换掉了 tracker、store 仍指
旧对象，只断言新对象所以照样绿）；`_owners` 索引公式被抄 4 份；锁顺序只是隐式约定；
232 条 conductor 测试没有一条能不经完整 service 构造协作者。

**修复**：`WorkflowTracker` 给公开接缝（`capacity` / `attach()`（重复挂载抛错）/
`rollback_point()` / `restore_projection()` / `prune_terminal()`，投影锁公开为
`tracker.lock`），store 内不再出现任何 `tracker._`；反向赋值转显式注入
（`ConductorStore.__init__` 调 `tracker.attach(self)`，"一个 tracker 一个 store"由代码
强制）。新增 `conductor_kernel.py`：`ConductorKernel` Protocol（只列实测用到的 22 个成
员）+ `ChatGuard`（锁不再外借）+ 唯一装配点。方法去私有前缀 68 处。

**护栏**：`test_conductor_collaborators_contract.py`（32 条）分四层——AST 静态契约、内核
契约（含"声明了但没用＝禁止投机声明"）、装配不变量、回滚一致性，并自检护栏对已知违规形
状确实会红。顺带修掉重命名暴露的一处漂移：发布点扫描正则只匹配 `.publish(`，
`._publish(` 一直是盲区（`conductor:resync_required` 与动态 topic 从未被校验）。

**验证**：pytest 1066 passed / 2 skipped（+32）；conductor 相关 275→307；vitest 517；
`build_all.py` 退出码 0。

### 3.6 问题 6：一个会话恢复能卡死全部会话 ✅ `5607a36`

**根因**：`SessionCoordinator.submit_stream` 把"构造 runtime + 提交"整个压在一把全局
`RLock` 里，而构造 runtime 是无界慢操作（AgentService 构造 + GA `continue_inplace` 抢锁
并解析整个日志 + 恢复工作记忆），UI 的读/停路径全在同一把锁上。前端已为此妥协：
`LiveChat` 注释写明"冷启动 submit 会挂住 HTTP 响应，所以先乐观上移会话顺序"。

**实测（1.5s 慢工厂，探针在该会话冷启动开始 0.2s 后发出，另一会话正在运行）**：

| | 修前 | 修后 |
|---|---|---|
| 6 条用户路径（含 abort 一个正在运行的会话） | 各阻塞 **1.300s** | **0.000s** |
| 仅 submit 慢（runtime 已预热） | 2/2 阻塞 1.300s | 0.000s |

**顺带纠正复审里"30 秒窗口"的提法**：GA `acquire_lock` 被活进程持有时**立刻**返回
False，`_STALE_AFTER=30` 只决定"多久不心跳算持锁者已死"，卡死与等 30 秒无关。

**修复**：`_runtime_for_session()` 锁内只查表，miss → 每会话创建闸 → 放锁 → 调工厂 →
回锁安装；并发保证由"调用方先占位的预留 + 每会话创建闸 + `_runtime_epoch`（会话在恢复
期间被删除/替换时丢弃刚建好的 runtime）"三件事承担。新增 `RunStartAbortedError`：冷启动
窗口内点停止则永不提交，映射 409 `run_start_aborted`，前端把它与"发送失败"分开。
**自查揪出并修掉两个新引入的漏洞**：创建完成时若已请求关闭会泄漏刚建好的 runtime；创建
抛错时预留不释放导致容量槽永久占用。

**护栏**：`test_session_coordinator_nonblocking.py`（16 条）——工厂与 runtime 都阻塞在测
试自己控制的 `Event` 上，于是"探针在放行前就返回"是**构造性证明**而非掐表赌运气。故障注
入自检 3/3 命中（把创建/快照/configure 分别塞回锁内 → 对应护栏立刻变红），注入后原文件
字节级还原。

**验证**：pytest 1083 passed / 2 skipped（+17）；并发用例连跑 5 轮、coordinator 套件连跑
3 轮稳定；vitest 519；`build_all.py` 退出码 0。

### 3.7 问题 7：宣称的"契约"和实际干的事差很远 ✅ `f5f1d1a`

**结论不是"没有契约"，而是契约只长了一条腿**：真正被版本化、双向校验的只有 Conductor
线协议；其余三层都缺——GA 内核面（`core_contract` 启动探针声明的面比真实调用点**旧**）、
bridge 符号面（从 bridge 取的符号无任何校验）、导入边界（`test_ga_boundary_contract` 是
只挡"新增"的单向棘轮）。**实测**：`server/**` 共 23 处 GA 触点（14 经 bridge + 9 直连）；
棘轮上限 21 条里 12 条早已不存在、0 条未登记。三个后果都是静默的：bridge 改名 → 后端起
不来或首次调用 500；探针过期 → 真正断掉的符号照样放行；棘轮死条目 → 没人知道边界在哪。

**三层收口**：

1. **启动探针改为声明整张面**：删掉三组过期常量（`continue_cmd.install`/
   `reset_conversation` 早在问题 5/6 就换成 session bridge，探针却还在要求它们），改为
   一张 `_REQUIRED_GA_SYMBOLS`（14 个模块 / 33 个具名符号），逐符号 import + getattr，
   缺一个就点名到符号
2. **边界治理**：扫描面 `server/**` → `server/ + desktop/ + scripts/`，并解析内嵌脚本字
   符串（`ga_external_worker.py:43` 的 `import_module("ga")` 写在 worker 脚本文本里，旧扫
   描看不见 → 假阴性）；棘轮换精确集合 + 反向校验（12 条死条目当场暴露）；新增"探针声明
   ↔ 源码互证"；模块名单自证（从配对 GA checkout 派生顶层名取交集）
3. **行为耦合显式化**：GA 磁盘布局漏斗（10 处字面量拼接散在 7 个文件）→ `_paths.py` 的
   8 个 `GA_LAYOUT_*` 常量 + 具名 helper + 护栏禁止 `GA_ROOT / "..."` 回流；归档块格式、
   失败文案、Goal/Hive 提示词、iLink 协议常量全部与 GA 源码**对钉**

**护栏**：故障注入 **13/13** 命中（漏声明 / 多声明 / 探针不再点名 / 死条目 / 关掉内嵌扫
描 / 名单漏名 / 改失败文案 / 改提示词 / 单方面升级协议 / 改块头 / 布局拼接回流 / 布局常
量绝对化），注入后原文件字节级还原。活体探针 ok=True / 51 项 / 584ms；成本中性（旧 670ms
/ 新 658ms）。

**给 GA 侧的两条诉求**（Hub 侧的耦合都是这两条缺口的绕行）：`continue_inplace` 返回结构
化 reason；`bridge.archive` 增加有界窗口投影原语。

**验证**：pytest 1101 passed / 2 skipped（+18）；`build_all.py` 退出码 0。

### 3.8 问题 8：CI 只打包，不跑测试 ✅ `962e748` + `01f2736`

**先量再定**。改前：唯一 CI `desktop-build` 只有 build，**没有 `pull_request` 触发**，路径
过滤不含仓根 `package.json`/lock；测试面全无——但有一点要说准：`vite build` 的前置是
`tsc -b`，所以**类型检查其实被顺带覆盖**，真正裸奔的是 vitest 与 api:check。

**实测"无 GA 能不能跑后端测试"**（空 ADMIN_DATA、无 GA、无 config.json）：

- `pytest tests` → **17 errors during collection → Interrupted，0 passed**
- 加 `--continue-on-collection-errors` → 910 passed / 6 failed / 11 skipped / 17 errors
- 两类**采集期**依赖：3 个服务模块的导入期守卫，与若干测试模块直接 `from frontends...`
  ——正是问题 7 那批模块级 GA 耦合的另一面
- `GA_ROOT` 环境变量（连 config.json 都不需要）足以让套件跑起来，但本地 GA HEAD 不在任何
  远端 → CI 要忠实复现，得先决定"给 CI 哪份 GA"

**决定（按"云端只要能把 exe 打出来"取舍）**：新增
`.github/workflows/webui-checks.yml`（`push(main)` + `pull_request` + 手动；三步
`tsc -b --noEmit` / vitest / api:check）；**独立 workflow、不设 `needs`、不阻断打包**；
`desktop-build` 路径过滤补 `package.json`/`package-lock.json`；后端 pytest **不进 CI**，
理由与实测数字写进 `docs/BUILD.md`。

**遗留 flake 同轮修掉**（`01f2736`）：`test_status_external_pid_cache_expires` 原写法 TTL
0.02s + `sleep(0.03)`，隐含要求第 1、2 次 `status()` 落在 20ms 内。改成不掐表（TTL 60s +
手动把缓存时间戳往回推 + 补"TTL 内必须复用缓存"的断言）。取证：

| 注入负载 | 原版 call_count | 现写法 |
|---|---|---|
| 0 / 5 ms | 2（绿） | 2（绿） |
| 50 / 200 ms | **3（红）** | 2（绿） |

### 3.9 问题 9：根目录成了"调查现场垃圾场" ✅ `b41cb0c`

**现状**：`git status` 长期 47 条未跟踪（46 文件 + 1 目录），全部产生于 09-21~09-25：探针
22、JSON 快照 12、diff 文本 9（~96KB，信息全在 git 历史里）、报告 2、截图 1、`dsml_analysis/`
1（24 文件 6.6MB）。**根因不是"忘了删"，而是三次都只修了快照**：`.gitignore` 逐条点名过
→ 47 条里 **32 条产生于 09-23 那次审查之后**（09-24 新增 19、09-25 新增 13）；归档惯例存
在且闲置；上次清运的落点机制齐备但**没有护栏**。代价：信噪比 1:47；快照含本机用户名、
anaconda 绝对路径、自建端点（逐个扫过 12 个 JSON 的键：无 token/密码，所以是"不该提交"
而不是"已泄露"）。

**P1 归位（移动不删除，可回滚）**：报告进 `docs/archive/`（`DIAGNOSIS.md` →
`feishu-check-timeout-diagnosis-20260924.md`、`FEISHU_STDIN_FINDING.md` 用 `git mv` 保留
历史、`audit_repo_hygiene_20260923.md`）；其余 45 项 → `temp/archive-scattered-20260928/`
分类别 + `MANIFEST.md`；**同步修引用链 3 处**（否则断链）。结果：**47 → 0**。

**P2 护栏**：新增 `tests/test_repo_hygiene.py`——①仓根不得有未跟踪散件（失败信息直接说该
放哪）②仓根已跟踪文件必须与白名单一致（多出/缺失双向）。`AGENTS.md` 补"过程产物去哪"一
节（**产出主体就是 agent 会话**，规矩得写在 agent 必读处）。故障注入 **7/7** 命中，注入前
后 `git status` 逐行一致。

**P3 入口归口——挖出的东西比预期严重**：

- **`check.bat` / `install_webui.bat` 一直在静默早退**（既有 bug）：`%PKG% -v` 漏了
  `call`。Windows 上 npm/pnpm 是 `.cmd`，批处理里不带 `call` 直接调会**交出控制权且永不
  返回** → 脚本在 npm 检测那行结束，**退出码还是 0**。后果：`check.bat` 的前端半套
  （`npm ci`/vitest/lint/api:check/build）**从来没跑过**，`[OK] All checks passed` 从不可
  达；`install_webui.bat` 更直接——前端依赖与构建一条都没执行。取证：对照实验（无 `call`
  时 `echo B-REACHED` 永不打印）+ `check.bat` 实测 **7 秒 / exit 0 / `webui/dist` 未重建**
- **步骤顺序错**：pytest 排在前端构建之前，而
  `test_backend_api_smoke.py::test_built_spa_deep_link_and_hashed_entry_asset` 断言的是
  `webui/dist` 里的构建产物（实测删掉 `dist` → 1 failed）→ 新克隆上必红
- **依赖口径**：`pip install -e ".[dev]" --upgrade` 用 pyproject 的**松范围**且主动升级
  （而 `requirements.txt` 自己写着"唯一可复现安装清单"）→ "提交前检查"会悄悄改变
  PyInstaller 打包进去的版本；`npm install` 哪怕已同步也会改写已跟踪的 lockfile

**验证**：`check.bat` 从**没有 `webui/dist`** 的状态完整跑通（98 秒 / exit 0）：npm ci →
vitest 519 → tsc → api:check 89 形状 / 136 操作 → build（3.63s，dist 重建）→ pytest 1103
passed / 2 skipped → **`[OK] All checks passed.`**；`install_webui.bat` 实跑 exit 0 且不再
弄脏 lockfile；`build_all.py --full` 退出码 0（134.6s）。

## 四、本轮顺带修掉/发现的"次级问题"（不在原九问里）

| 项 | 来源 | 处置 |
|---|---|---|
| `conductor:resync_required` 与动态 topic 从未被发布点扫描校验 | 问题 5 重命名时暴露 | 同轮修掉 |
| `_owners` 索引公式抄 4 份、锁顺序无凭据 | 问题 5 | 同轮收成单一实现 |
| 冷启动期间泄漏 runtime / 容量槽不释放（**修复自身引入**的新漏洞） | 问题 6 自查 | 同轮修掉 |
| `ga_external_worker.py` 内嵌脚本里的 GA 依赖对扫描不可见 | 问题 7 | 同轮修掉 |
| `test_ga_boundary_contract` 棘轮 12 条死条目 | 问题 7 | 同轮清理 |
| `test_feishu_service.py` 负载敏感 flake（3 次整跑红 1 次） | 问题 8 遗留 | `01f2736` |
| `check.bat`/`install_webui.bat` 静默早退、顺序、口径漂移 | 问题 9 P3 | `b41cb0c` |
| 前端一行纯间距改动（`gap-1` → `gap-2`）混在工作区 | 问题 6 提交前审计 | 单独提交 `478610d` |

**过程中我自己的两次误判，记下来当纪律**：

1. 曾把 `check.bat` 的"输出丢了但 dist 重建了"归因于 `chcp 65001`；对照实验后真因是
   上面那条 `call`（脚本根本没跑完）。**"退出码 0" 在这类脚本里不等于"通过"**。
2. 曾在本轮总结里写"问题 1 已被问题 7 的布局治理覆盖"——写本文档时回源码复核，发现
   `memory.py:336` 一字未改。**结论必须以回源码复核为准，不能以记忆为准**。

## 五、遗留清单（未修，按建议顺序）

1. **问题 1 的三行加固**（照 `_safe_sop_path`）+ 改掉那句错注释——当前不可远程利用，但
   一旦要开 `webui_host` 就立刻变成 🔴
2. **问题 2 的最小护栏**（绑定非回环地址时显式警告）——共享/外放时的前置条件
3. **`build_all.py --full` 与 check.bat 原先是同一个顺序坑**：`--full` 也是先 pytest、后
   前端构建，所以新克隆（无 `webui/dist`）上 `--full` 会在 pytest 阶段就红。属构建链改动，
   需单独一轮 + 同步 `test_build_all.py`
4. **后端 pytest 进 CI 的前置**：把 3 个服务模块的**导入期** GA 守卫改成**用时期**，并决定
   "给 CI 哪份 GA"
5. 复审里未列入九问的 P1/P2 项：统一错误格式、拆 god object（`chatStore` /
   `ConductorService` / `main.rs`）、统一手写 JSON 存储、补 WS 类型校验
6. 保留的两处刻意不动：`conductor_client.py:541,724` 的 `self.pm._headers`（引擎传输层，
   属它自己一轮）；`ConductorService` 的 god object 拆分

## 六、这轮的共同教训

1. **快照式修补会腐烂**：同一类问题（散件、耦合、契约）第三次回来时，修法必须从"补名
   字"换成"加机制"——`.gitignore` 逐条点名两天后失效（32/47 是事后产生的），而
   `test_repo_hygiene.py` 一次就把 47 条钉在 0。其余几条同理：问题 4/5 各自新增**契约测
   试**，问题 6 用**构造性证明**（Event 而非掐表），问题 7 用**探针↔源码互证**。
2. **护栏必须证明它会咬**：问题 5 的 32 条、问题 6 的 3/3、问题 7 的 13/13、问题 9 的
   7/7——全部做了故障注入并还原原文件。没注入过的护栏，只是一段没人知道会不会红的代码。
3. **"退出码 0"不是成功依据**（这句话在 `AGENTS.md` 的构建红线里已有，本轮在入口脚本上
   又验证了一次）：`check.bat` 用 7 秒、退出码 0 掩盖了"前端半套没跑"；判定要看**产物与
   步骤证据**（`webui/dist` 是否被重写、`[OK]` 是否打印）。
4. **定位决定"必修"的边界**：同一条"高危"（问题 2）在本机客户端前提下可以合理地不做，
   但要把**重开条件**写清楚；否则下一个人会以为它是漏掉的。

---

**参考**：逐条细节见 [`docs/BACKLOG.md`](../BACKLOG.md)；构建链接口与纪律见
[`docs/BUILD.md`](../BUILD.md)；构建链历史事故见
[`build-chain-incidents-20260927.md`](build-chain-incidents-20260927.md)。
