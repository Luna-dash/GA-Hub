# 任务简报：飞书会话 → GA-Hub 会话管理（2026-09-15）

> **状态标记（2026-09-18 复核）：✅ 主体已完成，只剩决策项。**
> T1（`a7c3cab`）、T2 导入 / adopt（`f2061ff` + `64df128`，`server/services/archive_import.py` +
> `bound_session_id`）、T3（`46ffcb4`）均已落地。
> §3 的五条待办：① 已重写（规格 §1.2 Adopt）、②④⑤ 已落地；③ 的 `mode: copy` 参数未引入
> （改由独立 adopt 端点承担，等价）。
> 剩余唯一动作是 §4 的三条确认 —— 其中第 1 条已事实落地（前端已无 restore 入口），
> 2、3 见 `docs/plans/TODO_REMAINING.md` 决策 ③ / ④。

## 1. 任务目标

**一句话**：把 GA 的 IM 归档（尤其飞书）变成 GA-Hub 里**可继续的一等会话**。

| 线 | 目标 | 状态 |
|---|---|---|
| T1 | 显示层：飞书会话在「历史对话」页不再泄漏 IM 指令头（FILE_HINT） | 已完成并提交（a7c3cab） |
| T2 | 导入：把无会话归属的归档（飞书/微信/CLI）**导入为一条新会话**（copy + 绑定） | 设计已定，待实现 |
| T3 | 后端：restore 会话域收敛（迁移至 `coordinator.replace_runtime`） | 已完成并提交（46ffcb4） |

## 2. 重要设定（事实与约束）

1. **仓库边界**：本会话绑定 `D:\study\GA-Hub`；GA 仓（`D:\study\GA`）只读——GA-Hub 项目铁律 "never modifies the GA repo"。
2. **FILE_HINT 是 GA 官方设计**（上游 `upstream/main` 含同一常量），每条 IM 消息前置；上游只在「首问预览」处剥离，归档历史读取（`continue_cmd._user_text`）不剥。
3. **GA 恢复语义共四档**：`restore`（载入历史，日志不动）/ `continue_inplace`（接管原文件，追加）/ `continue_copy`（拷成新记录）/ `begin_fresh_session`；另有已失效的「快照」档。
4. **锁缺口（决定性）**：IM 前端（fsapp/微信/QQ/Telegram）**不抢会话锁** → `session_occupant()` 把运行中的飞书会话判为「空闲」→ `continue_inplace` 会与 bot **双写同一归档**。故 inplace 不可用于 IM 源。
5. **持久性**：`archive_override` **不写 metadata**（`bind_archive`/`rotate_archive` 是仅有的两个写入口）→ 通过 restore 的接管**仅本次运行有效**；持久化只能靠绑定。
6. **两个入模入口**（都要注意清洗）：`archive_messages.restore_ga_archive`（转调 GA `restore`）与 `SessionRuntimeFactory`（用 GA `continue_inplace`）。
7. **已定决策（2026-09-15）**：
   - 模式：**copy 唯一**（源归档只读）；不做「接管原记录」。
   - 「恢复到当前会话」建议**下线**，飞书场景一律走「导入为会话」。
   - **导入 = 新建会话 + copy 归档 + 绑定**（= adopt）；多会话下不需要"选目标会话"。
   - 入口：历史页详情栏为主入口；会话栏「新建会话」加「从历史导入…」快捷（跳转，不重复实现选择器）。
   - 列表必须区分**已绑定会话 / 未绑定**（否则一条记录挂两条会话）。

## 3. 进度

- 已提交：`a7c3cab`（FILE_HINT 显示层剥离）、`46ffcb4`（restore 收敛）。
- 已实测：后端 `pytest -q` **804 passed / 1 skipped**；前端 vitest **412 passed / 59 files**；`tsc` 与 `api:check` 通过。
- 已产出：`docs/plans/restore-ui-interaction-spec.md`（UI 交互规格，含第 8 节模型修正）。
- 待办：① 规格按「导入」模型重写 1.1/2.2；② 阶段 1 UI（文案 + 失败映射）；③ 后端 `mode: copy`；④ adopt 端点（新建 + copy + 绑定）；⑤ 列表 `bound_session_id`。

## 4. 待确认

1. 是否下线「恢复到当前会话」动作。
2. 导入入口是否按「历史页主 + 会话栏快捷」。
3. 是否由本会话接后端 `mode: copy` + adopt 端点（或留给另一个任务）。