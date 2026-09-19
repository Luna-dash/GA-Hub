# GA-Hub 计划盘点：还剩什么没完成（2026-09-18）

> **本文定位：盘点过程与证据记录。**
> 状态视图已并入 [`README.md`](./README.md) §2，待办动作与顺序已并入 [`TODO_REMAINING.md`](./TODO_REMAINING.md)。
> **2026-09-20 更新**：本文关于 `GA_HUB_BOUNDARY_PLAN.md`、批次 1–5、路线 A/B 和 Memory 只读/端点化的结论已经作废；关系治理只按 [`gahub-frontend-implementation-plan.md`](./gahub-frontend-implementation-plan.md) 执行。
> 动手前请看上述活文档，本文只用于追溯“当时为什么得出这个结论”。
>
> **⚠️ 2026-09-18 更正（实测后）**：§1 第 1 行与 §3 P0-1 关于「桌面端未重建 / `target` 下无 release exe」的
> 结论**有误**。实测 `src-tauri/target/x86_64-pc-windows-msvc/release/` 下两个 exe 均存在，构建于
> 2026-09-16 10:50:59 / 10:52:09，且打包内前端与工作区 `webui/dist` **逐字节一致**（sha256 前缀
> `114be840d2ab74dd`）。正确结论是：**构建落后于 3 个提交**（`20ad092`、`348345e`、`ca0c278`），
> 因此仍需重建，但"从未构建"是错的。详见 `README.md` §4。

- 口径：以**当前代码 / 提交 / 产物**为准，不采信计划文档自述（发现 5 处文档已过期，见 §5）。
- 覆盖范围：GA-Hub 仓 `docs/plans/`、`docs/architecture/`、`docs/BACKLOG.md`、GA 仓 `frontends/gahub/`、以及 WorkBuddy / AutoClaw 两个设置区里的会话与日志。
- 证据标注：`文件:行`、commit hash、文件 mtime。

---

## 1. 结论速览

| # | 未完成项 | 归属 | 现在的真实状态 | 证据 |
|---|---|---|---|---|
| 1 | **桌面端构建落后 3 个提交**（`20ad092`/`348345e`/`ca0c278` 未进包） | Hub | 🔴 阻塞实机验证 | exe 存在：09-16 10:50:59（sidecar）/ 10:52:09（desktop）；打包内前端 == `webui/dist`（sha `114be840d2ab74dd`） |
| 2 | 子进程笼子「真实冻结 sidecar」场景未验证 | Hub | 🔴 依赖 #1（且现包不含 `20ad092`） | `docs/plans/child-process-lifecycle.md` §8.5 |
| 3 | **G3**：新任务边界换归档 + 清上下文 | GA | ⬜ 未开工 | `_new_log_path`/`_retarget_log`/`_clear_conversation_state` 在 `GA/frontends/gahub/` 零命中 |
| 4 | **「对已完成任务追加」另铸 request_id** | GA + Hub | ⬜ 未做（需 workflow reopen 语义） | `conductor-task-model.md` §4 H2.2；`ga-side-handover-g1g2.md` §6 |
| 5 | **两仓边界方案 批次 1–5** | 两仓 | ⬜ 仅批次 0 完成 | `GA_HUB_BOUNDARY_PLAN.md` §5 / §9 两个拍板点未定 |
| 6 | 可靠性方案 §8.4 遗留（D 范围 / GA 联跑 / 前端三项） | 两仓 | ⬜ 未做 | `conductor-reliability-plan.md` §8.4 |
| 7 | BACKLOG 未勾销项（含决策项） | Hub | ⬜ 部分待决策 | `docs/BACKLOG.md` 内剩余 `[ ]` |
| 8 | **Datalab API key 轮换**（已泄露到远端） | GA（安全） | 🔴 未处理 | `GA/.workbuddy/memory/2026-09-17.md` §待处理 |
| 9 | McAfee 排除项（用户侧环境动作） | 环境 | ⬜ 未执行 | `BACKLOG.md` 2026-09-07 节 |
| 10 | 前端已无 `restoreConversation` 调用方 → restore 端点无 UI 消费者 | Hub | ⬜ 待决策去留 | `webui/src` 全仓零命中；端点仍在 `conversations.py:338` |

---

## 2. 已收口（不要重复劳动）

| 事项 | 状态 | 证据 |
|---|---|---|
| GA 侧 **G1+G2**：supervisor 协议模板化（system 层 + 每轮 7 行动态头） | ✅ **已提交** | GA `04f0d9d`（2026-09-18 06:25）；`GA/frontends/gahub/supervisor_protocol.md` 已入库；`gahub_app.py:152-155` 读模板、`:526` `extra_sys_prompts=[SUPERVISOR_PROTOCOL]` |
| 运行期验收（不再落 `user_prompt_*.md`） | ✅ 已验 | `GA/.workbuddy/memory/2026-09-17.md` §GA 侧验收：195→195 delta=0，主会话归档每轮 7 行 |
| restore 会话域收敛（原计划 Step 1–5） | ✅ **已落地并提交** | Hub `46ffcb4`（09-15）；`server/routes/conversations.py:342-398` 使用 `ConversationRestoreReq.session_id` + `archive_override` + `replace_runtime`；openapi / `schema.d.ts` 已含新契约 |
| 归档导入为会话（T2）+ 来源标识/筛选（阶段 2、4 UI） | ✅ 已做 | Hub `f2061ff`、`64df128`；`server/services/archive_import.py`；`Conversations.tsx` 有 `sourceMeta`/`sourceFilter`/「导入为会话」与测试 |
| 子进程生命周期（Job 笼子 + 登记表 + 引擎 `cmd.exe` 中介） | ✅ 源码已实现；⚠️ `20ad092` **未进现包** | Hub `f6f5732`（09-16 09:22，在包内）、`20ad092`（09-16 13:43，不在包内） |
| Conductor 单一命令轨、动态持久化、历史任务下拉 | ✅ 已做 | `af9feb8`、`d17f024` 等 |
| BACKLOG「conductor 引擎无 journal」 | ✅ **实际已实现**（条目未勾销 → 2026-09-18 已勾销） | `GA/frontends/gahub/conductor_journal.py` 存在；`gahub_app.py:238` 读 `GAHUB_JOURNAL_PATH`；Hub `conductor_client.py` 注入该变量 |
| 边界方案批次 0（删 `.ga-staging/`） | ✅ 已完成 | 目录实测不存在（2026-09-18） |

> **一处假警报**：`GA/temp/user_prompt_*.md` 在 09-18 又新增了 2 个（10:09、11:52，pid 36784），初看似 G1/G2 回归。逐字读该文件后确认内容是**普通聊天的超长粘贴**（一段 base64 游戏存档 `STARDUST1:…`），不是 supervisor 的 7 行 wake 消息 → **G1/G2 结论不受影响**，这是 `agentmain` 对任意长 user prompt 的通用行为。

---

## 3. 真正的未完成（证据明细）

### P0 · 阻塞实机验证

1. **重建桌面端**。现包构建于 2026-09-16 10:50:59（sidecar）/ 10:52:09（desktop），**早于**以下三个提交：

   | 提交 | 时间 | 内容 | 打包位置 |
   |---|---|---|---|
   | `20ad092` | 09-16 13:43 | `child_job.py` + `conductor_client.py` —— cmd.exe 中介启动（修「冻结侧车 spawn 挂死」） | sidecar |
   | `348345e` | 09-16 14:05 | `webui/src/pages/Conductor.tsx` —— 启动窗口 UX 收口 | webui/dist |
   | `ca0c278` | 09-17 20:59 | `server/services/mykey_service.py` —— 默认端点切 KV | sidecar |

   - 重建前先退 app（否则 `ga-hub-sidecar.exe` 被锁 → PermissionDenied）。
   - 重建风险面：新哈希 → McAfee 信誉从零重评 → **排除项未加则引擎拉不起来**（见本节第 9 项）。

2. **`child-process-lifecycle.md` §8.5 的"真实冻结 sidecar"验收**。这是该方案唯一的未验证项（本地复现不了）。而修该场景的 `20ad092` **不在现包里**，因此必须"先重建再验"。重建后按 §5 验收清单跑：优雅关 / `taskkill /F` 硬杀 / 逃生口 / 手动附着不受影响。

### P1 · 引擎侧协议与生命周期

3. **G3：新任务边界换归档 + 清上下文**（`_new_log_path` + `_retarget_log` + `_clear_conversation_state`）。grep 零命中 = 未开工。不做这条，**"一个任务一个归档"不成立**，supervisor 归档仍把多任务轮次混在一起。

4. **「对已完成任务追加」的 reopen 语义缺口**。`conductor_commands.submit` 按 `is_open` 判定，对终态任务追加会**另铸 request_id**（实际变成新任务、不回到原归档）。需要 GA 侧 workflow reopen（清 `terminal_event`/`final_item`）+ Hub 侧配套，跨仓一起改。

5. **G4：放弃（任务级）的引擎侧语义**——复核。引擎已有单 worker 级 `abort_subagent(origin=...)` 与 `CANCELLED` 终态（`conductor_core.py:1567`、`gahub_app.py:1920`），Hub 侧也走该端点；但计划把 G4 列为未开工，需按 `conductor-task-model.md` §4 核对是否还缺 **workflow 级终态**收口。

### P1 · 两仓关系治理（旧结论已作废）

> 本节原列出 `GA_HUB_BOUNDARY_PLAN.md` 的批次 1–5，包括“全部跨进程”“Memory 端点化或只读”“重命名 `frontends/gahub`”等动作。它们已于 2026-09-20 被新架构决策取代，不得继续执行。

当前结论只保留为：GA-Hub 是 GA 的特殊 frontend；主 Agent 高语义能力走受控进程内 bridge，Conductor 走 HTTP/SSE，Memory 由 Hub 授权编辑并增加冲突保护。具体波次见 [`gahub-frontend-implementation-plan.md`](./gahub-frontend-implementation-plan.md) §10 和 [`TODO_REMAINING.md`](./TODO_REMAINING.md) W3。

### P2 · 可靠性方案遗留（`conductor-reliability-plan.md` §8.4）

11. **D 范围**：`workflows` 表终态行无保留策略（DB 无界增长）；旧 boot 的 pending 命令被静默跳过、unknown 数量/年龄不可观测；`engine_key` 取 `base_url`（应引入显式配置键）；提交被拒后遗留的 `submitting` 投影无清理。
12. **GA 仓范围**：§7 场景表第 5、8 行（watchdog 节拍、请求预算）的故障测试与两仓联跑套件，需在 GA 仓安排频率。
13. **前端范围**：`conductor.css` 局部 palette 与全局单主题冲突待收敛决策；页面级版本信封缺集成测试（现只有 store 单测）；首启示例任务 chips 与桌面栏折叠需产品确认。
    - 注：该节同时列的"`TaskBoard`/`WorkerCard` 的 memo 因内联 `onSelect` 失效"**已修**（现在靠 `(id)=>void` 稳定 handler + `useCallback`），复核时别重复改。
14. **真实模型长跑 / 桌面端 E2E / 全仓回归**待排。

### P2 · BACKLOG 里仍未勾销的条目

15. `[ ]` **chatStore 活跃会话 msgs 无上限**（打开视图随翻页无限增长）——产品级内存取舍。
16. `[ ]` **TS 生成契约新鲜度锁**：`api:generate` 产物无 CI/测试比对"是否过期"。
17. `[ ]` **HTTP 错误词汇收编**（34 结构化 vs 64 裸串 raise）：`routes` 内 `_not_found` 类 helper 升级为 coded `_api_error`；改前需逐路由核对前端是否字符串匹配 detail。
18. `[ ]` **结构搬移**：`create_app`（`main.py` ~295 行）内联端点外迁 `routes/system.py`；`Conductor.tsx`（~1280 行）拆历史栏/转录/设置 Modal。
19. `[ ]` **测试面统一**：conftest 零共享 fixture、double 命名三轨（Fake/Mock/_Stub）、TestCase vs 函数式无规律。
20. `[ ]` **观察项**：`WorkflowTracker.stranded_admitted()` 无生产调用者（刻意保留作诊断面）。
21. `[ ]` **McAfee 排除项**（用户侧，**尚未执行**）：把 `ga-hub-sidecar.exe` 与 `D:\APP\anaconda3\envs\ga\python.exe` 加入排除；或改计划任务启动引擎。**新哈希桌面在排除项落地前无法拉起引擎**——这直接卡住 §3 第 1 项的重建验证。

### P3 · 待产品/用户决策（不是"没做"，是"没定"）

22. **边界方案 §9 两个拍板点**：① 批次 4 走 A 还是先 B；② Hub 记忆写入走引擎端点还是降级只读。
23. **Conductor UI 六项（09-11 记录，待再定）**：WorkerCard 单击强切 tab、验收后自动跳转、停止二次确认、启动键改名、展开区与卷宗收敛、窄屏滚动记忆。（部分可能已被后续重构取代，落地前先复核。）
24. **`restore-ui-interaction-spec.md` §6**：是否下线「恢复到当前会话」动作 → **事实上已下线**（前端零调用方）；adopt 入口位置（历史页 / 会话栏 / 两处）仍待定。
25. **`POST /api/conversations/{cid}/restore` 端点去留**：已无 UI 消费者。

### P3 · 安全（必做，与业务无关）

26. **Datalab API key 轮换**：key 仍存在于 GA 仓历史，其中 `0477bd8` **已在 `origin/main`** → 删文件不能补救，**必须在 Datalab 侧轮换**；同时处理本地未跟踪的 `memory/chat_history.json`、`memory/L4_raw_sessions/all_histories.txt`。（`GA/.workbuddy/memory/2026-09-17.md`）

27. **09-15 审计"档 1"三条只分析未修**：LLM 偏好缓存断层、goalhive 独立执行链路、scheduled_chat 第三套持久化。（`D:\study\GA-Hub\.workbuddy\memory\2026-09-15.md`）

---

## 4. 文档过期清单（**2026-09-18 已全部处理**）

下表 6 条已于 2026-09-18 就地标记（统一格式的「状态标记（2026-09-18 复核）」横幅 + 修正内部状态行）。
本节保留为「文档自述不可信」这一现象的**证据**，供下一轮盘点参考。

| 文档 | 原自述 | 已改为 |
|---|---|---|
| `docs/plans/restore-session-scoped-fix-plan.md` | "尚未开始步骤 2" | ✅ 已完成（`46ffcb4`） |
| `docs/plans/restore-session-scoped-fix-checkpoint-2026-09-15.md`、`temp/restore-session-scoped-implementation-checkpoint.md` | "route 仍调全局 `AgentService.instance()`" | ⏹ 已过期 |
| `docs/plans/conductor-task-model.md` | "G1–G4 未开工" | 🟡 G1+G2 已完成（GA `04f0d9d`）；G3 未开工、G4 待复核 |
| `docs/plans/feishu-import-task-brief.md` §3 待办 | 列 5 项待办 | ✅ 主体完成，只剩决策 |
| `docs/BACKLOG.md`「conductor 引擎无 journal」 | `[ ]` | ✅ 已勾销（含残余说明） |
| `docs/plans/restore-ui-interaction-spec.md` | 状态"草案" | 🟡 大部分已落地、§1.1/§2.2–§2.4 作废、剩 1 决策 |

---

## 5. 建议执行顺序

完整顺序、依赖与决策点见 [`TODO_REMAINING.md`](./TODO_REMAINING.md) §0。摘要：

> **已出列（2026-09-18 用户决定）**：本节的第 1、2 条（原 **W0** Datalab key 轮换、原 **W1** McAfee 排除项 + 重建 + §8.5 验收）**不再纳入待办计划**。
> 其中重建已当日完成（14:43 sidecar / 14:54 桌面壳，§4.1），新包已含 `20ad092`；`child-process-lifecycle.md` §8.5 的实机验收因此**具备前提但仍未做**。

1. ~~**W0 先做安全**：Datalab key 轮换（已到 `origin/main`，删文件不能补救）。~~ → 已出列
2. ~~**W1 加 McAfee 排除项 → 重建桌面端 → 补 `child-process-lifecycle` §8.5 实机验收**。~~ → 已出列（重建已完成）
3. **W2 GA 侧 G3**（新任务边界换归档 + 清上下文）→ 追加 reopen → G4 复核。**引擎是脚本，改完重启即生效，不需要重建**。
4. **W3 关系治理**：本盘点当时提出的批次和决策点已经作废；按 [`TODO_REMAINING.md`](./TODO_REMAINING.md) W3.0–W3.7 执行。
5. 文档过期项随手勾销（§4 已完成）。
