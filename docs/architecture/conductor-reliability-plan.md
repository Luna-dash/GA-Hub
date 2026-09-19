# GA-Hub 与 GA Conductor 可靠性优化方案

> **状态标记（2026-09-18 复核）：🟡 主体已实施，§8.4 遗留未清零。**
> 未完成项：`workflows` 表终态行无保留策略；旧 boot 的 pending 命令被静默跳过（数量/年龄不可观测）；
> `engine_key` 取 `base_url`；提交被拒后遗留的 `submitting` 投影无清理；GA §7 场景表第 5、8 行的故障
> 测试与两仓联跑套件；前端 palette 收敛决策与页面级版本信封集成测试。
> 注：§8.4 同时列的「`TaskBoard` / `WorkerCard` 的 memo 因内联 `onSelect` 失效」**已修**，别重复改。
> 逐项措辞与排序见 `docs/plans/TODO_REMAINING.md` 并行轨 P.1。

状态：已实施；首轮代码评审完成，P1/P2 阻塞项已修复（见 §8.3 修订记录），遗留与长期运维验证项见 §8.4。日期：2026-09-09。

本方案已落地到 GA 引擎、GA-Hub 后端与 WebUI：GA 负责准入、资源池、watchdog、journal、交付路径策略和 operation receipt；Hub 负责 SQLite 持久化、恢复握手、命令意图与回执、workflow 生命周期；WebUI 通过数据 hook、任务看板、WorkerCard 与 context tabs 展示并调度这些状态。GA 是运行状态权威，Hub 是跨重启的持久化权威，前端只保存交互草稿并展示服务端快照。

已验证的性能措施包括 snapshot 摘要缓存、有界 milestone 队列、journal 批量追赶和 SQLite command 索引。前端真实 viewport 验证覆盖桌面、平板和手机尺寸，未发现横向溢出。

范围：`D:/study/GA-Hub` 与 `D:/study/GA/frontends/gahub` 的 Conductor 链路。依据[联合续审报告](../archive/GA_HUB_ENGINE_JOINT_REVIEW_20260908_FOLLOWUP.md)，基线为 Hub `85a0a7b` 加已有工作区修改、GA `aba30f7`。本文给出实施选择和验收边界，不代表生产代码已经修复。

## 1. 推荐决策

保留目前 Hub 与 GA 的进程结构，集中修复三个边界：

1. **GA 统一决定能否执行。** 派单、恢复、返工和停止共享准入规则；预算、路径占用、generation 和执行端幂等都由 GA 判断。
2. **Hub 持久保存任务身份和消费结果。** 用一个小型 SQLite 存储原子提交 workflow、journal 消费游标及待执行动作。GA 现有 JSONL journal 继续提供生命周期事件。
3. **实时通道允许丢失，但必须能恢复。** SSE 触发 journal 追赶，带版本的权威快照修复当前状态，前端使用既有 EventBus 重同步机制恢复展示。

先修复会丢任务、重复执行或突破约束的问题，再根据指标优化快照和日志读取。当前合成测量证明重复快照构造随 worker 数量增长，尚不足以证明需要更换整个通信栈。

### 方案比较

| 方案 | 收益 | 代价与边界 | 判断 |
| --- | --- | --- | --- |
| 逐处增加锁、条件和重试 | 修复直接缺陷较快 | Hub 重启仍丢任务，状态与游标没有共同提交点 | 适合第一批补丁 |
| 一个原子替换的 JSON 检查点 | 延续本仓库 JSON 存储习惯；单文件也能一起提交状态、游标和命令 | 每次重写聚合状态，后续并发、查询、命令保留及清理均需自行维护 | 任务量小且恢复需求固定时可用 |
| **Hub 专用 SQLite + GA 现有 journal** | 三类元数据可事务提交；支持唯一约束、局部更新和恢复查询 | 新增一处存储模式，需要 schema 迁移及故障测试 | **推荐目标方案** |
| 双端重建完整事件溯源或引入消息中间件 | 可支持更复杂的多节点需求 | 改动面和部署成本显著增加，仍不能原子提交外部模型和文件副作用 | 当前缺少采用依据 |

SQLite 使用标准库 `sqlite3`，不增加数据库服务；用途限于 Conductor 元数据。不要为过渡先做一套完整 JSON 持久化，再迁移同一套事务到 SQLite。

## 2. 所有权与必须保持的条件

| 内容 | 权威来源 | 其他层职责 |
| --- | --- | --- |
| 当前 worker 状态、generation、执行容量和路径占用 | GA pool 与统一准入器 | Hub 镜像，前端展示 |
| 请求预算与动作是否已经执行 | GA 执行边界 | Hub 可提前提示，但不能替代执行检查 |
| 已记录的生命周期事实 | GA journal | Hub 顺序消费，生成 workflow 投影 |
| Hub 接收的用户提交、原 request_id、命令意图 | Hub SQLite | GA 返回执行回执；恢复时保持原身份 |
| workflow、final、事件应用进度 | Hub SQLite 中已提交的投影 | WorkflowTracker 作为业务转换逻辑及已提交缓存 |
| 当前 worker 列表 | 当前 GA boot 的版本快照 | Hub/前端只接受有效会话中的较新版本 |
| 页面实时通知 | Hub EventBus | 通知失败后重新获取已提交状态 |

必须保持以下条件：

- 游标表示已成功提交的**连续事件前缀**，不能越过失败、缺失或未知关键事件。
- workflow 转换、该事件的游标更新和由它产生的自动验收意图在同一事务中提交。
- 业务提交之后才更新内存缓存及发布通知；通知失败不撤销已提交状态。
- 所有进入 running 的入口都原子检查并预留容量、预算和交付路径。
- 旧 generation 的完成、监控或验收动作不能影响新 generation。
- 缓存淘汰、断线、重启和清理计时数据都不能自行创造新的执行资格。

## 3. 协议身份与版本

在 GA 状态/hello 契约中增加能力及实际配置声明，Hub 连接时校验。下表中的新增字段是建议契约，当前代码尚未全部具备。

| 身份或字段 | 作用 | 边界 |
| --- | --- | --- |
| `protocol_version`、`capabilities` | 判断是否支持动作保护、版本快照、路径策略和恢复信息 | 明确能力名和字段语义，不依赖版本字符串猜行为 |
| `engine_key` | Hub 配置中的稳定引擎关联键 | 保存已确认的实例关联；不能仅凭端口相同复用旧状态 |
| `journal_epoch` + `applied_seq` | 定位持久事件消费进度 | 普通 GA 重启不必改变 journal epoch |
| `boot_id` | 标识当前 GA 进程 | 现有 JournalWriter 已提供；换 boot 必须重新握手 |
| `boot_id` + `snapshot_revision` | 拒绝旧的全池快照 | revision 单调递增；内容在锁内一致捕获 |
| `worker_id` + `generation` | 标识一次执行 | 用于完成事件、看门狗和返工前置条件 |
| `command_revision` | 标识 worker 已接受的修改命令序号 | token 输出不递增；保护不改变 generation 的 keyinfo 等动作 |
| `operation_id` + 规范化参数指纹 | 标识一次逻辑提交 | 相同 id 改 worker、动作或参数必须冲突 |

Hub EventBus 已有的 `(epoch, event_id)` 继续只用于 Hub 到浏览器的通知恢复。上述几类版本不相互换算，**快照不能用来推进 journal 游标**；分别读取的快照和 journal 尾部并不构成原子检查点。

Hub 仅通过受控握手切换当前 boot，并给连接及异步请求附加本地会话标识。重连后，旧连接帧和旧 HTTP 响应即使迟到，也不能把当前 boot 或快照切回去。

## 4. 八项问题的具体方案

### 4.1 事件确认与 final 去重

修改入口：[Hub journal 消费](D:/study/GA-Hub/server/services/conductor_service.py:1313)、[live 事件入口](D:/study/GA-Hub/server/services/conductor_service.py:1400)、[final 处理](D:/study/GA-Hub/server/services/conductor_service.py:1476)。

第一批修复回放失败后继续处理 live 帧的分支，把必要业务转换移到聊天去重提交之前，并让业务失败能传播到消费入口。不能把所有返回 None 的 callback 都当作成功；要分离业务转换和通知异常。

目标实现使用一个有序消费者：

1. SSE 的 journal 事件只唤醒追赶；多个唤醒合并。快照、日志分别处理，避免 journal 追赶阻塞它们。
2. 每次读取确定一个目标尾序号 H，分页处理到 H；每批设工作量或时间上限，再处理后续唤醒。
3. 按 seq 连续应用。一个事务写入业务状态、消费游标及派生命令；失败整体回滚，在同一位置退避重试。
4. 提交后更新缓存，发布页面通知。发布失败标记需要重同步，由监督循环重发或触发 EventBus 重连恢复。
5. 定期检查 journal 尾部，即使最后一条 SSE 丢失且没有后续输出，也能继续追赶。

明确登记 `engine_started` 等已知无业务变更的 journal 类型，允许它们作为已处理记录推进连续游标。未知关键类型、缺失序号、损坏记录或 journal disabled 进入可观察的恢复异常状态，不能用跳到尾部的方式掩盖。可选事件能否忽略由协议声明决定。

GA 的 [append](D:/study/GA/frontends/gahub/conductor_journal.py:133) 写失败会返回 None 并禁用日志。目标状态下必须暴露该故障、暂停依赖日志恢复的新准入及自动动作；停止和只读查询仍可用。已经发生但未持久记录的执行结果标记待对账，不能承诺可自动完整恢复。

### 4.2 快照乱序与最终状态丢失

修改入口：[快照发布](D:/study/GA/frontends/gahub/gahub_app.py:277)、[订阅队列](D:/study/GA/frontends/gahub/gahub_state.py:80)、[前端快照替换](D:/study/GA-Hub/webui/src/stores/conductorStore.ts:129)。

第一批先把捕获、去重和发布顺序串行化，并确保 worker 状态、request 归属与 generation 在同一状态边界读取。目标实现收敛为一个快照生产者：在一致捕获时分配 revision，普通进度合并约 100-250ms，终态直接唤醒发布。

完整列表快照继续作为第一版协议。拥塞时合并待发送快照；控制路径必须能发出 `resync_required` 或关闭订阅触发重连，不能把恢复信号放进已经满的普通队列后再次丢弃。

Hub 在重连、溢出、完成/失败/验收事件后请求真实 GA `/subagent` 对账，并增加低频尾部对账。接口和 SSE 都携带同一版本信封，前端列表查询响应也检查版本，避免旧 HTTP 响应覆盖新 SSE。

可复用 [Hub EventBus 的溢出重同步设计](D:/study/GA-Hub/server/services/event_bus.py:344)及[前端重同步处理](D:/study/GA-Hub/webui/src/runtime/RuntimeEffects.tsx:90)。GA 实现对应契约，不引入对 Hub Python 模块的反向依赖。

### 4.3 Hub 重启恢复 workflow

修改入口：[WorkflowTracker](D:/study/GA-Hub/server/services/conductor_workflow.py:101)、[首次连接基线](D:/study/GA-Hub/server/services/conductor_service.py:1330)、[Hub admission](D:/study/GA-Hub/server/services/conductor_service.py:1927)。

新增专用 store，建议位置为 `_paths.ADMIN_DATA / "conductor" / "state.sqlite3"`，沿用[用户数据目录](D:/study/GA-Hub/server/_paths.py:57)。不把运行数据库放进代码仓库。

| 表 | 最小内容 | 关键约束 |
| --- | --- | --- |
| `workflows` | engine_key、request_id、原始提交、admission 状态、worker 归属/generation、final、失败上下文、状态 JSON | `(engine_key, request_id)` 唯一；区分 submitting、已确认受理和 unknown |
| `consumer_state` | engine_key、journal_epoch、applied_seq | 只有连续应用事件的事务能前移 |
| `commands` | engine_key、operation_id、指纹、原 request_id、完整动作参数、预期 boot/generation/命令版本、执行状态和结果 | `(engine_key, operation_id)` 唯一；未知结果不能直接删除后重建 |

初期把每个 workflow 的 worker 归属放入状态 JSON，加载后重建索引即可；无需立刻按字段拆成大量关联表。使用 SQLite schema version、短事务和单写入所有权；可使用 WAL 与 `synchronous=FULL`，配置有界 busy timeout。数据库错误时暂停写命令，不能悄悄回退成仅内存成功。WAL 数据库放本机数据目录，备份使用 SQLite backup API。

`WorkflowTracker` 保留可复用的状态转换逻辑，先对副本计算，再提交数据库，再替换已提交缓存。HTTP 结果和事件消费者必须经过同一个 store 写入口，避免两份 workflow 状态互相覆盖。

Hub 向 GA 发 HTTP **之前**，保存 `operation_id -> request_id` 和原始请求。传输失败进入 unknown/待对账，不能立即认定任务失败，也不能在重试时重新生成 request_id。恢复时不会把仅已提交到 Hub 的意图误认为 GA 已受理。

自动验收意图与完成事件一起入库，以 `(engine_key, worker_id, generation)` 生成稳定动作身份。独立执行器在事务外发送命令；启动追赶结束且取得新鲜快照后才启用，执行前还要验证 generation、review 状态及当前证据。HTTP 回执同样通过 store 幂等提交。

恢复顺序：

1. 加载数据库和未完成意图，握手验证 GA 身份及能力。
2. 同一 journal epoch 从已提交游标继续追赶，重建 request 和 worker 关联。
3. 获取当前 boot 的权威快照，对账进行中的任务；有新 journal 事件时继续追赶。
4. 发布恢复后的展示状态，启用通过前置条件校验的待执行动作。

首次升级没有数据库时，从完整可用 journal 及引擎恢复信息导入。现有用户 chat 是在 notify 前保存的，可能随后 admission 失败，不能据此断言已成功派发。GA 需提供明确的受理/执行记录及 request-worker 绑定；历史证据不足的任务标记为 recovered/incomplete，保留证据并禁止自动补派。

GA 换 boot 时，旧 LLM 线程不会由 journal 自动恢复。未完成执行对账为 interrupted/unknown，保留已完成结果；不得把持久化的 running 直接当作新进程的运行事实。journal 换 epoch 或被截断也要走显式恢复，不能只重置游标后继续自动动作。

### 4.4 统一准入与占用释放

修改入口：[worker_is_active](D:/study/GA/frontends/gahub/conductor_core.py:692)、[派单入口](D:/study/GA/frontends/gahub/gahub_app.py:1538)、[worker 动作](D:/study/GA/frontends/gahub/gahub_app.py:1605)、[服务停止](D:/study/GA/frontends/gahub/gahub_app.py:413)。

新增一个 GA 内部准入器，复用 pool 及每个 worker 的锁。派单、input、rework 以及 supervisor self-API 都调用同一入口。生命周期、全局/请求容量、请求预算、worker 可恢复状态和交付路径在同一预留中检查。

第一阶段遵循现有代码说明：待验收继续占用 inflight 和交付路径。将 COMPLETED、review pending、执行线程已退出三件事区分；同一 worker 从 pending 返工时复用其占用，不重复计数。以后若确需释放待验收的计算槽，再显式拆分 execution_slots 与 delivery_leases，并单独修改产品规则和测试。

实现采用“预留、准备、提交”三步：

1. 在短临界区验证并预留资源，记录 lifecycle token 及预期 worker 版本；未入队的预留也计入容量。
2. 在锁外完成 agent 初始化、文件指纹或其他慢操作。
3. 回到临界区校验 token 和 worker 版本，提交状态并入队，或回滚预留。停止先关闭准入并使旧 token 失效，再处理 worker。

锁顺序固定为 admission gate -> pool lock -> worker dispatch lock；callback、网络请求和 join 在锁外执行。现有初始化和回调路径需要跟随该规则整理，不能只给整个 endpoint 再套一把长期持有的锁。

使用[已有投递回执](D:/study/GA/frontends/gahub/conductor_core.py:1023)区分失败点：`enqueued=False` 回滚预留及未消费预算；已入队后 monitor 启动失败仍计入 attempt，并进入取消/故障处理。对不确定的入队结果保留占用，不能当作未执行返还。

取消请求不等于旧任务已经停止写文件。路径租约须等该 generation 的执行退出/取消确认后释放；长寿命 runner 线程是否存在不是这一判据。保留这一约束才能防止新任务和旧工具调用同时写同一交付物。

### 4.5 看门狗不再依赖输出空闲

修改入口：[monitor](D:/study/GA/frontends/gahub/gahub_app.py:519)。

第一批把期限检查移到每轮循环的公共路径，用 monotonic 节拍控制频率；输出到达与 queue.Empty 都经过检查，不按 token 频率扫描文件。

目标方案使用引擎级轻量 watchdog，独立扫描当前 generation 的 attempt/request deadline。里程碑、归档和文件探测通过有界任务队列运行；慢探测不得阻塞硬期限判断。探测结果也携带 generation，过期结果丢弃。

建议初始检查周期 1s，并监测实际调度延迟。同一 boot 使用 monotonic；持久化只保存可解释的 epoch deadline/剩余预算及原始预算语义，不能把旧进程的 monotonic 起点直接用于新进程。

deadline 保证的是及时发起停止及关闭后续准入。实际工具停止时间取决于现有取消能力，应分别观测“发现超时”和“执行退出”；Python watchdog 不能保证强制中止任意阻塞调用。

### 4.6 路径策略两端一致

修改入口：[Hub 环境生成](D:/study/GA-Hub/server/services/conductor_client.py:84)、[GA roots 默认值](D:/study/GA/frontends/gahub/gahub_app.py:107)、[GA 校验](D:/study/GA/frontends/gahub/gahub_app.py:920)、[现有交付检查辅助函数](D:/study/GA/frontends/gahub/conductor_delivery.py:170)。

明确分离三项配置：默认输出位置、允许访问策略、任务声明的实际输出路径。建议契约为 `path_policy.mode = allowed_roots | explicit_absolute`，并返回 `default_output_dir` 和实际 `allowed_roots`。

本地使用场景中，按 Hub 当前改动表达的意图，显式配置 explicit_absolute，默认输出仍为 `<GA_ROOT>/temp`；受限部署配置 allowed_roots。旧引擎未设置 roots 时的原有根目录语义保留，通过能力声明区分，不能把空字符串同时解释成受限和任意路径。

短期先修跨盘：逐个 root 捕获 commonpath 的 ValueError 后继续匹配。复用并收敛现有交付路径检查，统一绝对路径、realpath、Windows 大小写/盘符、链接和父目录规则；dispatch、里程碑和质量检查都使用同一个显式 policy 对象。

握手返回实际生效策略。外置引擎仍在运行时，Hub 改环境变量不会影响它，应明确显示配置不一致和需重启，避免请求成功连接到错误配置的进程。路径策略约束声明交付及校验范围，本身不等于对任意 Agent 工具的文件系统隔离。

### 4.7 动作幂等落到 GA 执行端

修改入口：[Hub action](D:/study/GA-Hub/server/services/conductor_service.py:1667)、[HTTP client](D:/study/GA-Hub/server/services/conductor_client.py:448)、[GA action schema](D:/study/GA/frontends/gahub/gahub_models.py:41)、[OperationCache](D:/study/GA/frontends/gahub/gahub_state.py:132)、[前端 action](D:/study/GA-Hub/webui/src/api/client.ts:379)。

worker 写动作透传 `operation_id`、`expected_boot_id`、`expected_generation` 和 `expected_command_revision`。同一个 worker_action scope 以 operation_id 为键；指纹包含 worker、规范化 action、request_id、预期版本和规范化参数。worker 不能只放进 cache key，否则同 id 换 worker 无法报冲突。

GA 复用 execute_once 的并发合并机制：先尝试重放已记录结果，缓存未命中才检查当前状态前置条件。否则“已成功且 generation 已改变”的传输重试会被错误拒绝。预期版本校验与副作用提交必须在同一 worker 动作临界区完成。

每次实际接受修改命令都推进 command_revision；它与输出快照版本分开。返工/input 同时推进 generation；[keyinfo](D:/study/GA/frontends/gahub/conductor_core.py:1390)只修改当前尝试，需要 command_revision 防止缓存淘汰后再次注入。明确未产生副作用的失败可以回滚；已提交或结果不明的失败不能重置版本保护。

现有 cache 只有 512 条、600s TTL 且不跨进程。缓存淘汰后，版本校验能拒绝重复执行，**不保证还能返回第一次的完整结果**。此时返回结构化 conflict/unknown，Hub 查询权威状态及 journal 对账，不能猜成成功，也不能自动换 operation_id 重试。

初始 chat/dispatch 尚无旧 worker generation 可比较。GA 应为活跃 request 保留 operation 与 admission/worker 的绑定，独立于短期响应缓存；Hub 的待处理初始提交只按此回执及明确受理事实恢复。没有回执的模糊结果进入 unknown，禁止无限自动补派。

前端一次逻辑动作保留同一个 id，传输重试沿用；收到明确业务拒绝后，用户重新提交或改变内容才生成新 id。Hub 将原始 payload 和结果持久化，页面恢复可读取未完成操作。自动验收也走同一执行端契约，防止旧完成事件验收了新尝试。

新 boot 不自动重放旧的模糊命令。若以后要求跨 boot 重放历史回执，可向现有 journal 增加 operation intent/result 记录及索引，并保留“已产生副作用但结果未记录”的 unknown 状态。当前目标是阻止已受理命令重复改变执行状态，不承诺外部工具和模型副作用具有全局 exactly-once 语义。

### 4.8 请求预算不能被缓存清理重置

修改入口：[RequestBudget](D:/study/GA/frontends/gahub/gahub_state.py:279)、[准入预算检查](D:/study/GA/frontends/gahub/gahub_app.py:1404)。

以请求生命周期保存首次起点、deadline、attempts 和 exhausted 状态。touch 只为确认为新 admission 的 request 初始化；未关闭请求不能因为超过清理窗口而失去旧起点。input 与 rework 一并经过请求预算检查。

热缓存回收不决定资格；超限标记和已关闭 request 的不可复用身份须保留或从权威记录查询。当前 attempts/exhausted 也有 4096 条上限，设计时须一并避免通过淘汰活跃记录重获资格：先回收已关闭历史，达到活动上限时明确拒绝新 admission。

只有明确关闭生命周期才归档其预算；旧 request_id 的再次提交不能当作全新请求。当前方案将 GA 换 boot 后的未完成尝试标记 interrupted，不隐式创建同 id 的新预算。以后支持同请求跨 GA 重启继续执行时，需要增加引擎侧预算恢复契约。

## 5. 实施拆分与依赖

下表按评审和验收边界拆分，不作未经测量的工期承诺。可以将 GA 与 Hub 变更做成配套 PR，均以指定 GA 仓库为验证对象。

| 批次 | 范围 | 依赖与发布条件 |
| --- | --- | --- |
| A1 | 回放失败立即停止、final 业务/通知分离、同步旧测试断言 | Hub 独立修复；保留游标失败复现为回归 |
| A2 | 跨盘匹配修复、实际配置/能力声明、明确路径模式 | GA 先兼容新增字段，Hub 随后协商使用；外置引擎验证生效配置 |
| B1 | 统一 dispatch/input/rework/stop 准入，修复 pending 占用和预算回收 | GA 原子预留及停止竞态测试通过 |
| B2 | 输出无关的期限节拍，再抽取轻量 watchdog | 初始公共循环检查可先发布；独立 watchdog 覆盖慢 I/O |
| C1 | GA action 幂等、boot/generation/command_revision 保护；Hub/前端透传稳定 id | 依赖能力协商及 B1 提交边界；补真实 ASGI 丢响应测试 |
| C2 | 快照序列、溢出 resync 和权威对账 | 两端及 store/查询都识别版本；可与 C1 独立开发 |
| D1 | Hub SQLite store、admission/command 持久化、WorkflowTracker 提交边界 | 存储故障/重启测试通过；先具备迁移和读取能力 |
| D2 | 单 journal 消费者、事务内派生命令、完整启动恢复 | 依赖 C1、C2、D1 及明确的 GA 受理恢复信息；此后启用持久自动动作恢复 |
| E | 快照摘要缓存、journal 流式读取/按需索引、契约类型收敛 | 可靠性验收完成后，按基线测量逐项投入 |

初期继续使用已有同步 HTTP client 及线程边界，优先去除同一业务操作中重复的 `/status` 请求。共享连接池时先明确线程所有权；全面 async 改写会扩大当前修复面，不是这批问题的前置条件。

## 6. 跨仓库发布与迁移

1. GA 先添加能力声明、响应字段及可兼容的请求字段，并将 supervisor 自身调用接入统一执行规则。
2. Hub/client/前端再消费新协议，握手后按能力启用。恢复自动动作要求所需能力完整；不能因为旧 schema 静默忽略字段就认为已有保护。
3. 切换持久消费前暂停新的 Hub 写命令和自动动作；GA 可以继续生成 journal。把当时可证明的 Hub 状态与其消费进度一起导入，然后继续追赶。迁移所用检查点必须经过一致性验证。
4. 新 Hub 连接旧 GA 时保持显式兼容状态：允许可证明兼容的读取/旧操作，但不提供缺少前置保护的自动重试或恢复承诺。目录模式不支持时说明实际策略与不匹配字段。
5. 数据库使用版本化迁移和迁移前备份。恢复功能切换后如需退版，应先停止写入和自动命令；旧 Hub 不认识新数据库，不能带着未完成动作直接切回旧内存实现。

现有请求和响应能力差异，如 plan_milestones、detail max_len、pause/reject，集中加入契约矩阵。对已启用能力定义明确 schema；未知字段处理要按版本控制，避免全局开启严格校验后直接破坏旧调用方。

延续[现有 OpenAPI 契约流程](D:/study/GA-Hub/docs/architecture/api-contract-generation.md)，新增 payload/能力检查。测试使用真实 Hub route/client 与真实 GA ASGI app/schema，仅替换 Agent 和外部模型调用；返回表式 HTTP 替身不足以证明两仓库兼容。

## 7. 验收与可观测指标

### 必须通过的故障场景

| 对应问题 | 验收场景 | 通过条件 |
| --- | --- | --- |
| 1 | 事件 4 失败、5 到达；final 通知失败；提交前后终止 Hub | 游标不跨失败事件；恢复后的 workflow/final 与完整有序应用一致；不重复自动动作 |
| 2 | 强制 `[stopped, running]` 交错；丢最后快照后停止输出；旧 HTTP 响应迟到 | 状态不倒退；无需页面刷新或新任务即可与 GA 终态收敛 |
| 3 | GA 运行时重建 Hub；任务早于 hello 最近 20 条；重启发生在 HTTP 已执行未回执处 | request_id、归属、review、final 保留；unknown 不被重新派发；新 boot 旧执行不伪装 running |
| 4 | 并发派单/返工/stop；相同交付路径；初始化失败与入队后失败 | 容量和路径租约无重叠；关闭准入后无新提交；预算按入队事实消费 |
| 5 | 连续小帧、积压队列、静默、慢文件探测、generation 切换 | 各场景都触发期限检查；旧 monitor/probe 不修改新尝试 |
| 6 | roots 未设置/空值、多根换序、D/C 盘、大小写、链接、旧引擎、外置进程未重启 | 两端实际策略一致；跨盘继续匹配；不支持模式不被静默忽略 |
| 7 | 丢响应、并发重复、完成后重试、cache TTL/LRU 淘汰、同 id 改参数/worker、旧 boot | 原逻辑命令最多提交一次；缓存失效后旧版本被拒绝；keyinfo 也不重复注入；未知结果明确可查 |
| 8 | deadline 前后、超过清理窗口、超过记录上限、关闭后复用 id | 超限和关闭请求不会重新获得预算；无效重试不消耗新 attempt |

场景归属：第 5、8 行的实现主体（watchdog 节拍、请求预算、缓存淘汰）在 GA 仓库，其故障测试由 GA 侧验收；第 1/2/3/7 行的恢复与幂等组合以 Hub 的真实 ASGI 契约测试为最小闭环，完整两仓库联跑回归由 GA 仓库集成套件承担。两侧结论都通过才算 §7 验收完成。

增加 journal 损坏/disabled、DB 提交失败、自动验收提交前后崩溃及取消未确认的路径冲突测试。先复用[隔离复现脚本](D:/study/GA-Hub/temp/joint_review_20260908/reproduce.py)中已证实的场景，逐批迁入正式测试。

### 测量与初始目标

以下数值是建议验收起点，需要用相同机器和固定负载校准，不是现有系统测量结果：

- 记录 journal_lag、连续失败的 seq/类型、replay 批次耗时、journal 存储状态和消费者恢复阶段。
- 记录 snapshot revision、最后成功对账时间、溢出次数及快照捕获/编码耗时。健康本地引擎可先采用 5s 尾部对账周期；最后快照丢失后的恢复不超过一个周期加 HTTP/应用时间。
- watchdog 可先采用 1s 周期；受控测试中 deadline 后不超过两个检查周期发起终止。单独统计取消确认耗时，不能用发送 abort 的时间冒充停止完成。
- 记录 admission 拒绝原因、预留数、实际运行数、路径占用及未确认取消数。容量和路径互斥作为正确性断言，不能只看平均值。
- 记录 command pending/unknown 数量及年龄、幂等命中/冲突、数据库写失败。自动动作失败要落到可查询状态。
- 快照在没有可见变更时应跳过全量构造；普通进度每秒约 4-10 次上限，终态不受普通节流拖延。与原先 1/10/50 worker、500 次调用基线比较 CPU、字节量及状态延迟。

journal 先改为有界内存的流式读取；流式读取仍需从文件头扫描，不能宣称已消除历史大小相关的开销。只有记录规模和 lag 证明需要时，再加按 seq 的稀疏偏移索引及明确保留策略；索引可从 journal 重建。日志轮转必须与检查点和可恢复历史匹配，不能删除尚需消费的部分。保持既有 fsync 语义。

## 8. 实施与评审状态（2026-09-09 修订）

### 8.1 已落地的实施

方案已实施为 Hub 工作区改动（基线 `85a0a7b`）与 GA 仓库配套改动（基线 `aba30f7`）：SQLite store、命令意图层、恢复握手、单一有序 journal 消费者、快照版本信封、路径策略声明与握手校验、前端数据 hook 与任务看板。store 模式下 Hub SQLite 是聊天历史与 workflow 投影的权威。**旧内存路径已于 2026-09-14 删除（见 §8.5）**——ConductorService 在生产中恒启用 store（唯一构造路径 `instance()` 传入 `ADMIN_DATA/conductor/state.sqlite3`），原先"store 未启用则保留旧内存路径"的分支是死代码。

### 8.2 验证结果

- Hub 全量 pytest：**802 passed / 0 failed / 2 skipped**（2026-09-09，含 §8.3 修复）；本轮新增故障注入测试覆盖 §7 场景 1/2/3/7 的 Hub 侧：回放提交失败整体回滚且游标不动、丢响应跨重启同 request_id 恢复、旧 boot 不自动验收、journal gap/epoch/未知类型/截断四类拒绝、真实 GA ASGI 契约测试覆盖"HTTP 已执行未回执"。
- 前端：vitest **58 文件 352 passed**，`tsc -b` 通过。
- 2026-09-14 旧内存轨删除后复跑：Hub 全量 pytest **793 passed / 1 skipped**（见 §8.5）。上条 802/2 是 2026-09-09 的历史快照，不再代表当前基线。

### 8.3 首轮代码评审修订记录（已完成）

| 级别 | 问题 | 处置 |
| --- | --- | --- |
| P1 | chat 提交的确定性校验失败（如非法 model_policy）后命令滞留 pending，稍后会被 drain 延迟投递 | `configure_models` 的 ValueError 纳入拒绝路径，命令落 rejected；drain 不再投递；补回归测试 |
| P1 | GET /api/conductor/chat 仍代理引擎内存，引擎重启后页面历史空窗 | store 模式改为返回 SQLite 权威副本；补路由级回归测试 |
| P2 | GAHUB_PATH_POLICY 未注册环境变量清单（test_env_registry 唯一失败） | server/constants.py 注册，client/recovery 改用常量 |
| P2 | v1 迁移备份连接未关闭 | 显式 close |

评审确认：核心设计（游标连续性、三写同事务、先持久化后发送、回执驱动重试、版本信封双侧校验、故障显式暂停）无 P0；指纹语义以完整 payload 规范化 JSON 实现（含预期版本），强于 §4.7 最低要求，满足"同 id 改参数必须冲突"。

### 8.4 遗留事项（不阻塞，按 §5 批次排入）

- **D 范围**：workflows 表终态行只在内存投影修剪，DB 行无保留策略会无界增长；旧 boot 的 pending 命令被静默跳过，unknown 数量/年龄应可观测（§7 指标）；engine_key 目前取 base_url，与 §3"不能仅凭端口复用状态"存在差距，应引入显式配置键；提交被拒绝后遗留的 submitting 投影无清理。
- **GA 仓库范围**：§7 场景表第 5、8 行的故障测试与联跑套件归属见 §7 场景归属说明，需在 GA 仓库安排对应测试与运行频率。
- **前端范围**：conductor.css 局部 palette 与全局单主题架构冲突，需决策收敛为命名 token 或回退 :root；TaskBoard/WorkerCard 的 memo 因内联 onSelect 失效；页面级版本信封缺集成测试（现只有 store 单测）；首启示例任务 chips 与桌面栏折叠两处功能删减需产品确认。
- 真实模型长跑、桌面端端到端测试及全仓库回归仍应在生产实现验证后安排；普通 LiveChat、微信及其他运行域不随本方案迁移。

### 8.5 旧内存轨删除（2026-09-14，工作区改动，未提交 commit）

Conductor 原先并存两条轨道——「命令轨」（指令先写 SQLite，再发引擎，带凭据、可重试）与「内存轨」（直调引擎、靠内存记状态）——职责重复且行为不一致。本次删除旧轨道，Conductor 收敛为单一数据流：**指令先落库 → 再发引擎 → 成功后回填状态**。

- **常量搬家**：动词集合（`SUBAGENT_VERBS`）、异常类（`ConductorNotRunning`）等公共定义集中到 `server/services/conductor_vocabulary.py`，解开 `conductor_service` ↔ `conductor_commands` 的循环依赖（原靠函数内延迟 import 绕环）。
- **测试基建统一**：`for_tests()` 默认即生产形态（带 SQLite store）；共享假引擎 `tests/conductor_engine.py` 模拟引擎的日志、幂等凭据与恢复协议。
- **补引擎就绪断言**：改前只有 `dispatch/input/rework` 经 `_assert_engine_ready`；`accept/keyinfo/abort` 一个断言都没有（`ConductorNotRunning` 的 docstring 当时是假声明）。补齐后所有子代理操作在引擎未启动时一律 409 拒绝，不再冷启动。
- **补模型重推**：`ensure_started` 的冷启动点重推完整 hub 模型快照——引擎自行重启后，subagent 策略不再静默退回 `follow_main`（旧轨的 SSE hello 才会推，旧的 store 模式漏了）。
- **`resume_workflow` 迁入命令轨**：由 fire-and-forget 的 `client.post_chat` 改为 `commands.submit`（落库 + boot 守卫 + 回执），`operation_id` 由 `(engine, request, snapshot.boot_id, msg)` 派生而非每次新铸 → 双击/传输重试不再重复投递。原 `ConductorService.notify()` 已无生产调用者，一并删除。
- **命名与契约收尾**：`ensure_started` 的参数 `redispatch_stranded` 改名 `wake_recovery`（批量重发已删，旧名误导）；`CONDUCTOR_REQUEST_OUTCOME` 的裸字符串发布改为常量，topic 孤儿检查恢复严格规则。

对外行为变化仅一处：恢复现在是普通 chat 轮次，引擎回显会在对话中留下重发记录（双击不产生第二条，第二次直接回放已存命令的回执）。
