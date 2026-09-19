# GA-Hub 与 GA 依赖方案（已作废）

> **状态：⛔ 已作废（2026-09-20）**
>
> 本文原用于分析 GA-Hub 作为特殊 frontend 时的依赖关系。其有效结论已经合并进唯一权威实施方案：
>
> [`../plans/gahub-frontend-implementation-plan.md`](../plans/gahub-frontend-implementation-plan.md)
>
> 后续不得再从本文提取批次、待办或架构规则。历史内容可通过 Git 版本 `f3ba005` 查阅。

作废原因：

1. 与旧 `GA_HUB_BOUNDARY_PLAN.md` 对运行边界的定义冲突；
2. 混合了现状分析、架构决策和执行计划，容易造成多份权威来源；
3. fsapp 中性事件迁移、Conductor 协议声明、Memory 编辑权等状态已经变化；
4. 最新方案已经明确采用“特殊 frontend + 双连接面”，无需继续维护平行方案。

当前文档分工：

- **架构与实施唯一来源**：`docs/plans/gahub-frontend-implementation-plan.md`
- **待办与进度唯一入口**：`docs/plans/TODO_REMAINING.md`
- **计划文档索引**：`docs/plans/README.md`
