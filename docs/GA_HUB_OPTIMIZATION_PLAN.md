# GA-Hub 稳定性与可维护性优化计划

> 依据 2026-08-08 全项目审查与实测结果。本文记录问题、实施顺序、验收证据和未验证边界。

## 基线

- 审查时后端基线：182 passed，1 skipped，10 subtests passed；约 6 秒。
- 审查时前端基线：47 passed；约 3 秒。
- 审查时 TypeScript + Vite production build：通过，682 modules。
- 当前工作区已有用户未提交修改：`webui/src/pages/LiveChat.tsx`；实施过程不触碰、不覆盖。
- npm audit 当前镜像不支持 audit API，依赖漏洞状态未验证。

## 目标与顺序

### P1-A：发布质量门禁（本轮先做）

- 新增 PR/push CI：pytest、前端测试、类型检查、生产构建。
- release 构建依赖质量门禁成功。
- `check.bat` / `check.sh` 补跑前端测试，npm 优先使用 lockfile 安装。

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
- [x] CI 与本地门禁
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

### B. 启动速度：后台并行启动非首屏必需服务

- 现状：`main._startup`（L276-356）串行执行：probe → AgentService.instance → start_run_thread →
  scheduled_chats → token_persistence → feishu_watcher/autostart → AutonomousScheduler → TaskScheduler。
- 首屏必需仅前 3 项（probe + agent 初始化 + run 线程）。后 4 项（scheduled_chats / token_persistence /
  feishu_watcher / autonomous + task scheduler）非首屏必需，且各自已被独立 `try/except` 容错。
- 方案：将后 4 项封装为 `asyncio.create_task` 后台协程并行启动（fire-and-forget），不阻塞 lifespan 完成，
  首屏仅等前 3 项。各服务原有 try/except 保留，启动失败仍只告警不影响主功能。
- 验收：保留现有 `_cancel_background_task`（test_service_lifecycle L16）取消语义；
  新增单测断言 lifespan 不为后 4 项阻塞；全量回归通过。
