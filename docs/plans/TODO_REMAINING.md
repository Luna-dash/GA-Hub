# GA-Hub 待办总计划

- 首次整理：2026-09-18（源自 `PLAN_REMAINING_AUDIT_20260918.md` 的逐文件盘点 + 全量状态标记）
- **本文件是唯一待办入口**：其他计划文档只保留设计记录，进度一律回到这里勾销。
- 文件名故意不带日期：待办是活的，避免「日期一过就自动变成过期文档」这个本仓反复发作的老毛病。
- 已收口的事项见 §6 —— 动手前先看一眼，别重复劳动。

---

## 0. 执行顺序总览

> **已出列（2026-09-18 用户决定，不再跟踪）**：原 **W0**（Datalab key 轮换 + 本地敏感文件清理）与 **W1**（McAfee 排除项 → 重建桌面端 → §8.5 实机验收）。W1 的重建已随当日 UI 修复一并执行（见 §6），因此波次编号从 **W2** 起。
>
> **2026-09-20 架构决策已收口**：旧 `GA_HUB_BOUNDARY_PLAN.md` 与 `GA_HUB_DEPENDENCY_PLAN.md` 已作废；W3 只按 [`gahub-frontend-implementation-plan.md`](./gahub-frontend-implementation-plan.md) 执行。

| 波次 | 内容 | 前置 | 执行方 | 为什么排这里 |
|---|---|---|---|---|
| **W2** | GA 侧 Conductor 任务语义：G3 → reopen → G4 复核 | 无（改完重启引擎即可） | GA + Hub | 独立业务语义线，不与关系治理混写 |
| **W3.0** | 文档与架构口径收口 | 无 | Hub 文档 | 先消除互相冲突的施工依据 |
| **W3.1** | 真实性、Memory 数据安全、import 副作用 | W3.0 | 两仓 | 先修误导用户和可能覆盖数据的问题 |
| **W3.2** | 依赖护栏、契约单源、启动前置校验 | W3.1 | 两仓 | 迁移前阻止新增债务 |
| **W3.3–W3.5** | workspace/usage → session/archive/rewind → Agent/model | W3.2 | 两仓 | 按风险从低到高垂直迁移 |
| **W3.6** | official hub 可选监控/遥控接入 | 无硬阻塞 | GA 为主 | 独立能力，不阻塞主治理线 |
| **W3.7** | 旧 marker、fallback、白名单清理 | 对应兼容窗口结束 | 两仓 | 最后删除兼容层，避免提前破坏 |
| **并行轨** | 可靠性 §8.4 遗留 / BACKLOG / 长跑验证 | 无 | 两仓 | 低优先，不占关键路径 |

**执行硬规则**

1. W2 的引擎脚本改动只需重启 GA 引擎，不要求重建桌面端。
2. 跨仓能力一律 **GA provider first → Hub consumer second**。
3. 每项能力独立完成“新入口、测试、调用方切换、旧入口删除或兼容登记”，不做一次性大迁移。
4. 主 Agent 高语义能力走进程内 bridge；Conductor 只走 HTTP/SSE；Memory 由 Hub 授权编辑并加冲突保护。

---

## W2 · Conductor 任务语义收口

- [ ] **2.1 G3：新任务边界换归档 + 清上下文**。需要 `_new_log_path` + `_retarget_log` + `_clear_conversation_state`（当前在 `GA/frontends/gahub/` **零命中** = 未开工）。
      *不改的后果*：**「一个任务一个归档」不成立** —— supervisor 归档把多任务轮次混在一起。这是 `conductor-task-model.md` §1 目标终态的最后一块。
- [ ] **2.2 对已完成任务追加时保留原 workflow 语义**。当前会另铸 `request_id`，需 GA 侧 workflow reopen（清 `terminal_event` / `final_item`）+ Hub 侧配套。依据 `conductor-task-model.md` §4 H2.2。
- [ ] **2.3 G4 复核**：单 worker 级 `abort_subagent(origin=…)` 与 `CANCELLED` 终态已存在。确认是否还缺 workflow 级终态；若已足够，直接勾销旧文档的 G4。

## W3 · GA / GA-Hub 关系治理

> 唯一实施依据：[`gahub-frontend-implementation-plan.md`](./gahub-frontend-implementation-plan.md)。

### W3.0 文档与口径收口

- [x] 作废 `GA_HUB_BOUNDARY_PLAN.md` 和 `GA_HUB_DEPENDENCY_PLAN.md` 的旧执行内容。
- [x] 建立唯一权威实施方案，并同步本待办和计划索引。
- [x] 决策落定：不全量 HTTP 化；不搬走 `frontends/gahub/`；Memory 由 Hub 授权编辑；official hub 只做可选窄控制面。

### W3.1 真实性与数据安全

- [x] 修正 README、pyproject、路径注释中“磁盘零侵入/从不写 GA”表述。
- [x] Memory 写入增加 `expected_mtime` 或内容 hash、HTTP 409、写前备份、原子替换和前端重新载入。
- [x] 清理 `frontends/gahub/__init__.py` 对 `gahub_app` 的 wildcard 导入。
- [x] 增加 bridge 子模块 import 无副作用测试。

### W3.2 治理护栏与协议前置校验

- [x] GA 增加 frontend 依赖方向测试；通用 frontend 禁止新增 `GAHUB_`/`__GAHUB_` 协议名。
- [x] Hub 增加 GA 允许入口和遗留白名单测试；白名单只能减少。
- [x] GA 用单一常量生成 `/health` 与 `/recovery` 的 protocol/capability 声明。
- [x] Hub 共用一个 validator，并在启动 health 阶段立即校验版本、能力、boot identity 和 path policy。
- [x] 增加 paired-repo contract 测试。

### W3.3 低风险能力垂直迁移

- [x] workspace。
- [x] usage/cost tracker。
- [x] native log path。
- [x] archive 只读投影。

### W3.4 Session / Archive / Rewind

- [x] continue / begin / release native session。
- [x] archive occupant / lock / parse。
- [x] bind / sync rewind store、restore turn。
- [x] 移除 Hub 对 GA 私有 rewind 字段的直接写入，并用真实 archive fixture 回归。

### W3.5 Agent runtime 与模型配置

- [x] turn-end hook 注册/释放与 shutdown 清理。
- [x] Main Agent factory；GoalHive 保持独立 runtime owner。
- [x] LLM resolve/reload、MyKey invalidation、patch/tool 注入。
- [x] 验证模型切换、web/code tools、线程/子进程和 hook 无回归或残留。

### W3.6 Official hub 可选接入

- [ ] 在组合入口注册 monitor/wake/abort 窄控制面。
- [ ] 不替代 Conductor 和产品 API；依赖缺失时安全降级。
- [ ] 实测断线重连和 abort。

### W3.7 兼容清理

- [ ] 兼容窗口结束后移除旧 `__GAHUB_FEISHU_CHAT__` marker。
- [ ] 核实并清理无消费者 timeout topic、legacy WebUI fallback。
- [ ] 收紧 direct-import 白名单，删除无调用者旧 helper。

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

> 原决策 ①（全量端点化或冻结清单）与 ②（Memory 端点化或只读）已于 2026-09-20 关闭：采用“高语义能力进程内 bridge + Conductor HTTP/SSE”；Memory 保留 Hub 授权编辑并增加数据保护。

| # | 决策 | 卡住谁 | 现状与建议 |
|---|---|---|---|
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
