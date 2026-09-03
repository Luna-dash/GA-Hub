# 优化待办（Backlog）

来源：2026-09-03 全量架构复审（四路并行）+ GPT 交叉复审的合并结论。按"用户可感知伤害"排序。
修复后请条目化勾销，不要整段删除。

## P0 — 功能回归（无声失败）

- [ ] **autonomous idle 循环无异常保护**（`server/services/autonomous_scheduler.py:302`）
  `_idle_loop` 对 `self._fire(s.id)` 裸调用：一次容量/占用拒绝（如上轮 abort 后
  ABORTING 未清）抛 `AgentBusyError`，整个 `auto-idle` 线程永久死亡，idle 触发
  静默停摆直到重启。同函数对 `channel.agent` 已有 try 保护，唯独真正会抛的这行漏了。
  同型保护需覆盖 `_fire` 内部或循环体。
- [ ] **scheduler 先记账后提交**（`server/services/task_scheduler.py:248`、
  `server/services/autonomous_scheduler.py:321`）
  `_fire` 先 `last_fired_at/fire_count/_persist()` 再 `channel.submit`：提交被
  闸门拒绝时该次触发已计数持久化、无 run 记录、不重试。应改为提交成功后计数，
  或失败时回滚并写一条失败 run。
- [ ] **wechat submit 无异常防护**（`server/services/wechat_service.py:424`）
  `channel.submit` 在所有 try 之外，`AgentBusyError` 杀死 `wx-handle` 线程、用户
  无任何回复。⚠️ 当前微信 bot 处于搁置态（见下），**启用微信前必须先修此项**。
- [ ] **闸门集成测试缺失**（`tests/test_system_channels.py` 全程 FakeCoordinator）
  上述失败模式零覆盖。补一个用真实 SessionCoordinator 的集成测试：
  容量满/同会话占用时，微信回提示、scheduler 触发不丢账、idle 循环存活。

## 启用微信 Bot 前置条件

微信链路现状（2026-09-03 确认）：服务端全链路存活
（`routes/wechat.py` 已挂载、`WeChatService`/`wx_bot_client.py` 完整、桌面通知
订阅仍在），但上轮清理删掉了管理页（FeishuBot/WechatBot.tsx）及前端全部 `wx*`
API 封装，而服务端无开机自启（`WeChatService.instance()` 仅由 `/api/wechat/login`
懒创建）。**当前没有任何界面入口可启动微信 bot。** 重新启用需要：恢复最小登录
入口（Dashboard 服务面板按钮即可）+ 先修 P0 的 wechat 防护项。

## 会话管理（用户已确认要修）

- [ ] **SessionRail 排序跳变**（`webui/src/components/SessionRail.tsx:132-145`）
  现按状态权重分组排序（未启动 0 → 运行中 1 → 其他 2，同组内 updated_at 降序；
  项目抽屉按组内最高权重排序 :168-185）。手动停止任务 = 权重 1→2，会话从"运行
  中"组整体跳到底部组，视觉上下跳变。目标：统一排序逻辑（单一稳定键，如纯
  `updated_at` 降序，或运行中置顶但不重排其余项），消除状态切换引起的跳变；
  项目抽屉的组间跳动同步处理。

## P1 — 行为一致性护栏

- [ ] scheduler misfire 注册参数测试（cron/interval 均断言 `misfire_grace_time=21600`
  + `coalesce=True`）；并把 6h grace 补齐到 autonomous_scheduler 的同型安装点
  （当前只修了 task 侧）。
- [ ] AppServices 直接单测：status_snapshot 不构造服务、shutdown 顺序
  （scheduler → feishu → agent）、单个异常不阻断后续关闭、clear 释放。
- [ ] Conductor schema 缺字段三层契约：默认值兼容 + 服务层结构化 warning +
  （缺字段/完整响应）契约测试，防协议漂移伪装成空白卷宗。
- [ ] 生产者异常防护的回归测试与 P0 集成测试合并交付。

## P2 — 交互与门禁

- [ ] ModalOverlay 行为下沉：Escape 关闭、initial focus、focus trap、关闭后焦点
  恢复、可选背板关闭（LiveChat 定时弹窗曾因统一而新增"误点背板即关、填一半丢失"）。
  Tasks/Autonomous/MyKey 调用点补 `aria-labelledby`。组件自测。
- [ ] z-index 层级契约：ModalOverlay z-50 压过 CommandPalette z-40、与 DialogHost
  同层靠 DOM 顺序——需要一张明确的层级表并写进 CSS 注释/测试。
- [ ] storage key 静态扫描门禁（镜像 test_env_registry：扫 localStorage/
  sessionStorage 字面量，强制走 config/storageKeys.ts）。
- [ ] bubbleTone 表驱动测试（user/assistant/system/未知/undefined × chat/card）；
  顺带清理 align/isUser/defaultLabel 三个零消费字段。
- [ ] `_fill_dispatch_defaults` 参数化测试（dispatch/input/rework 同一组断言）。

## P3 — 收尾与降噪

- [ ] 前端死 API 清理：btw/agentSetTitle/agentSessions/agentRestoreSession/
  rewindTurns/wechatLog/agentLog/backendLog（client.ts），api.conductorLog 与
  孤儿键 queryKeys.conductor.log。
- [ ] 错误提示收口：22 处手抄 `e?.body?.detail || e?.message` 改用
  `errorMessageFromError`；统一 toast/pushSystem/dialog.alert 的使用场景。
- [ ] 消息渲染收敛：4 套实现（MessageBubble / Conversations MessageBlock /
  Conductor 内联 / GoalHive 裸 `<pre>`）收敛到参数化 MessageBubble。
- [ ] Tailwind 文本色收尾：37 处残留 hex 换 ink 令牌；`Conversations.tsx:411`
  bg-emerald-800/70 无垫片；修正 tailwind.config 中夸大的"ink 唯一"注释。
- [ ] 服务端未收敛项：conversations.py 自建归档索引/标题解析并入 archive_messages；
  rewind_adapter 双路径合并；service_registry 单例读 vs AppServices 所有权
  双真相源；`GAHUB_*` env 前缀族入 constants 注册表；3 处 stale `/ws/chat` 注释
  （agent_service.py:174,223、goalhive_service.py:5）。
