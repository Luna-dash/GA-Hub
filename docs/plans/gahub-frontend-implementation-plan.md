# GA-Hub 特殊 Frontend 关系治理实施方案

- **状态：📌 唯一权威方案**
- **生效日期：2026-09-20**
- **适用仓库**：`D:\study\GA`、`D:\study\GA-Hub`
- **进度入口**：[`TODO_REMAINING.md`](./TODO_REMAINING.md)
- **取代文档**：`GA_HUB_BOUNDARY_PLAN.md`、`GA_HUB_DEPENDENCY_PLAN.md`

> 本文只定义架构决策、实施顺序和验收标准。实际完成状态只在
> [`TODO_REMAINING.md`](./TODO_REMAINING.md) 更新，避免“方案”和“进度”再次分叉。

---

## 1. 一句话结论

**GA 是引擎，GA-Hub 是 GA 的特殊产品 frontend。**

两仓不是完全隔离的远程系统，也不是无边界地互相引用。采用两条明确连接面：

1. **主 Agent 高语义能力**：Hub 通过 GA 提供的稳定 bridge/helper 在进程内调用；
2. **Conductor 多 Agent 调度**：Hub 只通过 HTTP/SSE 调用 GA 侧服务。

Memory 保存在 GA 工作区，由 GA 定义格式和语义；GA-Hub 是获得授权的正式编辑前端。官方 `frontends/hub.py` 只提供可选监控/遥控能力，不替代 GA-Hub 产品 API，也不替代 Conductor。

---

## 2. 为什么采用这个方案

### 2.1 不把全部能力 HTTP 化

主聊天、GoalHive、模型实例、原生 session/archive/rewind 和 hook 都依赖进程内对象与生命周期。强制改成远程 API 会：

- 复制大量 GA 内部语义；
- 增加状态不同步和静默回归；
- 迫使 GA Core 承担一套并非通用需求的 Runtime Host；
- 让 turn folding、图片缓存、hook、模型热切换等行为更难保持一致。

因此这些能力保留进程内集成，但不允许 Hub 业务层任意读取 GA 私有字段；访问面必须逐步收口到 bridge/helper。

### 2.2 Conductor 继续 HTTP/SSE

Conductor 是独立的多 Agent 调度域，已经具备 supervisor、worker、journal、operation receipt、recovery 和 SSE。它适合保持清晰的进程边界：

- GA 拥有调度引擎和权威运行状态；
- Hub 拥有产品投影、WebUI 和 Hub 数据库；
- 两侧通过带版本的 HTTP/SSE 契约协作。

### 2.3 Memory 采用“授权写入”，不是“目录绝对隔离”

三个概念必须分开：

- **存储位置**：`GA/memory/`；
- **语义 owner**：GA；
- **授权编辑器**：GA-Hub。

Hub 可以编辑 Memory，但必须提供并发冲突检测、写前备份、原子替换和真实提示。不能再宣称“从不写 GA 目录”。

---

## 3. 最终结构

```text
┌──────────────────────── GA 仓 ────────────────────────┐
│                                                       │
│  GA Core                                              │
│  agentmain / llmcore / archive / workspace / memory   │
│                   ↑                                   │
│  稳定 frontend bridge / helper                        │
│          ↑                              ↑             │
│  frontends/gahub 特殊 frontend       其他 frontend    │
│          │                                            │
│          ├─ 主 Agent 能力：进程内 bridge              │
│          ├─ Conductor 服务：HTTP/SSE                  │
│          └─ official hub adapter：可选监控/遥控        │
└──────────┼──────────────────────────────┼──────────────┘
           │                              │
      HTTP/SSE                    supported bridge
           │                              │
┌──────────┴────────────── GA-Hub ────────┴──────────────┐
│ Conductor client / projection / WebUI                  │
│ Main Agent / GoalHive product services                 │
│ Memory / MyKey authorized editor                       │
│ Hub DB / uploads / desktop shell                       │
└────────────────────────────────────────────────────────┘
```

---

## 4. 所有权与访问规则

| 能力/数据 | 语义 owner | 正式访问方式 | 禁止事项 |
|---|---|---|---|
| Main Agent runtime | GA | 进程内 bridge/helper | Hub service 新增散落的 GA 私有字段访问 |
| GoalHive runtime | GA 对象语义；Hub 管产品生命周期 | 独立 runtime owner + 共用 factory/helper | 与 Main Agent 合并成一个全局实例 |
| 模型注册、MyKey | GA | model/config bridge | Hub 复制 `llmcore` 内部缓存规则 |
| Native session/archive/rewind | GA | session/archive bridge | Hub 写 `agent._rw_store` 等私有属性 |
| Conductor supervisor/subagents | GA | HTTP/SSE | Hub 在进程内操纵 supervisor 私有状态 |
| Conductor 产品投影/workflow | GA-Hub | Hub service/DB | GA 反向写 Hub 数据库 |
| Memory | GA | Hub 授权直接编辑，带冲突保护与备份 | 无检查覆盖外部修改；声称磁盘零侵入 |
| Hub DB/uploads/UI state | GA-Hub | Hub 内部接口 | GA Core 依赖 Hub 存储 |
| 通用监控/遥控 | GA official hub | 可选 adapter | 用 official hub 替代产品 API 或 Conductor |

### 4.1 依赖方向

```text
GA Core / 通用 frontend substrate
                  ↑
          frontends/gahub
                  ↑
        GA-Hub backend / WebUI
```

允许：

- `frontends/gahub/**` 依赖 GA Core 和通用 frontend；
- GA-Hub 通过登记的 bridge/helper 导入 GA；
- 组合入口显式连接 official hub。

禁止：

- GA Core 依赖 `frontends/gahub`；
- 通用 frontend 出现新的 `GAHUB_`、`__GAHUB_` 产品专属协议；
- official `hub.py` 识别 GA-Hub 产品状态；
- Hub 业务模块新增未登记的 `agentmain`、`llmcore` 直接依赖。

### 4.2 兼容入口例外

以下属于组合或兼容入口，不视为 Core 反向依赖，但必须白名单化：

- GA 启动 shim；
- `frontends/gahub_app.py` 等显式入口；
- 兼容别名模块；
- frontend 自身测试和打包脚本。

白名单只能减少，不能无审查增加。

---

## 5. Bridge 设计规则

### 5.1 Bridge 不是第二套业务实现

Bridge 只做：

- 稳定命名；
- 参数和返回值规范化；
- 生命周期封装；
- 能力探测；
- 对 GA 内部变化提供一个兼容层。

Bridge 不做：

- 复制 GA 的 archive、模型或 rewind 算法；
- 持有第二份 Agent 全局状态；
- 把所有能力堆进一个 God module；
- 为“以后可能使用”提前包装全部 GA。

### 5.2 按能力域组织

优先组织为：

```text
frontends/gahub/bridge/
  contract.py
  workspace.py
  usage.py
  archive.py
  sessions.py
  agent_runtime.py
  model_config.py
```

如果为了兼容暂时保留单文件入口，它只能 re-export 已拆分的实现，不得继续无限增长。

### 5.3 Import 必须无副作用

导入某个 bridge 子模块不得：

- 创建 FastAPI service；
- 创建 Agent；
- 启动线程或子进程；
- 监听端口；
- 隐式启动 Conductor。

`frontends/gahub/__init__.py` 不得 wildcard 导入 `gahub_app`。需要 app 的调用者必须显式导入。

---

## 6. Conductor 契约规则

### 6.1 GA 侧负责

- supervisor / subagent pool；
- dispatch / abort；
- worker silent / timeout；
- journal 和 operation receipt；
- recovery；
- 权威事件和运行状态；
- protocol version / capabilities。

### 6.2 Hub 侧负责

- WebUI；
- SSE 消费与重连；
- 产品状态投影；
- workflow 展示和 Hub 数据库；
- 用户权限与操作入口；
- 协议不兼容时的明确错误。

### 6.3 单一契约来源

GA 侧必须从同一常量生成：

- `PROTOCOL_VERSION`；
- capabilities；
- durable event names；
- action canonical names/aliases；
- completion marker aliases；
- journal format version。

`/health` 与 `/recovery` 不得各自手写一份声明。

Hub 使用同一个 validator 校验两类响应。

### 6.4 启动就校验兼容性

进程管理器应区分：

```text
is_reachable()    端口是否响应
probe_health()    能否解析完整 health envelope
validate_protocol() 版本和能力是否兼容
ensure_running()  只有全部通过才算 ready
```

不能把“HTTP 200”当成“引擎可用”，也不能拖到 recovery 阶段才发现版本不兼容。

---

## 7. Memory 与配置写入规则

### 7.1 Memory 写入最低要求

- 页面明确提示：内容保存在 GA 工作区，保存会产生文件修改；
- 请求携带 `expected_mtime` 或内容 hash；
- 外部内容已变化时返回 HTTP 409；
- 写前备份到 Hub 数据目录的 `memory-backups/`；
- 使用临时文件 + 原子替换；
- 前端提供重新载入，不静默覆盖；
- 保留文件编码和必要换行语义。

### 7.2 README 真实承诺

对外说明统一为：

> GA-Hub 与 GA 源码工程独立，不修改 GA Core 源码；作为正式管理前端，会在用户操作下修改 GA 的 Memory、配置和运行状态文件。

不得继续使用“磁盘零侵入”“从不写入 GA 目录”等绝对表述。

---

## 8. Official hub 接入边界

官方 `frontends/hub.py` 可以复用：

- 运行状态监控；
- wake/abort 等窄控制；
- WebSocket/P2P 传输；
- 手机遥控；
- 多 frontend 聚合。

不得用它替代：

- Conductor HTTP/SSE；
- GA-Hub session/workflow 数据模型；
- Memory/MyKey 管理；
- Hub WebUI 产品接口。

接入发生在组合入口，依赖缺失时明确告警并安全降级。通用 hub 不得反向 import `frontends/gahub`。

---

## 9. 实施原则

### 9.1 垂直切片，不做一次性大迁移

每项能力按同一闭环执行：

```text
GA 提供 helper
→ GA 单测
→ GA 提交
→ Hub 切一个调用方
→ Hub 测试
→ 两仓联跑
→ grep 旧访问
→ 删除旧路径或收紧白名单
→ 更新 TODO
```

### 9.2 Provider first，consumer second

跨仓能力必须先在 GA 提供并验证，再修改 Hub 使用。不得提交一个要求“另一仓未来补齐”才能运行的半成品。

### 9.3 行为保持

治理默认不改变用户可见行为。涉及以下内容时必须增加真实 fixture 或集成测试：

- native archive；
- rewind/restore；
- 模型热切换；
- hook 注册与释放；
- Conductor recovery；
- Memory 并发冲突。

---

## 10. 执行波次

### W3.0 文档与口径收口

目标：只有一个架构来源。

- 作废两份旧架构计划；
- 本文成为唯一权威实施方案；
- `TODO_REMAINING.md` 成为唯一进度入口；
- 修正计划索引和过期引用；
- 把已完成的 fsapp 中性事件迁移、现有 protocol 声明标为事实。

验收：仓库内不再有文档要求按旧“全 HTTP/零 import”批次执行。

### W3.1 真实性与数据安全

目标：先修会误导用户或覆盖数据的问题。

- 修正 README/pyproject 的“零侵入”承诺；
- Memory 增加 mtime/hash 冲突检测、409、备份和前端重载；
- 清理 `frontends/gahub/__init__.py` 导入副作用；
- 增加 bridge import 无副作用测试。

验收：并发修改不会被静默覆盖；导入 bridge 不启动服务或 runtime。

### W3.2 治理护栏与协议前置校验

目标：迁移前先阻止新增债务。

- GA 增加 frontend 依赖方向测试；
- Hub 增加允许入口/遗留白名单测试；
- GA 收口 protocol/capability 单一常量；
- Hub 抽统一 validator；
- 启动 health 阶段立即校验版本和能力；
- 增加 paired-repo contract 测试。

验收：非法依赖和协议不兼容在测试或启动阶段直接失败，并给出文件/能力名。

### W3.3 低风险能力垂直迁移

顺序：

1. workspace；
2. usage/cost tracker；
3. native log path；
4. archive 只读投影。

每一项独立提交、独立测试、独立收紧白名单。

### W3.4 Session / Archive / Rewind

- continue / begin / release native session；
- archive occupant / lock / parse；
- bind / sync rewind store；
- restore turn；
- 移除 Hub 对 GA 私有 rewind 字段的直接写入。

验收：使用真实 archive fixture 覆盖继续、恢复、回退和冲突场景。

### W3.5 Agent runtime 与模型配置

- turn-end hook 注册/释放；
- Main Agent factory；
- GoalHive 独立 runtime owner；
- LLM resolve/reload；
- MyKey invalidation；
- patch/tool 注入；
- shutdown 清理。

验收：Main Agent 与 GoalHive 不合并；无重复 hook；退出后无线程、子进程和 hook 残留；模型切换行为保持。

### W3.6 Official hub 可选接入

- 组合入口注册 monitor/wake/abort；
- 不改 Conductor；
- 不改产品 API；
- 依赖缺失安全降级；
- 验证断线重连和 abort。

该波次不占前述治理关键路径，可以独立延期或回滚。

### W3.7 兼容清理

- 到期移除旧 `__GAHUB_FEISHU_CHAT__` marker；
- 清理无消费者 timeout topic；
- 清理 legacy WebUI fallback；
- 收紧 direct-import 白名单；
- 删除已无调用者的旧 helper；
- 更新最终架构说明和发布记录。

清理必须有 grep、测试、遥测或至少一个兼容发布周期作为依据。

---

## 11. 已经完成、不要重复做

截至本文生效：

- GA `fsapp` 已输出中性 `__GA_FRONTEND_EVENT__`；
- Hub 已兼容新旧 marker，旧 marker 只等待兼容窗口结束后清理；
- Conductor `/health` 已声明 `protocol_version` 和 capabilities；
- Hub recovery 已有版本、能力、boot identity 和 path policy 校验；
- Conductor journal 已存在并可由 `GAHUB_JOURNAL_PATH` 配置；
- `.ga-staging/` 已删除；
- 主 Agent、GoalHive、Conductor 的 runtime owner 当前保持分离。

这些事项的后续工作是“收口、前置或清理”，不是从零重做。

---

## 12. 明确不做

本轮治理不做：

1. 建设新的通用 GA Runtime Host；
2. 把普通聊天、session、archive、rewind 全部改成 HTTP；
3. 用 Conductor `/models` 替代主 Agent 模型状态；
4. 搬走或改名 `frontends/gahub/`；
5. 合并普通 `conductor.py` 与 gahub Conductor；
6. 改变 native archive 格式；
7. 把 Main Agent、GoalHive 和 Conductor supervisor 合并成一个实例；
8. 用 official hub 替代 GA-Hub 产品后端；
9. 为未来假想需求预先包装整个 GA API；
10. 继续维持多份并列的架构实施计划。

---

## 13. 总体验收门

治理完成至少满足：

- [ ] 架构和执行只有本文一个来源，进度只有 TODO 一个来源；
- [ ] GA Core/通用 frontend 不依赖 gahub；
- [ ] Hub 新增 GA 依赖只能通过允许入口；
- [ ] bridge import 无运行时副作用；
- [ ] Conductor 启动时立即校验 protocol/capabilities；
- [ ] Memory 有冲突检测、备份、原子写和真实提示；
- [ ] Main Agent、GoalHive、Conductor owner 仍清晰分离；
- [ ] Hub 不再直接修改 GA 私有 rewind/runtime 字段；
- [ ] README 不再宣称磁盘零侵入；
- [ ] 旧 marker、旧 fallback 和白名单按兼容周期逐步归零；
- [ ] 两仓单测、契约测试及关键真实场景联跑通过。

任何一项迁移只有在“新入口可用、调用方已切换、旧入口已删除或进入明确兼容期、测试通过”后才算完成。
