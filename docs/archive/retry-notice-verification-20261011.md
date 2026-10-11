# 重试提示定位修复（2026-10-11）

## 行为
- 进行流的恢复提示使用 recoveryOffset/recoveryStreamId 锚定当前恢复流边界，位于之前正文之后、恢复正文之前；等待阶段提示在当前尾部。
- 不改写模型正文，不把重试状态写入存档；完成事件清理恢复提示，完成快照不再生成“重试已完成”。
- 已完成恢复流的迟到累计事件不能复活提示。

## 修改文件
- webui/src/stores/chatStore.ts
- webui/src/components/MessageBubble.tsx
- webui/src/components/LiveChatTranscript.tsx
- webui/src/stores/chatStore.recovery.test.ts
- webui/src/components/MessageBubble.test.tsx

## 验证
- vitest 全量：71文件、595测试通过。
- tsc --noEmit：通过。
- npm run build：通过，webui/dist 已刷新。
- git diff --check：通过。
- python scripts/build_all.py：exit 2，预检确认 ga-hub-sidecar.exe 正被占用；未关闭宿主或绕过产物守卫，桌面两个exe未完成重建。
- 未进行桌面真实重试端到端验收；组件DOM顺序及事件链由回归测试覆盖。

日志：同目录 retry-full-vitest.log、retry-webui-build.log、retry-build-all.log。
