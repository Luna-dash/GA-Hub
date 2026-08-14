# 会话运行域与实时聊天控制架构

- 状态：已实施
- 日期：2026-08-14
- 范围：GA-Hub LiveChat 的普通消息、BTW 与 rewind

## 1. 决策摘要

GA-Hub 当前同时存在两种 `AgentService` 实例域：

1. `AgentService.instance()` 是 legacy 全局实例，继续服务 `/api/agent/*`、微信、自动任务等尚未迁移的入口。
2. `SessionRuntimeFactory` 为每个 Hub session 创建 `AgentService(session_id=...)`，由 `SessionCoordinator` 管理，拥有该 session 的 GA agent、原生 archive、运行状态和实时事件。

二者并存本身不是错误；真正的风险是同一个产品界面混用两个实例域。例如 LiveChat 的普通消息进入 session runtime，而 BTW 或 rewind 却调用全局 `/api/agent/*`，操作的就可能不是用户当前看到的会话。

本次决策是：**LiveChat 的所有会话相关操作必须进入当前 session runtime。**

- 普通消息：`POST /api/sessions/{session_id}/runs`
- BTW：`POST /api/sessions/{session_id}/btw`
- rewind：`POST /api/sessions/{session_id}/rewind`
- legacy `/api/agent/btw` 和 `/api/agent/rewind` 保留兼容，但 LiveChat 不再使用。

## 2. 运行时所有权

| 对象或能力 | 唯一 owner | 持久化真相 | 说明 |
|---|---|---|---|
| Hub session 身份与配置 | `SessionMetadataStore` | session metadata | 保存 `session_id -> archive_path`、LLM、项目绑定等 |
| session GA runtime | `SessionCoordinator` | 无，按需恢复 | 每个 session 最多一个 runtime 实例 |
| GA agent 与 backend history | session `AgentService` | GA native archive | 是 archive 的内存投影，不是跨重启真相 |
| archive 生命周期锁 | `SessionRuntimeFactory` + GA `continue_cmd` | GA lock file | runtime 创建时取得，初始化失败时释放 |
| worldline checkpoint | session `AgentService` | `.ga_rewind/<archive-key>/tree.json` 与 blobs | 从完整 native archive 对账，不从压缩后的 live history 对账 |
| 普通 run admission | `SessionCoordinator` | 无 | 负责同 session 串行和进程级 run capacity |
| BTW reservation | `SessionCoordinator` | 无 | 不占普通 run capacity，保留 GA 已验证的旁路并发 |
| rewind exclusive control | `SessionCoordinator` | native archive + worldline | 同 session 独占，不阻塞其他 session |
| WebSocket 会话隔离 | `/ws/sessions/{session_id}` | EventBus cursor | 普通事件要求 session/run/stream 三重身份 |
| 前端历史展示 | `chatStore` | 服务端 archive hydration | runtime snapshot 只用于实时增量和短期重连 |

核心原则是：**Coordinator 拥有调度权，session AgentService 拥有运行时状态，GA archive 拥有持久化会话内容。**

## 3. 同一 session 的并发矩阵

下表只描述同一 session。不同 session 之间，BTW 和 rewind 相互独立；普通 run 是否可同时开始仍受配置的全局 run capacity 约束。

| 已在执行 | 新普通 run | 新 BTW | 新 rewind | 项目/LLM configure |
|---|---:|---:|---:|---:|
| 普通 run | 拒绝：`session_active` | 允许 | 拒绝：`session_active` | 拒绝：`session_active` |
| BTW | 允许 | 允许 | 拒绝：`session_control_active(btw)` | 拒绝：`session_control_active(btw)` |
| rewind | 拒绝：`session_control_active(rewind)` | 拒绝 | 拒绝 | 拒绝 |
| configure | 调用在 coordinator 临界区内串行完成 | 串行等待 | 串行等待 | 串行等待 |

BTW 是只读旁路操作，可以和普通 run、其他 BTW 并发。rewind 会改变 archive、worldline HEAD、backend history 和 working memory，因此必须是会话级独占操作。

## 4. rewind 的 durable 提交流程

```mermaid
flowchart LR
    UI["LiveChat 选择某个 Assistant 轮次"] --> Count["按可见用户轮计算 n"]
    Count --> API["POST /api/sessions/{id}/rewind"]
    API --> Coord["SessionCoordinator 取得会话独占权"]
    Coord --> Sync["解析完整 native archive 并 reconcile worldline"]
    Sync --> Plan["restore_plan mode=conv to=before"]
    Plan --> Archive["原子重写 native archive"]
    Archive --> Verify["重新解析 archive，与目标 history 硬校验"]
    Verify --> Runtime["更新 backend history 与 working memory"]
    Runtime --> Event["清理 runtime snapshots，发布 chat:rewound"]
    Event --> Hydrate["各标签页强制重新获取 archive history"]
```

关键提交边界在 archive 校验之后：

1. rewind 前先以 `parse_native_log(..., allow_empty=True)` 获取完整 archive，并让 `RewindStore.reconcile()` 吸收未建 checkpoint 的尾部轮次。
2. 按 worldline 的旧→新线性路径定位要删除的第一轮。
3. 使用 `restore_plan(mode="conv", to="before")` 删除该轮及之后的对话，同时保留当前代码状态。
4. GA 的 `restore_plan()` 对投影日志写失败是 best-effort 语义；Hub 不能接受静默失败，因此重新解析 native archive，必须与目标 history 完全一致。若不一致，显式重试一次原子投影写入。
5. 仍无法验证时，尽力恢复旧 worldline HEAD，抛出 `rewind_unavailable`。此时不更新 backend history、不删除 snapshots、不广播成功事件。
6. archive 验证成功后，才更新 `backend.history`、`handler.history_info`、`agent.history` 和 `handler.working["key_info"]`。
7. `chat:rewound` 是 archive 级事件，只要求明确 `session_id`；它不伪造不存在的 `run_id` 或 `stream_id`。

这保证了“刷新或重启后旧消息不会复活”。

## 5. archive、worldline、runtime 与 UI 的真相链

持久化真相链是：

`session metadata archive_path -> GA native archive -> worldline checkpoint/index -> runtime history -> WebSocket 增量 -> frontend hydration`

各层职责如下：

- native archive 是跨进程、跨刷新会话内容的最终真相。
- worldline 是可分支、可回退的 checkpoint 结构，但每次控制操作前必须与完整 archive 对账。
- runtime history 是当前进程中的执行上下文，可以被压缩或重建，不能反向覆盖未核对的完整 archive。
- WebSocket snapshot/event 用于实时性和短期重连，不是长期历史数据库。
- 前端在 rewind 后必须强制 archive hydration；仅按 `removed_sids` 删除本地消息不足以覆盖刷新后生成的 `history:*` 消息。

## 6. 为什么历史消息不能直接使用 stream ID rewind

runtime stream ID 只标识当前进程内某次提交，并受 snapshot 数量上限、进程重启和 archive hydration 影响。历史消息重新加载后使用 `history:*` 展示 ID，它不是 GA worldline node ID，也不是可恢复的 runtime stream ID。

因此 LiveChat 对历史 Assistant 消息执行 rewind 时：

1. 找到该 Assistant 所属的用户轮；
2. 计算“该用户轮及之后共有多少用户轮”；
3. 向后端发送 `{ n }`；
4. 后端只根据 durable archive/worldline 决定实际截断位置。

`sid` 仍保留给同一 runtime 生命周期内的精确控制或 legacy 调用，但不能作为 archive 历史的稳定身份。

## 7. API 错误契约

| code | HTTP | 含义 |
|---|---:|---|
| `invalid_btw` | 400 | BTW 文本为空 |
| `invalid_rewind` | 400 | 缺少 `sid/n`，或范围无效 |
| `session_active` | 409 | 当前 session 有普通 run，不能执行 rewind/configure |
| `agent_busy` | 409 | 普通 run 的进程级 capacity 已满 |
| `session_control_active` | 409 | 同 session 正在执行 BTW/rewind 等冲突控制 |
| `restore_failed` | 409 | session runtime 或 archive 无法恢复 |
| `rewind_unavailable` | 409 | worldline/archive 无法完成并验证 durable rewind |

机器码用于 UI 决策，中文 detail 只用于展示，不应成为前端分支条件。

## 8. 新增会话控制能力的扩展规则

以后增加 `/compact`、会话级 `/continue`、模型切换等控制时，遵循同一模式：

1. 先确定 owner 是 global agent 还是 session runtime；LiveChat 默认必须是 session runtime。
2. 在 `SessionCoordinator` 声明并发语义，不在 route 或 React 组件里临时加锁。
3. route 只负责校验、错误码映射和线程切换。
4. 会改变会话内容的操作必须先提交 durable archive，再更新内存和广播事件。
5. WebSocket 事件必须携带足够的 owner 身份；run 事件使用 session/run/stream，archive 事件至少使用 session。
6. 前端把服务端 archive hydration 作为恢复路径，不把本地消息数组当作持久化真相。

## 9. 后续架构切片

本次只完成“实时聊天控制统一到 session runtime”。其余问题建议按以下顺序推进：

1. **API 契约生成**：以 FastAPI OpenAPI 为唯一 schema，生成 TypeScript client/types；CI 检查生成文件无漂移，停止手工复制 request/response/event 类型。
2. **archive 身份与锁诊断**：在 metadata 中增加规范化 archive key/状态，统一 bind、archive、delete 的事务边界，并暴露锁 owner、心跳和 stale-recovery 诊断。
3. **调度器宿主统一**：保留 scheduled chat、autonomous、generic task 三种领域模型，但统一 scheduler lifecycle、持久 job store、执行网关和可观测性，避免三个独立启动/停止/恢复机制。
4. **持久化 owner 收口**：每类数据指定唯一 repository/single writer；route 和 service 不再各自直接读写 JSON。
5. **AgentService 拆分**：逐步拆为 GA runtime adapter、stream projector、rewind/archive adapter、LLM preference 等组件；`AgentService` 只做兼容 facade。
6. **Tauri 收敛**：用新的 ADR supersede `adr/0001`，将 Tauri sidecar supervisor 设为唯一生产桌面生命周期；pywebview 先降为明确的迁移/恢复入口，完成真实窗口、进程回收、升级和数据兼容验收后删除。

## 10. 会话与 archive 删除事务边界

状态：已实施（2026-08-14）

`SessionCoordinator` 现在提供两类可复用的生命周期入口：

- `exclusive(session_id, operation, action)`：在同一 session 内串行执行 archive/session 生命周期变更，拒绝与普通 run、BTW、rewind、配置变更竞态。
- `release_runtime(session_id, shutdown=..., operation=..., after_release=...)`：先取得独占权，再从缓存移除 idle runtime、执行阻塞式 shutdown，并在同一 reservation 内运行 `after_release` 删除 session/archive 身份；shutdown 或删除失败会向上抛出，调用方不得把事务视为已完成。

绑定关系按以下规则执行：

- `DELETE /api/sessions/{id}`：释放、停止缓存 runtime 和删除 session metadata 在同一个 `delete` 独占 reservation 中完成。
- `DELETE /api/conversations/{cid}`：若 archive 已绑定 Hub session，释放、停止缓存 runtime 和删除原生 archive/派生 metadata 在同一个 `archive_delete` 独占 reservation 中完成；执行删除前重新校验 archive 绑定仍是当初解析出的 session。
- 应用 shutdown 时先停止 scheduled chats，再逐个 abort 活跃 session run；全局 AgentService 与 token persistence 仍按既有顺序收尾。

这解决了“metadata/archive 已删除但 idle runtime 仍持有 GA birth lock”的竞态。若 runtime 正在运行或持有控制操作，删除请求返回 409，而不是先删除身份再留下不可恢复的锁。

## 11. 调度器宿主统一

状态：第一阶段已实施（2026-08-14）

`SchedulerHost` 是调度类服务的唯一生命周期宿主：

- scheduled chat、autonomous、generic task 仍是三个领域模型，保留各自持久化 schema 与 API 语义。
- autonomous 与 task 共享一个 APScheduler runtime；domain shutdown 只停止自身控制状态，runtime 由 host 最后统一停止。
- 启动按 scheduled chat → autonomous → task 注册顺序执行；单个 domain 启动失败只记录到 host status，不阻止其他 domain。
- 应用 shutdown 先停止 session run producer，再按注册反序停止调度 domain，最后停止共享 runtime。
- `/api/status` 暴露 `schedulers.runtime` 与三个 domain 的运行状态、计划数量和启动错误。

后续仍可继续收敛持久化 repository 与执行 gateway，但不以“合并三个类”为目标。

## 12. 持久化 owner 收敛

状态：第一阶段已实施（2026-08-14）

token usage 领域新增 `TokenUsageStore` 作为唯一 file owner：

- `token_usage.json` 与 `token_history.json` 的读取、shape 校验和 atomic replace 都由 store 完成。
- `routes/tokens.py` 只保留领域聚合、周/日归因和 API 语义，不再直接调用 `json`/临时文件写入。
- `AgentService` 继续通过 route 暴露的 `record_session_usage` 网关写入，避免 runtime adapter 反向依赖 HTTP 层的长期债务在本次行为改动中扩大。

后续按同样模式逐类收敛 UI preferences、email config 与 legacy chat history；目标是每类文件一个 repository/single writer，而不是一次性建立万能存储层。

### 12.1 UI preferences owner

UI preferences 领域新增 `UiPreferencesStore` 作为 `ui_preferences.json` 的唯一 file owner。它负责格式校验、线程锁、原子替换和默认文档；preferences route 只保留导航项校验与 HTTP 语义。迁移策略与 token usage 相同：先收敛文件所有权，保持 API 响应和既有 JSON 内容兼容。

## 13. AgentService 职责拆分

AgentService 保留 GA runtime facade、生命周期与全局兼容入口，但不再自己实现所有基础设施。第一片已把聊天回放投影抽为 `ChatStreamProjection`：它独立持有容量上限、插入顺序、快照复制与线程锁；AgentService 只提交快照并读取投影。后续按同样边界继续拆出 legacy archive adapter、rewind adapter 与 LLM preference，不用一次性重写 runtime facade。
