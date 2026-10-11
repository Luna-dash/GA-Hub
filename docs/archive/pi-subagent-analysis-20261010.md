# pi Subagent 设计研究与 GA-Hub 移植方案

日期：2026-10-10  
研究对象：`https://github.com/badlogic/pi-mono` 的 `main`，commit `42a3497d03ad17e308a2299fa824727894f2c0ec`（2026-10-09 UTC）  
本地快照：`D:/study/GA-Hub/temp/pi-latest`

本文只研究 subagent、任务调度、上下文隔离、重启恢复和结果回传。`pi` 有两套相关实现，必须分开理解：

1. `packages/coding-agent/examples/extensions/subagent/` 是一个轻量扩展示例。它每次调用都启动一个新的 `pi` 进程，适合一次性并行、串行链式委派。
2. `packages/durable/` 是新的持久化运行时。它没有把“subagent”硬编码成核心产品功能，而是提供 conversation、task、submission、ownership、transaction 和 recovery 原语，再用扩展实现前台或后台 subagent。

GA-Hub 应吸收第二套的状态和所有权语义，同时保留 GA 已经拥有的 workflow、交付物验证、accept/rework 和 journal。没有必要把 pi 的 TypeScript 运行时整体移植进 Python。

## 1. pi 的两种 subagent 实现

### 1.1 coding-agent 扩展：一次性进程委派

实现文件是 [`packages/coding-agent/examples/extensions/subagent/index.ts`](../../temp/pi-latest/packages/coding-agent/examples/extensions/subagent/index.ts)。工具参数有三种互斥模式：

```text
single   { agent, task }
parallel { tasks: [{ agent, task, cwd? }, ...] }
chain    { chain: [{ agent, task: "... {previous} ..." }, ...] }
```

每一个单任务都走以下流程：

1. 从用户目录或项目目录发现一个 Markdown agent 配置。frontmatter 提供 `name`、`description`、可选 `model` 和 `tools`，正文作为 system prompt。
2. 构造 `pi --mode json -p --no-session`。如果 agent 没有指定模型，就继承主 agent 的 provider/model 和 thinking level；如果 agent 指定了模型，则覆盖主模型。
3. system prompt 写进随机临时目录下的 `prompt-*.md`，文件权限为 `0600`，通过 `--append-system-prompt` 传入。
4. 以 `cwd`、工具 allow-list 和任务文本启动独立子进程，逐行读取 JSON 事件。`message_end` 收集消息和 usage，`tool_result_end` 收集工具结果，`onUpdate` 把当前结果投影回主工具卡片。
5. 中止先发 `SIGTERM`，5 秒后再尝试 `SIGKILL`；进程结束后删除临时 prompt 文件和目录。

并行模式最多接收 8 个任务，实际同时运行数最多为 4；结果按输入顺序归位，输出按每个任务最多 50 KiB 截断。chain 模式把前一步最后一条 assistant 文本替换 `{previous}`，任何一步失败就停止后续步骤。

这个实现的优点是隔离简单、适合一次性专家调用；缺点是 `--no-session` 明确不保留子 agent 会话，进程崩溃后没有“从上次提交继续”的语义，子进程副作用只能由任务自身处理幂等。它不是 pi 的持久化 subagent 架构。

项目 agent 还会触发信任确认：当 `agentScope` 为 `project` 或 `both`、当前目录未被信任且请求了项目 agent 时，UI 要求用户确认。这个安全边界适合 GA 的项目级脚本/工具扩展，但不能代替运行时的权限模型。

### 1.2 pi-durable：持久化 conversation + task

核心文档和示例：

- [`packages/durable/README.md`](../../temp/pi-latest/packages/durable/README.md) 的 “Abort and Subagents” 和 “Child Tasks”。
- [`22-subagent-foreground.ts`](../../temp/pi-latest/packages/durable/test/examples/22-subagent-foreground.ts)。
- [`23-subagent-background.ts`](../../temp/pi-latest/packages/durable/test/examples/23-subagent-background.ts)。
- [`packages/durable/docs/spec.md`](../../temp/pi-latest/packages/durable/docs/spec.md) 的 subagent 规范段落。

durable 的关键观点是：subagent 不是一个特殊线程，而是一个有独立 transcript 的 conversation；驱动它的工作是一个有 owner、checkpoint 和终态的 task。所有状态先经过一次原子 commit，再允许调度器执行外部代码。

前台 subagent 的最小实现可以概括为：

```text
父工具 task
  └─ atomic commit:
       create child conversation(owner = parent task)
       configure child model/tools/instructions
       record child identity
  └─ details({ conversationId }) 让 UI 可以挂接子会话
  └─ submit(input, requestId = subagent:<parent-task-id>)
  └─ wait(submission)
  └─ 从 child assistant entry 读取答案
  └─ 返回给父模型
```

示例把 subagent 扩展从 child 的 extension selection 中移除，因此 child 默认不能无限递归创建 subagent。child 初始复制父 conversation 的 model、thinking level、cwd、tools 和 extensions，然后可以按需切换更便宜的模型或更窄的工具集合。

后台 subagent 则多了一层 anchor 和 reporter：

```text
主 conversation
  ├─ registry document: name -> child conversation / reported answers
  ├─ background anchor task（立即完成，但成为 ownership boundary）
  │    └─ child conversation（由 anchor 拥有）
  └─ background reporter task（每一条消息一个）
       ├─ 向 child submit(steer 或 followUp)
       ├─ wait child submission
       ├─ 原子记录“该 answer 已报告”
       └─ 向主 conversation submit followUp 报告
```

因此主 agent 可以立即回答用户，child 在后台继续运行；主 conversation 的 Esc 和普通 idle wait 不会穿过 background boundary，但显式的全局停止仍可使用 `abort(..., { background: true })` 穿透。`spawn`、`send`、`stop`、`status` 是示例工具暴露的四个动作。

## 2. pi 真正解决的可靠性问题

### 2.1 所有权树决定 abort 和 idle 语义

每个 task 必须有 owner：conversation 或同一 conversation 内的另一个 task；child conversation 可以由 task 拥有。owner edge 不可变。

- 取消向下传播。取消父 task 会取消它拥有的普通 child task 和 child conversation。
- 一个 task 只有在普通 owned work 全部排空后才真正 terminal。已经决定结果但子工作仍在运行时，状态是 `completing`。
- abort 是自下而上的清理：先让子工作终止，再运行父 task 的 abort handler，使父 handler 能看到子工作的最终结果。
- background task 是边界。普通 abort/idle 不穿透；显式带 `background: true` 的 abort 才穿透。
- child task 不能再声明 background，避免所有权树出现没有明确父边界的孤儿。

这比“一个线程一个 status 字符串”更重要。它定义了用户按停止键、主 agent 返回答案、进程关闭时哪些工作应该继续、哪些工作必须等待。

### 2.2 task 是可恢复的状态机，不是裸 future

task 状态是持久化的：

```text
pending -> running -> waiting -> pending -> running -> ...
                         \-> completing -> terminal
                         \-> terminal (failed / aborted / faulted / orphaned)
```

每个 phase handler 返回前必须提交下一份 checkpoint。等待多个 child 时，task 进入 `waiting`，记录 `on` task IDs 和 `failFast` 或 `allSettled` 策略；等待期间不运行代码，子任务终态后再从 checkpoint 恢复。

Harness 打开 SQLite/JSONL storage 时，会把遗留的 `running` 改回 `pending`，再由 scheduler 继续；`abandonOnRestart` 专门标记“调用者只在内存里等待、重启后不应重跑”的不安全任务。task definition 还带版本号和 migration，避免代码升级后无法解释旧 checkpoint。

### 2.3 原子提交与 requestId 去重

pi 的 `commit()` 可以把以下动作放在同一事务：

- 新建 conversation 或 fork；
- 新建 task；
- 修改 typed document（如 subagent registry）；
- 创建或 settle submission；
- 写 transcript entry。

只有 storage commit 成功后，调度器才会运行 agent、工具或网络调用。这样“创建 child”和“把 child 写入 registry”不会出现一半成功的状态。

submission 有独立记录和状态：`queued`、`placed`、`done`、`unanswered`。调用方给同一 conversation 的 submission 一个稳定 `requestId`，重试会返回原 submission，而不是再次排队。前台示例用 `subagent:<parent-task-id>`；后台 reporter 用自己的 task ID，再用 `subagent-report:<reporter-task-id>` 保护回传。

这提供的是“admission exactly once”，不是外部副作用 exactly once。模型请求、文件写入、网络调用在 commit 之后，崩溃恰好发生在副作用和结果提交之间时，仍需要工具自身的幂等键或 `replay: unsafe` 策略。

### 2.4 replay policy 明确写在工具上

durable tool 默认 `replay: "unsafe"`。只有声明 `replay: "safe"` 的工具，在 crash/reopen 后才会按同一 task 和同一 nested-call key 重跑；不安全工具会产生 `interrupted` 结果，避免重复发送邮件、扣款或再次部署。

因此，pi 不把“重启后自动再跑”当作普遍正确行为，而是把可重放性当作每个操作的契约。

### 2.5 上下文、模型、工具是 conversation 级配置

每个 conversation 有自己的 agent 配置：model、thinking level、extensions、tools、modelTools、instructions、cwd。child 创建时复制父配置，但在自己的事务中覆盖。provider session identity 对每个 conversation 独立，child/fork 都得到新的 identity。

这让“上下文隔离”和“模型路由”自然统一：父 supervisor 的历史不会注入 child；child 可以使用较便宜模型和只读工具；新任务的 session 不需要手工清理旧对象的私有字段。

## 3. 与 GA-Hub 现状的对应关系

### 3.1 GA 已经具备的部分

GA 的现有设计并不落后于 pi 的所有方面：

- `request_id` 已经是 workflow 的稳定身份，并且按照“一个任务 = 一个归档”重建 supervisor。见 [`docs/plans/conductor-task-model.md`](../plans/conductor-task-model.md)。
- GA 每个 worker 有独立 `GenericAgent` 和 native archive；`agent_factory`、generation、thread retirement 和 archive lock 已经处理了 worker 上下文隔离。
- Hub 的 [`ConductorStore`](../../server/services/conductor_store.py) 使用 SQLite WAL + `synchronous=FULL`，已有 `workflows`、`commands`、`subagent_archive`、`activity`、journal cursor 和 tombstone。
- `operation_id` 有参数 fingerprint；Hub 的 command track 先落库，再向 engine 发送，能处理重复请求、transport timeout 和 boot 变化。
- GA engine 已有 `SubagentPool`、generation、command revision、intervention budget、request wall-clock/attempt budget、deliverable baseline、机械验收和 accept/rework。
- append-only journal 以 `epoch + seq + boot_id` 标识引擎重启，Hub 可 catch-up 并将事件投影回 SQLite。
- request 终态追加已经有 reopen 语义，同一 `request_id` 可继续原任务归档；这与 durable conversation 的持续输入方向一致。

因此移植重点不是重写整个 Conductor，而是把现在分散在 workflow、pool、archive、command receipt 中的概念显式化并连接起来。

### 3.2 GA 与 pi 的关键差距

| pi durable 概念 | GA 当前对应物 | 主要差距 |
|---|---|---|
| conversation | supervisor/worker 的 native archive + `logid` | archive 是输出历史，尚不是可查询的 conversation 记录；没有 parent/owner edge |
| task | `SubAgentState` + Python thread | state 大多在 GA engine 内存；没有统一 phase checkpoint 和 task scheduler |
| submission | Hub `commands` / engine operation receipt | command 是 Hub→engine 意图，尚没有“某个 conversation 的输入已放置/已回答”记录 |
| ownership tree | `request_id` 与 worker binding | 有 workflow→worker，但没有 task→child、background boundary、abort/idle traversal |
| replay policy | operation idempotency + recovery `unknown` | 已防止重复投递，但没有每类 worker/工具的 safe/unsafe replay 契约 |
| foreground child | supervisor dispatch 后等待 worker 事件 | worker 输出回 Hub，缺少可附着的 child conversation identity |
| background child | 无命名常驻 subagent；只有 worker pool | 没有 anchor/reporter，主任务结束后无法安全地让 child 独立运行并回报 |
| child agent config | `llm_index` 与 worker prompt/manifest | 模型选择已有策略，但 tools/cwd/instructions/session identity 尚未成为 worker 级配置对象 |
| task graph | workflow board + worker cards | 可以看 workflow/worker，不能显示 task owner、waiting child、completing 和 abort cascade |

GA 的 review、manifest、deliverable gate 是 pi 没有的业务能力，应继续保留。pi 的 `terminal` 只说明执行结束，GA 还需要“交付物机器验证通过后才能 accept”。

## 4. 推荐的 GA 目标模型

### 4.1 四种 ID 分层

不要让 `request_id` 同时承担所有身份：

```text
workflow_id / request_id  用户任务，跨多次派发、review、rework、final
conversation_id           一条独立上下文和 archive；supervisor/worker 各自一个
task_id                   一次可调度执行；rework 可创建新 attempt task
operation_id              一次 Hub→engine 命令的幂等收据
submission_id             某个 conversation 的一次输入，支持 wait 和去重
```

现有 `request_id`、worker `sid`、generation、operation_id 继续兼容；先新增内部字段和响应字段，再逐步让 UI 使用新身份。

### 4.2 最小持久化表

复用现有 `ConductorStore` 的 SQLite，不引入第二套数据库。第一阶段可把大字段放 JSON，先稳定状态机。

```sql
conversations(
  engine_key, conversation_id, request_id, parent_conversation_id,
  owner_task_id, archive_path, model_policy_json, tools_json,
  instructions, cwd, provider_session_id, status, created_at, updated_at,
  PRIMARY KEY(engine_key, conversation_id)
)

tasks(
  engine_key, task_id, conversation_id, request_id, owner_task_id,
  kind, version, input_json, checkpoint_json, status,
  background, replay_policy, abort_requested, started_at, ended_at,
  outcome_json, PRIMARY KEY(engine_key, task_id)
)

submissions(
  engine_key, submission_id, conversation_id, request_id,
  input_json, status, entry_id, answer_entry_id, reason, created_at,
  UNIQUE(engine_key, conversation_id, request_id)
)

subagent_registry(
  engine_key, parent_conversation_id, name, child_conversation_id,
  anchor_task_id, reported_answers_json, updated_at,
  PRIMARY KEY(engine_key, parent_conversation_id, name)
)
```

已有 `workflows` 保持 workflow 业务状态；已有 `subagent_archive` 保持“引擎丢失后还能读 worker dossier”的投影；新增表承载执行身份和恢复依据。不要把完整 token 流写入 task 行，输出仍进 archive/journal 并受现有上限控制。

### 4.3 一次 foreground dispatch 的事务边界

```text
Hub commands.submit(operation_id, intent)
  1. SQLite transaction:
       ensure workflow(request_id)
       allocate conversation_id + task_id + submission_id
       insert task = pending, conversation = active
       bind worker sid/generation (若 sid 已由 engine 生成则写 admission row)
       persist command = pending
  2. transaction commit
  3. send engine command outside SQLite lock
  4. engine callback/journal:
       pending -> running -> pending_review -> accepted/rejected/failed
       append archive snapshot and activity
       settle submission when final report exists
  5. command receipt becomes succeeded / rejected / unknown
```

网络调用不能放在 SQLite transaction 内；如果第 3 步超时，状态必须是 `unknown`，由 boot/journal reconciliation 决定是已受理、已拒绝还是需要人工处理。不能直接当作“没发出去”再派一次。

### 4.4 foreground 与 background 语义

先实现 foreground，因为 GA 当前 supervisor→worker 正是这种关系：

- supervisor request/task 拥有 worker task；停止 request 时向下 abort；父 workflow 只有 worker drain 后才进入终态。
- worker 的 `generation` 对应一次 attempt；rework 创建新 task 或新 generation，但保留同一 workflow 和必要的 prior-attempt evidence。
- worker `details` 返回 `conversation_id`、`task_id`、`generation`，WebUI 可从一个 worker card 进入完整 archive。

之后再新增显式的 background subagent：

- `spawn(name, message)` 在一个 SQLite transaction 中创建 registry row、background anchor 和 child conversation。
- anchor 是 parent 的 background boundary，child 后续输入属于 child conversation。
- `send` 创建 reporter task；reporter 使用 `when_busy=steer|follow_up`，等待 child submission，原子记录 answer 已报告，再向主 conversation 投递 follow-up。
- `stop(name)` 只 abort child 当前 run，保留 conversation 可继续使用；全局 shutdown 才穿透所有 background anchor。

这套功能应作为单独的“persistent subagents”产品能力，不要把所有普通 worker 都改成 background。

### 4.5 GA replay policy 的具体取值

建议先只对内部操作定义三种状态：

```text
safe       没有不可逆外部副作用，journal unknown 后可按相同 task_id 重试
unsafe     可能已写文件/部署/发送请求；重启后标记 interrupted，等待人工 review
reconcile  不重跑；先用 operation receipt + journal + archive 对账，确认后再决定
```

普通 supervisor chat、worker LLM 轮次和 deliverable 检查先用 `reconcile`；纯状态更新、读取和报告回传可以 `safe`；文件修改、部署、远程操作默认 `unsafe`。这比简单地把所有 `operation_id` 当作 exactly-once 更符合真实副作用语义。

## 5. 对外 API 建议

保持现有端点，先增加可选字段，避免一次性重做 WebUI：

```text
POST /api/conductor/subagent
  新增 conversation_id、task_id、owner_task_id、replay_policy、submission_id

POST /api/conductor/subagent/{sid}
  新增 when_busy = steer | follow_up
  响应返回 conversation_id、task_id、generation、operation_id

GET /api/conductor/task-graph?request_id=...
  返回 task、owner、background、status、checkpoint 摘要和等待关系

GET /api/conductor/conversation/{conversation_id}
  返回 archive 元数据、模型策略、工具策略和最近事件

POST /api/conductor/subagents/persistent
  action = spawn | send | stop | status
```

现有 `accept`、`rework`、`abort` 和 manifest/quality gate 不删除。`accept` 是 GA 业务层的验收，不应被 pi 的普通 task terminal 直接替代。

## 6. 分阶段实施顺序

### Phase 0：只做身份和事件，不改变执行行为

1. 在 engine/HUB response 中加入 `conversation_id`、`task_id`、`submission_id` 的兼容字段。
2. 用当前 `logid` 作为 conversation identity；用 `(sid, generation)` 派生 task identity。
3. journal 增加 `task_created`、`task_running`、`task_waiting`、`task_settled`、`submission_placed`、`submission_done` 事件。
4. WebUI 只读显示 task graph，验证事件顺序和重连投影。

### Phase 1：落 SQLite 的 task/submission 状态机

1. 新增上述三张表和 migration/version。
2. 把当前 `commands`、workflow binding、archive snapshot 的写入收敛到同一个 admission 事务。
3. 明确 `pending/running/pending_review/completing/terminal/unknown` 的映射；不能用一个 `status` 字符串同时表示 worker 生命周期和 review verdict。
4. 先覆盖：重复 POST、Hub 重启、engine boot 变化、journal 重放、响应丢失、同 request reopen。

### Phase 2：前台 owner/abort/wait

1. supervisor request task 拥有 worker task；实现向下 abort 和父 task 的 `completing`。
2. `stop`、`abort`、`rework` 在 task 层记录意图和 outcome，保留现有 `origin="hub"` 的 workflow 终态规则。
3. 线程仍由现有 `SubagentPool` 运行；新 scheduler 只负责持久化状态和恢复，不要同时重写 GenericAgent。

### Phase 3：恢复策略和安全边界

1. 给 dispatch、input、rework、accept、report 分配 replay policy。
2. engine 重启时把 `running` 置为 `unknown/pending-reconcile`，先用 operation receipt、boot_id、journal 和 archive 对账。
3. 只有明确 safe 的动作允许自动继续；unsafe 动作生成可审计的 interrupted worker，禁止静默补派。
4. 给每个 child conversation 固定 model/tools/instructions/cwd 快照；新任务沿用现有 G3 的“新 GenericAgent + 新 archive”边界。

### Phase 4：持久化后台 subagent

1. 新增 registry document/table、anchor task、reporter task。
2. 实现 `spawn/send/stop/status`，先限制只能由 supervisor 调用。
3. 增加“主会话已回复但后台 child 仍在运行”的重启测试，以及 reporter 重放不重复回报的测试。

### Phase 5：再考虑 parallel/chain 产品化

coding-agent 的 parallel/chain 只是工具编排层，不是 durable 核心。GA 已有并发 admission、worker path conflict 和 workflow 聚合，优先复用这些约束；只有用户确实需要专家串联时，才增加 `chain` 和并发上限字段。

## 7. 不建议直接移植的部分

- 不要把 `pi-durable` 的 TypeScript/Chord scheduler 整体嵌进 GA。GA 已有 Python engine、SQLite store、journal 和 Tauri/sidecar 生命周期，跨语言复制会产生两套真相。
- 不要把每个 worker 改成独立 OS 进程。GA 当前 `GenericAgent` thread、display queue、archive lock 和 callback 已经形成一套可工作的边界；只有需要不同权限或不同运行环境时才考虑进程/容器隔离。
- 不要用“杀线程后重新派发”替代 task outcome。线程停止只能说明运行态结束，不能说明外部副作用没有发生。
- 不要把完整 parent transcript 拼进 child prompt。应复制 model/tool policy 和必要的 manifest/prior-attempt evidence，child 使用自己的 archive/session identity。
- 不要承诺外部工具 exactly-once。pi 自己也只保证 durable admission 和 replay policy，外部副作用仍需幂等键或人工对账。

## 8. 验收矩阵

移植完成前至少验证以下场景：

| 场景 | 期望 |
|---|---|
| dispatch 请求响应丢失后重试 | 同一 `operation_id` / `request_id` 返回原 receipt，不创建第二个 worker |
| Hub 在 worker running 时重启 | task 保留；状态进入可解释的 pending/unknown；journal catch-up 后不重复派发 |
| foreground stop | worker 子任务先结束，父 workflow 最终进入 cancelled/failed，不能留下 running 孤儿 |
| background child 工作时主 agent 返回 | 主 conversation idle；child 继续；reporter 完成后只回报一次 |
| reporter 在提交 child 后崩溃 | 重启后同一 reporter task 找到原 submission，不重复发送或回报 |
| child 无 subagent 工具 | tool allow-list 和 extension policy 生效，不能递归无限创建 |
| rework | 新 generation/task 使用 fresh attempt budget；保留 prior-attempt evidence；accept 仍走 GA gate |
| 不安全外部操作中途崩溃 | 标记 interrupted/unknown，等待 receipt/journal/人工确认，不静默重跑 |
| 同 workflow reopen | 复用原 `request_id` 和业务 archive，执行身份使用新的 submission/task |

## 结论

pi 最值得移植的不是“启动一个子进程”这件事，而是四条可验证的边界：

1. 一个 child 是独立 conversation，拥有自己的上下文、模型、工具和 provider session。
2. 一次执行是有 owner、checkpoint、outcome 的 durable task，abort/idle 由 ownership tree 决定。
3. 输入通过带稳定 request ID 的 submission 进入 conversation，原子 admission 防重复。
4. replay policy 明确区分可重放、不安全和需要对账的操作。

GA 已经有 workflow/review/交付验证和 Hub command journal。推荐路线是把 pi 的 conversation/task/submission/ownership 语义逐步落进现有 SQLite 和 journal，再在其上加持久化 background subagent；不要替换现有 Conductor，也不要先引入另一套运行时。
