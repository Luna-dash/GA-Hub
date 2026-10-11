# GA-Hub 项目结构与 GA 集成审查

审查日期：2026-10-10。GA-Hub 基线 `2ad063f`，配对 GA 基线 `cce32e2`；审查使用两个工作区的当前代码。GA 工作区已有 Memory 文件改动，本次没有编辑 GA 源码或这些文件。

初次审查交付为报告和待办登记；用户随后要求先优化非 Goal/Hive 部分，本日已实施 R1/R3/R5，详见文末实施记录。修复进度统一记在 [TODO_REMAINING.md](../plans/TODO_REMAINING.md)，下文问题描述及行号保留发现时的基线证据。

## 判断

现有顶层结构基本合理：React 产品界面、FastAPI 产品服务、Tauri 桌面宿主、GA 引擎分别有自己的位置。应继续采用既定的“主 Agent 进程内 bridge + Conductor HTTP/SSE”双连接面。没有证据支持全量 HTTP 化、合并两个仓库或重写技术栈。

主要问题是**执行主体已经迁移到 session，但部分控制入口、状态读取和另一条 Goal/Hive 执行链没有同步收敛**。这已产生可定位的行为缺陷，应先修这些问题，再整理目录。仅移动文件不会消除多个运行实例、两套取消语义和不同上下文清理规则。

本次确认 5 项应修复的问题，其中 3 项 P1、2 项 P2。P1 表示应优先处理的控制/兼容性缺陷，P2 表示状态或上下文一致性问题。结构建议单列，不把长文件本身当成缺陷。

## 已确认问题

### R1 · P1：命令面板“新对话”操作了旧全局 Agent

- 入口：[CommandPalette.tsx](../../webui/src/components/CommandPalette.tsx)，142–153 行。点击“新对话”后调用 `api.agentNew()`，再 `clearLocal()`、导航到 `/chat`。
- 服务端：[routes/agent.py](../../server/routes/agent.py)，23–24、44–47 行，实际对象是 `AgentService.instance()`。
- 正常主聊天入口：[LiveChat.tsx](../../webui/src/pages/LiveChat.tsx)，475–498 行，调用 `api.createSession()`，更新会话目录、当前 session id，并导航到新 session。
- `chatStore.clearLocal()`（[chatStore.ts](../../webui/src/stores/chatStore.ts)，1182 行）只清消息投影，保留当前 `sessionId` 和连接；后端 session 的实例由 `SessionRuntimeFactory` 另行创建。

**触发与影响：**已有聊天会话时，从 Ctrl+K 命令面板选择“新对话”。界面提示上下文已清空，但没有创建新 session，原 session 的上下文仍存在；随后发送可能继续原会话。与侧栏新建、`/new` 的语义不同。

**验证：**端到端源码调用链确认；隔离 HTTP 探针调用真实旧路由，返回 200，session 数量和元数据不变。探针替换了旧全局服务，没有启动真实模型；没有宣称已做桌面点击验收。

**修正方向：**把“创建并选中新 session”抽成一个应用动作，供侧栏、斜杠命令、命令面板共同使用。梳理旧 `/api/agent/*` 的真实消费者，逐个迁移后退役；模型目录和全局偏好不再依附一个可聊天的全局实例。

**验收：**在存在旧 session 的页面从命令面板新建，产生不同 id，新消息提交到新 id，旧 archive 完整保留；三个新建入口使用同一动作。

### R2 · P1：Goal/Hive 在任务入队但尚未执行时，停止无效

- [goalhive_service.py](../../server/services/goalhive_service.py)，336 行直接 `agent.put_task()`；454–463 行 `abort()` 只调用 GA `abort()`，随即 `_finish_active_messages()`。
- GA 的 `agentmain.py`，112–113 行：`abort()` 在 `is_running == False` 时立即返回。131–134 行的 `put_task()` 只是把任务放进队列，运行线程稍后才取出并设置运行标志。
- 主聊天已有 [session_coordinator.py](../../server/services/session_coordinator.py) 的准入和 starting/aborting 生命周期；Goal/Hive 未复用这部分控制语义。

**触发与影响：**提交后、GA runner 取到队列项之前点击停止。界面已经显示不再运行，但排队任务仍会执行。对已经运行但未停止的任务，当前实现也会提前释放 UI 活动标记，使“停止请求”和“停止完成”混为一谈。

**验证：**用可控的假 GA runner 固定上述时间窗口，实际执行 `GoalHiveService.submit()` 和 `abort()`。结果：`visible_running_after_abort=false`、`pending_after_abort=1`、`executed_after_abort=true`。假对象的 idle abort 行为与配对 GA 源码一致，没有执行真实任务。

**修正方向：**保留 Goal/Hive 独立实例与 owner，复用经过验证的准入、取消和完成确认机制。取消必须覆盖排队/创建/执行阶段；释放活动状态应以 worker 完成为依据。

**验收：**入队前后、runner 启动前后、执行中三类停止用例都受控；取消后未开始的任务不执行；未退出的 worker 不允许 reset 或新的冲突操作。

### R3 · P1：GA 契约诊断没有成为真正的启动与提交门禁

- [main.py](../../server/main.py)，535–578 行在 `create_app()`/模块加载期间导入全部正常模式路由。
- [agent_service.py](../../server/services/agent_service.py)，27–39 行提前导入 bridge 符号；其他路由也在导入期间依赖 GA。
- 契约检查在 `main.py` 的 lifespan 内、347 行才执行；失败后仅记录日志，363 行仍继续创建 `AgentService` 和后续服务。
- [routes/sessions.py](../../server/routes/sessions.py)，319–339 行提交直接进入 coordinator；`SessionLifecycle`、系统 channel 和 Goal/Hive 也没有消费 `app.state.core_contract` 的失败状态。
- 全仓检索 `core_contract_failed`，当前只有注释/日志/诊断说明，没有对应的请求拒绝实现。

**触发与影响：**更换/升级到缺少 bridge 模块的 GA，后端会在应用创建前失败，无法打开承诺的诊断接口；若不兼容项未阻止导入，健康检查可以显示失败，但聊天仍被受理，直到更深层调用出错。

**验证：**模拟缺少 `frontends.gahub.bridge.runtime`，导入 `server.main` 得到 `ModuleNotFoundError`，app 未创建。另用真实 `create_app()` 和真实 session 路由、假 coordinator，设置契约 `ok=False`，提交仍返回 **202 / running**，coordinator 被调用 1 次。探针跳过 lifespan，避免启动真实 Agent、机器人或定时任务。

**修正方向：**先建立与 GA 解耦的 setup/health 外壳，再探测能力，再装配可用的运行服务。将不可用状态接入共享的准入层，覆盖 HTTP、系统 channel 和独立 runtime；检查失败时保持诊断可访问。可选能力应按域降级，避免一个可选模块故障封锁所有页面。

**验收：**缺模块、缺符号、probe 异常三类场景仍能访问 setup/health；不可用能力的提交稳定拒绝且没有创建 runtime/入队副作用。

### R4 · P2：Goal/Hive 重置没有清除 GA 的完整上下文

- [goalhive_service.py](../../server/services/goalhive_service.py)，465–476 行只清 `messages` 和 `agent.history`。
- GA `frontends/continue_cmd.py`，1053–1064 行的原生清理还会清各 LLM `backend.history`、`last_tools` 和 `agent.handler`；1082 行的 `begin_fresh_session()` 进一步处理归档和锁。
- GA `agentmain.py` 在下一次 run 中会延续 `handler.working['key_info']`，因此 handler 残留直接影响后续任务上下文。

**触发与影响：**Goal/Hive 已有对话后点击重置，再发起新目标。界面消息消失，但模型仍可能收到上一任务的聊天历史、工具状态和工作记忆。

**验证：**给真实 `GoalHiveService.reset()` 注入带历史和 handler 的假 agent：摘要数变成 0，`backend.history` 仍有 1 项，handler 和工具状态均保留。再调用 GA 原生纯清理 helper，三者均清空。没有调用真实模型或变更 GA 归档。

**修正方向：**通过现有 GA session bridge 执行完整的新会话语义，Hub 负责产品消息状态；不要在 Hub 再复制一份清理字段清单。与 R2 一起处理，确保 worker 完成后才能重置。

**验收：**除了界面消息为空，还应检查下一次模型调用的输入、工作记忆、archive 绑定，以及运行中 reset 的拒绝行为。

### R5 · P2：状态面板的 Agent 活动读的是旧全局实例

- [service_registry.py](../../server/services/service_registry.py)，101–118 行只读取 `AppServices.agent` 或 `AgentService._instance`。
- [main.py](../../server/main.py)，363–364 行放入的是全局实例；聊天、定时聊天等的真实运行实例在 `SessionLifecycle.coordinator()` 内。
- [Dashboard.tsx](../../webui/src/pages/Dashboard.tsx) 的“当前活动”和 Agent 行依赖该 service panel。

**触发与影响：**某个聊天 session 正在运行，而旧全局 Agent 空闲，状态面板仍显示 Agent“等待任务”、队列/上下文为全局对象的数据。该面板不能准确回答用户当前是否有聊天任务在执行。

**验证：**隔离探针让 session coordinator 受理一个 running 任务，同时给 registry 一个空闲全局实例，实际读取结果为 `ready / 等待任务`。源码确认 registry 没有查询 session coordinator。

**修正方向：**聚合 session runtime 的 running/starting/aborting 状态，模型目录状态另行表达；status 读取只观察已有实例。与 R1 一起收敛旧全局 Agent 的职责。

**验收：**至少覆盖两个不同 session 同时活动、停止中、全部空闲，面板统计与 `/api/session-runtimes` 一致。

## 结构与代码质量评估

### 应保留的设计

| 现有设计 | 审查判断 |
|---|---|
| GA bridge 与 Conductor HTTP/SSE 两条连接面 | 与 GA 对象生命周期及独立引擎的实际形态相符，继续使用 |
| GA 原生 archive 是主聊天持久正文真源 | 避免双写消息数据库；Hub 保留元数据和界面投影合理 |
| `SessionLifecycle` + `SessionCoordinator` | 所有权与准入已集中，适合作为控制入口收敛的基础 |
| `conductor_protocol` / journal recovery / operation receipt | 处理真实进程边界和恢复问题，不是可随意删去的抽象 |
| `SchedulerHost` 和共享调度基类 | 已有统一基础，不应再因为页面名称不同复制调度机制 |
| 生成 OpenAPI/TS 契约、GA 边界测试、仓根卫生测试 | 有效护栏；当前缺口在跨入口行为集成，而非单纯缺测试数量 |
| 唯一构建入口、产物守卫、子进程所有权管理 | 具有事故背景与测试，应保留契约后再考虑代码拆分 |

### 优先减少职责交叉，再调整目录

源文件规模（物理行数，含注释；Rust 还含内嵌测试）：`server` 86 个 Python 文件 / 25,005 行；`webui/src` 排除测试与 `.d.ts` 后 109 个 TS/TSX 文件 / 18,921 行。`server/services` 有 54 个模块。规模只用于定位阅读热点。

| 热点 | 当前职责与建议边界 |
|---|---|
| `agent_service.py`，1,203 行 | 工具宿主补丁、运行实例、模型展示、流转发、重试、续接、rewind 汇集。先拆出显式的 GA 宿主装配和模型目录，再让 session runtime 专注执行；保留已抽出的 retry/projection/rewind 组件 |
| `conductor_service.py`，1,419 行 | 已有 commands/recovery/store/kernel 分工。应继续缩小 facade 到装配、协调和产品入口；不要把 GA 调度引擎搬回 Hub，也不要简单再包一层空 service |
| `chatStore.ts`，1,224 行 | 历史分页、连接恢复、消息归约、活动会话与视图缓存并存。先分离纯消息归约与历史加载，保持一个明确的活动 session owner，避免拆成多个相互订阅的 store |
| `LiveChat.tsx`，864 行 | 会话选择、新建、模型修复、发送、附件、定时与页面渲染。抽出共享 session actions 后再拆 hook，R1 就是缺少共享动作的实际后果 |
| `archive_messages.py`，868 行 | Hub 承担有界分页、索引和展示适配有合理性，但仍识别 GA 原始块格式与错误提示。与 GA 协调增加结构化结果后，逐步去掉正文/错误文案匹配；不能为了“薄”改回整文件读取 |
| `src-tauri/src/main.rs`，1,980 行 | 进程所有权、生命周期状态机、readiness、调试桥、窗口和命令并存。可按这些边界拆模块，必须保留退出/重启/产物契约，不作为本轮修复的前置条件 |

建议目标目录如下，按触及的业务域渐进迁移；并非要求一次性移动所有文件：

```text
server/
  main.py                   # setup/health 外壳与应用装配
  routes/                   # HTTP/WS 校验和协议映射
  services/
    sessions/               # 会话元数据、准入、runtime、消息投影
    goalhive/               # 独立 owner，复用 runtime 生命周期机制
    conductor/              # 产品 workflow、投影、命令和恢复
    scheduling/             # scheduler host 与各触发策略
    configuration/          # MyKey、偏好、授权编辑
  integrations/             # 实际需要的 GA 宿主适配、外部进程、IM
webui/src/
  features/
    chat/                   # 页面、session actions、store、专用组件
    conductor/
    goalhive/
    conversations/
    settings/
  api/                      # HTTP 与生成契约
  runtime/                  # 桌面/共享连接设施
  components/               # 真正跨业务使用的 UI 原语
  utils/                    # 真正通用的纯函数
```

`integrations` 只容纳现有的宿主适配和外部边界，不给每个 GA bridge 方法机械增加一层透传。GA 的 session/archive/model 语义继续归 GA；Goal/Hive 保持独立运行实例；Conductor workflow 是合法的 Hub 产品投影，不能因两仓都有状态类就判为重复引擎。

### GA 边界仍有需要收口的债务

1. Hub 已登记 9 条 direct-import 债务，当前静态护栏能防新增，但不等于所有对象操作都已经收口。例如 `project_runtime.py` 仍直接写 `_ga_project_mode_name`；GA 的 `plugins/project_mode.py` 正在读取该字段，当前兼容，不应误报已失效。
2. `agent_service.py` 在导入时调用 subprocess/web tool patch，替换 GA 模块成员；这是桌面外部 Python 环境的真实需求。建议移到显式、幂等的宿主装配动作，GA 侧提供受控注入点，保留现有不修改全局 `subprocess.Popen` 的保护。
3. `routes/tokens.py` 在导入时调用 usage 初始化并打开 GA token ledger。导入路由因此不只是声明 API；这与 R3 的提前导入问题共同造成环境和测试耦合。初始化归 lifespan/适配器 owner，查询路由只读状态。
4. `core_contract` 检查符号存在性，paired tests 比对协议常量和部分文案，但不能代替真实操作的参数与行为契约。优先补充跨新建入口、取消窗口、完整 reset 和失败启动的行为验证。

### 测试与文档需要按现状整理

- 后端单元、配对契约、进程/桌面集成测试目前同处 `tests/`，模块导入又依赖 GA，导致没有 GA 的 CI 不能独立采集大部分后端用例。先消除导入期副作用，再明确这些测试的环境要求；不要用统一 skip 掩盖必须执行的 GA 契约检查。
- `docs/plans/TODO_REMAINING.md` 的历史条目仍包含已完成的“生成 TS 契约新鲜度检查”“conftest 零共享 fixture”等描述。当前 `check-api-contract.mjs` 已生成临时类型并比对，`tests/conftest.py` 已有 session domain fixture。它们不能作为新缺陷重复施工。
- 同一文件的 W3.5 虽标完成，direct-import/宿主 patch 等债务仍有实际代码，应区分“本轮迁移完成”和“边界完全收口”。归档保留证据，活待办按可验证的验收标准更新。
- 当前仓根 git 状态没有未跟踪散件。已有 ignored 日志/缓存不构成新的 git 卫生失败，本轮未移动或删除现有本地资料。

## 建议执行顺序

| 批次 | 范围 | 验收边界 |
|---|---|---|
| A | R1 + R5：统一会话控制与状态来源 | 新建操作与统计都指向真实 session；旧全局端点消费者有明确清单 |
| B | R2 + R4：Goal/Hive 生命周期 | 独立 owner 保留；入队取消、执行中停止、完整 reset 有行为测试 |
| C | R3：可诊断启动与准入门禁 | 先探测后装配；不兼容时诊断可访问、提交无副作用 |
| D | 收拢 GA 宿主适配、业务目录、测试分层 | 每批只迁移一个域；公共行为和现有契约保持通过 |
| E | 修正文档现状、再评估桌面模块拆分 | 活待办有证据；无第二份进度真源；构建纪律不变 |

目录迁移涉及新增 Python 子包时，需要同步检查 `pyproject.toml` 当前显式 packages 清单及 sidecar 打包发现方式。这属于构建链相关变更，届时必须先按 [BUILD.md](../BUILD.md) 验收，不能只用开发环境可 import 判断交付成功。

## 验证与限制

| 检查 | 结果 |
|---|---|
| 后端现有全量测试，配对 `D:\study\GA` | **1155 passed, 3 skipped, 38 subtests passed**；10 条弃用警告 |
| 前端现有全量 Vitest | **68 文件，551 tests passed** |
| TypeScript `tsc -b --noEmit` | 通过 |
| `api:check` | 89 个前端 HTTP 调用形状匹配 136 个 OpenAPI operation；生成类型新鲜度通过 |
| 隔离行为探针 | R2/R3/R4 确定性复现；R1/R5 由源码链和隔离 endpoint/registry 检查确认 |

后端最终使用 `D:\APP\anaconda3\envs\ga\python.exe`、隔离 `GA_ADMIN_DATA` 和临时目录。系统默认 Python 首次因缺依赖出现 36 个采集错误；沙箱中的前端子进程和后端临时目录曾分别触发 EPERM/WinError 5，获准重跑后通过。这些环境错误不计为项目功能缺陷。

复核材料位于已忽略的 `temp/`：

- `temp/review-20261010/reproduce_findings.py`：`state` / `missing-bridge` 两种探针。
- `temp/review-20261010/probe-state.jsonl`、`probe-missing-bridge.jsonl`：最终复核结果。
- `temp/review-20261010-backend-verified.log`、`temp/review-20261010-frontend.log`：现有套件结果。

探针通过假 runtime/可控队列验证控制行为；未发送真实模型请求或 IM 消息。没有构建桌面产物，没有做桌面 UI、真实模型长跑或所有页面的交互验收。现有套件全绿证明当前覆盖的场景通过，不代表本报告列出的跨入口缺口不存在。

## 同日实施记录：非 Goal/Hive 优化

用户指定暂不修改 Goal/Hive。本批完成 R1/R3/R5 及直接相关的初始化整理；Goal/Hive 实现、页面及专属测试均未改动，R2/R4 保留为暂缓事项。

1. **统一主聊天新建入口。** `queries/sessions.ts` 提供共享 `createAndOpenSession`，由命令面板、聊天侧栏和 `/new` 使用。创建失败不清理旧投影；创建期间用户切换会话时，仅登记已创建的 session；取消过期目录请求，避免迟到的列表响应覆盖新会话。命令面板按当前 session 的稳定模型 key 创建，移除前端 `api.agentNew` 封装。旧服务端兼容端点和全局模型配置实例仍保留，未宣称全局 Agent 已完全退役。
2. **让 GA 兼容性检查控制启动与准入。** 正常路由先整体收集再注册；导入失败保留 setup、health、事件和静态外壳，并将原因写入契约报告。lifespan 探测成功后才创建运行实例与任务生产者。共享 ASGI 层对不兼容的普通 HTTP API 返回结构化 503，运行 WebSocket 使用 1013；来源校验继续生效。session lifecycle 同时阻止后台生产者绕过 HTTP 准入，系统会话在拒绝前不写元数据。OpenAPI 导出器拒绝用不完整的降级路由覆盖正式契约。
3. **状态面板观察真实 session。** 由应用注入 session lifecycle，从 coordinator 获取不可变状态快照；分别统计 starting/running/aborting/error，异常显示需处理。读取状态不构造 coordinator 或 GA runtime。现有全局 Agent 状态兼容接口未改成含义模糊的多会话聚合对象。
4. **减少导入阶段的运行副作用。** GA subprocess/web tool 补丁移到实际 Agent 构造阶段；用量台账初始化显式归 lifespan。新的独立 Python 进程测试确认，仅导入应用不会安装这些工具补丁或初始化台账。
5. **修复回归时发现的 Windows 配置保存问题。** 并发配置测试中的工作线程曾遇到 WinError 5，却只留下 warning。测试改为通过 Future 传播异常，保存逻辑对 WinError 5/32/33 的原子替换最多尝试 6 次、累计等待最多 0.31 秒。失败时旧配置保留且错误继续向上传播；未改成覆盖写入，也不无限重试。

结构仍采用“主运行能力通过 GA bridge；Conductor 通过 HTTP/SSE”。本批收拢实际重复动作和启动装配职责，大型业务目录迁移与 facade 拆分留待对应模块后续触及时处理。没有改 GA 源码，没有制作桌面发布产物。

### 实施后验证

| 检查 | 结果 |
|---|---|
| 后端全量 pytest（配对当前 GA；未处理线程异常按失败处理） | **1169 passed, 3 skipped, 38 subtests passed**；仅 10 条原有弃用警告 |
| 前端全量 Vitest | **69 文件，559 tests passed** |
| TypeScript `tsc -b --noEmit` | 通过 |
| OpenAPI 快照与前端 `api:check` / 生成类型新鲜度 | 通过；包含于后端全量契约测试 |
| `git diff --check` | 通过 |
| Goal/Hive 实现、页面及专属测试的 diff | 无变更 |

新增行为验证包括命令面板实际点击、新建失败/选择竞争/旧目录响应竞争、多个会话同时启动与运行、停止和停止超时、缺失 bridge 的全新进程启动、探测异常与路由导入异常、诊断可达与运行拒绝、后台提交拒绝前零元数据写入、导入无工具补丁/台账初始化、配置临时占用与永久拒绝。

最终日志：`temp/optimize-20261010-verified/backend.log`、`temp/optimize-20261010-frontend-final.log`。未进行真实模型请求、IM 发信、桌面打包或桌面 E2E；这些验证范围与初次审查一致。

### 独立复审补修：异步新建的导航归属

复审发现 P2：只比较当前会话 ID，不能阻止用户离开聊天页、往返原页或组件卸载后，迟到的新建响应抢占导航。用户要求继续完成后，新增共享 `useSessionSelectionGuard`：首次 await 前捕获授权；路由变化、会话变化和卸载永久撤销旧授权。会话变化采用 store 同步订阅，覆盖 React 批处理下同一 tick 的 A→B→A。

命令面板、聊天侧栏及 `/new` 接入授权；无会话首次发送的创建分支也接入，离页后不迁移草稿、不提交消息。共享新建动作仍把服务端已创建会话登记到列表，但不强制选中；不尝试删除迟到创建的会话。

验证：命令面板新增四个回归用例修复前全部失败、修复后通过；该文件 7 项通过，共享 sessions 测试 8 项通过。新增真实 LiveChat 组件测试 4 项，保留真实路由和 store，桩化网络、WebSocket 副作用和展示子组件，覆盖正常新建、离页后不选中、正常首次发送、离页后保留草稿且不发送。

最终前端全量 **70 文件 / 567 tests passed**；`tsc --noEmit` 和 `tsc -b --noEmit` 均 rc0；隔离 Vite 构建 rc0，产物 index.html 已核验；`git diff --check` 通过。证据及隔离产物：`temp/navigation_guard_fix/`。构建保留 Browserslist 数据过旧及动态/静态混用的非阻断警告。

本补修仅涉及前端导航竞争，没有重跑后端套件、修改 Goal/Hive 或 GA core、重启当前宿主、桌面打包、真实模型请求、提交或 push；桌面运行时验收仍未进行。
