# GA-Hub 下一阶段演进与细化实施方案（2026-11-23）

- **基准基线**：主干 `HEAD` `e4fd708`（`fix(chat): preserve reading position when loading older messages`），桌面端构建基线仍停留在 `0874252`，工作区存在 `src-tauri/` 高 DPI 窗口图标未提交改动。
- **定位说明**：本文基于 `2026-11-23` 对仓库源码的实盘核查，对四个演进方向给出**当前真实状态、精确到文件与符号的改造清单、分批实施顺序与验收命令**。全局波次与总账仍以 [`TODO_REMAINING.md`](./TODO_REMAINING.md) 为准。

---

## 总览：四个方向与推荐执行节拍

| 批次 | 方向 | 目标 | 核心涉及范围 | 前置依赖 |
|---|---|---|---|---|
| **Phase 0（立即收尾）** | 方向一：在途改动与桌面端同步 | 验证并提交高 DPI 图标修复；将 `0874252` 之后的 5 个提交及图标修复打包交付桌面端 | `src-tauri/Cargo.toml`、`src-tauri/src/main.rs`、`src-tauri/src/window_icon.rs` | 退出运行中的 `GA-Hub` 与 `sidecar` |
| **Phase 1（视觉收口）** | 方向二：剩余 WebUI 布局统一 | 对齐 `Tasks.tsx`（`0874252`）收口 `Autonomous.tsx`；清理 `AntiChat` 附属弹层及 `conductor.css` 硬编码 | `Autonomous.tsx`、`AntiAccountUsageButton.tsx`、`AntiChat.tsx`、`conductor.css`、`Conductor.tsx` | 无 |
| **Phase 2（能力与安全对齐）** | 方向三：Agy 隔离深化 & Nova 协议同步 | 修复 Nova 远控对新 ACP 协议（`permission_mode`、`allow_always`、`option_id`、`step` 事件、`reset`）的断层；补齐 Agy 账号配额联动与临时状态清扫 | `assets/nova/connector.py`、`agy_profile.py`、`agy_runtime.py`、`agy_usage.py`、`anti_engine.py` | 建议在 Phase 0 同步基准后推进 |
| **Phase 3（结构与稳定性）** | 方向四：架构与可靠性技术债 | 对照 `TODO_REMAINING.md` 实况消化仍成立的 DB 保留策略、前端单会话内存窗口与历史兼容清理 | `conductor_store.py`、`conductor_workflow.py`、`chatStore.ts`、`feishu_service.py`、`scheduled_chat_service.py` | 按低优先穿插执行 |

---

## 方向一：当前在途改动收尾与桌面端重打包

### 1.1 真实代码现状

1. **工作区未提交的原生窗口修复（`src-tauri/`）**：
   - `src-tauri/Cargo.toml`：为 `windows-sys` 新增 `Win32_System_LibraryLoader`、`Win32_UI_HiDpi`、`Win32_UI_WindowsAndMessaging` feature。
   - `src-tauri/src/main.rs`：声明 `#[cfg(windows)] mod window_icon;`（L26-27），并在主窗口 `.build()?` 之后调用 `window_icon::install(hwnd.0.cast())`（L1656-1659）。
   - `src-tauri/src/window_icon.rs`（45 行，未跟踪）：通过 `GetSystemMetricsForDpi` 读取 `SM_CXICON/SM_CYICON` 与 `SM_CXSMICON/SM_CYSMICON`，再以 `LoadImageW` 加载资源图标 `32512` 并发送 `WM_SETICON`（`ICON_BIG` 与 `ICON_SMALL`），解决 Windows 高 DPI 缩放下任务栏/标题栏图标模糊问题。
   - 注：普通 PowerShell 终端未加载 VS MSVC 环境（`cargo check` 报缺少 `cl.exe` / `link.exe`），需由 `scripts/build_all.py` 自动加载 `vcvarsall` 完成编译与链接。
2. **自上次桌面构建（`0874252`）后尚未打入便携包的 5 个提交**：
   - `af8ef50`：移除定时任务邮件逻辑。
   - `4ef4d60`：优化 Nova 长会话历史投影，避免未变更时重复投影。
   - `703f2cb`：定时任务摘要改取最终助手结论而非开头过程文案。
   - `3e461ef`：桌面端聊天历史分页首屏投影设限，避免大历史卡顿。
   - `e4fd708`：加载更早历史消息后保持当前阅读滚动位置。

### 1.2 细化执行方案

1. **审阅并提交 `src-tauri` 图标改动**：
   - 核对 `window_icon.rs` 仅在 `#[cfg(windows)]` 编译、图标句柄加载失败静默降级（不阻断窗口启动）。
   - 单独提交：`fix(desktop): install DPI-aware big and small window icons on Windows`。
2. **按红线执行完整构建与替换**（严格遵守 `AGENTS.md` / [`docs/BUILD.md`](../BUILD.md)）：
   - 确认桌面端 `GA-Hub` 主进程与 `ga-hub-sidecar` 已退出，避免产物文件锁导致预检失败（exit `2`）。
   - 执行全量验证与构建：`python scripts\build_all.py --full`（禁止直接手拼 `tauri build` 或 `npm run desktop:build`）。
   - 验证退出码为 `0` 且三件产物（主 exe、sidecar 中间产物、sidecar 交付副本）均通过刷新守卫与 `--selftest`。
   - 启动新版便携 exe 实机核对：高 DPI 屏幕任务栏/标题栏图标清晰度、`LiveChat` 向上翻页保持阅读位置、`Tasks` 卡片结论摘要。

---

## 方向二：剩余 WebUI 页面布局与视觉统一

### 2.1 真实代码现状（基于源码盘点）

- **已完成标杆页（勿重复翻修）**：`LiveChat.tsx`、`Conversations.tsx`（`b99d38a`）、`Tasks.tsx`（`0874252` / `af8ef50` / `703f2cb`）、`Dashboard.tsx`（217 行）、`Memory.tsx`（395 行）已对齐统一卡片语言、状态胶囊、字号层次与无邮件化。
- **高优先失配页 — `webui/src/pages/Autonomous.tsx`（510 行）**：
  - 仍沿用旧版 `Tasks.tsx` 结构：`<PageShell title="自主进化" actions={...}>` 未提供 `titleExtra` 内联状态胶囊；
  - L95-123 渲染 3 列大块 `aria-label="运行概览"` 统计卡片（调度计划 / 累计触发执行 / 已归档进化报告），占高且与标题栏割裂；
  - `ScheduleCard`（L245-332）把类型胶囊置顶另起一行、带 `border-l-[3px] border-l-accent` 粗边框、内嵌 `.ga-paper-subcard`、`<hr className="ga-hairline" />` 和 4 个平铺按钮（`立即触发` / `禁用或启用` / `编辑` / `删除`）；
  - `触发历史`（L164-199）仍使用 `text-sm` 宽松单元格（`px-3.5 py-2.5`）、裸显示 `r.schedule_id`、无单行紧凑摘要。
- **中优先收敛页 — `AntiChat` 组件群 & `Conductor` 样式**：
  - `AntiChat.tsx`（663 行）主体已完成（`SessionRail`、`ChatComposerFrame`、Plan/Edit、`permission_mode`、Slash 菜单、`AntiTaskProgress` SSE 流、隔离账号横幅 L562-567）。但 `headerActions` 在中窄屏与 `SessionRail` 共存时控件偏挤；
  - `AntiAccountUsageButton.tsx`（326 行）弹层内混用独立样式（如 `text-[10px]`、未复用的小表单输入框与 `rounded bg-accent` 按钮，见 L267-302）；
  - `conductor.css`（242 行）仍有硬编码色值（L65 `.conductor-recovery`: `#EBD8AC` / `#FFF3D8` / `#7A4F08`；L189 `.conductor-history-delete:hover`: `#9E3328`）以及透明分割线与实色 `var(--c-line)` 混用（L108、L164、L222）；`Conductor.tsx` 单文件达 875 行。

### 2.2 细化执行方案

#### A. `Autonomous.tsx` 布局重构（对齐 `Tasks.tsx`）
1. **状态上提至 `PageShell titleExtra`**：
   - 移除 L95-123 三栏 `运行概览` 大卡；
   - 在 `titleExtra` 展示两个轻量胶囊：`计划 enabled/total`、`已归档 report_count`（与 `Tasks.tsx` 头部状态保持同一胶囊尺寸与 `tabular-nums`）。
2. **`ScheduleCard` 卡片减负与交互收敛**：
   - 移除 `border-l-[3px] border-l-accent` 粗边框、`<hr className="ga-hairline" />` 与嵌套 `.ga-paper-subcard`，统一使用 `.ga-paper-card` 层次与 `divide-y` / 轻量柔分割；
   - 标题行同一行容纳「状态点 + 计划标题 + 类型胶囊」，次行展示 cron/间隔、上次执行状态与输出预览；
   - 按钮收敛：保留主触发（`立即触发`）、状态开关与图标级操作（`编辑` / `删除`）紧凑排列，避免换行撕裂。
3. **`触发历史` 紧凑化**：
   - 表头与行内边距收窄（`text-xs`、`py-1.5`），将 `schedule_id` 映射为人类可读的计划名称，`result_summary` / 报告预览复用或对齐 `Tasks` 的最终结论摘要提取方式（避免截断过程性开场白）。

#### B. `AntiChat` & `Conductor` 视觉一致性收敛
1. **`AntiAccountUsageButton.tsx` 弹层控件规范化**：将校准表单与重置熔断操作收敛到既有 `.ga-input` / `.ga-btn-sm` / `.ga-btn-sm-primary` / `.ga-btn-link` 类，消除零散 `text-[10px]` 与裸 `bg-accent` 按钮；长文本/多模型配额池限制高度并对齐 `font-mono tabular-nums`。
2. **`AntiChat.tsx` 顶栏窄屏适应**：评估 `MainModelSelect` + `思考等级` + `重连 ACP` 在 1024px–1280px 宽度与侧栏展开时的换行/截断表现，必要时把次要诊断文本收敛进 tooltip。
3. **`conductor.css` 主题收口与 `Conductor.tsx` 拆分**：
   - 将 L65 `.conductor-recovery` 改为 `--c-status-warning-*` 语义变量（或与 `.ga-badge` / `bg-status-warning-soft` 等价 Token），将 L189 `#9E3328` 改为 `var(--c-status-danger)`；
   - 统一内部细线为 `rgb(var(--c-line-rgb) / 0.55)`；
   - 按 TODO P.2 将 `Conductor.tsx`（875 行）中的历史抽屉、工作区看板与右侧交付/动态栏拆至独立组件文件，降低后续修改回归面。

---

## 方向三：Agy 多账号安全隔离深化与 Nova 远程通道对齐

### 3.1 真实代码现状

1. **Nova 远控 `/api/agy/*` 与新 ACP 后端存在协议断层**（`assets/nova/connector.py` L83-210 对比 `server/routes/anti.py` L122-198 & L551-630）：
   - **权限模式缺失**：`server/routes/anti.py` 的 `AntiRunCreate`（L161）已支持 4 档 `permission_mode`（`approval-required` / `auto-accept-edits` / `auto` / `full-access`），但 `assets/nova/connector.py` L154 的 `agy_body` 允许集合仍为 `{'upload_ids', 'model', 'effort', 'mode'}`，完全未透传 `permission_mode`；
   - **交互审批残缺（阻塞可用性）**：`server/routes/anti.py` L620-630 允许 `decision in ('allow', 'allow_always', 'reject')` 及问题选项 `option_id`，而 `connector.py` L184-188 严格拒掉除 `('allow', 'reject')` 之外的一切决策，且不接收 `option_id`，导致新版 ACP 的“本会话始终允许”和多选问题卡在 Nova 手机端失效；
   - **步骤事件被过度裁剪**：`connector.py` L193 对 `/events` 仅保留 `('seq', 'type', 'text')`，丢弃了 `step` 字段（工具调用名、命令行、退出码、`diff`）；
   - **ACP 控制与账号可见性缺失**：`connector.py` 未映射 `POST /sessions/{sid}/reset`（重连 ACP）、`/profiles`、`/quota`、`/reset-breaker`。
2. **Agy 多账号隔离与风控保护现状**（`agy_profile.py` 769 行 / `agy_runtime.py` 1299 行 / `agy_usage.py` 693 行 / `anti_engine.py`）：
   - 已落实：`switch_profile` / `stop` / `restart` / `delete_profile` 均有 `_active_turn_count()` 保护与 `_close_all_workers_locked()` 清理（`agy_runtime.py:820-845, 1160-1197`）；`prepare_profile` 同步清理旧 `run-*` 临时目录；`delete_agy_profile`（`routes/anti.py:402-410`）同步清理会话与 `ledger.delete_profile(profile_id)`。
   - 待补齐：
     - **凭证清除与目录清理联动**：`clear_profile_credentials`（`agy_runtime.py:1169`）仅删除凭证文件，未即时清扫该 `profile_id` 的 `profile_runtime_temp_root`；`quota_state` 中针对已失效凭据的冷却态需明确是否在重新登录/清除时重置；
     - **隔离目录并发冲突防护**：`clean_agy_env` 已通过 `GEMINI_HOME` / `USERPROFILE` / `AGY_ACP_FORCE_FILE_STORAGE=1` 隔离，但缺少基于隔离目录的互斥锁或明显状态提示，无法感知宿主机外部 CLI 意外占用同一隔离配置；
     - **风控熔断的主动恢复体验**：`agy_usage.py:515` `check_run_allowed` 仅校验 `cooldown_until` 与 `calibrated_remaining_pct <= 0`，被拦截时只返回 429 文案，缺少与实时探测配额（如已知剩余 < 阈值）协同及前端一键切到“未冷却且有配额备用账号”的联动动作。

### 3.2 细化执行方案

#### A. Nova Gateway `/api/agy/*` 协议补齐（优先高，影响手机远程体验）
1. **补齐提交与运行控制契约**（`assets/nova/connector.py`）：
   - `agy_body`（L154）放行可选字段 `permission_mode`，严格白名单校验为 `('approval-required', 'auto-accept-edits', 'auto', 'full-access')`；
   - 新增 `POST /sessions/{sid}/reset` 转发至 `/api/anti/sessions/{sid}/reset`，供远程在 ACP 断线/异常时重连；
   - 确认 `/runs` 与 `/runs/{rid}` 返回裁剪字段补充 `permission_mode` 与 `usage` 摘要（保持零绝对路径/宿主机环境变量泄露）。
2. **修复审批与事件透传**：
   - L184-188 放行 `decision in ('allow', 'allow_always', 'reject')` 与可选 `option_id`（长度与字符白名单校验 `1..256`）；
   - L193 对 `/events` 在保留 `('seq', 'type', 'text')` 基础上按白名单透传精简 `step`（`index`、`kind`、`state`、`tool`、`duration_seconds`、`detail`、`exit_code`，超长 `output`/`diff` 做截断保护或脱敏，不透传任意未校验字段）；
   - 如 Nova 云端前端需要切换/查看多账号熔断，按需补充只读 `GET /api/agy/profiles`（仅暴露 `id`、`name`、`active`、`auth_state`，**严禁暴露本地路径与 token**）与 `GET /api/agy/quota`。
3. **测试加固**：扩展 `tests/test_nova_component.py` 与 `tests/test_nova_connector_e2e.py`，覆盖 `permission_mode`、`allow_always`、`option_id`、`step` 事件与 `/reset` 路径。

#### B. Agy 多账号安全隔离与熔断体验深化
1. **运行时清扫闭环**（`agy_profile.py` / `agy_runtime.py`）：
   - 在 `clear_credentials` 与 `shutdown` 末尾主动调用 `retire_runtime_temp_dirs(profile_runtime_temp_root(profile_id))`，确保注销即清空遗留临时解包目录；
   - 在 `agy_runtime.clear_profile_credentials` 成功清除凭据后调用 `ledger.clear_quota_state(profile_id)`（保留 `usage_ledger` 历史用量用于统计，清除陈旧的 `quota_state` 冷却锁）。
2. **隔离文件锁检查**：为每个隔离 `profile_id` 引入轻量 PID/锁文件标记（写入 `profile_runtime_temp_root(profile_id)`），在 `prepare_profile` 启动前检测孤立锁或给出诊断告警，减少多进程并发踩写 `jetski_state.pbtxt`。
3. **429 熔断引导切换**：当 `AntiChat` 收到 429 配额/冷却拦截时，在提示内附带「打开账号设置切换可用账号」快捷入口（复用既有 `setProfilesOpen(true)`），并在 `AntiAgyProfiles` 中高亮非冷却状态的备选账号。

---

## 方向四：架构与可靠性技术债核查与分批消化

> 对照 [`TODO_REMAINING.md`](./TODO_REMAINING.md) 逐项核实当前代码，剔除已失效项，仅保留**真实仍存的债项**：

### 4.1 已确认闭合（可在 TODO 中核销，勿重复建设）
- **TS 契约新鲜度校验**：`webui/scripts/check-api-contract.mjs` 与 `tests/test_api_contract.py` 已接入（P.2 已标注完成）。
- **`conftest.py` 共享测试 fixture**：`session_domain` / `bind_session_domain` 已落地。
- **`TaskBoard` / `WorkerCard` memo 失效**：已使用稳定回调与 `useCallback` 修复（P.1 已排除）。
- **Anti 核心单测缺口**：`tests/test_anti.py`、`tests/test_anti_daemon.py`、`tests/test_anti_acp.py` 及 `tests/test_nova_component.py` 当前合计 `33 passed, 3 subtests passed`。

### 4.2 仍真实存在的债项与微创落地方案

| 编号 | 现状核实（代码位置） | 实际影响 | 建议方案与验收 |
|---|---|---|---|
| **D4.1 Conductor `workflows` 表保留策略（P.1）** | `conductor_store.py` 已有 `SUBAGENT_ARCHIVE_CAP=400` 与 `ACTIVITY_CAP=4000` SQL 裁剪，但 `conductor_workflow.py:594-618` 的 `prune_terminal()` 仅 `pop` 内存 `self._workflows`，SQLite `workflows` 表仅在单条 `forget_workflow`（L175）时删除 | 长期运行后 `workflows` 表及其关联 `workflow_tombstones` 单调增长 | 在 `conductor_store.py` 增加 `WORKFLOW_RETENTION_CAP`（如保留最新 200 条终态记录及对应 `tombstone`），在 `prune_terminal(committed=True)` 同事务内清理超限最老终态 SQL 行；补单测验证重启恢复后活跃工作流不受影响 |
| **D4.2 `chatStore` 活跃会话内存窗口（P.2）** | `chatStore.ts:181-205` 已限制跨会话缓存（`MAX_CACHED_SESSION_VIEWS = 3`、`MAX_CACHED_SESSION_CHARS = 3_000_000`），且后端分页（`3e461ef`）与滚动锚定（`e4fd708`）已就位；但单会话持续连续流式或不断向上翻页时，当前活跃 `msgs` 仍无上限 | 极长单会话挂机数小时后内存持续累加 | 在保持 `historyBefore` 与向上加载锚定兼容前提下，允许对超出安全阈值（如 > 400 条非实时历史消息或字符超限）的老段自动折叠/提供「仅保留最近阶段，点击从归档重新展开」，确保 `applyEvent` 与 `stop` 零回归 |
| **D4.3 W3.7 兼容标记清理** | `server/services/feishu_service.py:37` 仍保留 `_CHAT_MARKERS = ("__GA_FRONTEND_EVENT__", "__GAHUB_FEISHU_CHAT__")`；`event_topics.py` 与 `test_import_direction.py` 目前静态扫描均为零违规 | 少量历史兼容字符串残留 | 确认外部/飞书脚本无再依赖 `__GAHUB_FEISHU_CHAT__` 后，从 `_CHAT_MARKERS` 移除旧标记并跑全量 `feishu` / `event_topics` / `import_direction` 回归 |
| **D4.4 P.4 结构与路由边界收编** | `scheduled_chat_service.py:48` 持久化在 `ADMIN_DATA / "scheduled_chats.json"`；`main.py` 含应用装配与部分系统路由；`Conductor.tsx` 875 行 | 维护可读性成本，非功能故障 | 作为纯重构批：先拆 `Conductor.tsx`（配合方向二样式收敛）；再评估 `create_app` 外迁 `routes/system.py` 与 HTTP 错误结构化渐进对齐 |

---

## 验证基线命令（每批落地后执行）

- **仓根卫生与契约守卫**：`python -m pytest tests/test_repo_hygiene.py tests/test_event_topics.py tests/test_import_direction.py -q`
- **Agy & Nova 定向测试**：`python -m pytest tests/test_anti.py tests/test_anti_daemon.py tests/test_anti_acp.py tests/test_nova_component.py -q`
- **后端全量测试**：`python -m pytest tests -q`
- **前端全量测试**：`npm --prefix webui test -- --run`
- **桌面构建与守卫验证（方向一及最终发布前）**：`python scripts\build_all.py --full`（检查 exit code `0` 及 `--selftest` 通过）
