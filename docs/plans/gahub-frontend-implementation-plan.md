# GA-Hub 特殊 Frontend 依赖治理实施方案

- 日期：2026-09-18
- 适用仓库：`D:\study\GA`、`D:\study\GA-Hub`
- 架构定位：`gahub` 是 GA 的特殊 frontend；GA 侧提供定制引擎桥，Hub 侧提供产品后端与 WebUI
- 核心约束：不拆主 Agent runtime、不把全部调用改成 HTTP、不大改 GA 核心、不搬走 `frontends/gahub/`
- 依赖硬规则：**gahub 可以依赖 GA core / 通用 bridge / 通用 frontend 组件；GA core 和通用组件不得依赖 gahub 功能**
- 本文用途：作为可逐批执行、逐批验收、逐批回滚的实施单

### 依赖方向的准确含义

允许：

```text
GA core / 通用 frontend substrate
        ↑
frontends/gahub（特殊 frontend）
        ↑
GA-Hub backend / webui
```

禁止：

```text
agentmain / llmcore / agent_loop  → frontends.gahub
通用 frontend 组件               → gahub 专属状态、事件或产品逻辑
```

例外只允许出现在**组合入口和兼容 shim**：

- `frontends/gahub_app.py` 启动 `frontends.gahub.gahub_app`；
- `frontends/conductor_core.py` 作为既有兼容别名转发到 gahub core；
- GA 测试导入 gahub 模块。

这些入口加载特殊 frontend，不代表 GA core 反向依赖它。例外必须白名单化，不能扩散。

当前一处需要治理的语义反向依赖是 `frontends/fsapp.py` 输出 `__GAHUB_FEISHU_CHAT__`：
通用飞书 frontend 已经知道 gahub 专属协议。建议迁成通用 `__GA_FRONTEND_EVENT__` envelope，
Hub 一个兼容周期同时接受新旧 marker，之后删除旧 marker。

---

## 1. 实施目标

本轮不是降低 GA-Hub 对 GA 的功能依赖，而是把依赖治理成一条受支持的 frontend 链路：

```text
GA Core
  ├─ 官方通用能力：GeneraticAgent / continue / worldline / llmcore
  ├─ gahub frontend bridge：GA-Hub 需要的稳定调用面
  └─ gahub Conductor engine：HTTP/SSE 专用执行面

GA-Hub
  ├─ 主 Agent 产品逻辑：聊天、session、调度、GoalHive
  ├─ archive/config 展示与管理逻辑
  ├─ Conductor workflow / persistence / UI projection
  └─ WebUI
```

完成后的具体结果：

1. GA-Hub 仍可直接嵌入 `GeneraticAgent`，但不再从十几个位置随意依赖 GA 私有实现；
2. GA 通过一个轻量 `gahub_bridge` 模块声明这个特殊 frontend 使用的稳定能力；
3. Hub 的 `core_contract` 能在启动和测试时指出具体哪项 GA 能力不兼容；
4. Conductor 保持独立进程，但健康握手、事件和命令契约可验证；
5. memory、mykey、temp、journal 的实际读写规则与产品文案一致；
6. 每批改动可以独立提交和回滚，不要求两仓一次性大迁移。

---

## 2. 本轮明确不做

1. 不建设新的通用 `GA Runtime Host`；
2. 不把普通聊天、session、archive、rewind 改成 HTTP；
3. 不用 Conductor `/models` 替代主 Agent 模型状态；
4. 不把 `frontends/gahub/` 改名或搬出 GA；
5. 不合并 `frontends/conductor.py` 与 `frontends/gahub/`；
6. 不改变 native archive 格式；
7. 不改变用户可见 API 和 WebUI 行为，除 memory 页面增加真实的工作区提示；
8. 不要求 GA-Hub 对 GA “零 import”或“零文件访问”；
9. 不让 GA core、通用 frontend 或通用数据模型 import `frontends.gahub`；
10. 不把 gahub 专属 marker/event 名称继续扩散到通用 frontend。

---

## 3. 最终代码形态

### 3.1 GA 侧增加一个轻量官方桥

新增：

```text
GA/frontends/gahub_bridge.py
```

它是 `gahub` frontend 的嵌入式调用面，不是新服务，也不持有新的状态。
它只做三件事：

1. 将 GA-Hub 已经使用的能力用非私有名称暴露出来；
2. 将少量私有字段操作封装在 GA 仓内；
3. 声明 API version 和 capabilities，供 Hub probe。

建议首版接口：

```python
FRONTEND_API_VERSION = 1
FRONTEND_CAPABILITIES = frozenset({...})

# Agent/runtime
GeneraticAgent
install_agent_extensions(agent_cls)
register_turn_end_hook(agent, owner, callback)
unregister_turn_end_hook(agent, owner)
invalidate_model_config()

# Session/archive
new_native_log_path()
list_native_sessions()
restore_native_session(agent, path)
continue_native_session(agent, path)
begin_fresh_session(agent)
release_native_session(agent)
archive_occupant(path)
archive_lock_path(path)
extract_native_ui_messages(text_or_path)
parse_native_log(path, *, allow_empty=False)

# Workspace / frontend helpers
workspace_list()
workspace_prepare(path)
workspace_remove(name)
public_access_policy(...)

# Usage
install_usage_tracker()
init_usage_ledger(ga_root)
read_usage_ledger()
```

注意：首批只加入迁移实际需要的接口，不为“以后可能用”预先包装全部 GA。

### 3.2 Hub 侧保留现有业务 service

不建立厚重的新架构层。现有 service 继续负责产品逻辑：

- `AgentService`：主 runtime 生命周期和流式投影；
- `archive_messages.py`：Hub 消息投影、分页、搜索；
- `SessionRuntimeFactory`：Hub session 与 GA native session 的绑定；
- `RewindAdapter`：Hub rewind 产品语义；
- `mykey_service.py`：编辑、校验、备份和 UI 响应；
- `llm_registry.py`：Hub 的稳定 assignment key；
- `ConductorService`：workflow、命令持久化和页面投影。

这些模块只把“如何触碰 GA 内部”的部分改为调用 `frontends.gahub_bridge`。

### 3.3 契约所有权

| 契约 | owner | 消费方 |
|---|---|---|
| 嵌入式 bridge API | GA `frontends/gahub_bridge.py` | Hub `core_contract`、services |
| Hub 对 bridge 的必需能力集合 | Hub `core_contract.py` | Hub 启动与测试 |
| Conductor protocol/capabilities | GA `frontends/gahub/gahub_app.py` | Hub `conductor_client/recovery` |
| workflow 状态与命令持久化 | Hub | WebUI、Hub recovery |
| worker 真实执行状态 | GA Conductor engine | Hub mirror |
| native archive 格式 | GA | Hub archive projection |
| memory/mykey 编辑体验 | Hub 产品层 | GA 文件与 runtime |

Provider 可以提供更多能力；Consumer 只要求自己实际依赖的子集。因此 GA 与 Hub 不需要复制完全相同的“大清单”。

---

## 4. 分批实施

## 批次 0：基线和文档纠偏（仅 Hub，零行为变更）

### 目标

先让仓库描述与真实产品定位一致，为后续代码迁移建立静态闸门。

### 修改文件

- `README.md`
- `pyproject.toml`
- `server/_paths.py`
- `docs/architecture/GA_HUB_DEPENDENCY_PLAN.md`
- 新增 `tests/test_ga_frontend_boundary.py`

### 具体改动

1. 将 `README.md` 的“磁盘零侵入、从不写 GA 目录”改为：
   - GA-Hub 是 GA 的配套 frontend；
   - 会受控读取 GA runtime data；
   - 会编辑 `mykey.py` 和 memory；
   - Hub 自己的 metadata/DB/uploads 放在 `ADMIN_DATA`。
2. 修改 `pyproject.toml:4` 的错误描述 `never modifies the GA repo`。
3. 修改 `_paths.py:36-37` 的绝对承诺，改成分级文件规则。
4. 新增静态测试，维护两组 allowlist：
   - 允许 import GA 模块的当前文件；
   - 允许写入 GA 跟踪/非跟踪路径的入口。
5. 静态测试只阻止**新增未登记依赖**，不要求首批立即清零当前调用点。

### 测试

```powershell
python -m pytest tests/test_ga_frontend_boundary.py tests/test_import_direction.py tests/test_core_contract.py -q
```

### 验收

- 用户文档不再声称零侵入；
- 新增 GA import 或 GA 文件写入口时，测试要求显式登记；
- 无生产行为变化。

### 回滚

整批可直接 revert，不影响运行数据。

---

## 批次 1：GA 发布 `gahub_bridge` v1（仅 GA，不切调用方）

### 目标

在不改变现有运行逻辑的前提下，为特殊 frontend 建立正式嵌入式调用面。

### 修改文件

- 新增 `GA/frontends/gahub_bridge.py`
- 新增 `GA/tests/test_gahub_bridge.py`
- 更新 `GA/frontends/ga_contract_probe.py`

### 首批接口范围

只覆盖低风险、已有调用：

```text
版本/capability
workspace registry
cost tracker ledger
mykey invalidation
turn-end hook 注册/释放
native log path
archive session list/restore
archive lock path/occupant
continue/begin/release session
```

rewind 的 `worldline` 操作先不包装，留到批次 3；避免首批桥模块过大。

### 实现原则

- bridge 函数内部调用现有 GA 函数，不复制实现；
- 不构造全局 Agent；
- import bridge 不启动 FastAPI、不创建 Conductor service、不启动线程；
- 不 import `frontends.gahub` package，避免其当前 `__init__.py` 导入 `gahub_app` 的副作用；
- 旧调用面保持可用。

### GA 测试

```powershell
python -m pytest tests/test_gahub_bridge.py tests/test_gahub_app.py tests/test_gahub_reliability.py -q
```

### 验收

- `import frontends.gahub_bridge` 无线程、端口、文件写入副作用；
- bridge version/capability 可读；
- wrapper 的参数和返回值与现有 GA helper 一致；
- GA 现有 frontend 测试通过。

### 回滚

这是纯新增模块；Hub 尚未切换，直接删除即可。

---

## 批次 2：Hub 切换低风险桥接点（Hub）

### 目标

先迁移不涉及 Agent 生命周期的孤立 import，验证 bridge 模式是否合适。

### 修改文件

- `server/routes/sessions.py`
- `server/routes/tokens.py`
- `server/services/archive_import.py`
- `server/services/archive_messages.py`
- `server/services/core_contract.py`
- 对应测试

### 具体改动

1. `sessions.py`：
   - 去掉模块级 `from frontends import workspace_cmd`；
   - 改用 `gahub_bridge.workspace_list/prepare/remove`。
2. `tokens.py`：
   - 去掉裸 `import cost_tracker`；
   - 改用 bridge 的 install/init/read 函数；
   - 保持 API 返回结构不变。
3. `archive_import.py`：
   - `_new_log_path` 改为 `new_native_log_path()`。
4. `archive_messages.py`：
   - list/restore/UI extraction 改为 bridge；
   - Hub 自己的分页、索引、搜索逻辑不动。
5. `core_contract.py`：
   - 检查 `FRONTEND_API_VERSION == 1`；
   - 检查 Hub 需要的 capability 子集；
   - 失败信息指明缺失的 bridge capability。

### 兼容策略

本批不做 fallback 到旧私有 import。要求配套 GA bridge 已存在；否则 `/api/health/core-contract` 明确返回不兼容，主聊天保持现有 503 gate。

如果需要支持旧 GA 一个 release，可只在 `core_contract` 明确报“GA 版本过旧”，不要在各业务文件分别写 fallback。

### Hub 测试

```powershell
python -m pytest tests/test_core_contract.py tests/test_sessions_api.py tests/test_token_persistence.py tests/test_conversation_import.py tests/test_archive_message_paging.py tests/test_archive_folding_consistency.py tests/test_conversations_index.py tests/test_conversations_search.py -q
```

### 两仓联跑

```powershell
$env:GA_ROOT='D:\study\GA'
python -m pytest tests/test_core_contract.py tests/test_sessions_api.py tests/test_token_persistence.py -q
```

### 验收

- `sessions.py` 和 `tokens.py` 不再依赖 sys.path 中来源不明的裸模块；
- archive API、分页、搜索、导入行为不变；
- core contract 对旧 GA 给出明确诊断。

### 回滚

回滚 Hub 调用点即可；GA bridge 保留不会影响旧路径。

---

## 批次 3：Session/Archive 生命周期桥接（GA + Hub）

### 目标

把 session restore、lock、fresh session 和 rewind 使用的 GA 私有细节收回 GA bridge，但不改变 Hub 的 session 产品模型。

### GA 修改

扩展 `frontends/gahub_bridge.py`：

```text
continue_native_session
begin_fresh_session
release_native_session
archive_occupant
archive_lock_path
parse_native_log
bind_rewind_store
sync_rewind_store
restore_turn
```

其中 rewind wrapper 可以直接调用现有 `worldline`，返回 Hub 需要的中性结果；不要让 Hub 再写 `agent._rw_store`。

### Hub 修改文件

- `server/services/session_runtime_factory.py`
- `server/services/rewind_adapter.py`
- `server/services/archive_messages.py`（剩余 restore）
- `server/services/archive_import.py`（如仍有私有 helper）

### 保留在 Hub 的策略

以下仍由 Hub 决定，不下沉到 GA：

- dead PID 判定；
- 不可读 archive 的备份文件名与 session rebind；
- Hub session metadata；
- rewind 后的 UI snapshot/event；
- 409/500 等 HTTP 错误映射。

GA bridge 只负责 GA native 操作。

### 测试

GA：

```powershell
python -m pytest tests/test_gahub_bridge.py -q
```

Hub：

```powershell
python -m pytest tests/test_session_runtime_factory.py tests/test_rewind_turns.py tests/test_conversation_import.py tests/test_agent_service_session_identity.py tests/test_session_runtime_api.py -q
```

### 验收

- Hub 不再 import `_lock_path`、`_new_log_path`、`parse_native_log`、`frontends.worldline`；
- restore/rewind 的 session identity、归档备份和错误语义不变；
- 一个 session 仍只有一个 runtime owner。

### 回滚

GA 保留 wrapper；Hub 回退到旧调用。native archive 没有格式变化，无数据迁移回滚问题。

---

## 批次 4：主 Agent runtime 高风险私有访问收口（GA + Hub）

### 目标

处理真正影响 GA 升级稳定性的私有 hook 和 process-wide patch，但不改变 `AgentService` 的业务职责。

### GA bridge 增加

```text
create_agent() 或 GenericAgent alias
install_agent_extensions()
register_turn_end_hook()
unregister_turn_end_hook()
invalidate_model_config()
resolve_model_assignment()
```

是否提供 `create_agent()`：

- 若只需构造默认 `GenericAgent`，提供 factory；
- 测试注入仍允许 Hub 给 `AgentService(agent=...)`；
- 不把 AgentService 的线程、EventBus、retry 逻辑下沉到 GA。

### Hub 修改文件

- `server/services/agent_service.py`
- `server/services/goalhive_service.py`
- `server/services/llm_registry.py`
- `server/services/mykey_service.py`
- `server/services/ga_subprocess_patch.py`
- 必要时 `server/services/ga_external_worker.py`

### 具体改动

1. `AgentService` 通过 bridge 安装 continue extension 和 turn-end hook；
2. shutdown 时通过 bridge 注销 hook，防止 test/app lifespan 残留；
3. `llm_registry` 不直接写 `_mykey_mtime`；
4. `mykey_service.test_session_sync` 通过 bridge resolve client；
5. GoalHive 通过相同 factory 构造 Agent，但仍拥有独立 instance/thread；
6. `ga_subprocess_patch` 若必须保留 monkey patch，将 patch 入口纳入 bridge capability；
   不需要把 Windows/macOS 的 Hub-specific policy 放进 GA 核心。

### 测试

```powershell
python -m pytest tests/test_service_lifecycle.py tests/test_agent_service_session_identity.py tests/test_on_turn_end.py tests/test_llm_registry.py tests/test_llm_ping_silence.py tests/test_preferred_llm_cache.py tests/test_paths_python.py tests/test_goalhive_service_lifecycle.py tests/test_goalhive_model_selection.py -q
```

### 验收

- Hub 业务代码不再直接修改 `_turn_end_hooks`、`_mykey_mtime`；
- AgentService、GoalHive 仍然是两个独立 Agent owner；
- 模型切换、mykey reload、web tools、code_run 行为不变；
- app shutdown 后 hook/thread/child 无残留。

### 回滚

按功能分两次提交更安全：

1. hook/factory；
2. llm/mykey/patch。

任一提交可以单独回滚。

---

## 批次 5：Conductor Wire Contract 收口（GA + Hub）

### 目标

保持 `gahub_app` 专用引擎定位，只把跨进程契约变成可立即验证的 frontend contract。

### GA 修改文件

- `frontends/gahub/gahub_app.py`
- 可新增 `frontends/gahub/gahub_contract.py`
- `tests/test_gahub_app.py`
- `tests/test_gahub_reliability.py`
- `tests/test_conductor_journal.py`

### Hub 修改文件

- `server/services/conductor_client.py`
- `server/services/conductor_recovery.py`
- `tests/test_conductor_service_surface.py`
- `tests/test_conductor_hub_engine_chain.py`
- `tests/test_conductor_asgi_contract.py`
- `tests/conductor_engine.py`

### 具体改动

1. GA 抽出单源常量：
   - `PROTOCOL_VERSION`；
   - capabilities；
   - action canonical names/aliases；
   - durable event names；
   - completion marker aliases；
   - journal format version。
2. `/health` 与 `/recovery` 从同一 contract 常量生成声明。
3. Hub 抽一个 validator：
   - `/health` 200 后立即校验 version + required capabilities；
   - `/recovery` 复用 validator，再校验 boot/path/journal 恢复信息。
4. `GahubProcessManager.is_healthy()` 不再把任意 200 当兼容；
   建议拆成：
   - `is_reachable()`：仅网络可达；
   - `probe_health()`：返回并校验 envelope；
   - `ensure_running()`：只有 probe 通过才 ready。
5. `test_conductor_asgi_contract.py` 继续作为 paired-repo 真实协议测试；fake engine 只测试 Hub failure/retry 分支。
6. completion marker 不要求运行时跨仓读取同一个文件，采用 provider 声明 + consumer golden 测试即可。

### 验收

- 旧/错误 engine 在启动阶段直接报告 protocol mismatch；
- health 与 recovery 不会对同一 capability 给出不同声明；
- 新增 durable event/action 时，两仓测试至少有一处明确失败；
- Hub 不需要启动替代服务器或改变桌面部署。

### 回滚

保留 protocol v2，不升级大版本。本批是更严格校验；如产生兼容问题，可只回滚 Hub health 的 early-reject，recovery 强校验仍保留。

---

## 批次 6：数据语义和历史残留（Hub 为主）

### 6.1 Memory

默认采用当前产品定位：**Hub 是 GA memory 的正式编辑前端**。

修改：

- Memory 页面显示“内容保存在 GA 工作区，保存会产生文件修改”；
- 写入增加 `expected_mtime` 或内容 hash，防止覆盖外部并发修改；
- 保存前备份到 `ADMIN_DATA/memory-backups/`；
- API 冲突返回 409，前端提供重新载入；
- README 不再承诺 GA 工作区 clean。

不增加 memory HTTP 中转，不迁移 memory root。

### 6.2 MyKey

- 保留现有原子写、语法校验、备份和 reload；
- 增加 expected mtime/hash，避免覆盖外部编辑；
- 所有 GA reload/resolve 调用经 bridge；
- secret mask 和同步服务仍由 Hub 产品层负责。

### 6.3 Temp / Journal

- `GA/temp`：Hub 只读展示和导入，不把 Hub 自己的 DB/上传放进去；
- `GAHUB_JOURNAL_PATH`：Hub 决定存储位置，GA engine 写入；
- engine 启动日志明确 journal enabled/path/disabled reason；
- 不给未受 Hub 管理的独立 `gahub_app` 强制默认 journal 路径。

### 6.4 Timeout 和 Legacy

- 删除 Hub `conductor_ext_timeout.py`，前提是确认产品不需要 120 秒早期告警；
- 删除对应只验证幽灵 topic 的测试；
- 保留引擎权威 `worker_silent` / `worker_timeout`；
- WebUI legacy fallback 暂保留一个 release，并标注移除版本；
- 后续 telemetry 显示无旧 sidecar 后再删除。

### 测试

```powershell
python -m pytest tests/test_blocking_routes.py tests/test_llm_preference_store.py tests/test_conductor_ext_timeout.py tests/test_conductor_event_lifecycle.py tests/test_api_contract.py -q
npm --prefix webui test
npm --prefix webui run lint
npm --prefix webui run api:check
```

若删除 `test_conductor_ext_timeout.py`，命令中相应移除，并由 engine event 测试替代。

---

## 批次 7（可选）：接入官方 `frontends/hub` 作为监控/遥控通道

### 7.1 结论

**可以接，而且应该接，但只接「监控 + 粗粒度遥控」这一层，不能拿它替代 Conductor 的控制面。**

官方 `frontends/hub.py` 就是 GA 的「监控 + 遥控中枢」：本机 WS 总线 + 网页面板 + 可选手机配对。
`stapp`（`stapp.py:308`）和 reflect（`agentmain.py:312-316`）已经在用，说明它是通用组件。
因此 `gahub` 依赖它是**合法方向**（特殊 frontend → 通用 frontend），不需要自己再造一套面板和远程通道。

反过来，Conductor 的编排、验收、journal、恢复语义**不属于** hub 的职责，也不应搬进去。

### 7.2 官方 hub 已核实的真实能力

| 能力 | 事实 |
|---|---|
| 总线 | `ws://127.0.0.1:19736/ws`，仅 loopback，校验 Origin；端口即单例锁 |
| 面板 | `http://127.0.0.1:19737/?t=TOKEN`，token + cookie 守卫，页面为 `frontends/hub.html` |
| 注册 | `hello {name,pid,fixed,caps,sub}`；`fixed=True` 得到稳定可寻址名字 |
| 监控读 | `GET /api/peers`（含 `title/n_msgs/run/llm/sig` 增量）、`/api/{name}/messages?since=&sig=`、`/api/{name}/seg/{i}/{j}?off=`（步骤可断点续读） |
| 遥控写 | `POST /api/{name}/put`、`/abort`、`/api/{name}/llm`（列/切模型） |
| 事件总线 | `emit(topic,data,to=)` + `sub` 订阅的 fanout，跨前端广播 |
| 远程 | `hub_p2p.py` 手机配对，只导出 `/api/*`（复用它就不要自建隧道） |
| 拉起 | `serve()` 按需 detached 启动，已在跑则直接返回 |

监控语义是**单 agent 线性 transcript**：`tasks[].input` + `tasks[].outputs[].steps`（面板渲染为输入气泡 + 可折叠步骤）。

### 7.3 哪些必须继续自建

| 层 | owner | 是否交给官方 hub |
|---|---|---|
| 发现 / 监控面板 / 手机遥控入口 | 官方 hub | **接** |
| abort、supervisor 模型切换 | 官方 hub | **接** |
| 跨前端事件广播 | 官方 hub bus | 可作为补充 |
| worker 生命周期、验收、交付物、milestone、admission | Conductor engine | 自建，保留 |
| durable 命令、幂等回执、journal 恢复、boot/generation | Conductor engine + Hub | 自建，保留 |
| Hub 产品 workflow、SQLite、activity timeline、通知 | GA-Hub | 自建，保留 |
| `/chat` `/subagent` `/accept` `/journal` `/recovery` | Conductor 协议 | 保留，不迁到 hub bus |

原因：hub 的 `put` 是「往一个 agent 投一段文本」，没有 request 归属、没有幂等键、没有交付物契约、没有恢复游标。
把编排语义压进这条单 agent 文本通道，会丢掉 Conductor 已有的可靠性保证。

### 7.4 接入形态

在 GA 侧新增 `frontends/gahub/hub_peer.py`（**不改 `hub.py`**），由 `gahub_app` 在 supervisor 就绪后注册：

```python
hub.connect(
    supervisor,
    "gahub/conductor",              # fixed 风格稳定名字
    put_task=_hub_put,              # 必须显式提供，见 7.5
    get_outputs=_hub_outputs,       # request → 步骤摘要的有损投影
    abort=_hub_abort,               # supervisor + 可选 workers
    llm=_hub_llm,                   # supervisor 模型列/切
)
```

投影约定：

```text
tasks[i].input   = 一次 request 的 goal/标题
tasks[i].outputs = 该 request 下 worker 生命周期摘要行
                   （spawned / reworked / pending_review / accepted / rejected / timeout）
```

这是**监控视图**，有损是刻意的：权威 UI 仍是 Hub 的 Conductor 页面。

`emit()` 可用来把里程碑广播到总线，供其他前端订阅；但不得把 Hub workflow 状态写进 hub 契约。

### 7.5 四个已核实的坑（必须按此实现）

1. **`hub.connect()` 一定会注入默认 `_put`**，`caps` 永远包含 `put`；而面板 `open_()` 无条件 `enable(true)`，
   **不按 `caps` 隐藏发送框**。所以必须显式传 `put_task`，不能指望靠 caps 关掉遥控输入。
2. **默认 `_put` 写 `agent._hub_inbox`，依赖活的 UI tab 去 drain**。
   Conductor supervisor 没有这种 UI，默认路径会造成「面板说发送成功、实际永不执行」。
   官方 reflect 模式已给出正确姿势：显式 `put_task` 直接调 `agent.put_task(t, source='hub')`。
3. **若 `put_task=None`（直接构造 `HubClient`）**，面板点「发送」会让 `_on_cmd` 抛 `TypeError`，
   连接被 `except Exception: pass` 吞掉并进入 5 秒重连循环，表现为 peer 反复消失。
   因此宁可显式返回 `{'error': '...', 'code': 'nosupport'}`，也不要留空。
4. **`websockets` 不在 GA 声明依赖中**（实测环境为 16.0）。
   `HubClient._loop` 在 `ImportError` 时**静默 return**，缺依赖时表现为「什么都没发生」。
   必须：可选降级 + 启动日志明确记录一次原因；建议在 GA 声明 optional extra，
   并在 `gahub_bridge` probe 中报告 hub capability 是否可用。

### 7.6 依赖方向

- `gahub_app` / `frontends/gahub/*` → `frontends.hub`：**允许**；
- `frontends/hub.py`、`hub.html`、`hub_p2p.py`：**不得**出现 `gahub` / `GAHUB_` 专属逻辑；
- conductor 专用投影只放在 `frontends/gahub/hub_peer.py`；
- 与 §依赖硬规则一致：通用 hub 不认识特殊 frontend。

### 7.7 建议分档与验收

| 档 | 内容 | 建议 |
|---|---|---|
| A（最小） | 注册 peer：`get` + `abort`，`put` 显式返回 `nosupport` | **先做这档** |
| B（完整） | 追加 `llm` 切换与 `put`→conductor admission | 需先定义归属与幂等 |
| C（不做） | 官方面板看不到 conductor | 仅在不需要统一监控时 |

测试：

```powershell
# GA
python -m pytest tests/test_gahub_hub_peer.py tests/test_gahub_app.py -q
```

验收点：

- 未安装 hub / hub 未运行时：完全静默，Conductor 功能不受影响；
- hub 运行时：`/api/peers` 出现 `gahub/conductor`，标题与步骤可读；
- A 档下点「发送」得到明确错误且**连接不重建**；
- `abort` 能停住 supervisor；
- 缺 `websockets` 时日志有一次明确告警，而不是静默失效；
- 依赖方向测试证明 `hub.py` 未新增 `GAHUB_` 符号。

回滚：删除 `hub_peer.py` 与注册调用即可；Conductor 协议与 Hub 页面完全不受影响。

---

## 5. 提交与发布策略

### 5.1 两仓提交顺序

需要 GA 新 bridge 的批次采用 provider-first：

```text
1. GA：新增 bridge/helper，保留旧接口
2. GA：测试通过并提交
3. Hub：切换调用方
4. Hub：联跑通过并提交
5. 一个 release 后再考虑清理旧接口
```

禁止 consumer-first：Hub 先依赖新 helper 会使当前 GA checkout 直接无法启动。

### 5.2 建议提交拆分

| 提交 | 仓库 | 内容 |
|---|---|---|
| H0 | Hub | 文档纠偏 + boundary 静态测试 |
| G1 | GA | `gahub_bridge` v1 + tests |
| H1 | Hub | workspace/usage/archive 低风险切换 |
| G2 | GA | session/rewind helper |
| H2 | Hub | session factory + rewind 切换 |
| G3 | GA | Agent hook / mykey invalidation helper |
| H3 | Hub | AgentService/GoalHive/LLM 切换 |
| G4 | GA | Conductor contract 单源 |
| H4 | Hub | health/recovery validator + paired tests |
| H5 | Hub | memory 并发保护 + timeout/legacy 清理 |
| G5 | GA | （可选）`frontends/gahub/hub_peer.py` 接入官方 hub 监控/遥控 |

每个提交只解决一个兼容面，不把重构、协议升级和 UI 改动混在一起。

### 5.3 兼容窗口

- `frontends/gahub_app.py` shim：长期保留；
- bridge v1：至少一个 release 只增不删；
- Hub 最低 GA bridge version：在 health/core-contract 页面明确展示；
- Conductor protocol：当前保持 v2；新增可选能力用 capability，不轻易升 v3；
- 删除旧 helper 前，全仓 grep + paired test 必须证明无调用者。

---

## 6. 全量验收

### Hub

```powershell
python -m pytest -q
npm --prefix webui test
npm --prefix webui run lint
npm --prefix webui run api:check
```

### GA

```powershell
python -m pytest -q
```

### 两仓联跑

```powershell
$env:GA_ROOT='D:\study\GA'
$env:TEST_GA_ROOT='D:\study\GA'
python -m pytest tests/test_core_contract.py tests/test_conductor_asgi_contract.py tests/test_conductor_hub_engine_chain.py tests/test_session_runtime_factory.py tests/test_rewind_turns.py -q
```

### 人工冒烟

1. 新建普通会话，发送消息，确认流式输出与归档；
2. 切换模型，重启 Hub 后恢复同一 assignment；
3. 恢复历史会话并 rewind 一轮；
4. 编辑 mykey，确认备份、reload 和错误提示；
5. 编辑 memory，制造外部并发修改，确认 409 而不是覆盖；
6. 新建 Conductor 任务，完成 dispatch → worker → review → final；
7. Conductor 运行中重启 Hub，确认 journal catch-up；
8. 用协议不匹配的 fake engine，确认 health 阶段立即拒绝；
9. 关闭 Hub，确认 Agent thread、Conductor engine、Feishu/external worker 均被回收。

---

## 7. 完成定义

本方案完成不等于 GA-Hub 不再依赖 GA，而是满足：

- `gahub` 被明确视为 GA 的特殊 frontend；
- GA 提供一个轻量、无副作用的 `gahub_bridge` 嵌入式调用面；
- Hub 的 GA 私有访问集中到 bridge，业务 service 职责保持不变；
- 主 Agent 与 Conductor 两种 runtime 分工清楚；
- GA execution state 与 Hub workflow state 各有唯一 owner；
- archive/mykey/memory/temp/journal 的读写规则与产品文案一致；
- GA 或 Hub 任一侧升级时，contract probe 和 paired tests 能在发布前指出不兼容项；
- 没有为了“架构独立”重建 GA 核心或破坏现有 frontend 模式。
