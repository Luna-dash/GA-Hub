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

## 2026-09-04 结构整合度重扫描（第二轮，四路并行）

来源：P3 收敛完成后对全仓的再次结构扫描。本轮已修（能立即修的分类提交）：

- [x] P0×2（无测试能抓到）：rewind 共享助手对真 ChatStreamProjection 的
      `pop(sid, None)` 签名错配——两个 rewind 端点在改写历史/世界线之后、
      发事件之前崩溃（tests/test_rewind_turns.py 补真投影回归）；tokens.py
      清理时删掉 logger 但保留 `log.` 调用，GA 无 cost_tracker 时整站起不来
      （tests/test_module_loggers.py 静态扫描门禁）
- [x] ConductorService 关闭后不释放类单例——二次 create_app 复用死实例
      全线 500（对齐 AgentService 语义）
- [x] ServiceRegistry._HEALTH_BY_STATE 死表：测试锁的词汇表在生产路径永不
      执行；health_summary 统一吃 panel 的 health 字段（healthy/attention/
      unknown），unavailable 语义保留在 /api/health 的核心契约闸门层
- [x] /api/agent/sessions(+restore) 绕过归档目录直接枚举 GA 日志目录
      （与目录缓存竞态、restore 按易漂移的索引定位）——改走
      archive_messages.list_archive_sessions
- [x] GAHUB_*/GA_MYKEY_* env 族全量入 constants 注册表 + 扫描门禁扩网
      （此前只扫 GA_HUB_ 前缀，GAHUB_* 家族零约束）
- [x] wechat 路由全部 async 导致 0.4s 登录阻塞共享事件循环——改同步
      def（FastAPI 线程池派发，对齐 feishu 既有注释约定）
- [x] 前端：MyKey 两处漏网错误提取 + line/col 诊断去重（新 helper
      myKeyParseErrorFromError，修掉"第 undefined:undefined 行"）；MarkdownView
      右键菜单 z-[100]/LiveChatTranscript tooltip z-50 越层——Z_LAYERS 增
      contextMenu/tooltip 令牌；Conductor/MarkdownView 剪贴板写入绕过
      writeClipboard 的非安全上下文回退；Conversations 自造 Msg 类型换
      ConversationMessage；Conductor.test 滚动/失败用例改 waitFor 轮询
      （并行跑全量时不同用例随机挂）；两个页面 verbatim 重复的 CronPreview
      提为组件；死 CSS 块（.ga-sidebar-llm-*，136 行）删除；delete_session
      补走 coordinator 准入门；事件 WS legacy 分支保持原帧形（有测试锁定，
      是有意兼容决定）；两调度器 unclosed 文件句柄；autonomous read_report
      /memory _read 同；conductor_client/conductor_service/conductor_workflow
      未用 import 与缺 Any 注解

需要决策的大件（按伤害排序）。2026-09-04 已定四项方向（条目内【已定】标注）：
Skills.tsx 删除、折叠解析走策略 b、暗色确认废弃；LLM ping 分析修正（原
"双实现"实为"一活一死"，无需新抽象）。**批次 A（快赢七项）已完成**：
e99bf6c、ba75acd、06cad0e、be03131、ea67753、d6ab384、cdb1664、6498211、
50bbdf3（+ 9687bbf legacy 帧形回退）。剩余大件归入批次 B/C/D。

- [x] Skills.tsx 是孤儿页面（253 行，无路由/无导航/无测试）——【已定：
      删除】已删（ba75acd）；Memory 页在用的 skill API/类型/queryKeys 保留
- [x] 双调度器（autonomous/task）~70% 逐行克隆（持久化/装 job/fire/守卫），
      已咬过一次（misfire 只补了一边）——已抽 scheduler_domain_base.py 的
      SchedulerDomainBase 模板方法基类（06f819f），骨架单份、差异成钩子；
      测试无需收缩（既有用例已按双域参数化，全部原样通过，继续当契约锁）
- [ ] routes/mykey.py 674 行是"穿着路由皮的服务"（备份轮转/原子写/解释器
      探测/子进程编排内联）——抽 services/mykey_service.py
- [x] LLM ping——【2026-09-04 分析修正】UI 入口只有一个：MyKey 卡片"测 ping"
      （MyKey.tsx:374 → api.testMyKeySession → /api/mykey/sessions/{var}/test），
      routes/mykey.py:_test_session_sync 是唯一活实现。/api/llms/{idx}/test
      （routes/agent.py:_test_llm_sync）+ 前端 api.testLLM 死包装
      （client.ts:239）+ LLMTestResult 类型均无任何调用方（webui/桌面壳/
      脚本/服务端内部全查过）。原"抽 llm_probe 合并双实现"不再需要：
      已删死端点整链并重生成 OpenAPI/TS 契约（06cad0e），死链测试清理
      （6498211），mykey 侧保持单实现
- [x] 归档折叠解析 `_extract_ui_messages_from_text` fork 了 GA 的
      extract_ui_messages（分页回退路径）——【已定：策略 b】保留 fork、
      不动 GA；守护测试已补（50bbdf3）：合成归档驱动续跑分支，断言
      hub 切片折叠 == GA 整文件 extract_ui_messages，无 GA checkout 的
      机器自动跳过
- [x] 点查路由在事件循环内做目录刷新+迁移副作用——迁移已挪到 lifespan
      启动钩子（永不抛出、失败可重试），5 处点查 `_session_by_id` 进
      to_thread（d6ab384）
- [x] 事件主题 ~70 处内联字符串（"chat:reset" 三处发布）——已建
      server/event_topics.py（47 常量 + conductor 动态 f-string 家族，
      35956e9），tests/test_event_topics.py 仿 test_env_registry 扫描
      （未注册字面量/重复值/孤儿常量全失败；值不变，线上契约与断言不变）
- [ ] 生产代码携带测试回填脚手架（ConductorService 五个 _ensure_* hasattr
      回填，专为 object.__new__ 测试实例）——给测试正规的 for_tests()
      构造器后删除
- [ ] 状态词汇漂移：Conductor phaseDot 硬编码色 vs 相邻 phaseTone 语义令牌；
      全仓 62 处裸 rose/emerald 类 vs 23 处 status-* 令牌——【2026-09-04
      更新】暗色已确认废弃（index.css 强制纸黄单主题，:root/html.light/
      html.dark 钉同一套变量），原"先定暗色策略"前置取消。收敛 62 处到
      令牌（机械活）+ 顺手清暗色残骸：themeStore/main.tsx 仍在按系统偏好
      打 html.dark class、个别 html.dark 元素级覆盖（text-slate/::selection）
      仍会生效、tailwind darkMode:'class' 配置
- [ ] WS 游标管线（events.py 与 sessions.py）重复 invalid-cursor 解析 +
      replay/ping 生命周期——抽可恢复 WS 会话助手
- [x] runtime-state payload 三处手拼（sessions.py bus/WS/REST）——已全部走
      SessionRuntimePayload.from_state（cdb1664）；bus 帧刻意保留 error 恒在
      的差异（test_session_websocket.py 锁定，注释已说明）
- [x] conductor 路由内联服务级业务（subagent 镜像合并、动词分派、指令文案）
      ——已下沉 ConductorService.subagent_dossier / apply_subagent_action /
      INSTR_* / SUBAGENT_VERBS（12434e1）；顺带修了 accept/rework/input 未
      透传 tracker owner 的不一致（现在三个动词在服务内部自行解析 owner，
      引擎的 request_mismatch 守护对全部动词生效，路由旧注释声称的
      "EVERY verb" 才真正成立）
- [x] ConductorService.instance() 在请求路径懒构造重服务（TimeoutMonitor
      线程/进程管理器）——已纳入 AppServices 所有权（cb9fd29，完成
      16b4f08 模式的最后一角）；shutdown 排在 feishu 后 agent 前（引擎
      停机时会回调 hub HTTP API）
- [x] tests/ 无 conftest.py；smoke 测试靠 importlib.reload 制造分叉模块态
      （xdist 不安全）；wechat 测试隐式依赖本机 GA checkout 布局
      ——已修（aa371a8）：conftest.py 钉根目录入 sys.path（任意 cwd 裸
      pytest 可跑）；smoke 改为原地 patch _paths 的 GA_ROOT/ADMIN_DATA/
      CONFIG_FILE（服务端全部经模块对象按调用时读取，无需 reload）；
      wechat 单测与系统通道闸门集成测试在无 GA checkout 的机器上显式
      skip 而非导入报错（空 admin-data 环境实测 7 skip 12 pass）
- [x] README 存储目录表过期——已补全 13 行（e99bf6c，含 conversations_v2/
      gahub_journal/tasks_schedules.json/mykey-backups 等），_paths.py
      ADMIN_DATA docstring 同步并注明与 README 保持一致；routes/agent.py
      "legacy 全局路由"注释已改为准确的 chat WebSocket tombstone 表述，
      并注明其余路由全部在用勿删
- [x] 剩余小块（06cad0e、be03131、ea67753）：RewindResp 补
      removed_history_entries（FakeCoordinator 同步对齐）；formatDateTime
      助手统一四处完整日期时间显示（气泡时钟/紧凑卡/datetime-local/日期
      分桶各有不同需求，不迁移）；PasteAttachment 挪 api/types；
      api:generate 输出锚定脚本位置（import.meta.dirname 先例）
