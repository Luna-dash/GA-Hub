# GA-Hub 与 GA：按特殊 Frontend/Bridge 视角梳理依赖

- 复核对象：`D:\study\GA` 与 `D:\study\GA-Hub`
- 复核原则：**GA-Hub 不是要脱离 GA 的独立产品，而是 GA 的一种特殊 frontend**
- 目标：不大改 GA 核心，不人为制造两套完全独立的系统；把 `gahub` 这条 frontend 链路的职责、契约和数据归属理清楚
- **依赖方向硬规则：`gahub` 可以依赖 GA；GA Core 和通用 frontend 不应依赖 `gahub`。**

> 这里的“GA 不依赖 gahub”指 GA 的核心、通用 runtime、通用 frontend substrate 不应 import 或理解 `gahub` 的产品逻辑。
> `frontends/gahub_app.py` 这种“启动入口加载特殊 frontend”的兼容 shim，以及 GA 对 `gahub` 的专门测试，不属于核心反向依赖，应该单独列入白名单。

---

## 1. 先定性：GA-Hub 是一个 Frontend 的两半

GA 现有的结构本来就是：

```text
GA 核心引擎
  ├─ hub / hub.pyw              一种桥接前端
  ├─ desktop_bridge.py           桌面前端桥
  ├─ conductor.py               Conductor 参考前端
  ├─ fsapp.py                   飞书前端
  └─ gahub/                      面向 GA-Hub 的特殊 frontend
```

`gahub` 与普通 `conductor.py` 的区别在于，它不是只提供一个页面，而是和另一个仓库中的 GA-Hub 配合，形成一个完整的产品 frontend：

```text
GA-Hub frontend
  ├─ GA 侧：frontends/gahub/ + gahub_app.py
  │    定制 supervisor、worker、派工、验收、journal、SSE、运行时策略
  │
  └─ Hub 侧：server/ + webui/
       定制页面、会话列表、workflow、持久化、恢复、通知和产品交互
```

因此正确问题不是：

> GA-Hub 如何尽可能不依赖 GA？

而是：

> 这个特殊 frontend 的 GA 侧和 Hub 侧，如何共享 GA 能力，同时不把职责、状态和契约写成一团？

这也解释了为什么 Hub 直接使用 `GeneraticAgent`、`continue_cmd`、`worldline` 并不天然错误。它和 `desktop_bridge.py` 直接管理 GA runtime 是同一种架构风格。

---

## 2. 当前关系图

### 2.1 三个层次，不是两个独立系统

```text
┌──────────────────────────────────────────────────────────┐
│ GA Core                                                  │
│ agentmain / llmcore / continue_cmd / worldline / memory  │
└──────────────┬───────────────────────────────┬───────────┘
               │                               │
               │ 原生 runtime bridge           │ 专用 Conductor bridge
               │                               │
┌──────────────▼──────────────┐     ┌────────▼────────────┐
│ GA-Hub backend               │     │ GA frontends/gahub   │
│ AgentService、sessions、     │     │ supervisor、workers、 │
│ archive、rewind、GoalHive    │     │ journal、HTTP/SSE     │
└──────────────┬──────────────┘     └────────┬────────────┘
               │                              │
               └───────────┬──────────────────┘
                           │ frontend product contract
                    ┌──────▼──────┐
                    │ webui       │
                    │ Chat/Hub UI │
                    └─────────────┘
```

### 2.2 两条 runtime 不是重复，而是两个角色

**主 Agent runtime**：

- Hub 内直接拥有一个或多个 `GeneraticAgent`；
- 服务普通聊天、session、scheduled chat、GoalHive 等；
- 依赖 GA 原生对象和归档能力；
- 这是 GA frontend 的正常嵌入式用法。

**Conductor runtime**：

- GA 侧 `frontends/gahub/gahub_app.py` 自己拥有 supervisor 和 worker；
- Hub 侧通过 HTTP/SSE、journal 和 recovery 消费它；
- 这是为了让 Conductor 的 worker 生命周期和 Hub 产品生命周期分开，不代表所有 GA 能力都必须走 HTTP。

两者都属于 `gahub` frontend，但不是同一个 Agent，也不应该强行合并。

---

## 3. 哪些耦合是合理的，哪些才需要整理

### 3.1 合理耦合：特殊 Frontend 必须知道 GA 能力

以下依赖属于正常的 frontend/bridge 依赖，不需要清零：

| 依赖 | 用途 | 判断 |
|---|---|---|
| `agentmain.GeneraticAgent` | 主聊天、GoalHive、后台会话 | 合理，属于主 runtime bridge |
| `frontends.continue_cmd` | 原生归档、session restore、锁 | 合理，但需要稳定 helper/contract |
| `frontends.worldline` | rewind 与 durable checkpoint | 合理，属于 GA 原生会话能力 |
| `llmcore` / `mykey.py` | 模型配置和热加载 | 合理，Hub 是 GA 的管理前端 |
| `cost_tracker` | 读取 GA 官方 token ledger | 合理，Hub 是展示方 |
| `frontends.chatapp_common` | WeChat 等 GA 前端能力 | 合理，复用官方 frontend substrate |
| `frontends.hub` | 监控 + 遥控总线（peer 注册） | 合理，且**应复用而不是自建面板/远程通道** |
| `frontends/gahub/` HTTP/SSE | Conductor 专用运行时 | 合理，属于 gahub 的定制协议 |

真正的风险不是“用了这些模块”，而是业务代码散落地使用私有符号，没有一份 `gahub` frontend contract。

### 3.2 需要整理的耦合：同一个 frontend 的职责没有写清

#### A. GA 侧与 Hub 侧都实现了一部分 Conductor 领域规则

GA 侧负责：

- worker 创建、停止、重做、验收前置条件；
- supervisor turn；
- execution admission；
- journal 事件；
- worker 运行状态。

Hub 侧负责：

- workflow 投影；
- request admission；
- command receipt；
- SQLite/状态恢复；
- 页面 activity timeline。

这里不是要把其中一侧搬走，而是要明确：

> **GA 侧是真实执行状态的 owner；Hub 侧是产品 workflow 和投影的 owner。**

如果一个字段同时被两边判断，例如 worker 是否可运行、某次 abort 是否已经生效，就会出现真正的耦合问题。

#### B. Hub 把 GA 私有字段当成稳定接口

实际使用包括：

```text
agent._turn_end_hooks
agent._rw_store
llmcore._mykey_mtime
backend._sessions
continue_cmd._user_text
continue_cmd._lock_path
```

这些依赖可以暂时保留，但应该归类为：

```text
GA-Hub Frontend Contract：private-but-required
```

也就是承认它们是这个 frontend 的内部兼容面，而不是假装它们不存在。

#### C. 同一个契约在 GA、Hub、WebUI 各写一遍

典型包括：

- worker event kind；
- completion marker；
- `INSTR_DISPATCHED` / `INSTR_KEYINFO`；
- action alias；
- activity label；
- journal format 和 protocol version。

这才是当前最值得解决的“耦合度大”：不是调用多，而是**改一个规则要靠人工记住三处**。

#### D. 文件数据的 owner 没有统一说明

当前事实是：

| 数据 | 实际 owner/用途 | 需要明确的规则 |
|---|---|---|
| `GA/temp/model_responses` | GA 产生，Hub 展示/解析 | GA 格式是 frontend contract，Hub 不应直接改写 |
| `GA/temp/token_ledger.jsonl` | GA 产生，Hub 读取 | 只读消费，版本/字段需探测 |
| `GA/mykey.py` | GA 配置，Hub 提供编辑界面 | Hub 可写，但必须走统一 config bridge、备份、reload |
| `GA/memory/**` | GA 的知识/SOP 内容，Hub 也提供编辑页 | 需要决定 Hub 是否是正式编辑前端；不能继续文档写“零侵入” |
| `GA-Hub ADMIN_DATA` | Hub 的 workflow、metadata、journal 位置 | GA 不应自行把产品状态写入这里，除非是明确的 gahub 协议路径 |
| `GAHUB_JOURNAL_PATH` 指向的文件 | gahub frontend 的共享运行时事实流 | GA 写格式，Hub 负责存储位置和消费恢复 |

---

## 4. 推荐目标：不是隔离，而是“官方 Frontend Contract”

### 4.1 建议定义一个 `GA-Hub Frontend Contract`

它不是一个新进程，也不是把 GA 封装成第三方 SDK，而是一份面向这个 frontend 的兼容清单：

```text
GA-Hub Frontend Contract
  ├─ Main Agent surface
  │    GeneraticAgent 方法、必要 attrs、thread/queue 语义
  ├─ Archive surface
  │    continue_cmd helpers、native archive 格式、lock 语义
  ├─ Model/config surface
  │    mykey.py 结构、reload、assignment/index 映射
  ├─ Conductor wire surface
  │    /health、/recovery、/models、/chat、/subagent、/events、/journal
  ├─ Event surface
  │    event kind、字段、boot_id、generation、seq
  ├─ File surface
  │    temp、memory、mykey、journal 的 owner 和读写权限
  └─ Compatibility surface
       允许使用的 private symbol、替代 helper、废弃周期
```

这份 contract 可以由现有代码逐步整理出来，不必马上做独立 package。

### 4.2 GA 侧应该提供什么

不是把 `gahub` 搬出 GA，而是在 GA 的 frontend 体系内补少量正式桥接点：

1. 保留 `frontends/gahub/` 和 `frontends/gahub_app.py` 入口；
2. 继续让 `gahub_app.py` 拥有 Conductor 专用逻辑；
3. 对 Hub 主 runtime 使用的高风险 private 访问，逐步增加官方 helper；
4. 为 `gahub` contract 提供 probe/compatibility check；
5. 把 supervisor/worker wire schema、事件和 marker 作为 frontend contract 管理；
6. 不要求 `frontends/conductor.py` 与 `frontends/gahub/` 合并，它们是两个不同消费场景的 frontend。

例如，不必马上重写 rewind，只要 GA 侧逐步提供：

```python
agent.bind_rewind_store(...)
agent.restore_turn(...)
agent.on_turn_end(...)
```

Hub 以后优先调用这些 helper，内部仍然可以继续使用 `_rw_store` 和 hook。这样是“官方桥接点增加”，不是“架构重建”。

### 4.3 Hub 侧应该做什么

Hub 侧重点不是把 GA 隐藏掉，而是把自身的产品职责定清：

1. `AgentService` 负责主 Agent runtime 的产品生命周期；
2. `SessionRuntimeFactory` 负责 Hub session 与 GA archive 的绑定；
3. `ConductorService` 负责 GA-side Conductor 的产品投影、命令持久化和恢复；
4. `webui` 只依赖 Hub API 和事件，不直接理解 GA 私有结构；
5. `core_contract.py` 从“几个必需符号探测”升级成 `gahub` frontend contract probe；
6. 业务代码可以依赖 GA，但通过少量明确的 bridge/service 入口，而不是每个模块随意 import。

建议先做轻量收口，而不是重建目录：

```text
server/services/ga_runtime_bridge.py
  - Agent 构造、run、abort、task、turn hook

server/services/ga_archive_bridge.py
  - continue_cmd、native archive、lock、worldline

server/services/ga_config_bridge.py
  - mykey、reload、LLM assignment、cost tracker
```

这些模块不是“隔离层”，而是 `gahub` frontend 在 Hub 侧的桥接实现。

---

## 5. 按业务场景的依赖边界

### 5.1 普通聊天

```text
LiveChat
  → Hub session API
  → AgentService
  → GA GeneraticAgent
  → GA archive/temp
```

这是 `gahub` frontend 的主 Agent 通道，保留进程内调用。
需要整理的是：

- Agent 创建和 patch 集中；
- queue、abort、stream、turn end hook 形成 contract；
- GA 的 archive 由 GA 生成，Hub 只做投影和绑定。

不建议为了“独立”把普通聊天改成 Conductor HTTP。

### 5.2 Conductor

```text
Conductor 页面
  → Hub ConductorService
  → HTTP/SSE
  → GA frontends/gahub_app.py
  → supervisor / worker GenericAgent
```

这是 `gahub` 的专用定制通道。
GA 侧拥有执行状态，Hub 侧拥有产品 workflow 投影。

需要做的是：

- `/health` 成功后立即校验版本和 capabilities；
- wire contract 单源或 golden 校验；
- engine event 与 Hub activity projection 的映射可检测；
- 不把 Hub workflow 状态反向塞回 GA execution state。

### 5.3 历史会话 / restore / rewind

```text
Hub session metadata
  → GA native archive bridge
  → continue_cmd / worldline
```

Hub 管理“哪个产品 session 对应哪个归档”；GA 管理归档格式和恢复动作。

这里不需要强行拆成远程 API，但需要把 `continue_cmd` 的私有 helper 使用集中，并由 contract probe 检查。

### 5.4 mykey / 模型选择

```text
WebUI 设置
  → Hub mykey service
  → GA mykey.py / llmcore
  → 主 Agent 或 Conductor 各自 reload 自己的模型状态
```

主 Agent 和 Conductor 的模型状态仍然分开，这是合理的；Hub 只是同时管理两个 frontend runtime。

### 5.5 memory

如果 GA-Hub 被定位为官方 frontend，那么 Hub 编辑 GA memory 是可以成立的：

```text
Hub Memory 页面 = GA memory 的一个官方编辑入口
```

但要把文档改成真实语义：

- 编辑会修改 GA 工作区内容；
- 写入前要备份和并发检测；
- tracked memory 是否允许自动提交/同步，需要产品决定；
- 不能再宣传“完全不写 GA 目录”。

不需要为了这件事额外增加一层 HTTP；除非未来需要把 memory owner 迁移到 GA 仓外。

---

## 6. 分阶段方案

### 阶段 0：确认 frontend 领域和 owner

产出不是新目录，而是两份清单：

1. `GA-Hub Frontend Contract`
   - GA core/bridge 符号；
   - private-but-required 符号；
   - Conductor wire schema；
   - event/action/marker。
2. `GA-Hub Frontend Ownership`
   - execution state 谁负责；
   - workflow state 谁负责；
   - archive、memory、mykey、journal 谁写谁读。

同时修正文档中的“磁盘零侵入”等不准确说法。

### 阶段 1：扩展已有 contract probe

不新增第三套 baseline，而是扩展：

- Hub `server/services/core_contract.py`；
- GA `frontends/ga_contract_probe.py`。

补充检查：

- 实际调用的 helper 和签名；
- archive/worldline/workspace/cost tracker 依赖；
- 必需 instance attrs；
- `gahub_app` protocol v2 和 capabilities；
- 不允许的旧字段/废弃事件。

目标是：GA 升级时测试明确告诉我们“哪个 frontend contract 被破坏”。

### 阶段 2：轻量收口 Hub 侧 bridge

不做大规模拆仓，只新增或整理三个服务入口：

```text
GA runtime bridge
GA archive bridge
GA config/model bridge
```

迁移顺序：

1. `cost_tracker`、`workspace_cmd` 等孤立 import；
2. archive/lock/restore；
3. mykey/reload/LLM registry；
4. Agent hook、patch、GoalHive。

每一步保持行为不变，Hub 的业务 service 仍然存在。

### 阶段 3：GA 侧增加小型官方 helper

优先处理 Hub 直接操作的私有字段：

- turn-end hook；
- rewind store；
- mykey reload/invalidation；
- archive/lock 查询。

不是重构 `agentmain.py`，而是给 `frontends` 使用者加几个受支持入口。
旧字段可以保留一个兼容周期。

### 阶段 4：收口 Conductor 专用契约

- 启动健康检查直接验证 protocol/capabilities；
- engine event、Hub projection、WebUI fallback 的集合测试；
- 明确 `boot_id`、`generation`、journal seq、operation_id 的边界；
- 继续保留 `frontends/gahub_app.py` shim；
- 不把 `gahub` 改成与现有 `conductor.py` 冲突的目录名。

### 阶段 5：清理明显的历史残留

可以单独处理：

- Hub `TimeoutMonitor` 的无消费者事件；
- 重复的旧 vocabulary；
- 过期的 legacy WebUI fallback；
- 文档中把 gahub 说成“零侵入/完全独立”的表述。

---

## 7. 依赖方向规则

### 7.1 这条规则是有道理的，而且应作为硬边界

```text
GA Core / 通用 frontend substrate
                  ↑
          frontends/gahub
                  ↑
        GA-Hub backend / WebUI
```

允许：

- `frontends/gahub` import `agentmain`、`llmcore`、通用 `frontends` 能力；
- GA-Hub backend 调用 GA 的 bridge、runtime、archive、LLM 和 workspace 能力；
- `gahub_app.py` 作为特殊 frontend 的启动入口加载 `frontends.gahub`。

禁止：

- `agentmain`、`llmcore`、通用 runtime import `frontends.gahub`；
- 通用 `frontends` 组件理解 Hub 的 workflow、SQLite、WebUI store、Hub event bus；
- GA 核心为了 gahub 专属字段、事件或产品状态增加反向分支；
- 把 `GA-Hub` 的业务包作为 GA 的普通 Python 依赖安装进 GA。

原因很简单：`gahub` 是 GA 的一个特殊消费者。如果 GA 核心反过来依赖它，GA 就不再是通用引擎，而会变成“必须带着 GA-Hub 才能运行”的单一产品。这样会直接影响：

- 其他 frontend（desktop、Conductor、飞书、CLI）的独立使用；
- GA 核心的测试和发布；
- GA-Hub 与 GA 的版本演进；
- 循环 import 和隐式初始化。

### 7.2 允许的例外必须是组合入口，不是业务依赖

以下可以允许，但要单独白名单：

1. `GA/frontends/gahub_app.py`：兼容启动 shim，负责把 `python frontends/gahub_app.py` 转到特殊 frontend；
2. `GA/frontends/conductor_core.py`：已有兼容别名，转发到 gahub 专用实现；
3. `GA/tests/test_gahub_*.py`：GA 仓的特殊 frontend 测试；
4. 发布/打包脚本显式选择 `gahub` frontend。

这些属于“组装时加载哪个 frontend”，不是 `agentmain` 或通用组件在运行时依赖 gahub。

### 7.3 当前需要治理的一处语义反向依赖

当前 `GA/frontends/fsapp.py` 虽然没有 import `gahub`，但会输出：

```text
__GAHUB_FEISHU_CHAT__
```

这意味着通用飞书 frontend 已经知道 GA-Hub 的专属 marker。它不是 Python import 反向依赖，但仍是协议层的反向依赖：通用组件理解了特殊产品名称。

建议按兼容周期治理：

1. 通用 `fsapp.py` 输出中性 envelope，例如 `__GA_FRONTEND_EVENT__`；
2. payload 内使用通用事件类型和版本，不出现 Hub 的页面/业务字段；
3. GA-Hub 继续兼容旧 `__GAHUB_FEISHU_CHAT__` 一个发布周期；
4. 新版本后删除旧 marker，并在 import/protocol direction test 中禁止通用 frontend 新增 `GAHUB_` 专属符号。

### 7.4 应增加的自动化检查

在 GA 侧新增 `tests/test_frontend_dependency_direction.py`，规则至少包括：

- `agentmain.py`、`llmcore.py`、通用 `frontends/*.py` 不得出现 `import frontends.gahub`、`import gahub`；
- 允许路径仅为上述组合入口、特殊 frontend 测试和明确的打包脚本；
- 通用 frontend 源码不得新增 `GAHUB_`、`__GAHUB_` 等产品专属协议名；
- `frontends/gahub/**` 可以依赖 GA core 和通用 frontend；
- 依赖方向测试失败时输出具体文件、行号和规则名称。

Hub 侧相应保留 `test_import_direction.py`，但它检查的是 Hub → GA 的允许入口和未登记新增依赖，不应把 Hub 对 GA 的依赖本身判为错误。

### 7.5 官方 hub 是通用组件，gahub 应接入而不是自建

GA 已有官方「监控 + 遥控中枢」：`frontends/hub.py`（本机 WS 总线 + 网页面板 `hub.html` + 可选 `hub_p2p.py` 手机配对）。
现有使用者：

```text
frontends/stapp.py:308      hub.connect(agent, 'stapp')
agentmain.py:312-316        reflect 模式，显式 put_task 调 agent.put_task(t, source='hub')
```

它已核实的能力：

- 注册与发现：`hello {name,pid,fixed,caps,sub}`，`GET /api/peers` 支持 `sig` 增量；
- 监控读取：`/api/{name}/messages?since=&sig=`、`/api/{name}/seg/{i}/{j}?off=`（步骤可断点续读）；
- 遥控写入：`/api/{name}/put|abort|llm`；
- 事件总线：`emit(topic,data)` + `sub` 订阅 fanout；
- 远程暴露：`hub_p2p` 只导出 `/api/*`；
- 按需拉起：`serve()` detached 启动，端口即单例锁，仅 loopback + Origin 校验。

**结论：gahub 应把 Conductor 注册为 hub peer 来做监控与粗粒度遥控，而不是自建面板和远程通道。**

但 hub 是**单 agent 线性 transcript** 模型（`tasks[].input` + `outputs[].steps`），它不承担：

```text
worker 生命周期 / 验收 / 交付物 / milestone / admission
durable 命令 / 幂等回执 / journal 恢复 / boot·generation
Hub 的 workflow、SQLite 投影、activity timeline
```

这些仍归 Conductor engine 与 GA-Hub。因此正确关系是**叠加**，不是替换：

```text
官方 hub        → 发现 / 监控面板 / abort / 模型切换 / 手机遥控
Conductor 协议  → 编排 / 验收 / journal / recovery（保留）
GA-Hub          → 产品 workflow / UI / 持久化（保留）
```

依赖方向约束：

- `frontends/gahub/*` → `frontends.hub`：允许；
- `frontends/hub.py`、`hub.html`、`hub_p2p.py`：不得出现 `gahub` / `GAHUB_` 专属逻辑；
- Conductor 专用投影只放 `frontends/gahub/hub_peer.py`。

实现细节、四个必须注意的坑（默认 `_put` 依赖活的 UI tab、面板不按 `caps` 隐藏发送框、
`put_task=None` 会导致 5 秒重连循环、`websockets` 缺依赖时静默失效）与分档验收，
见 `docs/plans/gahub-frontend-implementation-plan.md` 批次 7。

## 8. 最终判断

GA-Hub 与 GA 的理想关系不是：

```text
GA ← HTTP → Hub
```

也不是：

```text
Hub 尽量不 import GA
```

而是：

```text
GA 核心
  → 官方 frontend/bridge 能力
  → gahub 专用引擎扩展
  → GA-Hub 产品前端
```

其中：

- 主聊天等能力可以继续使用 GA 原生嵌入式 bridge；
- Conductor 作为 gahub 特殊能力走独立 HTTP/SSE；
- 监控与粗粒度遥控复用官方 `frontends/hub`，不自建第二套面板或远程隧道；
- Hub 负责产品体验、session metadata、workflow 和投影；
- GA 负责引擎执行状态、原生 archive、LLM runtime 和 frontend 适配；
- 两边通过 `GA-Hub Frontend Contract` 协作，而不是靠“尽量少 import”来假装独立。

最终验收标准应该是：

```text
gahub 作为 GA frontend 能正常复用 GA 能力
Hub 业务不用到处知道 GA 私有细节
GA 升级时有明确的 frontend contract 检查
Conductor 的 execution state 与 Hub workflow state 不混淆
文件和 journal 的 owner/读写规则清楚
不需要为了架构整洁重建 GA 核心或主 runtime
```
