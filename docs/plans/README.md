# 计划文档索引（docs/plans）

- 最后整理：2026-09-18
- 口径：**以代码、提交与构建产物为准**，不采信计划文档的自述状态。历史上已抓到 5 处自述与事实不符（清单见 §3）。
- **待办唯一入口**：[`TODO_REMAINING.md`](./TODO_REMAINING.md)。其他文档只保留设计记录，进度一律回到那里更新。

---

## 1. 状态图例

| 标记 | 含义 | 该怎么处理 |
|---|---|---|
| ✅ 已完成 | 动作全部落地，且有提交/产物证据 | 保留为设计记录；可收进 `docs/archive/` |
| 🟡 部分完成 | 部分落地，仍有明确剩余动作 | 剩余部分已汇总进 `TODO_REMAINING.md` |
| ⏹ 已过期 | 描述的状态已被后续实现推翻 | 应收进 `docs/archive/` |
| 📌 活文档 | 持续维护的清单 / 规格 / 参考 | 就地更新，不归档 |

## 2. 一览

### 2.1 docs/plans/

| 文档 | 状态 | 结论与证据 |
|---|---|---|
| `restore-session-scoped-fix-plan.md` | ✅ 已完成 | 步骤 1–5 全部落地并提交 `46ffcb4`（09-15）。`conversations.py:342/:369` 使用 `session_id` + `archive_override`；`session_runtime_factory.py:170` 支持 override |
| `restore-session-scoped-fix-checkpoint-2026-09-15.md` | ⏹ 已过期 | 文中「route 仍调进程级 `AgentService.instance()`」已不成立 |
| `restore-ui-interaction-spec.md` | 🟡 部分完成 | adopt / 来源徽标 / 入口 / 后端契约已落地（`a7c3cab`、`f2061ff`、`64df128`）；§1.1、§2.2、§2.3、§2.4 因「restore 动作整体下线」而作废；剩 §6.3 一个决策 |
| `feishu-import-task-brief.md` | ✅ 主体完成 | T1 / T2 / T3 均落地；§3 五条待办只剩决策项 |
| `conductor-task-model.md` | 🟡 部分完成 | H1–H3 ✅（`a1d5659`）、G1+G2 ✅（GA `04f0d9d`）；**G3 未开工**、G4 待复核、追加 reopen 缺口 |
| `child-process-lifecycle.md` | 🟡 代码已实施并进包 | 实现已提交（`f6f5732`、`20ad092`）；**2026-09-18 重建后新包已含 `20ad092`**（见 §4.1）；**§8.5 实机验收仍未做** |
| `ga-supervisor-protocol-patch.md` | ✅ 已完成 | 补丁包已执行完毕：GA `04f0d9d`（2026-09-18 06:25） |
| `ga-side-handover-g1g2.md` | ✅ 已完成 | 交接单已被接收方执行（GA `04f0d9d`）；文中「GA HEAD `aba30f7`」已过期 |
| `PLAN_REMAINING_AUDIT_20260918.md` | 📌 分析记录 | 本次盘点的过程与证据；桌面产物一节已按实测更正 |
| `TODO_REMAINING.md` | 📌 活文档 | **唯一待办入口**（波次顺序 + 决策区 + 已收口清单）。原 W0（key 轮换）/ W1（重建与验收）已于 2026-09-18 按用户决定移出，故波次从 W2 起 |

### 2.2 docs/architecture/

| 文档 | 状态 | 结论 |
|---|---|---|
| `GA_HUB_BOUNDARY_PLAN.md` | 🟡 待决策 | 批次 0（删 `.ga-staging/`）已完成（实测目录已不存在）；批次 1–5 未开工，卡 §9 两个拍板点。⚠️ 该文件**尚未纳入 git 跟踪**（`git status` 显示 `??`） |
| `GA_HUB_DEPENDENCY_PLAN.md` | 🆕 未复核 | 2026-09-18 **15:09 由另一会话落盘**（本轮整理之后），细化解耦面并**自称修订** `GA_HUB_BOUNDARY_PLAN.md` §5 批次表三处。执行 W3–W5 前必须先读它——这三波的依据正是被它修订的那张表 |
| `conductor-reliability-plan.md` | 🟡 主体已实施 | §8.4 遗留未清零（逐项见 `TODO_REMAINING.md` 并行轨） |
| `api-contract-generation.md`、`llm-preference-store.md`、`session-runtime-controls.md` | 📌 架构参考 | 非计划文档，随实现更新 |

### 2.3 docs/ 根与其他

| 文档 | 状态 | 结论 |
|---|---|---|
| `docs/BACKLOG.md` | 📌 活文档 | 历史多轮扫描的条目绝大多数已勾销（`[x]`）；剩余 `[ ]` 已汇总进 `TODO_REMAINING.md` |
| `docs/BUILD.md`、`docs/CONDUCTOR_SUBAGENT_MODEL_POLICY.md` | 📌 参考手册 | 非计划文档 |
| `temp/restore-session-scoped-implementation-checkpoint.md` | ⏹ 已过期 | 本地草稿（未跟踪），内容同 2.1 的 checkpoint |

---

## 3. 已知的「文档自述失真」（复发点）

计划文档的自述状态**不可信**，本轮已逐条纠正。**新增计划时请遵守**：状态行必须带提交哈希或产物时间戳，否则下次盘点仍会误判。

| 文档 | 原自述 | 事实 |
|---|---|---|
| `restore-session-scoped-fix-plan.md` | 「尚未开始步骤 2」 | 5 步全部完成并提交（`46ffcb4`） |
| `conductor-task-model.md` | 「GA 侧 G1–G4 未开工」 | G1+G2 已于 2026-09-18 完成（GA `04f0d9d`） |
| `child-process-lifecycle.md` §8.5 | 读起来像「未实施」 | 代码已实施，缺的只是实机验收 |
| `docs/BACKLOG.md` 2026-09-05「引擎无 journal」 | `[ ]` | 引擎侧已实现写盘（`conductor_journal.py` + `gahub_app.py:238`） |
| `PLAN_REMAINING_AUDIT_20260918.md` §1 #1 | 「桌面端未重建，`target` 下无 exe」 | **错**：exe 存在，只是构建落后于 3 个提交（见 §4） |

## 4. 构建产物事实

### 4.1 当前包（2026-09-18 14:43 / 14:54 重建）

- `src-tauri/target/x86_64-pc-windows-msvc/release/`：
  - `ga-hub-sidecar.exe` —— 2026-09-18 **14:43:01**，46,470 KB
  - `ga-hub-desktop.exe` —— 2026-09-18 **14:54:23**，6,224 KB
- 打包内前端 `_up_/webui/dist/index.html` 与工作区 `webui/dist/index.html` **逐字节一致**（sha256 前缀同为 `6c90ea24b5ed7bf7`）；工作区 `dist/assets` 的 95 个文件**全部在包内**（含本次会话栏 chunk `LiveChat-Cr41SXJI.js`）。
- 因此 09-16 的 `20ad092`、`348345e`、`ca0c278` 与 09-18 的会话栏改动**都已在包里**。
- 构建方式：`python scripts/build_all.py`（前端 9.6s + sidecar 64.8s + Tauri 72.4s = 147s），产物守卫通过。

### 4.2 历史：为什么当时判定「需要重建」（2026-09-18 早间实测）

- 当时 `ga-hub-sidecar.exe` 停在 09-16 **10:50:59**、`ga-hub-desktop.exe` 停在 10:52:09，
  打包内 `index.html` sha 前缀 `114be840d2ab74dd` —— 09-16 10:52 之后的提交都不在包里：

| 提交 | 时间 | 改了什么 |
|---|---|---|
| `20ad092` | 09-16 13:43 | `child_job.py` + `conductor_client.py`（cmd.exe 中介启动 —— 修「冻结侧车 spawn 挂死」） |
| `348345e` | 09-16 14:05 | `webui/src/pages/Conductor.tsx`（启动窗口 UX 收口） |
| `ca0c278` | 09-17 20:59 | `server/services/mykey_service.py`（默认端点切 KV） |

- 当时的结论是「需要重建」，理由不是「从未构建」，而是「构建落后于 3 个提交」—— 已于 §4.1 完成。
- 参照：GA 侧引擎改动（如 `04f0d9d`）**不需要重建** —— 引擎是以 `python.exe` 直接运行的脚本（`D:\study\GA\frontends\gahub\gahub_app.py`），重启引擎即生效。

---

## 5. 下一步（需用户确认后才执行）

以下 4 份已完成 / 已过期的文档**目前只做了标记，未移动**。按本仓 `docs/archive/` 约定，建议收进归档：

- `restore-session-scoped-fix-plan.md`（已完成）
- `restore-session-scoped-fix-checkpoint-2026-09-15.md`（已过期）
- `ga-supervisor-protocol-patch.md`（已完成）
- `ga-side-handover-g1g2.md`（已完成）

移动时需同步修两处相对引用：`restore-ui-interaction-spec.md:6`（指向 fix-plan）、`ga-side-handover-g1g2.md:5`（指向 patch 包）。
