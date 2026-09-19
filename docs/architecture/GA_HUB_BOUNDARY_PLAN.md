# GA 与 GA-Hub 边界方案（已作废）

> **状态：⛔ 已作废（2026-09-20）**
>
> 本文提出的“GA 与 GA-Hub 之间只允许 HTTP/SSE、Hub 不得 import GA、Memory 只能端点化或只读”等结论不再采用。
>
> 唯一权威实施方案：
>
> [`../plans/gahub-frontend-implementation-plan.md`](../plans/gahub-frontend-implementation-plan.md)
>
> 后续不得再按本文的批次 1–5 或路线 A/B 执行。历史内容可通过 Git 版本 `f3ba005` 查阅。

作废原因：

1. GA-Hub 已明确定位为 GA 的特殊 frontend，而不是普通远程客户端；
2. 主 Agent、GoalHive、模型与原生 session 存在高语义进程内状态，强制全部 HTTP 化会增加回归风险；
3. 用户已决定 GA-Hub 可以正式编辑 GA Memory，原“端点化或只读”决策已失效；
4. Conductor 已经有独立 HTTP/SSE 边界，不应把其规则机械套到所有能力；
5. 当前 `/health` 已声明 protocol/version capabilities，原文部分现状判断已经过期。

当前文档分工：

- **架构与实施唯一来源**：`docs/plans/gahub-frontend-implementation-plan.md`
- **待办与进度唯一入口**：`docs/plans/TODO_REMAINING.md`
- **计划文档索引**：`docs/plans/README.md`
