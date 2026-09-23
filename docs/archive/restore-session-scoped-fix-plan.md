# Restore 会话域收敛修复计划

> **状态标记（2026-09-18 复核）：✅ 已完成 —— 不再是待办。**
> 步骤 1–5 全部落地并提交 `46ffcb4`（2026-09-15）。代码证据：`server/routes/conversations.py`
> 使用 `ConversationRestoreReq.session_id` + `archive_override` + 协调器原子替换（`:342` / `:369`）；
> `server/services/session_runtime_factory.py:170` 支持 `archive_override`；openapi 与 `schema.d.ts` 已含新契约。
> **本文保留为设计记录。** 后续动作见 `docs/plans/TODO_REMAINING.md`；索引见 `docs/plans/README.md`。
> ⚠️ 附带发现：前端已无任何 `restoreConversation` 调用方，`POST /api/conversations/{cid}/restore` 目前
> **无 UI 消费者**，去留待定（待办计划决策 ④）。
> 已归档（2026-09-23 移入 `docs/archive/`）。

- **日期**：2026-09-15
- **状态**：~~设计已冻结，尚未开始步骤 2；当前工作树保留既有步骤 1 改动~~
  → **全部 5 步已完成并提交（`46ffcb4`，2026-09-15）**（2026-09-18 更正）
- **范围**：GA-Hub 后端 restore 链路、会话 runtime 构造、Web UI 调用与回归测试
- **原则**：先验证行为，再逐步实现；不引入兼容性临时分支，不改变会话归档绑定语义

## 0. 当前真实状态（以本计划生成时源码和 git 工作树为准）

### 已确认的缺陷

`POST /api/conversations/{cid}/restore` 当前直接使用进程级 `AgentService.instance()` 及 GA 原生 restore 路径；普通聊天则通过 `SessionCoordinator` 使用每个 Hub session 的 runtime。于是 restore 成功后，被恢复的历史在全局 agent 中，而随后聊天仍可能发送给目标 session 的旧 runtime，表现为“恢复成功但继续对话看不到恢复内容”。

这是全局 agent 与 per-session runtime 的双轨残留，不是归档读取本身的问题。

### 已确认的架构边界

1. `server/routes/sessions.py` 懒创建并持有 `SessionCoordinator`；聊天/控制操作均以 `session_id` 为边界。
2. `SessionRuntimeFactory.__call__(session_id)` 当前负责：
   - 从 metadata 读取该 session 的 `archive_path`；
   - 创建 runtime；
   - 通过 `continue_inplace(..., agent_id=session_id, restore_wm=True)` 加载绑定归档；
   - 必要时处理 stale lock / 不可读归档轮换；
   - 初始化 rewind store、项目并启动 runtime 线程。
3. 普通 factory 路径在无归档时会 `bind_archive`，在内容损坏时会 `rotate_archive`。这两种 metadata 写入行为不能被 restore 临时复用，否则会把“查看/恢复某个历史归档”误变成“永久改 session 绑定”。
4. `SessionCoordinator.replace_runtime()` 已在工作树中实现并有单测：通过 `exclusive(session_id, ...)` 拒绝忙碌 session，锁内原子换 runtime，锁外关闭旧 runtime；构造新 runtime 失败时旧 runtime 不动。
5. `ConversationRestoreResp` 已有 `title`、`restored_lines` 等响应字段，不需要为了本修复新增响应字段。
6. Web UI 当前 `api.restoreConversation(id)` 不带 body；`chatStore` 已有 `sessionId` 状态。

### 当前工作树（不得误删）

- `server/services/session_coordinator.py`：未提交，新增 `replace_runtime()`。
- `tests/test_session_coordinator.py`：未提交，新增 shutdown 计数及替换测试。
- `docs/archive/audit-remaining-review-2026-09-15.md`：未跟踪的既有审查文档，不属于本修复，不改动、不删除。

## 1. 目标终态与非目标

### 目标终态

restore 必须作用于调用方明确指定的 Hub session：

1. 解析并校验目标 archive `cid`；
2. 校验目标 `session_id` 存在；
3. 以该 archive 为**一次性新 runtime 的工作历史**构建 runtime；
4. 原子替换目标 session 的 runtime；
5. 关闭旧 runtime；
6. 返回原有 restore 响应；
7. 后续聊天继续使用刚替换的新 runtime，因此能看到恢复历史。

### 明确不做

- 不再把 restore 写入进程级全局 agent。
- 不修改目标 session 的 `archive_path` 绑定；恢复只是把选定 archive 加载到当前 runtime。
- 不把被恢复的 archive 自动永久绑定到该 session。
- 不在 session 忙碌时排队、强杀 run、抢占 runtime。
- 不借机移除整个 `AgentService` 单例；本修复只切断 restore 的全局路径，单例清理另行评估。
- 不保留旧的无 body restore 兼容路径。接口契约明确改为必填 `session_id`，避免服务器猜测目标 session。

## 2. 冻结的接口与语义决策

### HTTP 请求

`POST /api/conversations/{cid}/restore`

请求 JSON：

```json
{"session_id": "<target Hub session id>"}
```

`session_id` 必填、非空；由 Pydantic request model 校验。`cid` 仍是 archive catalogue 中的归档 id，而不是 Hub session id。

### 状态码

- archive 不存在：保持现有 `404 conversation not found` 语义。
- `session_id` 不存在：`404 session not found`。
- session 正在 run、控制操作或其他 coordinator exclusive 操作中：`409`，不创建/替换 runtime。
- 新 runtime 构建或归档加载失败：返回明确的 `5xx`/现有异常映射；旧 runtime 必须保持可用，不能先换后建。
- 成功：保持既有 `ConversationRestoreResp` 形状。

### factory 新接口

将 `SessionRuntimeFactory.__call__` 扩展为：

```python
factory(session_id, *, archive_override=None)
```

- `archive_override is None`：保留当前普通 session 启动语义，包括 metadata 绑定和现有 L2 损坏归档轮换。
- `archive_override` 有值：只把该路径作为本次 runtime 的加载源；禁止 `bind_archive`、`rotate_archive` 或任何 metadata archive 写入。目标 session 的 `archive_path`、title、project 等 metadata 不变。
- override 路径必须沿用现有归档解析/锁/stale-lock处理和 runtime 初始化步骤，避免实现第二套加载逻辑。
- override 内容不可读时：构建失败并清理新 runtime；不能因 override 失败而旋转、删除或覆盖该归档，也不能修改 session metadata。
- 路由负责先通过 archive catalogue 解析 `cid` 得到受信任路径，factory 不接受未经路由解析的 cid。

## 3. 实施步骤（纵切面顺序）

### Step 1：保留并验证现有 coordinator 原子替换（已完成于工作树，尚未提交）

- 复读 `replace_runtime()`，将 shutdown/disposer 分支改为清晰的普通 `if`（仅在不改变行为且一并补测时做）。
- 保持 `exclusive` 的 busy 拒绝语义、锁内 swap / 锁外 shutdown 顺序。
- 增加/确认测试：成功替换关闭旧 runtime；busy 时不替换、不关闭旧 runtime；shutdown/disposer 异常不会破坏已完成的 swap（若当前公共语义允许异常向上传播，则明确测试该语义）。

### Step 2：factory 增加 archive override

实现一个与普通 `__call__` 共用初始化骨架的分支，避免复制出两套 runtime 生命周期：

1. 读取并确认 session metadata 存在；
2. 创建新 runtime；
3. 选择 `archive_override` 或 metadata 中的 `archive_path` 作为加载源；
4. 对 override 仅调用 GA continue/load，不执行 metadata bind/rotate；
5. 复用 rewind store、project activation、run thread 启动；
6. 任一初始化步骤失败，调用现有 release/cleanup，向上抛出清晰异常。

测试先行：

- override 从指定 archive 加载，而不是从 session 绑定 archive 加载；
- override 成功后 metadata `archive_path` 不变；
- override 失败会 release 新 agent，metadata 不变；
- 普通无 override 路径的 bind、stale-lock retry、L2 rotate 回归不变。

### Step 3：restore 路由切到 coordinator

在 `server/routes/conversations.py`：

1. 增加 restore request schema 的导入；
2. 增加 coordinator 的安全访问/注入方式，复用 sessions 路由的生命周期对象，不自行创建第二个 coordinator；测试通过 monkeypatch/依赖注入替换；
3. 保留 archive catalogue 解析，放在 `asyncio.to_thread` 中执行，避免阻塞事件循环；
4. 校验 archive 和 session；
5. 按以下严格顺序执行：
   - 先调用 factory(session_id, archive_override=resolved_path) 构建新 runtime；
   - 再调用 coordinator.replace_runtime(session_id, new_runtime)；
   - replace 成功后生成原有响应；
   - replace 因 busy 拒绝时，立即 shutdown 刚构建的新 runtime，不碰旧 runtime，并映射为 409；
   - replace/响应构造的其他失败，保证新 runtime 被清理；旧 runtime 不被破坏。
6. 删除 restore 对 `AgentService.instance()`/全局 restore helper 的调用和不再需要的导入。
7. 所有 archive 统计、读取、解析仍放在线程池；不得把同步 GA I/O 直接放回事件循环。

路由测试：

- 成功：factory 收到正确 `session_id` 和 archive path，coordinator 收到新 runtime，旧 runtime 被关闭，响应字段正确；
- archive 404；session 404；
- busy 409：factory 新 runtime 被清理，旧 runtime 保持，metadata 不变；
- factory 构建失败：旧 runtime 和 metadata 不变；
- 请求缺少/空 `session_id`：4xx 校验失败；
- 确认不再触发全局 `AgentService.instance()`。

### Step 4：Web UI 发送目标 session

在 `webui/src/api/client.ts`：

```ts
restoreConversation: (id: string, sessionId: string) =>
  http<ConversationRestoreResponse>(
    'POST', `/api/conversations/${encodeURIComponent(id)}/restore`,
    { session_id: sessionId },
  )
```

在 `webui/src/pages/Conversations.tsx`：

1. 从现有 `chatStore` 读取当前 `sessionId`，不得从 conversation id 猜测；
2. 没有活动 session 时不发请求，给用户明确提示“请先选择会话”；
3. restore 调用传入当前 sessionId；
4. 成功后的现有导航/刷新/`restoredFrom` 链路保留；
5. 更新 TypeScript 编译影响处和相关 UI 测试。

### Step 5：生成/更新 API schema 与测试

如果仓库的 OpenAPI/前端 generated schema 是生成物：

1. 先更新后端 schema 和路由；
2. 使用仓库现有生成命令更新 generated schema；
3. 不手工制造与生成器不一致的类型。

最低测试集合：

- coordinator 单测；
- factory 单测；
- conversations restore 路由单测/集成测试；
- 现有 conversations archive/search/zip 测试；
- sessions/coordinator/websocket/blocking route 测试；
- 前端 typecheck/lint 和 restore 交互测试（如已有测试框架）。

## 4. 事务与失败回滚矩阵

| 阶段 | 可能失败 | 允许的持久化变化 | 必须保持 |
|---|---|---|---|
| 查 archive | archive 不存在/解析失败 | 无 | session runtime、metadata、archive 文件不变 |
| 查 session | session 不存在 | 无 | 全部不变 |
| 构建 override runtime | GA 加载/锁/初始化失败 | 无 | 释放新 runtime；旧 runtime、metadata、archive 不变 |
| replace admission | session busy/shutdown | 无 | 释放新 runtime；旧 runtime 保持运行；返回 409/明确错误 |
| atomic swap | coordinator 内部拒绝 | 无 | 旧 runtime 保持；新 runtime 清理 |
| swap 后 shutdown 旧 runtime | 旧 runtime shutdown 异常 | swap 已完成 | 新 runtime 仍是 session 当前 runtime；记录异常并按既有 coordinator 语义处理，不回滚到已关闭/不确定的旧 runtime |
| 响应构造 | 序列化/读取失败 | 不新增 metadata 写入 | 当前 runtime 已是新 runtime；清理策略和错误必须明确，不能偷偷恢复全局 agent |

关键不可逆边界：**只有 coordinator 原子 swap 成功后，session 才指向新 runtime**；因此构建阶段必须在 swap 前完成，避免出现“先换空 runtime、后加载失败”。

## 5. 验收标准

### 功能验收

1. 同一 Hub session：restore archive A 成功后，下一条聊天请求/WS 提交命中新 runtime，并能读取 A 的历史。
2. session X restore 时，session Y 的 runtime、历史和 metadata 不受影响。
3. restore 不改变 X 的 `archive_path` 绑定；冷启动仍按原绑定 archive 恢复。
4. restore 期间 X 忙碌返回 409，不杀 run、不替换、不丢历史。
5. archive/session 不存在、请求体缺字段均有确定错误。
6. 全局 `AgentService.instance()` 不再出现在 restore 执行路径。

### 结构验收

- restore、普通聊天、rewind、delete 共用同一 coordinator 生命周期；
- 不新增第二个全局 session/runtime 注册表；
- factory 没有复制一套与普通启动不一致的锁、清理、线程启动逻辑；
- 不引入 archive 内容到 metadata sidecar；
- 旧的全局 AgentService 仅在仍有明确非 restore 调用方时保留，并记录调用点，不做无证据删除。

### 验证命令

在 `D:\study\GA-Hub` 使用仓库现有 Python/Node 环境执行：

```powershell
pytest -q tests/test_session_coordinator.py tests/test_conversations_search.py tests/test_conversations_zip.py
pytest -q tests/test_blocking_routes.py tests/test_session_websocket.py
pytest -q
# 前端按 package.json 的既有脚本执行 typecheck/lint/test/build（以实际脚本为准）
```

验收报告必须记录：命令、退出码、测试数量/失败信息、git diff --check、最终 `git status`，以及至少一个真实 restore→继续聊天链路验证；不能只以“测试通过”替代代码链路复核。

## 6. 暂停点、提交与回滚策略

当前暂停点是 Step 1 已有未提交改动，Step 2 尚未开始。每一步完成后：

1. 先跑该步骤最小测试，确认红/绿证据；
2. 再跑受影响回归；
3. 用 `git diff` 逐段审阅，确认没有碰 `docs/archive/audit-remaining-review-2026-09-15.md`；
4. 最后才进入下一步骤。

若任一步无法保持上述回滚矩阵，停止继续编码，先更新本计划并报告分歧；不得用兼容临时方案掩盖架构边界。

## 7. 设计结论

本次一次性修复的核心不是给 restore 增加一个参数，而是将“归档恢复后的工作历史”纳入已有 per-session runtime 生命周期：

> archive 是历史来源，Hub session 是运行归属，coordinator 是唯一 runtime 所有者。

所有实现必须服从这条所有权关系。
