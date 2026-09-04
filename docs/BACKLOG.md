# 优化待办（Backlog）

来源：2026-09-03 全量架构复审（四路并行）+ GPT 交叉复审的合并结论。按"用户可感知伤害"排序。
修复后请条目化勾销，不要整段删除。

**2026-09-04 进度**：P0 全部、SessionRail 排序、P1 全部、P2 全部、P3 全部
（dac6a10、4e89e76、3df23a3、143ac57、e972ea7、ab591ab、6faffd1、beaaef6、
bbed3cf、d63f98a、7572e21、ea68615、16b4f08）。

## P0 — 功能回归（无声失败）✅ 已全部完成

- [x] autonomous idle 循环异常保护 + 两个 scheduler `_fire` 改为提交成功后计数
      （dac6a10；拒绝时返回闸门原因、不消耗触发）
- [x] wechat submit 防护 + 按拒绝原因回送忙碌提示（dac6a10；⚠️ 启用微信前置仍有效）
- [x] 真 coordinator 闸门集成测试（tests/test_system_channel_gate_integration.py）

## 启用微信 Bot 前置条件

微信链路现状（2026-09-03 确认）：服务端全链路存活
（`routes/wechat.py` 已挂载、`WeChatService`/`wx_bot_client.py` 完整、桌面通知
订阅仍在），但上轮清理删掉了管理页（FeishuBot/WechatBot.tsx）及前端全部 `wx*`
API 封装，而服务端无开机自启（`WeChatService.instance()` 仅由 `/api/wechat/login`
懒创建）。**当前没有任何界面入口可启动微信 bot。** 重新启用需要：恢复最小登录
入口（Dashboard 服务面板按钮即可）。submit 忙碌防护已就位（dac6a10）。

## 会话管理 ✅

- [x] SessionRail 统一稳定排序（4e89e76：单一最近活动键，停止任务不再跳行；
      项目抽屉同键；回归测试锁定）

## P1 — 行为一致性护栏 ✅ 已全部完成

- [x] scheduler misfire 注册参数测试（双 scheduler × cron/interval；
      tests/test_scheduler_misfire_policy.py）+ autonomous 侧 6h grace 补齐（dac6a10）
- [x] AppServices 四条直接单测（tests/test_app_services.py：不构造、顺序、
      异常隔离、clear）
- [x] conductor 缺字段三层契约（tests/test_conductor_response_contract.py：
      默认值兼容 + PoolMirror 结构化 warning + 完整响应不覆盖 + extra 透传）

## P2 — 交互与门禁 ✅ 已全部完成

- [x] ModalOverlay 行为下沉（143ac57：Escape/焦点进出/Tab 陷阱/滚动锁/
      closeOnBackdrop 可关；LiveChat 定时弹窗已关背板误点；Conductor/GoalHive
      页面级 effect 删除；Tasks SMTP 弹窗迁移；三处 aria-labelledby 补齐）+
      组件自测（ModalOverlay.test.tsx）
- [x] z-index 层级契约（config/zLayers.ts：modal 50 < palette 55 < dialog 60 <
      toast 70；三个宿主接入令牌）
- [x] storage key 静态扫描门禁（storageKeys.test.ts，镜像 test_env_registry）
- [x] bubbleTone 表驱动测试 + 死字段裁剪（e972ea7）
- [x] `_fill_dispatch_defaults` 直测（e972ea7）

## P3 — 收尾与降噪 ✅ 已全部完成

- [x] 前端死 API 清理 + 孤儿键 queryKeys.conductor.log（ab591ab）
- [x] 语义状态令牌（beaaef6：danger/info/success/warning 进 tailwind.config；
      Conductor/错误横幅迁移；两处漂移的危险底色收敛；注释改为准确表述）
- [x] 主题漏洞修复（beaaef6：Conversations 翡翠绿气泡改用 bubbleTone user 面；
      TokenStats 错误态 rose-300 换 danger 令牌）
- [x] GAHUB_* env 族入 constants 注册表 + 3 处 stale `/ws/chat` 注释（6faffd1）
- [x] 错误提示收口（bbed3cf：13 处 LiveChat + 15 处各页手抄错误链统一到
      `errorMessageFromError`；capacityConflict 先行分支、409 专文案、stderr 合并、
      行号列号诊断等特化行为保留；嵌套 detail 优先级有测试锁定）
- [x] 消息渲染收敛（d63f98a：收敛为内容原语 `MessageContent`（text/markdown/pre）
      而非万能气泡——页面保留自己的 chrome/对齐/标签/虚拟化，只选内容格式；
      flat 视图用户内容有意统一为字面文本，与 Round 视图/实时聊天一致）
- [x] 服务端"半个收敛"三项（7572e21、ea68615、16b4f08）：归档目录/标题/
      preview/搜索下沉 archive_messages（路由只留 HTTP 编排）；rewind 双策略
      保留独立提交但共享规划/收尾助手；ServiceRegistry 绑定 app 所有权
      （owned 优先、单例回退，跨端点单一真相源）
