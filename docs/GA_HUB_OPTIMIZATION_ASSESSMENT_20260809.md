# GA-Hub 近期优化复验与评估报告

日期：2026-08-09
复验基线：`acff165`（本地 `main` 与实时 `myfork/main` 一致，ahead/behind = 0）

## 结论

近期优化整体有效，后端、前端和生产构建均通过全量回归；安全边界、会话 I/O、调度持久化、生命周期、HTTP 请求韧性、可观测性及聊天提交热路径缓存均有对应实现和测试。测试规模已从计划记录的后端 186 项增长到本次实测 216 项，未发现现有优化引入的功能回归。

项目仅供本地使用、不准备分发，因此不保留 GitHub workflow。质量验证由本地 `check.bat` / `check.sh` 及本报告列出的测试命令承担。

综合评级：**A-（可继续演进；主要残余风险为 E2E 覆盖不足及少量平台相关场景未实测）**。

## 优化行为梳理

| 主题 | 主要提交 | 评估 |
|---|---|---|
| 会话管理、标题与 Token 使用体验 | `15e6448` | 功能增强已进入前后端；本轮全量回归通过。 |
| 上传/文件/ZIP/会话 I/O 健壮性及生命周期 | `0595c6b` | 分块与上限、防目录逃逸、索引与资源退出均有专项测试；Windows 实体 symlink 场景仍受权限限制而跳过。 |
| 调度持久化与并发协调 | `f8b347c`, `cacc559` | 覆盖任务恢复、调度协调及相关异常路径；全量回归通过。 |
| 校验、日志、健康状态与版本一致性 | `4ca906b` | P1-C 已实际完成；健康状态、脱敏诊断、日志轮转和版本一致性已有实现/测试。 |
| MyKey codec 与原始内容呈现 | `00a80f4` | codec 与 UI 有专项测试；全量回归通过。 |
| Agent 回调与 prompt artifact 回归测试 | `349d9fb` | 增加异常日志与行为测试，避免裸吞异常。 |
| preferred LLM 热路径缓存 | `d60e9b7` | 消除每次 submit 的重复配置磁盘读取，并保留临时任务 LLM 切换后的偏好恢复语义。 |
| 启动服务后台并行化评估 | `acff165` | **否决合理**：可并行部分只有毫秒级收益，却会引入 scheduler 尚未安装时即被访问的竞态。 |
| HTTP timeout/abort | `4ca906b` 所在批次 | P1-B 已完成：默认超时、调用方 signal 合并、TimeoutError/主动取消/网络错误分类均有前端单测。 |

## 本次实测证据

### 后端

执行：`python -m pytest -q`

- **216 passed**
- **1 skipped**
- **10 subtests passed**
- 耗时约 **4.40 s**
- 10 条 warning 均为第三方 protobuf/FastAPI `on_event` 弃用告警，不是测试失败。

跳过项是 Windows 实体 symlink 权限相关测试；跨平台模拟路径已有覆盖，但本机未验证真实 Windows symlink。

### 前端

执行：

- `npm test -- --run`
- `npm run lint`
- `npm run build`

结果：

- **12 test files / 51 tests passed**
- TypeScript `tsc -b --noEmit` 通过
- production build 通过
- **683 modules transformed**，约 **2.42 s**

模块数比旧报告的 682 多 1；本次工作区存在用户自己的 `LiveChat.tsx` 未提交修改，因此不能把该变化单独归因于已提交优化。本轮没有修改或覆盖该文件。

## 问题与纠偏结果

1. **项目交付模式已纠正**
   项目不分发，已删除 `.github/workflows/release.yml`，计划文档同步改为纯本地质量验证，不再维护无实际用途的自动构建和发布流程。

2. **计划状态的表述歧义已核实**
   P1-B（HTTP timeout/abort）与 P1-C（健康状态/日志/诊断）均已完成。本轮不重复实现，避免无价值重构。

3. **启动并行化没有盲目实施**
   现有否决结论有明确收益/竞态分析，保持串行启动是当前正确选择。

## 残余风险与后续建议

1. **E2E 仍为空缺**：建议下一独立批次添加最小 headless Edge E2E，覆盖会话创建/切换、WS snapshot/replay、取消请求和错误恢复。
2. **弃用告警**：测试夹具仍使用 FastAPI `on_event`。应在后续维护批次迁移到 lifespan，防止未来 FastAPI 升级变成硬错误。
3. **真实 Windows symlink 场景未验证**：需要管理员权限或 Developer Mode 环境补一次实体测试。
4. **前端大 chunk**：`MarkdownView` 约 446 kB（gzip 136 kB）仍是最大异步 chunk。若启动性能实测表明它进入关键路径，再做依赖拆分；当前不应仅凭体积数字盲目重构。
5. **用户未提交修改**：`webui/src/pages/LiveChat.tsx` 保持原状，需由其作者独立审查、提交或回退；本报告不将其计入本轮纠偏成果。

## 本次交付边界

- 删除 `.github/workflows/release.yml`；
- 更新 `docs/GA_HUB_OPTIMIZATION_PLAN.md` 的本地使用约束；
- 新增本评估报告。

未自动 commit 或 push。
