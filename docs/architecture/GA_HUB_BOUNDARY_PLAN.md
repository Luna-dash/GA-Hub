# 理顺 GA 与 GA-Hub 两仓架构的方案

> **状态标记（2026-09-18 复核）：🟡 待决策 —— 批次 0 已完成，批次 1–5 全部未开工。**
> - **已完成**：批次 0（删 `.ga-staging/`）—— 实测目录已不存在；依据文档
>   `docs/archive/GA_HUB_STRUCTURAL_NESTING_AUDIT_20260915.md` 已归入 archive。
> - **阻塞点**：§9 两个拍板点未定 —— ① 批次 4 走路线 A（端点化）还是先 B（冻结 `GA_EMBEDDED_API.md`）；
>   ② Hub 记忆写入走引擎新端点还是降级只读。决策 ② 卡批次 2，决策 ① 卡批次 4。
> - **可立即开工**：批次 1（声明与可见性：`/health` 版本协商 + 更正三处「零侵入」失真文档 +
>   golden 常量）—— **零行为变更**，不需要等决策。
> - ⚠️ 本文**尚未纳入 git 跟踪**（`git status` 显示 `??`）。
> 逐项拆解与执行顺序见 `docs/plans/TODO_REMAINING.md` W3–W5。

- 制定日期：2026-09-16
- 依据：`docs/archive/GA_HUB_STRUCTURAL_NESTING_AUDIT_20260915.md`（四向嵌套核查）
- 状态：**方案待决策** —— 批次 0 已完成，批次 1–5 未开工；第 5 节批次 4 与第 9 节列了两个需要拍板的点（2026-09-18 复核）
- 基线：GA `aba30f7`（`main`，较 `origin/main` ahead 42）；Hub 工作区

---

## 1. 目标状态

> **GA = 引擎（含它自己的官方适配器）；GA-Hub = 客户端。**
> 两者之间只有一条边界：**HTTP/SSE 协议**。
> 每一个数据只有**一个 owner**，且落在 owner 自己的目录里。
> 每一份跨仓契约只有**一个来源 + 一个版本号**。

这不是"解耦成两个不相干的系统"——它们本来就是同一个产品的两侧。目标是让**耦合变成显式的、单向的、可检测的**，而不是现在这种隐式、双向、靠人工同步的。

---

## 2. 五条硬规则（每条都可静态校验）

| # | 规则 | 当前反例 | 校验方式（可进 CI） |
|---|---|---|---|
| **R1** | 跨进程只走协议：Hub 不 `import` GA 符号、不 spawn GA 脚本 | `agent_service.py:28`、`goalhive_service.py:22`、`core_contract.py:215`（`agentmain`）；`llm_registry.py:84`、`mykey_service.py:274`（`llmcore`） | Hub 仓内 `import agentmain\|llmcore` 命中数 = 0（白名单可显式登记） |
| **R2** | 单向写入：任何一方不写对方的**跟踪源码树** | `routes/memory.py:46-48` 写 GA 的 `memory/global_mem*.txt`（TRACKED） | Hub 内面向 `<GA_ROOT>` 的写入调用 = 0 |
| **R3** | 能力命名：GA 仓内的适配器按**能力**命名，不按客户品牌 | `frontends/gahub/` | GA 仓内 `grep -ri gahub` 只剩 env 前缀与迁移说明 |
| **R4** | 契约单源：跨仓常量只有一份来源，其余生成或比对 | 完成标记正则 2 份（`conductor_core.py:173` ↔ `presentation.ts:513`）；`INSTR_*` 词表 2 份 | CI golden 比对 |
| **R5** | 版本协商：握手声明 `protocol_version` + `capabilities` | 不存在 | `GET /health` 返回且 Hub 启动时校验 |

---

## 3. 必须先纠正的认识：不是"两套代码"，是"同域三套实现"

这是本次核查最容易被忽略的发现，也是方案能省最多力气的地方。

| 层 | 位置 | 体量 | 传输 | 谁在用 |
|---|---|---|---|---|
| 上游原版 | `GA/frontends/conductor.py` + `conductor.html` | 870 行 | **进程内** `GenericAgent`，自带 HTML 页 | GA 自带的参考 UI |
| fork 版 | `GA/frontends/gahub/`（7 模块） | 5934 行 | **HTTP/SSE**，服务外部客户端 | GA-Hub |
| 客户端版 | `GA-Hub/server/services/conductor_*.py`（9 文件）+ `webui/src/components/conductor/`（11 文件） | — | 消费 HTTP/SSE | GA-Hub 的页面 |

三者是**同一个领域**：子代理池、派工、keyinfo、abort、chat。

- 上游 `conductor.py:782` 定义 `INSTR_DISPATCHED = "Task received. I'll handle THIS TASK from here. ..."`，并暴露 `/subagent`、`/subagent/{sid}`、`/chat`、`/ws`；
- fork 的 `gahub_app.py` 暴露**同名路由** `/subagent`、`/chat`，并扩出 `/events`(SSE)、`/models`、`/journal`、`/recovery`；
- Hub 的 `conductor_vocabulary.py:124-145` **又抄了一份** `SUBAGENT_VERBS` / `INSTR_DISPATCHED` / `INSTR_KEYINFO` / `ConductorNotRunning`。

另外：`frontends/conductor.py` **在上游与 fork 中完全一致**（`git diff upstream/HEAD...HEAD` 空）——它没有被 fork 动过，也就是说 fork 是在**旁边新写了一套**，而不是改造它。

**含义**：目录层面的"嵌套"（`frontends/gahub/` 在 GA 里）只是表象。真正的架构债是**同一领域被实现三次、词表被抄两份**。方案的核心不是"把 gahub 搬走"，而是**把这三层收敛成清晰的分层**。

---

## 4. 目标形态

```
┌─ GA 引擎进程 ────────────────────────────────┐
│  agentmain / llmcore / agent_loop  (上游核心) │
│  frontends/conductor/  ← GA 的 conductor 服务 │
│     （能力命名；HTTP/SSE；唯一对外面）        │
│  frontends/conductor.py (上游参考 UI，保留)   │
│  frontends/fsapp.py 等：GA 官方适配器          │
└──────────────┬───────────────────────────────┘
               │  协议：HTTP + SSE
               │  X-Conductor-Token / protocol_version / capabilities
┌──────────────┴───────────────────────────────┐
│ ── GA-Hub 客户端进程 ──────────────────────┐ │
│  server/services/conductor_*  （协议消费）  │ │
│  server/services/*            （产品逻辑）  │ │
│  webui/                       （Conductor 页）│
└───────────────────────────────────────────────┘

数据归属（各归其主，交叉为零）
  GA 的 memory/ 、temp/ 、mykey.py     → owner: GA     （Hub 只读 + 走协议写）
  Hub 的 conversations_v2 / uploads…    → owner: Hub
  共享 runtime dir（journal 等）        → 显式声明为「共享」，不是 Hub 私有
```

---

## 5. 迁移批次（风险递增，每批可独立回滚）

### 批次 0 · 清除失效副本 ✅ 已完成（2026-09-16）

删除 `GA-Hub/.ga-staging/`（464 文件 / 35MB，非跟踪、零代码引用、与现役 GA 不同版）。
核对证据：`git status --porcelain` 脏文件数 6→6、跟踪文件 415→415 未变，顶层目录与关键路径完好；删除前清单留存 `temp/ga-staging-removal-manifest-20260916.txt`。
`.gitignore:63` 的忽略项**保留**（防将来误提交）。

---

### 批次 1 · 声明与可见性（零行为变更，可先做）

1. **`GET /health` 增加 `protocol_version` 与 `capabilities`**。引擎侧只输出，Hub 侧只记录不强制——本批次不改变任何行为，先把"能力协商"的地基铺好（对应 R5）。
2. **更正三处失真文档**（对应既有审计 §6 与 §3.3）：
   - `README.md:5-6` 与 `server/_paths.py:36-37`：把"从不写入 GA 目录"改成"**不写 GA 的源码树**；运行时数据面限定为 `<GA>/mykey.py`、`<GA>/temp/`（均被 GA 的 `.gitignore` 忽略）"；
   - `GA/memory/ga_update_sop.md:34`：把"核心文件零 delta"改成"核心文件**无 gahub 相关** delta（实测有 80+/42- 行其它 fork 改动）"。
3. **跨仓常量抽 golden + 一致性测试**（对应 R4）：完成标记的三种拼法、事件 `kind` 表、`INSTR_*` 词表，各落一份 `*.golden.json`，两侧 CI 各自比对。

**验收门**：无行为变更；两侧测试全绿（Hub pytest / GA pytest / `tsc -b` / vitest）。

---

### 批次 2 · 数据归属（对应 R2）

1. **Hub 停写 GA 的 `memory/`**。读功能全部保留；写功能二选一：
   - **(a) 推荐**：引擎侧新增 `POST /memory/{global_mem,global_mem_insight}`，由引擎自己落盘（语义可控、可审计、可备份）。Hub 的"记忆编辑"页改调该端点。
   - **(b) 降级**：Hub 该页变只读，提示用户在 GA 侧编辑。成本最低，体验倒退。
   
   > 注意：`mykey.py` 的写入（`mykey_service.py:103-107`）落在 `.gitignore:41`，**不违反 R2**，可暂时保留，但建议一并纳入 (a) 的端点化路线。

2. **明确 runtime dir 语义**。`~/.genericagent-admin/gahub_journal/journal.jsonl` 是"引擎产生、Hub 消费"的共享真值流，不该被表述为 Hub 私有状态。两个动作：
   - 文档上把它从"Hub 私有"改列为"**共享运行时状态**"；
   - 引擎侧在 `GAHUB_JOURNAL_PATH` 缺失时要有**明确默认值 + 启动日志**（现在 `gahub_app.py:1284` 只是报 `reason: "GAHUB_JOURNAL_PATH is not set"`，属于隐式依赖）。

**验收门**：Hub 内对 `<GA_ROOT>/memory/**` 的写入调用 = 0；在 Hub 里编辑一次记忆后 `cd /d/study/GA && git status --porcelain` 保持 clean。

---

### 批次 3 · 代码归属与命名（对应 R3）

1. **`frontends/gahub/` → `frontends/conductor/`**（能力命名）。同时迁移/保留：
   - `frontends/gahub_app.py`（19 行 shim）**保留一个 release** 作为兼容入口，之后删；
   - `frontends/conductor_core.py`（13 行 shim）同理。
   
   > 迁移期要同时接受"旧入口 + 新入口"，因为已发布的桌面包与旧 journal 还在用旧路径（这个教训在跨仓改完成标记时已经付过一次）。
2. **去客户端品牌**：模块 docstring、日志前缀 `[gahub]` → `[conductor]`。
3. **`GAHUB_*` 环境变量名保留不改**（对应第 7 节"不做什么"），但在文档中登记为"**客户端-引擎协议前缀**"，明确它指协议不指客户端品牌。
4. **消除双份实现**：`conductor_ext_timeout` 只在引擎侧保留一份，Hub 侧 `server/services/conductor_ext_timeout.py` 删除（引擎注释 `gahub_app.py:213` 自称 "absorbed from GA-Hub"，说明是同一份逻辑搬过去的）。

**验收门**：GA 仓 `grep -ri gahub` 仅剩 `GAHUB_*` env 名与迁移说明；Hub 侧不存在与引擎重复的实现文件。

---

### 批次 4 · 进程边界（最高风险，需要拍板）

这是全案唯一会改变运行时行为的批次，也是把 R1 真正落地的地方。

**路线 A（终态，务实版）**：给 Hub 需要的能力逐个补引擎端点（chat / stream / abort / model 切换 / 模型列表 / 归档读取），Hub 只走 HTTP/SSE。
- 优点：R1 彻底达成；Hub 不再受 GA 内部 API 变动影响。
- 风险：`agent_service` 现在承担的语义很多（turn 折叠、图片粘贴、会话恢复、archive 投影），逐个端点化会有一段长尾。

**路线 B（兜底，最小改动）**：承认进程内集成，但把它**冻结成受支持的嵌入式 API**：
- 在 GA 侧维护一份 `GA_EMBEDDED_API.md` 清单（当前只有 `agentmain.GeneraticAgent`、`llmcore.reload_mykeys`、`llmcore.resolve_client` 三个符号）；
- 清单内符号的签名变更必须同步更新该清单 + 通知客户端；
- 加一条契约测试：Hub 侧只 import 清单内符号（越界即红）。
- 优点：立刻把"隐性耦合"变成"显式、可检测的耦合"；成本极低。
- 缺点：仍然跨进程边界，frozen 打包场景仍受 `bootstrap_sys_path` 约束。

**建议的落地顺序**：**先做 B 把风险面兜住 → 再按"能力已被协议覆盖"的顺序逐个迁 A**。判据很简单：某能力若协议已有端点，就迁；若依赖 GA 进程内状态（典型是 turn 折叠、paste 图片缓存），先留 B 并登记为技术债。
**不要一次性全切 HTTP**——会有静默的行为回归，而这类回归在 Conductor 上表现为"页面不报错但数据不对"，最难查。

**验收门**：Hub 侧 `import agentmain|llmcore` 的命中集合 ⊆ 清单；清单每项都有契约测试。

---

### 批次 5 · 长期（可选，不阻塞前四批）

把 `frontends/conductor/` 做成**独立可安装包**（`pip install ga-conductor` 进 GA 的运行环境），GA 仓只保留一个 entrypoint 钩子 + 上游 `conductor.py` 参考实现。这样既保留上游 `frontends/` 的放置惯例，又让客户端的引擎侧实现彻底离开引擎源码树。

---

## 6. 回归保护（每批必须留下的东西）

| 批次 | 必须新增的保护 | 不可回退的断言 |
|---|---|---|
| 1 | golden 文件 + 两侧一致性测试 | 契约变了而 golden 没变 → 测试红 |
| 2 | "Hub 不写 GA 跟踪树"的静态扫描测试 | `open(<GA_ROOT>/memory/…,'w')` 命中即红 |
| 3 | 针对新入口的 ASGI 契约测试（旧入口同步保留一条） | 迁移期两条入口行为一致 |
| 4 | 嵌入式 API 清单守卫 | 越界 import 即红 |

> Hub 与 GA 两侧都必须跑这份保护。既有审阅已强调过"返回表式 HTTP 替身不足以证明两仓库兼容"（`docs/architecture/conductor-reliability-plan.md`），本方案沿用该原则。

---

## 7. 明确**不做**的事（否定项，防跑偏）

1. **不把 `frontends/` 整体搬出 GA。** 上游的 `frontends/` 就是按消费方命名的适配器目录（`qqapp.py`/`dingtalkapp.py`/`dcapp.py`/`fsapp.py`/`hub.py`），`upstream/HEAD` 里没有 gahub。位置合规，只改内容与命名。
2. **不追求"两仓零耦合"。** 它们是一套产品的两侧，耦合是必然的；要的是显式、单向、可检测。
3. **不在没有协议覆盖前强行切 HTTP。** 见批次 4。
4. **不改 `GAHUB_*` 环境变量名。** 改名收益远小于迁移与兼容风险。
5. **不动 `frontends/conductor.py`（上游参考实现）。** 它是 GA 自带的参考 UI，不该被客户端需求改造。

---

## 8. 风险与回滚

| 批次 | 主要风险 | 回滚方式 |
|---|---|---|
| 1 | 无（只增字段、只改文档） | 直接 revert |
| 2 | 记忆编辑功能短暂不可用 | 保留旧写入路径一个 release，配置开关切换 |
| 3 | 旧包/旧 journal 依赖旧路径 | 保留双入口 + 别名；`[[…]]` 类别名**永久保留** |
| 4 | 静默行为回归（最难查） | 按能力逐个迁，每个能力独立开关；迁移前记录基线行为 |

---

## 9. 需要拍板的两个点

1. **批次 4 走 A 还是先 B？**（建议：先 B 兜底再渐迁 A）
2. **Hub 的记忆写入走"引擎端点"还是"降级只读"？**（建议：端点化，即 (a)）

这两点定了，批次 1-3 可以立刻并行开工——它们与运行行为无关，风险极低，且能把最大的一处"声明与事实不符"（README 的零侵入）先修掉。
