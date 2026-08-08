# GA-Hub 稳定性与可维护性优化计划

> 依据 2026-08-08 全项目审查与实测结果。本文记录问题、实施顺序、验收证据和未验证边界。

## 基线

- 审查时后端基线：182 passed，1 skipped，10 subtests passed；约 6 秒。
- 审查时前端基线：47 passed；约 3 秒。
- 审查时 TypeScript + Vite production build：通过，682 modules。
- 当前工作区已有用户未提交修改：`webui/src/pages/LiveChat.tsx`；实施过程不触碰、不覆盖。
- npm audit 当前镜像不支持 audit API，依赖漏洞状态未验证。

## 目标与顺序

### P1-A：发布质量门禁（本轮先做）

- 新增 PR/push CI：pytest、前端测试、类型检查、生产构建。
- release 构建依赖质量门禁成功。
- `check.bat` / `check.sh` 补跑前端测试，npm 优先使用 lockfile 安装。

### P1-B：前端请求韧性

- 统一 HTTP client 默认超时。
- 支持 `AbortSignal`，保留调用方 RequestInit 合并能力。
- 超时产生可识别的 `TimeoutError`，取消请求不伪装成服务端错误。
- 对上传、流式/长任务保留显式延长或取消入口。

### P1-C：可观测性

- 统一服务健康状态为 healthy/degraded/unavailable/unknown。
- 日志增加轮转和脱敏诊断出口。
- FastAPI 生命周期弃用 API 迁移另列后续任务，避免与本轮行为改动混杂。

### P2：维护成本与体验

- 统一 Python/WebUI/桌面壳/安装包版本来源。
- 发布版关闭公开 source map，或改用 hidden source map。
- 为 LiveChat、MyKey、调度和服务降级补关键 E2E/故障注入测试。
- 按行为边界拆分 launcher、agent_service、LiveChat/chatStore、MyKey。
- 分批收敛宽泛异常捕获，并保留必要边界降级。
- 完成关键页面键盘导航、焦点和 aria 审计。

## 验收规则

每一批改动都必须：

1. 先检查 `git diff`，确认不包含用户既有 `LiveChat.tsx` 修改；
2. 运行对应测试；
3. 运行 `git diff --check`；
4. 最终报告区分已验证、未验证和残余风险。

## 当前状态

- [x] 审查报告和实施计划落盘
- [x] CI 与本地门禁
- [x] HTTP timeout/abort
- [x] 生产 source map 关闭；版本统一为 `pyproject.toml` 的 `0.3.4`，并新增一致性测试
- [x] 日志轮转、脱敏诊断出口与健康状态
- [ ] 大模块拆分与 E2E（后续独立批次，避免扩大本轮行为变更）

## 本轮验收（2026-08-08）

- 后端全量：186 passed，1 skipped，10 subtests passed。
- 前端：51 passed；TypeScript lint 通过；production build 通过，682 modules。
- `git diff --check`：通过。
- Rust/Tauri：本机未安装 `cargo`，因此未执行 `cargo check`；版本字段和 `Cargo.lock` 由静态一致性测试覆盖。
- 用户既有 `webui/src/pages/LiveChat.tsx` 修改不属于本轮提交。
