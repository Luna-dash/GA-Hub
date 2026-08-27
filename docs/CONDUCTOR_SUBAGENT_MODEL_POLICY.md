# Conductor 子代理模型策略说明

> 落实日期：2026-08-17。本文记录 GA-Hub 对 Conductor 子代理模型选择的最小扩展方案，作为后续调整模型路由策略的维护入口。

## 1. 目标与边界

本次改动解决两个同时存在的需求：

1. 保留 GA 原版能力：Conductor 主 LLM 在每次派单时可以显式指定子代理模型。
2. 增加 GA-Hub 页面策略：可以设置默认子代理模型，并可锁定该模型，防止单次派单覆盖。

实现严格限制在 GA-Hub 的 Conductor 适配层，不修改 D:\study\GA\agentmain.py、llmcore.py 或 frontends\conductor_core.py。这样不会改变 LiveChat、Goal/Hive、TUI 或其他 GA 入口的模型语义，也不会增加后续同步 GA 上游代码的冲突面。

## 2. GA 原版派单机制

GA 原版已经具备完整的“派单时指定模型”链路：

| 位置 | 作用 |
| --- | --- |
| D:\study\GA\frontends\conductor.py:130 | _select_llm(agent, llm) 接受模型编号或名称，并调用 agent.next_llm(...)。 |
| D:\study\GA\frontends\conductor.py:175 | StartSubagentIn.llm 暴露单次派单模型字段。 |
| D:\study\GA\frontends\conductor.py:510 | POST /subagent 把 body.llm 传给子代理池。 |
| D:\study\GA\frontends\conductor_core.py:491 | SubagentPool.start_subagent(...) 创建代理后通过 PoolRuntime.llm_selector 应用模型。 |
| D:\study\GA\frontends\conductor.py:532、538 | rework/input 恢复入口继续传递 body.llm。 |
| D:\study\GA\frontends\conductor_core.py:623、643 | 恢复旧子代理时在重新派发前切换模型。 |

因此问题不在 AgentMain 缺少模型切换能力，而在 GA-Hub 原适配层只保存了一个页面子代理编号，无法区分“跟随主模型、默认但可覆盖、强制锁定”，且新建与恢复入口没有统一的策略边界。

## 3. 为什么不修改 AgentMain

- GenericAgent.next_llm(...) 和 load_llm_sessions() 已能完成模型应用，没有必要新增核心接口。
- 策略属于 Conductor 调度语义，不应污染所有 GenericAgent 使用场景。
- 修改 AgentMain 会同时影响 LiveChat、TUI、Goal/Hive 等路径，扩大回归范围。
- GA-Hub 已可通过 PoolRuntime.llm_selector 注入选择行为，适配层能够完整实现需求。
- 将策略集中在 ConductorService，后续修改优先级或增加策略时只需改一处。

## 4. 三种策略

| 策略 | 页面默认模型 | 单次 llm_index | 行为 |
| --- | --- | --- | --- |
| follow_main | 无 | 可选 | 有显式值时使用显式值，否则跟随 Conductor 主模型。 |
| default | 必须有 | 可覆盖 | 有显式值时使用显式值，否则使用页面默认子代理模型。 |
| locked | 必须有 | 被忽略 | 始终使用页面锁定的子代理模型。 |

完整优先级为：

~~~text
locked 页面配置
> Conductor 本次派单显式 llm_index
> 页面默认子代理模型
> Conductor 主模型
> 全局 preferred_llm_no
~~~

注意：follow_main 并不禁止 Conductor 显式指定模型；它只定义“本次派单未指定时”的回退行为。

## 5. 配置与派单数据流

~~~text
页面保存稳定 llm_key
    ↓ 按当前 LLM 列表解析
本次请求中的 index + policy
    ↓
ConductorService.configure_models()
    ↓ 生成一次不可变配置快照
ConductorService._resolve_subagent_model_from_snapshot()
    ↓ 得到本次实际 index
CoreSubagentPool.start_subagent() / input_subagent()
    ↓
PoolRuntime.llm_selector = _configure_subagent
    ↓
GenericAgent.next_llm(index)
~~~

一次派单只使用一份已接纳的配置快照。页面并发切换策略不会把已经进入派发流程的任务二次改路由，接口返回的 llm_index 和 model_policy 也与该次派单保持一致。

## 6. 生命周期与模型配置分离

ConductorService 将两个职责拆开：

- configure_models(...)：只更新模型路由状态，不启动或停止 supervisor。
- ensure_started()：只确保 supervisor 已启动，不重置模型配置。
- start(...)：保留为兼容 facade，顺序执行配置和启动。

用户发送聊天时先配置模型，再确保 Conductor 启动，然后投递 user_message。这样重复发送消息不会因旧 start(llm_index) 调用而把已有子代理默认模型重置为主模型。

主 Conductor 已经运行时，切换主模型通常只会影响下一次 supervisor agent 启动；新的子代理策略对切换后的后续新建或恢复派单立即生效。已经运行中的子代理不会被强制热切换。

## 7. API 字段

| 请求 | 字段 | 含义 |
| --- | --- | --- |
| ConductorChatIn | llm_index | 页面选择的 Conductor 主模型。 |
|  | subagent_llm_index | 页面明确选择的默认/锁定子代理模型；跟随主模型时为 null。 |
|  | subagent_model_policy | follow_main、default 或 locked。 |
| ConductorStartReq | 同上 | 显式启动时同步模型配置。 |
| ConductorStartSubagent | llm_index | Conductor 对本次派单的显式模型请求。 |
|  | conductor_llm_index | 可选的页面主模型配置。 |
|  | subagent_llm_index | 可选的页面默认/锁定模型配置。 |
|  | subagent_model_policy | 可选页面策略。 |
| ConductorSubagentAction | llm_index | input/reply 恢复旧子代理时的本次模型请求。 |
|  | conductor_llm_index / subagent_llm_index / subagent_model_policy | 恢复前可同步页面策略。 |

所有模型编号必须是非负整数。Schema 先做基本校验，服务层也保留校验；无效策略或缺少 locked/default 所需默认模型时，HTTP 路由返回 422。

## 8. 统一派发入口

GA-Hub 中会创建或恢复执行的入口全部经过 ConductorService：

- POST /api/conductor/subagent → ConductorService.start_subagent(...)
- POST /api/conductor/subagent/{sid} 的 input/reply/append/message/msg → ConductorService.input_subagent(...)
- 页面审批派单 → 同一个 POST /api/conductor/subagent
- Conductor 主 LLM 自主派单 → 同一个 POST /api/conductor/subagent

keyinfo 只补充上下文，不创建新执行；abort/stop 只终止执行，因此不参与模型解析。

## 9. 兼容规则

- 请求省略模型配置字段时，保留服务当前状态，不把默认子代理模型重置为空。
- 显式传 follow_main 时，清除之前保存的默认/锁定子代理模型。
- 旧调用只传 subagent_llm_index、不传策略，且服务此前仍为 follow_main 时，自动转为 default。
- 旧调用只传本次 llm_index 时，继续获得 GA 原版“本次派单显式指定模型”的行为。
- 前端用稳定 llm_key 持久化偏好，页面每次按当前列表重新解析 index，避免模型排序变化造成相邻模型漂移。

## 10. 本次落实文件

后端：

- server/services/conductor_service.py
- server/routes/conductor.py
- server/schemas.py

前端：

- webui/src/pages/Conductor.tsx
- webui/src/api/client.ts
- webui/src/hooks/useSharedModelSelection.ts

合同生成物：

- docs/api/openapi.json
- webui/src/api/generated/schema.d.ts

测试：

- tests/test_conductor_model_policy.py
- tests/test_conductor_route_lifecycle.py
- tests/test_conductor_admission.py
- webui/src/api/client.test.ts
- webui/src/hooks/useSharedModelSelection.test.tsx

## 11. 测试矩阵与验收结果

2026-08-17 当前验证结果：

- Conductor 针对性回归：24 passed，2 warnings。
- 后端合同、冒烟、生命周期、请求归因和扩展回归：61 passed，10 subtests passed，2 warnings。
- 后端全量：356 passed，1 skipped，10 subtests passed，10 warnings。
- 前端全量 Vitest：21 个测试文件、101 tests passed。
- TypeScript lint：通过。
- Vite production build：通过，697 modules transformed。
- 前端 HTTP 形状合同：120 个调用匹配 132 个 OpenAPI operations。
- TypeScript OpenAPI 类型重复生成前后 SHA-256 相同，生成物已同步。

npm run api:check 的合同匹配阶段通过，但命令最终仍返回 1。原因是脚本最后使用 git diff --exit-code 对比 HEAD；本批次有意更新 schema.d.ts 且尚未提交，因此被报告为 stale。这不是 OpenAPI 与生成类型不一致，提交生成物后该最终门禁才会归零。

## 12. 已知限制

1. 后端短期仍以 llm_index 作为 GA 核心调用参数。非页面调用者如果长期保存 index，模型列表重排后仍可能漂移。
2. 页面偏好已经使用 llm_key，但后端 Conductor API 尚未直接接受 llm_key。
3. server/services/llm_registry.py 当前要求 MyKey assignment 数量和运行时 llmclients 数量完全一致；不一致时会抛出 LlmRegistryError。该边界稳定前，不应直接把 Conductor 派发强耦合到现有 registry。
4. 模型编号在创建 GenericAgent 后才有最终可用性上下文；当前沿用 GA-Hub 原有行为，越界或加载失败由模型应用层记录并按核心现有行为处理。

## 13. 后续策略调整入口

策略优先级的主入口是：

- ConductorService._resolve_subagent_model_from_snapshot(...)
- ConductorService.resolve_subagent_model(...)

新增策略时应同步修改：

1. SubagentModelPolicy 和 SUBAGENT_MODEL_POLICIES。
2. server/schemas.py 中四个请求模型的 Literal。
3. webui/src/api/client.ts 的 ConductorSubagentModelPolicy。
4. Conductor 页面策略推导和说明文案。
5. OpenAPI 与生成 TypeScript 类型。
6. tests/test_conductor_model_policy.py 的优先级矩阵。

推荐的下一阶段迁移是为 API 增加 llm_key，并在 ConductorService 内“先按稳定 key 解析，再生成本次 index 快照”。迁移期间同时接受 key 和 index，key 优先；待 registry 能可靠处理 assignment/client 不一致后，再逐步把 Conductor 主模型、默认模型和单次派单全部切到稳定标识。
