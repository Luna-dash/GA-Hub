# GA-Hub / GA 引擎联合代码分析：续审

日期：2026-09-08。

审阅对象：`D:/study/GA-Hub` 当前工作区，以及用户指定的 `D:/study/GA/frontends/gahub`。基线提交分别为 Hub `85a0a7b`、GA `aba30f7`；Hub 含本次开始前已有的未提交修改，GA 工作区干净。本轮只新增分析文档和隔离复现脚本，未修改生产代码、运行真实模型或向现有引擎派发任务。工作区内 `.ga-staging/` 不作为指定 GA 引擎已完成修复的证据。

本报告更新了[上一轮报告](D:/study/GA-Hub/docs/GA_HUB_ENGINE_JOINT_REVIEW_20260908.md)对当前代码的判断。优先解决事件恢复、状态一致性和资源约束。共确认以下 8 组问题；表中 P1 表示可能阻断正常任务、丢失工作流状态或突破执行约束，P2 表示触发范围较窄、可随后处理。

## 已确认问题

| 编号 | 优先级 | 问题 | 可观察影响 | 主要归属 |
| --- | --- | --- | --- | --- |
| 1 | P1 | 回放失败后仍可能确认更大的游标；聊天提前去重 | 缺失事件及 final 无法恢复 | Hub |
| 2 | P1 | 快照乱序；最终快照丢失后 journal 不能修复镜像 | 已结束 worker 仍显示 running | 两仓库 |
| 3 | P1 | Hub 重启没有重建 workflow | 工作列表恢复，但完成事件和自动验收失效 | Hub，需引擎恢复契约 |
| 4 | P1 | 待验收提前释放占用；返工绕过统一准入 | 并发超限、交付路径冲突 | GA |
| 5 | P1 | 看门狗只在输出队列超时时运行 | 持续输出绕过总时限和里程碑 | GA |
| 6 | P1 | Hub 默认路径策略与指定引擎不一致 | 仓库外交付仍被 422 拒绝 | 两仓库 |
| 7 | P1 | worker action 幂等没有到达执行端 | 丢失响应后的同一返工被执行两次 | 两仓库及前端 |
| 8 | P2 | 清理计时记录会复活过期请求预算 | 长时间闲置的请求重新获得总时限 | GA |

### 1. 回放失败后仍确认后续事件，final 重试也可能被去重吞掉

证据：[回放返回值的分支](D:/study/GA-Hub/server/services/conductor_service.py:1408)、[处理后的游标更新](D:/study/GA-Hub/server/services/conductor_service.py:1472)、[聊天提前登记去重](D:/study/GA-Hub/server/services/conductor_service.py:1485)、[final 的工作流提交](D:/study/GA-Hub/server/services/conductor_service.py:1503)。

当前修改把游标更新移到了 handler 之后，并在 live 帧前读取 journal，方向正确，但有两条失败路径尚未闭合：

- `_replay_journal()` 返回 False 时没有退出 `_on_sse_event()`，会继续处理当前 live 帧。复现：游标为 3，journal 中事件 4 处理失败，live 事件 5 成功，最终游标变为 5。下次回放从 5 之后开始，事件 4 被永久越过。
- `_on_remote_chat()` 在消息发布和 `record_final()` 之前调用 `_remember_relayed()`。复现：final 首次发布失败，游标保持 3；再次回放同一事件时，由于消息 id 已登记，handler 提前返回，游标推进至 4，但 workflow 仍为 admitted，第二次发布次数为 0。

此外，部分 callback 自行捕获异常并返回 None，外层无法据此判断业务转换是否成功。仅在 `_on_sse_event()` 增加布尔返回值不足以覆盖这些情况。

建议：失败必须阻止连续确认点前移；明确区分“业务状态已应用”和“通知已发布”，让每个阶段能幂等重试。聊天去重应在必要的业务转换完成后提交。把 journal 消费收敛到一个有序入口，live SSE 负责触发追赶，失败时使用退避和可观察的恢复状态。

验收：注入事件 4 失败、事件 5 到达、final 发布失败后重试，最终状态必须与按 journal 顺序完整应用一致。不能只断言 cursor 为最大序号。

### 2. 快照既可能倒退，也可能在丢帧后长期停留在旧状态

证据：[GA 快照捕获和发布](D:/study/GA/frontends/gahub/gahub_app.py:277)、[队列满时丢帧](D:/study/GA/frontends/gahub/gahub_state.py:80)、[快照不写 journal](D:/study/GA/frontends/gahub/gahub_app.py:172)、[Hub 查询只返回本地镜像](D:/study/GA-Hub/server/services/conductor_service.py:1876)、[前端直接替换](D:/study/GA-Hub/webui/src/stores/conductorStore.ts:129)。

乱序复现：线程 A 先取得 running 内容，线程 B 随后发布 stopped，A 最后发布旧内容。真实发布函数得到的顺序为 `[stopped, running]`。`_snap_lock` 只锁去重 key，没有覆盖快照捕获和发布顺序；Hub 和前端也没有权威 revision 可用于拒绝旧内容。

丢帧复现：用 500 个 running 快照填满引擎订阅队列，再发布最终 stopped 快照，最终快照被丢弃。随后成功回放 `subagent_completed`，游标推进至 4，但 Hub 的 `pool` 仍为 running，计数仍为 `[1, 0]`。生命周期 callback 更新 workflow 和发布通知，不会根据该事件更新 pool 状态；`subagents` 快照本身不写 journal。

因此，即使修好第 1 项，仍不能保证 UI 状态恢复。刷新页面的列表接口也只是重新读取同一个旧镜像；需要引擎 SSE 重连后的 hello 或后续新快照才能修复。

建议：快照捕获、去重和发布有序化；在权威状态提交时产生 revision，并携带引擎实例身份，Hub 和前端拒绝旧版本。队列压力下按 worker 合并最新快照，或发出必须重新同步的信号。完成事件、检测到缺口和恢复连接时，增加真实 GA `/subagent` 全量对账，不能只向 Hub 自己重新取缓存。

验收：固定两线程发布顺序；丢掉最后一帧后停止所有输出，验证无需用户刷新或新任务，Hub 仍能收敛到引擎终态。

### 3. Hub 重启后恢复了卡片，却没有恢复任务身份

证据：[内存 workflow 初始化](D:/study/GA-Hub/server/services/conductor_service.py:638)、[首次连接直接基线到 journal 尾部](D:/study/GA-Hub/server/services/conductor_service.py:1330)、[hello 恢复范围](D:/study/GA-Hub/server/services/conductor_service.py:1420)、[未知 request 拒绝处理](D:/study/GA-Hub/server/services/conductor_workflow.py:169)。

当外置 GA 引擎仍在运行、Hub 单独重启时，新的 `WorkflowTracker` 是空的。hello 只恢复 worker 镜像和最近聊天，首次 journal 连接又跳过历史事件。

复现：新建 Hub service，注入包含一个现有 worker 和一条用户聊天的真实 hello 结构，镜像数量为 1、聊天数量为 1，但 workflow 数量为 0。随后该 worker 的完成事件因 `unknown conductor request_id` 被拒绝，handler 返回 False。携带该 request 的自动验收也会被 Hub 校验拦截。

建议：为 workflow 建立持久化检查点，保存 admission、worker 归属、generation、验收状态、final 和消费游标；或者由引擎提供足够完整的恢复快照，使 Hub 能重建这些字段。恢复顺序应先重建任务身份，再按游标追赶事件。当前“直接全量回放”也不足以修复，现有 handler 不会从用户聊天重建所有 admission。

验收：引擎保持运行，销毁并重建 Hub service，在恢复前后继续同一任务，确认原 request_id、验收动作、最终报告及工作流终态完整保留。覆盖超过 hello 最近 20 条聊天的活跃任务。

### 4. 资源准入在完成状态、新派单和返工之间不一致

证据：[完成同时标记 pending 和 COMPLETED](D:/study/GA/frontends/gahub/conductor_core.py:612)、[活动占用判定](D:/study/GA/frontends/gahub/conductor_core.py:692)、[新派单准入](D:/study/GA/frontends/gahub/gahub_app.py:1556)、[input/rework 入口](D:/study/GA/frontends/gahub/gahub_app.py:1617)。

- 通过真实 `pool.on_display(done=True)` 完成 worker，active 从 1 变为 0，但 review_status 仍为 pending。`worker_is_active()` 将 COMPLETED 当作已释放所有资源的终态，与其注释承诺的“验收前继续占用”不符。
- 设置上限为 1，已有一个运行中 worker 和一个失败 worker，二者声明相同输出路径。新派单正确拒绝为 `global_inflight_limit`，但经过真实 GA action 入口和 pool 恢复逻辑返工失败 worker 后，active 变为 2。复现只替换了实际向 Agent 投递消息的部分，没有运行模型。

引擎的恢复入口也没有与新派单等价的 supervisor 生命周期、路径占用和全局容量检查；input 未执行请求级预算检查。Hub 自己的前置检查无法保护 supervisor 直接调用 GA self-API 的路径。

建议：统一所有进入 running 的入口，原子完成生命周期、容量、请求预算和输出路径检查及占用登记。若业务希望执行结束立即释放计算并发，应把“计算槽”与“交付路径/待验收占用”分别定义，而不是让一个 terminal_event 隐式释放全部资源。返工已经持有的资源不能重复计数，失败要回滚预留。

验收：用真实完成转换进入 pending，再派发冲突任务；并发执行新派单、两个返工和 stop，保证容量、预算及路径所有权不被突破。

### 5. 持续输出使总时限和里程碑失效

证据：[输出监控循环](D:/study/GA/frontends/gahub/gahub_app.py:519)、[里程碑检查](D:/study/GA/frontends/gahub/gahub_app.py:562)、[总时限检查](D:/study/GA/frontends/gahub/gahub_app.py:580)。

上述检查均在 `except queue.Empty` 中。只要每次 `dq.get(timeout=5)` 都能取得帧，它们就不会运行。

复现：attempt 已经过 7200 秒、上限 3600 秒，队列预置 100 个 next 和 1 个 done。真实监控循环消费了全部 101 帧，里程碑调用数和终止调用数均为 0。

建议：使用独立的 monotonic 检查节拍，在有帧和无帧两条路径都判断期限；把文件/归档探测限制在合理周期，避免每个 token 都触发 I/O。保留 generation 检查，避免旧 monitor 终止返工后的新尝试。

验收：连续小帧、队列积压、长时间静默、generation 替换四类场景。现有[相关测试](D:/study/GA/tests/test_gahub_app.py:754)虽然声明验证持续输出，实际喂入的是空队列，未覆盖此问题。

### 6. 默认交付目录策略未与指定 GA 引擎同步

证据：[Hub 不再注入允许目录](D:/study/GA-Hub/server/services/conductor_client.py:84)、[启动脚本引用指定 GA 目录](D:/study/GA-Hub/scripts/start-gahub-engine.cmd:17)、[GA 的默认根目录](D:/study/GA/frontends/gahub/gahub_app.py:107)、[跨盘校验](D:/study/GA/frontends/gahub/gahub_app.py:920)。

Hub 当前注释认为 `GAHUB_DELIVERABLE_ROOTS` 未设置时可以接受任意绝对路径。实际指定的 GA 源码仍将未设置或空值解释为只允许 `D:/study/GA`。外置启动脚本引用的也是这份引擎，不是 Hub 内的暂存副本。

复现：清除该环境变量后，Hub 子进程环境不含 roots；GA 的 roots 为 `[D:/study/GA]`；`C:/Users/lunagent/GA-Deliverables/review-result.md` 校验失败。即使显式配置 D、C 两个根，C 盘目标也会因先比较 D 盘时抛出的 `commonpath ValueError` 而被拒绝。

建议：先明确并统一两端的空值语义，按同一协议版本一起交付；逐个根捕获跨盘异常，继续尝试后续根。默认交付位置、允许访问范围和用户指定的输出路径是不同配置，应分别表达。更改启动环境后还需考虑已经运行的外置引擎不会自动重新读取配置。

验收：真实 Hub 生成环境配合真实 GA schema，覆盖未设置、空值、显式多个根、根顺序互换、跨盘及链接边界。

### 7. worker action 的幂等保护没有覆盖引擎已执行但响应丢失的窗口

证据：[Hub action 预留及调用](D:/study/GA-Hub/server/services/conductor_service.py:1667)、[异常后释放预留](D:/study/GA-Hub/server/services/conductor_service.py:1697)、[client 未传 operation_id](D:/study/GA-Hub/server/services/conductor_client.py:448)、[引擎 action schema](D:/study/GA/frontends/gahub/gahub_models.py:41)、[页面每次调用重新生成 id](D:/study/GA-Hub/webui/src/api/client.ts:379)。

当前 Hub 在成功收到响应后才记录 action 结果。若 GA 已经执行返工，但 HTTP 响应丢失，Hub 会删除预留；相同 id 再次请求时重新调用 GA。GA action 既没有 operation_id 字段，也没有 chat/dispatch 已有的 `OperationCache.execute_once()` 保护。

链路复现：使用真实 Hub service/client、真实 GA FastAPI endpoint 和真实 pool 恢复/完成逻辑，仅用模拟消息投递代替 Agent。在第一轮 GA 返回 200 后模拟 ReadTimeout，完成该轮 worker，再使用相同 operation_id 重试。两次 GA 响应均为 200，两个请求体均无 operation_id，attempt 和 generation 从 1 增至 3。

另一个较低优先级问题：Hub action cache 只用 operation_id 作键，没有 worker、action 或参数指纹。对 worker A 的 rework 成功后，给 worker B 的 input 复用该 id，会返回 worker A 的成功结果，不实际操作 B。GA 的 chat/dispatch cache 已有 scope 和 fingerprint，可作为统一实现的参考。

建议：将 operation_id 贯穿页面、Hub 和 GA，幂等确认放到执行动作的 GA 端；校验 worker/action/参数指纹，冲突时明确返回 409。页面为一次逻辑操作保留 id，网络失败的重试沿用该 id；用户提交新内容时才创建新 id。同步明确跨引擎重启的幂等保留周期。

验收：引擎已提交但响应丢失、重复同时请求、完成后再重试、同 id 不同 worker/action，以及失败后修改参数重试。

### 8. 过期计时数据清理后，请求预算被重置

证据：[清理开始时间](D:/study/GA/frontends/gahub/gahub_state.py:309)、[touch 重新登记](D:/study/GA/frontends/gahub/gahub_state.py:320)、[准入先 touch 再检查超时](D:/study/GA/frontends/gahub/gahub_app.py:1404)。

`_prune_locked()` 删除超过 `2 * max_seconds` 的开始时间，但不会在删除时登记 exhausted；同一次 `touch()` 又把当前时间写为新起点。因此，只有此前已被拒绝并登记 exhausted 的请求才得到不可恢复的超限保护。

复现：max_seconds=10，在 t=1 首次检查通过；t=22 时 `wall_clock_exceeded()` 原本为 True，但进入真实 `_request_budget_rejection()` 后返回 None，elapsed 被重置为 0。按默认 4 小时预算，对应超过 8 小时未触发预算检查后再次派发或返工。

建议：未关闭请求保留绝对 deadline，或在回收时间记录前持久登记已超限；只在明确关闭请求后删除生命周期预算。时间窗口缓存不能决定请求是否重新获得执行资格。

验收：没有历史超限拒绝记录的请求，分别在 deadline 前、deadline 后和清理窗口后重试，后两者必须仍被拒绝。

## 已有改动的复核

| 上轮编号 | 原问题 | 当前判断 |
| --- | --- | --- |
| 1 | 跨盘路径校验 | 未闭合；Hub 默认环境又出现与指定 GA 版本不一致的问题，见本轮第 6 项 |
| 2 | async 路由内同步 HTTP | 已有修改覆盖 chat/log/status 和 start/stop/settings 的状态组装；本轮相关慢调用测试通过 |
| 3 | 准入规则不一致 | 指定 GA 源码仍存在，见本轮第 4 项 |
| 4 | 持续输出绕过看门狗 | 仍存在，见本轮第 5 项 |
| 5 | 提前推进 journal 游标 | 部分修复；失败回退和提前去重仍有缺口，见本轮第 1 项 |
| 6 | 旧快照覆盖新状态 | 仍存在，并确认最终快照丢帧无法由 journal 修复，见本轮第 2 项 |
| 7 | HTTP 错误丢失验收证据 | 当前 client/route 已保存结构化 detail，相关 HTTP 转发测试通过 |

不能继续把旧报告中“测试全部通过”的记录当作当前工作区的结果；本轮结果如下。

## 性能和维护优化

### 合并快照、缓存摘要，减少重复构造

GA 每个输出帧都会进入 `push_subagent_snapshot()`，先在 pool 锁内扫描所有 worker、提取摘要，再做完整 JSON 编码，最后才判断是否重复。静态 prompt 和 manifest 随每次变化一起发布。

本轮合成测量：每个 worker 的 prompt 为 4000 字符、reply 约 12,000 字符，摘要 1000 字符；预热后连续调用真实快照构造和去重函数 500 次，3 组样本。所有内容不变，实际广播被去重。

| pool 中 worker 数 | 500 次调用耗时 | 单个全池 JSON 大小 |
| --- | --- | --- |
| 1 | 10.58-11.84 ms | 5,490 bytes |
| 10 | 101.42-102.47 ms | 54,900 bytes |
| 50 | 495.45-497.12 ms | 274,540 bytes |

这些数据只量化重复快照计算，不含网络、SSE 二次编码或 UI 渲染；50 个 worker 用于观察规模趋势，超过默认活动上限，但 pool 还可能保留历史 worker。没有生产负载测量，不能据此断言它是当前最大性能瓶颈。

优先缓存每个 worker 的内容摘要与版本，把没有 UI 变化的帧过滤在全量构造之前；对普通进度使用约 100-250ms 的合并窗口。完成、失败、验收等状态变化及时发布。prompt、manifest 和完整校验证据可由详情接口提供。与本轮第 2 项一起设计 revision，避免节流改变终态可见性。

### Journal 按游标定位，并限制追赶工作量

[read_events](D:/study/GA/frontends/gahub/conductor_journal.py:163)仍然每页全量读取文件并从头解析。当前 live 事件前新增 journal 追赶，使生命周期繁忙时也会触发该成本；它不是每个模型 token 都读取，因为 RUNNING 事件在引擎 callback 中被过滤。

建议先流式读取以减少峰值内存，再依据日志规模增加稀疏 seq 到文件偏移索引、检查点和轮转。一次追赶设定目标游标或时间预算，避免一直追赶正在增长的日志而延迟处理 hello、快照及停止信号。不要直接通过关闭 fsync 换取速度。

### 建立跨仓库契约测试和能力声明

当前 `test_conductor_hub_engine_chain` 的 HTTP 引擎是返回表替身，能发现 Hub service/client 签名不匹配，但不能发现 GA schema 和业务默认值变化。

静态核对还发现：GA 已支持 `plan_milestones`，Hub 派单 schema/client 未透传；Hub detail 的 max_len 允许 1,000,000，GA 只允许 100,000；GA 支持 pause/reject，Hub 没有完整公开。这些能力差异需要先明确产品意图，其中未知字段被 Pydantic 默认忽略尤其容易产生“请求成功但设置未生效”。

建议增加 `protocol_version`、`capabilities`、`boot_id` 和实际生效的 roots；健康检查校验所连接的服务身份和能力。建立“真实 Hub route/client + 真实 GA ASGI endpoint/schema + fake Agent”的无模型测试层，覆盖本报告的复现。首次阶段保留同步 client 配合线程边界，减少同一请求内重复的 `/status` 查询；共享 HTTP 连接时明确线程所有权。

模块拆分可随后按事件恢复、workflow 投影、模型策略、准入和进程管理的职责推进，不建议先做纯粹按文件长度切分的重构。

## 本轮验证

运行环境：现有 `D:/APP/anaconda3/envs/ga/python.exe`，Python 3.12.13；未安装新依赖。

- Hub 定向测试：164 passed，3 failed。覆盖 journal replay、HTTP error、Hub/client 调用链、事件和路由生命周期、service surface/shutdown、响应契约和 blocking routes。
- GA 核心/state/journal/checks/milestones/request lifecycle：156 passed。
- GA 监控相关测试：5 passed，89 deselected，但 `test_worker_silent_wakes_supervisor` 有后台线程异常警告。
- 隔离脚本输出 13 个行为复现场景和 3 组快照规模测量。其中返工重试通过真实 Hub client 和 GA ASGI endpoint，未访问本机运行中的 HTTP 服务。

Hub 的 3 个失败：

1. `test_replay_journal_handles_engine_restart_with_fresh_epoch`：期望事件不含 jseq，当前实现给回放事件补入 jseq。
2. `test_replay_journal_paginates_when_backlog_exceeds_one_page`：同样是回放事件期望值未同步。两项属于测试替身断言与新内部接口不一致，不能单独作为实际丢事件的证明；第 1 项的隔离失败场景才证明运行缺陷。
3. `test_engine_spawn_env_injects_deliverable_roots`：当前不再设置 roots，旧测试读取该键失败。若目录产品策略已变，应更新契约测试；但指定 GA 引擎的默认策略确实尚未同步，见第 6 项。

后台线程警告：Hub 新增 HTTP 错误测试的 manager 替身缺少 `ensure_running`，启动的 SSE 线程异常退出；GA silent 测试的 pool 替身缺少 `evaluate_milestones`。两项测试仍显示 passed。建议修正替身、明确关闭后台线程，并在相关测试中将 `PytestUnhandledThreadExceptionWarning` 纳入失败条件。

初次执行因临时目录父目录不存在及 Windows 临时目录 ACL 导致额外环境错误；随后使用隔离 runner 将临时文件集中到 Hub `temp/joint_review_20260908/`，并仅在该范围保留目录继承权限，重跑后得到上述结果。GA 源码和测试文件均未修改。

前端 4 个 Conductor 测试文件未能执行：常规运行被 `spawn EPERM` 阻止；用户明确批准沙箱外重试后，自动审批仍因审批模型 `gpt-5.6-luna` 不可用返回 404 并拒绝启动。该结果是验证环境阻塞，不是前端测试失败。本轮没有将旧报告的 51 passed 冒充为当前验证。

2026-09-08 后续验证补充：执行权限更新后，上述前端测试已成功重跑。`Conductor.test.tsx`、`conductorStore.test.ts`、`RuntimeEffects.test.tsx`、`presentation.test.ts` 共 **4 个文件、51 passed**；失败路径测试的预期 stderr 未造成失败。前一段保留为当时的环境阻塞记录，当前已不再阻塞。各项优化的设计、实施依赖和验收标准见[可靠性优化方案](D:/study/GA-Hub/docs/architecture/conductor-reliability-plan.md)。

复现工具：[行为复现与快照测量](D:/study/GA-Hub/temp/joint_review_20260908/reproduce.py)、[隔离测试 runner](D:/study/GA-Hub/temp/joint_review_20260908/run_pytest.py)。这些工具位于被 git 忽略的 temp 目录。

## 建议实施顺序

1. 完成当前边界修复：路径策略两端对齐，修复回放失败分支和提前去重，更新与新契约不一致的测试。
2. 修复资源约束：统一派单/恢复/返工准入，让看门狗独立计时，修复过期请求预算复活。
3. 联合解决恢复：快照 revision、队列溢出后的权威对账、Hub workflow 持久化/重建，以及执行端 action 幂等。
4. 使用跨仓库无模型测试固化上述行为，再根据实际帧率、日志规模和延迟指标实施快照与 journal 优化。

未覆盖全仓库回归、真实 LLM 长跑、桌面 E2E，以及普通 LiveChat/微信等非 Conductor 功能的同等深度审计。
