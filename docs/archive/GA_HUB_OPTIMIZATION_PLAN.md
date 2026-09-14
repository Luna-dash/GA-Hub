# GA-Hub 稳定性与可维护性优化计划

> 依据 2026-08-08 全项目审查与实测结果。本文记录问题、实施顺序、验收证据和未验证边界。

## 基线

- 审查时后端基线：182 passed，1 skipped，10 subtests passed；约 6 秒。
- 审查时前端基线：47 passed；约 3 秒。
- 审查时 TypeScript + Vite production build：通过，682 modules。
- 当前工作区已有用户未提交修改：`webui/src/pages/LiveChat.tsx`；实施过程不触碰、不覆盖。
- npm audit 当前镜像不支持 audit API，依赖漏洞状态未验证。

## 目标与顺序

### P1-A：本地质量门禁（本轮先做）

- 项目仅供个人本地使用，不启用 PR/push GitHub CI。
- `check.bat` / `check.sh` 补跑前端测试，npm 优先使用 lockfile 安装。
- 项目不做分发，删除 release workflow；质量验证仅由本地 `check.bat` / `check.sh` 承担。

### P1-B：前端请求韧性

- 统一 HTTP client 默认超时。
- 支持 `AbortSignal`，保留调用方 RequestInit 合并能力。
- 超时产生可识别的 `TimeoutError`，取消请求不伪装成服务端错误。
- 对上传、流式/长任务保留显式延长或取消入口。

### P1-C：可观测性

- 统一服务健康状态为 healthy/degraded/unavailable/unknown。
- 日志增加轮转和脱敏诊断出口。
- FastAPI 生命周期弃用 API 迁移另列后续任务，避免与本轮行为改动混杂。

### P2：维护成本与体验

- 统一 Python/WebUI/桌面壳/安装包版本来源。
- 发布版关闭公开 source map，或改用 hidden source map。
- 为 LiveChat、MyKey、调度和服务降级补关键 E2E/故障注入测试。
- 按行为边界拆分 launcher、agent_service、LiveChat/chatStore、MyKey。
- 分批收敛宽泛异常捕获，并保留必要边界降级。
- 完成关键页面键盘导航、焦点和 aria 审计。

## 验收规则

每一批改动都必须：

1. 先检查 `git diff`，确认不包含用户既有 `LiveChat.tsx` 修改；
2. 运行对应测试；
3. 运行 `git diff --check`；
4. 最终报告区分已验证、未验证和残余风险。

## 当前状态

- [x] 审查报告和实施计划落盘
- [x] 本地质量门禁（按个人使用需求移除 GitHub CI）
- [x] HTTP timeout/abort
- [x] 生产 source map 关闭；版本统一为 `pyproject.toml` 的 `0.3.4`，并新增一致性测试
- [x] 日志轮转、脱敏诊断出口与健康状态
- [ ] 大模块拆分与 E2E（后续独立批次，避免扩大本轮行为变更）

## 本轮验收（2026-08-08）

- 后端全量：186 passed，1 skipped，10 subtests passed。
- 前端：51 passed；TypeScript lint 通过；production build 通过，682 modules。
- `git diff --check`：通过。
- Rust/Tauri：本机未安装 `cargo`，因此未执行 `cargo check`；版本字段和 `Cargo.lock` 由静态一致性测试覆盖。
- 用户既有 `webui/src/pages/LiveChat.tsx` 修改不属于本轮提交。

## 体验优化批次：启动速度 + 聊天流畅度（2026-08-08）

针对个人桌面端核心诉求，目标为降低首屏就绪延迟与消除聊天热路径同步磁盘 IO。

### A. 聊天流畅度：消除 submit 热路径的重复磁盘读

- 现状：`AgentService.submit` 在每次 user/webui 提交时调用 `_restore_preferred_llm`（`agent_service.py` L499），
  该方法每次执行 `_paths.load_config()`（L402）从磁盘读取 `config.json` 并解析 JSON，即使大多数 submit
  会命中 `agent.llm_no == n` 短路也要先付一次磁盘 IO 代价。
- 语义分析：`preferred_llm_no` 的真值源唯一——仅 `switch_llm`（L379）→ `_save_preferred_llm`（L389）写盘。
  `_select_llm_for_task`（L364）只临时改 `agent.llm_no` 而不写偏好。
- 方案：引入实例内存缓存 `self._preferred_llm_no_cache`（三态：未加载 / 已置值 / 哨兵无偏好）。
  `_restore_preferred_llm` 读缓存而非磁盘；`_save_preferred_llm` 写盘后同步刷新缓存。
  首次 restore（`__init__` L251）触发一次 load 完成 cache 初始化，此后 submit 命中内存。
- 验收：新增单测断言连续两次 `submit`（无 switch）期间 `load_config` 调用 ≤1 次；switch_llm 后下一次
  submit 不再触发 load；restore 仍能纠正 `_select_llm_for_task` 的临时切换。全量回归零行为变更。

### B. 启动速度：后台并行启动非首屏必需服务 —— 已评估，否决（无需实施）

- 现状：`main._startup`（L276-356）串行执行：probe → AgentService.instance → start_run_thread →
  scheduled_chats → token_persistence → feishu_watcher/autostart → AutonomousScheduler → TaskScheduler。
- 评估结论：对后 4 项逐个读实现体，**全部为纯内存注册 / 起在守护线程**，无同步阻塞 I/O：
  - `start_scheduled_chats` → `ScheduledChats.start`：apscheduler `.start()` + install job（内存操作）。
  - `start_persistence`（tokens.py L165）：仅一次 `_flush_usage()` 写盘（毫秒级）+ 起 daemon 线程。
  - `AutonomousScheduler.start`（L162）：apscheduler `.start()` + install job + 起 `_idle_loop` daemon 线程。
  - `TaskScheduler.start`（L124）：apscheduler `.start()` + install job（纯内存）。
  - `feishu_autostart` 本就 `asyncio.create_task` 延迟（`FEISHU_AUTO_START_DELAY_SECONDS=180`），不在此路径。
- 因此把后 4 项改为 `create_task` fire-and-forget **收益 ≈ 0**（串行累积毫秒级），却引入 startup race：
  例如 chat WS 在 `TaskScheduler.install_job` 尚未完成时被访问，可能漏调度 / 状态不一致。
- 真正启动开销在 `AgentService.instance()`（绑定 GA agent）与 lazy imports，且属首屏必需、不可后台化。
- 决策：**不实施 B**。保留现状串行启动，首屏语义明确、零竞态。

## 桌面生命周期批次：即时关闭体感 + 必要清理（2026-08-17）

### 为什么要做

- 旧 Tauri 关闭路径在窗口事件线程中直接执行进程清理，历史实现需要约 5 秒且窗口无响应；后续改成直接 `taskkill /T /F` 虽然窗口能立刻消失，却跳过了 FastAPI shutdown 中的会话 runtime、调度器、Agent、飞书和 token 持久化等必要清理。
- release 启动仍会把编译机仓库目录作为 sidecar 工作目录，安装包换目录或换机器后不具备可移植性。
- sidecar 提前崩溃时，壳只轮询 HTTP readiness，最坏可能空等 600 秒。
- GA 根目录的后端校验和 `~/.genericagent-admin/config.json` 持久化原本已经存在，但桌面首次设置只能手工输入路径，没有接入已有原生目录选择能力。

### 整体方案与已实施内容

1. 点击主窗口关闭后先 `prevent_close` 并立即隐藏窗口，使用户感知上的关闭不再等待后端。
2. Rust 后台线程通过 owned sidecar 的 stdin 发送换行，给 FastAPI 最多 5 秒执行完整 shutdown；只有超时才在 Windows 使用隐藏窗口的 `taskkill /T /F`，失败时再回退到 child kill。
3. 后台清理完成后再调用 Tauri `exit(0)`；`ExitRequested` 也进入同一清理路径，并用原子状态防止重复清理。关闭期间的重复启动不会重新显示窗口。
4. readiness 轮询同时检查 child 状态；sidecar 提前退出时立即失败。启动上限由 600 秒收紧为 120 秒。窗口创建失败时也会回收已启动的 sidecar。
5. debug 仍从源码仓库启动 `python -m server.desktop_sidecar`；release 改为从 `current_exe().parent()` 解析工作目录，不再依赖编译机绝对路径。GA_ROOT 与 sidecar cwd 保持分离。
6. 设置页接入 Tauri/桌面统一 `selectDirectory()`，首次使用和后续修改都可通过“浏览…”选择 GA 目录，选择后立即调用现有校验接口，保存仍由后端原子持久化。
7. 增加静态生命周期契约，并在本机存在 PyInstaller sidecar 时实测打包产物可以接收 stdin、完成 readiness 和优雅退出。同步更新 Tauri README 与 ADR 0002。

### 验收证据与边界

- `cargo check --manifest-path src-tauri/Cargo.toml`：通过。
- release Rust 分支使用临时空 `externalBin` 配置执行 `cargo check --release`：通过。完整打包拷贝受本机两个改动前遗留的旧 sidecar 进程占用目标文件影响，本轮未擅自结束这些进程。
- 打包 sidecar stdin/readiness 冒烟测试：通过，约 3 秒完成启动与优雅退出。
- 桌面 sidecar + Tauri 契约测试：通过；前端 85 项测试、TypeScript lint、production build：通过。
- 后端全量：337 passed、1 skipped、1 failed；唯一失败是本批次开始前已存在的 `subagent_llm_index` OpenAPI 快照未重新生成，本批次不混入无关的大型生成文件更新。
- 尚需使用包含本轮 Rust 改动的新桌面包做一次人工真实窗口验收：启动、点击关闭、立即重开，并确认无新增孤儿进程。

## Conductor 子代理模型策略批次（2026-08-17）

### 目标与边界

- 保留 GA 原版由 Conductor 在单次派单中显式指定模型编号的能力。
- 页面增加默认子代理模型和锁定策略，但不修改 D:\study\GA\agentmain.py、llmcore.py 或 frontends\conductor_core.py。
- 所有新建和恢复子代理入口统一经过 GA-Hub 的 ConductorService，继续使用 PoolRuntime.llm_selector 扩展点应用最终模型。

### 已落实

- 新增 follow_main、default、locked 三种策略，优先级为：锁定配置 > 单次显式请求 > 页面默认 > Conductor 主模型 > 全局 preferred_llm_no。
- 分离模型配置和 Conductor 生命周期，避免重复聊天启动重置已有子代理默认模型。
- 新建、审批派单以及 input/reply 恢复旧子代理使用同一解析规则。
- 一次派单固定使用接纳时的配置快照，避免并发切换策略造成实际模型与返回信息不一致。
- 前端以稳定 llm_key 保存主模型和子代理偏好，再按当前列表解析 index；同步 API、OpenAPI、生成类型和测试。

### 验收与后续

- 后端相关合同与回归：61 passed、10 subtests passed；后端全量：356 passed、1 skipped、10 subtests passed；前端全量：101 passed；TypeScript lint 和 production build 通过。
- npm run api:check 的 120 个前端调用与 132 个 OpenAPI operation 匹配；最终退出码仅因脚本把本批次有意变更、尚未提交的 schema.d.ts 与 HEAD 比较。
- 完整机制、兼容规则、已知限制和后续 llm_key 迁移方案见 docs/CONDUCTOR_SUBAGENT_MODEL_POLICY.md。

## 聊天渲染第二阶段：虚拟窗口 + Markdown 重用（2026-08-17）

### 目标

第一阶段已经把首屏历史限制为最近 32 条 / 40 万字符，并限制会话缓存；第二阶段继续解决用户主动加载多页历史后 DOM 与 Markdown 解析成本重新线性增长的问题，同时保留流式自动滚动、向上分页锚点和 Turn 导航。

### 已实施

1. 新增无第三方依赖的变量高度消息虚拟窗口。消息数超过 80 后，仅挂载视口与 900px overscan 范围内的消息；未出现的消息使用文本/附件估算高度，进入窗口后由 `ResizeObserver` 校正。
2. 高度校正时，若变化发生在视口上方则同步补偿 `scrollTop`；若用户仍贴底则继续保持贴底。向上分页仍使用原有 scroll-height delta 锚定，并与测量补偿共同工作。
3. Turn 导航不再依赖所有用户消息都存在于 DOM，而是保存“用户轮次 → 逻辑消息索引”，通过虚拟列表布局直接定位未挂载轮次。
4. 完成消息的 Markdown 渲染树进入 LRU：最多 48 项、150 万源字符，单条超过 18 万字符不保留；流式消息显式绕过缓存，避免每个 chunk 污染缓存。这样虚拟行滚出并重新进入视口时无需重复执行 remark/rehype 管线。
5. 新增纯本地性能探针，开发模式默认启用；生产包可通过 URL `?perf=1` 或 `localStorage.gahub.chatPerformance = '1'` 启用。DevTools 中的 `window.__GA_HUB_PERF__` 提供最近 80 个样本，包括会话 ready 耗时、逻辑/已挂载消息数、DOM 数、总字符数、流式状态和浏览器可用时的 JS heap。

### 验证与边界

- TypeScript `--noEmit --incremental false`：通过。
- 前端全量：118 passed；其中新增虚拟范围、虚拟组件、性能采样和 Markdown LRU 共 11 项测试。
- production build：通过，Vite 共转换 703 个模块。
- 后端全量：357 passed、1 skipped，包含历史分页与 Windows 子进程回归。
- 尚需在新 Tauri 包中用超长会话人工验证：连续向上加载、快速拖动滚动条、流式贴底/离底、Turn 上下节与大 Markdown 展开。
