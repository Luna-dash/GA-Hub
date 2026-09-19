# GA-Hub 待办总计划

- 首次整理：2026-09-18（源自 `PLAN_REMAINING_AUDIT_20260918.md` 的逐文件盘点 + 全量状态标记）
- **本文件是唯一待办入口**：其他计划文档只保留设计记录，进度一律回到这里勾销。
- 文件名故意不带日期：待办是活的，避免「日期一过就自动变成过期文档」这个本仓反复发作的老毛病。
- 已收口的事项见 §6 —— 动手前先看一眼，别重复劳动。

---

## 0. 执行顺序总览

> **已出列（2026-09-18 用户决定，不再跟踪）**：原 **W0**（Datalab key 轮换 + 本地敏感文件清理）与 **W1**（McAfee 排除项 → 重建桌面端 → §8.5 实机验收）。W1 的重建已随当日 UI 修复一并执行（见 §6 末行），因此波次编号从 **W2** 起 —— 保留原编号是为了不打断 `PLAN_REMAINING_AUDIT_20260918.md` 与 `README.md` 的交叉引用。

| 波次 | 内容 | 前置 | 执行方 | 为什么排这里 |
|---|---|---|---|---|
| **W2** | GA 侧引擎契约收口：G3 → 追加 reopen → G4 复核 | 无（只需重启引擎，**不需要重建桌面**） | GA 仓 | 唯一「改完即生效」的轨道：引擎是 `python.exe` 直跑脚本，不进包 |
| **W3** | 两仓边界 · 批次 1（声明与可见性） | 建议排在 W2 之后（同仓，避免改动相撞） | 两仓 | 零行为变更、风险最低，但会动 GA `gahub_app.py` |
| **W4** | 边界 · 批次 2（数据归属）→ 批次 3（改名去重） | **决策 ②** | 两仓 | 批次 2 必须先知「记忆写入走引擎端点还是降级只读」 |
| **W5** | 边界 · 批次 4（进程边界）→ 批次 5（抽包，可选） | **决策 ①** | 两仓 | 最高风险；路线 A/B 未定不能动工 |
| **并行轨** | 可靠性 §8.4 遗留 / BACKLOG 剩余项 / 文档收口 | 无 | 本机 | 低优先，随手做，不占关键路径 |

**排序的两条硬逻辑**

1. **引擎侧改动不需要重建。** 引擎是以 `python.exe` 直接跑的脚本（`GA/frontends/gahub/gahub_app.py`），改完重启引擎即生效 —— 所以 W2 与任何桌面端工作都不必串行，这是省时间的关键判断。
2. **决策只卡它自己那一批。** 决策 ② 卡批次 2，决策 ① 卡批次 4。批次 1 零行为变更，**不必等决策**，只需避开同仓的 G3。

---

## W2 · 引擎契约收口（GA 仓）

- [ ] **2.1 G3：新任务边界换归档 + 清上下文**。需要 `_new_log_path` + `_retarget_log` + `_clear_conversation_state`（当前在 `GA/frontends/gahub/` **零命中** = 未开工）。
      *不改的后果*：**「一个任务一个归档」不成立** —— supervisor 归档把多任务轮次混在一起。这是 `conductor-task-model.md` §1 目标终态的最后一块。
- [ ] **2.2 追加语义缺口：对已完成任务追加会另铸 `request_id`**（实际变成新任务、不回到原归档）。需 GA 侧 workflow reopen（清 `terminal_event` / `final_item`）+ Hub 侧配套，跨仓一起改。依据 `conductor-task-model.md` §4 H2.2。
- [ ] **2.3 G4 复核**：单 worker 级 `abort_subagent(origin=…)` 与 `CANCELLED` 终态已存在（`conductor_core.py:1567`、`gahub_app.py:1920`），Hub 侧也走该端点。确认是否还缺 **workflow 级终态**收口；若已够，直接把 `conductor-task-model.md` 的 G4 勾销。

## W3 · 两仓边界 · 批次 1（零行为变更，风险最低）

> 依据 `docs/architecture/GA_HUB_BOUNDARY_PLAN.md` §5。
>
> ⚠️ **开工前先读 `docs/architecture/GA_HUB_DEPENDENCY_PLAN.md`**（2026-09-18 15:09 由另一会话落盘）：它自称
> **修订了本文所依据的那张批次表三处**，且结论「Conductor 链路已解耦、真正没解耦的是普通会话 + 管理面」可能改变
> 批次 1–5 的划分。本文件对 W3–W5 的排序**尚未按它校正**。

- [ ] **3.1 R5 版本协商**：`GET /health` 增 `protocol_version` + `capabilities`，Hub 启动时校验。
- [ ] **3.2 更正三处「磁盘零侵入」失真文档**：`README.md:5-6`、`server/_paths.py:36-37`、`GA/memory/ga_update_sop.md:34`。
      事实：`server/routes/memory.py:46-48` 直写 GA **被跟踪**的 `memory/global_mem*.txt`，「零侵入」不成立。
- [ ] **3.3 R4 契约单源**：跨仓常量抽 `*.golden.json`（完成标记三拼法、事件 kind 表、`INSTR_*`）+ 两侧一致性测试。
      *注*：完成标记三拼法已在 2026-09-14 用「两侧同集合 + 各自单测」手工对齐，golden 化就是把这份口头约定变成可校验契约。

## W4 · 两仓边界 · 批次 2 / 批次 3

- [ ] **4.0 决策 ②**（见 §5 决策区）
- [ ] **4.1 批次 2 · 数据归属**：Hub 停写 `GA/memory/global_mem*.txt`；`gahub_journal` 语义改为「共享运行时状态」并给 `GAHUB_JOURNAL_PATH` 明确默认值 + 启动日志。
- [ ] **4.2 批次 3 · 命名与去重**：`GA/frontends/gahub/` → `frontends/conductor/`（保留一个 release 的旧入口 shim）；去客户端品牌（docstring / 日志前缀 `[gahub]`）；删 Hub 侧与引擎重复的 `conductor_ext_timeout.py`。
      ⚠️ 改名是破坏性变更：必须配套 shim，并一次性 grep 全仓引用（含 `.gitignore`、env 名、文档）。

## W5 · 两仓边界 · 批次 4 / 批次 5（最高风险）

- [ ] **5.0 决策 ①**（见 §5 决策区）
- [ ] **5.1 批次 4 · 进程边界（R1）**：路线 A 逐步端点化 / 路线 B 先冻结 `GA_EMBEDDED_API.md` 清单 + 越界 import 契约测试。
      现状反例：`agent_service.py:28`、`goalhive_service.py:22`、`core_contract.py:215`（`agentmain`）；`llm_registry.py:84`、`mykey_service.py:274`（`llmcore`）。
- [ ] **5.2 批次 5 · 抽独立包**（长期、可选）。

---

## 并行轨 · 低优先（不占关键路径，随手做）

- [ ] **P.1 可靠性方案 §8.4 遗留**（`conductor-reliability-plan.md`）
  - `workflows` 表终态行无保留策略（DB 无界增长）
  - 旧 boot 的 pending 命令被静默跳过，unknown 数量/年龄不可观测
  - `engine_key` 取 `base_url`（应引入显式配置键）
  - 提交被拒后遗留的 `submitting` 投影无清理
  - GA 侧 §7 场景表第 5、8 行（watchdog 节拍、请求预算）的故障测试与两仓联跑套件
  - 前端：`conductor.css` 局部 palette 与全局单主题冲突待收敛决策；页面级版本信封缺集成测试（现只有 store 单测）；首启示例任务 chips 与桌面栏折叠待产品确认
  - *已排除*：「`TaskBoard`/`WorkerCard` 的 memo 因内联 `onSelect` 失效」**已修**（现靠 `(id)=>void` 稳定 handler + `useCallback`），别重复改
- [ ] **P.2 BACKLOG 剩余 `[ ]` 项**（`docs/BACKLOG.md`）
  - `chatStore` 活跃会话 msgs 无上限（产品级内存取舍，做的话要同时保留 `historyBefore` 再取路径）
  - TS 生成契约新鲜度锁（`api:generate` 产物无 CI/测试比对是否过期）
  - HTTP 错误词汇收编（34 结构化 vs 64 裸串 raise；改前需逐路由核对前端是否字符串匹配 detail）
  - 结构搬移：`create_app`（`main.py` ~295 行）外迁 `routes/system.py`；`Conductor.tsx`（~1280 行）拆历史栏/转录/设置 Modal
  - 测试面统一：conftest 零共享 fixture、double 命名三轨（Fake/Mock/_Stub）
  - 观察项：`WorkflowTracker.stranded_admitted()` 无生产调用者（刻意保留作诊断面）
- [ ] **P.3 长跑验证待排期**：真实模型长跑 / 桌面端 E2E / 全仓回归。
- [ ] **P.4 09-15 审计「档 1」三条只分析未修**：LLM 偏好缓存断层、goalhive 独立执行链路、scheduled_chat 第三套持久化。

---

## 5. 决策区（需要拍板，不是「没做」）

| # | 决策 | 卡住谁 | 现状与建议 |
|---|---|---|---|
| ① | 边界批次 4 走 **路线 A（逐步端点化）** 还是 **先 B（冻结 `GA_EMBEDDED_API.md` 清单 + 越界 import 契约测试）** | W5.1 | 建议先 B：零行为变更即可把越界面变成可检测，再照清单稳步做 A |
| ② | Hub 记忆写入走 **引擎新增 `POST /memory/...` 端点** 还是 **降级只读** | W4.1 | 取决于是否接受「Hub 不能再改 GA 记忆」的体验退化 |
| ③ | adopt 入口位置：仅历史页 / 仅会话栏 / 两处都要 | 无阻塞 | 现实现 = 仅历史页详情栏（`Conversations.tsx:409`）。若要加会话栏快捷，建议只做跳转、不重复实现选择器 |
| ④ | `POST /api/conversations/{cid}/restore` 端点去留 | 无阻塞 | **已无任何前端调用方**（`webui/src` 全仓无 `restoreConversation`）。要么当作纯 API 保留，要么整体下线（连带 `ConversationRestoreResp` 等契约） |
| ⑤ | 是否下线「恢复到当前会话」动作 | — | **事实上已下线**（前端已无入口），只需确认并在文档收口 |

## 6. 已收口 · 不要重复劳动

| 事项 | 证据 |
|---|---|
| restore 会话域收敛（步骤 1–5） | `46ffcb4`；`conversations.py:342/:369`；`session_runtime_factory.py:170` |
| GA 侧 G1+G2：supervisor 协议模板化 | GA `04f0d9d`（09-18）；`supervisor_protocol.md`；`gahub_app.py:152-155`/`:526` |
| 归档导入为会话 + 来源标识/筛选 | `f2061ff`、`64df128`；`server/services/archive_import.py`；`bound_session_id` |
| 子进程生命周期（Job 笼子 + 登记表 + cmd.exe 中介） | `f6f5732`、`20ad092` —— **已进包**（2026-09-18 重建，sidecar 14:43:01 / 46,470 KB）；`child-process-lifecycle.md` §8.5 实机验收仍未做（已按用户决定移出本计划） |
| 会话栏删除交互 + 排序键（2026-09-18） | 删除键改 hover/选中显隐；确认条改「删除索引？」+ 单确认按钮 + 外点/Esc 取消；排序键统一为 `sessionUi.sessionRecencyMs`；发消息即乐观置顶（`queries/sessions.ts`）|
| Conductor 单一命令轨 / 动态持久化 / 历史任务下拉 | `af9feb8`、`d17f024` 等 |
| BACKLOG「conductor 引擎无 journal」 | `conductor_journal.py` 存在；`gahub_app.py:238` 读 `GAHUB_JOURNAL_PATH` |
| 边界方案批次 0（删 `.ga-staging/`） | 目录已不存在（2026-09-18 实测） |
| 完成标记接受单括号别名（跨仓读取端放宽） | 2026-09-14；引擎 `_DONE_TAIL_RE` + Hub `stripContractTail` 同集合 |
