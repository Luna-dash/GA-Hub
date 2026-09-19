# Conductor 任务提交模型与引擎生命周期改造计划

> **状态标记（2026-09-18 复核）：🟡 部分完成 —— H1–H3 ✅、G1+G2 ✅、G3 ✗、G4 待复核。**
> - **H1–H3**（Hub 侧：引擎懒启动/关闭回收、输入三态）✅ 提交 `a1d5659`（2026-09-15）。
> - **G1+G2**（GA 侧：supervisor 协议模板化 + 每轮仅动态头）✅ **已于 2026-09-18 提交 GA `04f0d9d`（06:25）**
>   —— `GA/frontends/gahub/supervisor_protocol.md` 已入库；`gahub_app.py:152-155` 读模板、`:526` 注入
>   `extra_sys_prompts=[SUPERVISOR_PROTOCOL]`。原文「G1–G4 未开工」已过期。
> - **G3**（新任务边界换归档 + 清上下文）✗ **未开工** —— `_new_log_path` / `_retarget_log` /
>   `_clear_conversation_state` 在 `GA/frontends/gahub/` 零命中。不做这条，「一个任务一个归档」不成立。
> - **G4**（放弃 = 任务级）**待复核**：单 worker 级 `abort_subagent(origin=…)` 与 `CANCELLED` 终态已存在
>   （`conductor_core.py:1567`、`gahub_app.py:1920`），需确认是否还缺 workflow 级终态收口。
> - **追加语义缺口**：对终态任务追加会另铸 `request_id`（见 §4 H2.2），需 GA 侧 workflow reopen + Hub 侧配套。
> 剩余动作与顺序见 `docs/plans/TODO_REMAINING.md` W2。

- 日期：2026-09-15
- 状态：GA-Hub 侧 H1–H3 **已实现**；GA 侧 **G1+G2 已完成（GA `04f0d9d`，09-18）、G3 未开工、G4 待复核**（2026-09-18 更正）
- 范围：GA-Hub（引擎生命周期、Conductor 输入框）+ GA 仓（提示词模板化、任务级归档/上下文切换）
- 关联：`feishu-import-task-brief.md`、`restore-ui-interaction-spec.md`

## 0. 背景与已核实事实

1. supervisor 提示词**全文内联进 user 消息** → 超长 → `agentmain.py:177` 落 `temp/user_prompt_*.md`，日志只留「读取并执行」→ 主会话归档不可读、正文依赖 temp（有语义丢失风险）。
2. worker 走 `extra_sys_prompts=[WORKER_CONTRACT]`（system 层）→ 归档干净。supervisor 应改成同机制。
3. 一个 supervisor 一个归档，所有任务的轮次混在一起；每个 worker 一个归档。
4. F1 批量默认开：一次 wake 可多 request → 与「一个归档=一个任务」冲突。
5. 引擎进程当前是孤儿（实测 PID 42216 自 9/9 起、父进程已死），关 GA-Hub 不回收（`main.py::_shutdown` 未接停引擎）。
6. UI 已有 append/new 底子（`submitChat(target === 'append' ? … : null)`），但未显式化。

## 1. 目标终态

**一次一个任务；一个任务一个归档；引擎按需启停。**

1. supervisor 协议 = 固定 md 模板（system 层）+ 每轮仅动态片段（user 消息短）。
2. 任务 = `request_id` = 一个归档；多轮（派发→review→rework→final→追加）归同一归档；新任务 → 新归档 + 清上下文。
3. 提交模型：三态输入框（新任务 / 追加 / 放弃）；初次提交 vs 追加内容不同（追加不重复模板）。
4. 引擎生命周期：进入 Conductor 页幂等启动；关 GA-Hub（双路径）显式回收；不闲置自动停。
5. 停止（引擎级）退到设置；放弃（任务级）新增，带确认。

## 2. 明确不做

- 不保留 F1 批量（由 GA-Hub 注入 env 关闭）。
- 不合并「停止」与「放弃」。
- 不做闲置自动停。
- 不碰 `agentmain.py` 的长 prompt 落 .md 通用机制。
- 不做引擎后台常驻（HKCU Run 键那类）。

## 3. 关键决策（已定）

| # | 决策 |
|---|---|
| 1 | 引擎懒启动：进 Conductor 页幂等 ensure；关 GA-Hub 双路径停 |
| 2 | 模板：`frontends/gahub/supervisor_protocol.md`，启动读一次，4 个动态值每 wake `format` |
| 3 | 一次一个任务：`GAHUB_MULTI_REQUEST_TURNS=off`（GA-Hub 注入） |
| 4 | 一个任务一个归档：新 request → `_new_log_path` + `_retarget_log` + `_clear_conversation_state`（B2） |
| 5 | 输入三态：无任务=新任务；有任务=默认追加；「＋新开任务」= 放弃确认后新开 |
| 6 | 放弃（任务级）新增、带确认（中止本 request 活跃 worker，origin=hub）；停止（引擎级）退设置 |

## 4. 实施步骤（纵切）

### GA 侧（出精确 diff，落由用户定）

- G1 新增 `frontends/gahub/supervisor_protocol.md`：把 `_build_prompt` 内联协议抽为模板，4 处模型路由值留占位。
- G2 `gahub_app.py`：`_new_conductor_agent` 注入 `extra_sys_prompts`；每次 wake 前 `format` 动态值；`_build_prompt` 瘦身为动态尾段（`Current state: {summary}` + `<wake_events>{events}</wake_events>`）。
- G3 `conductor_core.py`：新 request 边界做 `_retarget_log` + `_clear_conversation_state`（B2）；F1 若要从根上关，`multi_request_turns` 默认改 False。
- G4 放弃任务：中止当前 request 的活跃 worker（`abort_subagent(origin="hub")`）+ workflow 终态 CANCELLED。

### GA-Hub 侧（本会话做）

- H1 `conductor_client.py`：`_engine_spawn_env()` 注入 `GAHUB_MULTI_REQUEST_TURNS=off`；加 `ensure_running()`（幂等启动）；`main.py::_shutdown` 与 sidecar shutdown hooks 接线停引擎。
- H2 `Conductor.tsx`：进入页面触发 ensure；「启动中…」就绪态；输入框三态 + 放弃确认 + 停止按钮退设置。
- H3 测试 + 契约（如新增路由）。

#### 落地说明（2026-09-15 实现）

- H1.1：`_engine_spawn_env()` **强制**写 `GAHUB_MULTI_REQUEST_TURNS=off`（不是 setdefault）：一次一个任务是 hub 的不变量，继承来的 `on` 不得把批量重新打开。GA 侧 `gahub_app.py` 已有 `_env_flag_off` 读取，无需改 GA。
- H1.2：进页面复用 **`POST /api/conductor/start`** 作为幂等 ensure（进程 + supervisor 会话 + 模型快照一次到位），未新增路由；app 启动路径不碰引擎。前端在 llms 查询结算后触发一次（模型三件套已解析，避免用引擎默认模型冷启动），成功后静默，失败给「重试启动」。
- H1.3：dev（`server.run` → `server.main:app`）与桌面 sidecar（`desktop_sidecar.py` 同样 import `server.main.app`）共用 lifespan → `_shutdown` → `services.shutdown_all()` → `ConductorService.shutdown()`（先停 supervisor，再 `GahubProcessManager.stop()` 收进程）；本轮补了注释与两条回归测试，未发现漏洞。
- H2.2 已知偏差：对**已终态**任务追加仍按 `conductor_commands.submit` 的 `is_open` 规则**另铸 request_id**（实际成为新任务，不回到原归档）。UI 三态按规格实现；「追加进原归档」需要 workflow tracker 的 reopen 语义（清 `terminal_event`/`final_item`、允许新 worker 绑定终态 workflow），风险面大，留给 GA 侧 B2/G3 后续计划一起做。
- H2.3：abort 走现有 `POST /api/conductor/subagent/{sid}`；`origin="hub"` 由 `conductor_service.apply_subagent_action` 对 abort 动词统一盖章，前端路由无需也无法传 origin（已核实）。

## 5. 验收

- 引擎：进页面才起；关 GA-Hub 必停（dev 后端 + 桌面 sidecar 两路径）；无孤儿。
- 归档：新任务=新归档+清上下文；追加进当前任务归档；supervisor 轮次可读（含任务文本，不再落 .md）。
- 提交：无任务时=新任务；有任务时默认追加、可显式放弃（确认框显示将中止的 worker 数）。
- F1：off 生效（一次 wake 一个 request）。
- 回归：Conductor 页、引擎传输 E2E、历史页来源标识均不受影响。

## 6. 回滚

- GA-Hub 侧改动独立可回退（单提交 revert）。
- GA 侧集中在 2 个文件 + 1 个新模板文件；`supervisor_protocol.md` 与原内联协议逐字对应，可 diff 核对。

## 7. 结论

> 任务 = request_id = 一个归档；协议是常驻模板，用户提交的是任务本身；引擎按需启停。