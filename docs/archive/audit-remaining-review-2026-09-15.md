# 审计报告剩余条目复核（2026-09-15）

> 基线：本机 HEAD（含 2026-09-14 三个提交 `af9feb8` / `4d736ed` / `72ac67a`）。
> 本文只覆盖**上一轮未执行**的条目；第 0 档（relTime 真 bug、.gitignore、docs 归档）与两项已批整改（相对时间合并、9.57MB 零引用图片删除）均已完成。
> 排序原则：**按「会不会真的出错」排序，不按「看起来有多乱」排序。**

---

## 一句话结论

第三方审计的方向可用，但**有 2 条被证伪、3 条强度被高估**。真正值得动手的只有 3 条（语义分叉与陈旧缓存），其余多为整洁问题；原审计里「842 行就该拆」和「原子写有风险」这两个直觉判断，实测都不成立或收益远小于预期。

---

## 一、证伪（原报告不成立，建议从待办删除）

| 条目 | 审计说法 | 实测 |
|---|---|---|
| **WebSocket 握手重复** | 多处重复握手/重试/心跳 | **不成立**。统一封装 `webui/src/runtime/managedJsonSocket.ts`（connect + reconnect + 指数退避，14-176 行）。`chatSocket.ts` / `goalHiveSocket.ts` / `hubEventClient.ts` 均为薄适配，仅 path 与 delay 不同。全仓 `new WebSocket` 仅 `managedJsonSocket.ts:41` 一处。 |
| **侧栏折叠重复** | 折叠逻辑多份实现 | **不成立**。主侧栏单一实现：`SidebarNav.tsx:122` 读 localStorage `sidebarCollapsed` + `toggleCollapsed`(:124-129)。`SessionRail.tsx:296`、`ConversationIndexRail.tsx:24` 的 `data-collapsed` 是**另外两个组件各自的折叠**（会话栏 / 索引栏），不是同一逻辑的复制。 |

---

## 二、高估（成立，但风险/收益被夸大）

| 条目 | 审计暗示 | 实测修正 |
|---|---|---|
| **原子写散落 7-8 处** | 隐含「有风险」 | 实际 **9 处**，全部使用 `os.replace` / `Path.replace`（Windows 上替换已存在文件是安全的，**无此 bug**）。差异仅在：只有 `mykey_service.py:100-107` 做了 `fsync`；`memory.py:45-48`、`scheduler_domain_base.py:195-199`、`scheduled_chat_service.py:190-195`、`wechat_service.py:230-234`、`_paths.py:109-111` 用固定名 `*.tmp` 且异常时残留临时文件。**这是耐久性与整洁问题，不会写坏数据**，且各处有 RMW 锁保护并发。 |
| **`sessions.py` 842 行 22 路由就该拆** | 大文件 = 该拆 | 18 个模块级函数里，**9 个持有隐式单例状态**（`_get_coordinator`:137 / `peek_coordinator`:156 / `prepare…`:171 / `begin…`:179 / `finish…`:186 / `stop_session_runtimes`:249 / `_get_scheduled_chats`:222 / `scheduled_chat_service`:231 / `system_channels`:236），拆了会坏；只有 **8 个是纯 helper 可安全拆**（`_publish_runtime_state`:77 / `_session_run_capacity`:112 / `_dispatch_scheduled_chat`:193 / `_effective_llm_key`:213 / `_state_payload`:281 / `_session`:290 / `_api_error`:297 / `_not_found`:306）。拆分的**实际收益远小于行数暗示**。 |
| **`main.py` 4 处直调生命周期** | 绕过 DI 有隐患 | 4 处（`main.py:317 / 403 / 410 / 430`）确实绕过依赖注入，但都在 `_lifespan`/`_startup` 内，且 `sessions.py:171-190` 有 `_coordinator_lifecycle_lock` + `_coordinator_stopping` 门控，`prepare_*` 仅在 `_coordinator is None` 时置位。**顺序正确，无重复初始化或乱序 shutdown 的实锤**。属设计选择，非缺陷。 |

---

## 三、档 1：真会出错（语义分叉 / 陈旧数据）——建议优先

这三条的共同点：**同一个动作在系统的不同位置会得到不同结果**，或**用户看到的是过期数据**。这类问题不会崩，但会让人怀疑系统在骗人。

1. **LLM 偏好缓存失效断层**（`server/services/llm_preference_store.py:26-27`）
   `_cache` / `_key_cache` 仅在 `_UNSET` 时加载，不受 mtime 感知，且 **`reset_config_cache()` 不会重置它**。而 `_paths.py:79-98` 的 `load_config` 是按 `(mtime_ns, size)` 签名缓存、外部改动能自愈——两套规则并存。`agent_service.py:326` 持有进程级单例 `self._llm_preferences`，**外部改 `config.json` 后仍返回旧值，直到调用 `set_*` 或重启**。
   → 修法小（让 reset 一并清该 cache，或让其走 mtime 签名），收益明确，建议第一个做。

2. **goalhive 独立执行链路**（`server/services/goalhive_service.py:71` 起，498 行）
   自带阻塞式 runner + drain 线程 + `_stream_queues`，**完全绕过 `SystemChannel` / `SessionCoordinator`**（autonomous 与 scheduled_task 都走 coordinator 的 `submit`/`abort`/`switch_llm`）。`system_channels.py:36` 的 `SYSTEM_CHANNEL_TITLES` 无 goalhive → **不进统一容量门与生命周期账**；其 `abort`（`goalhive_service.py:447`）直调 `agent.abort()` 后 `_finish_active_messages()`，与 coordinator 的 abort **语义不一致**。
   → 改动大，但这是全仓**唯一「同一动作两种结果」**的地方。

3. **scheduled_chat 是第三套调度持久化**（`server/services/scheduled_chat_service.py:188-195`）
   直接写 `scheduled_chats.json`，未继承 `SchedulerDomainBase`（对比 `autonomous_scheduler.py:86`、`task_scheduler.py:76`），因此**吃不到基类的 `misfire_grace_time=6h` 与 `coalesce`**，也吃不到统一 `_persist` 生命周期。
   → 实打实的功能洞：scheduled chat **缺漏触发保护**。

---

## 四、档 2：结构性重复（改动会扩散，收益随改动次数复利）

不是 bug，但每次改需求都要改两处，迟早改漏。

4. **Autonomous / Tasks 双胞胎**（部分成立）
   `Autonomous.tsx` 287 行、`Tasks.tsx` 410 行。重复点：卡片网格 `ScheduleCard`(142-188) / `TaskCard`(113-151) 同 className 与同 toggle/remove；运行历史表(93-115 / 74-104) 同 thead/tbody；`ModalOverlay`+`Field`+`inp` 常量(277 / 400) **逐字相同**。差异：Tasks 多 `EmailSettings`(271-389) 与 `StatusBadge`，Autonomous 多报告浏览器与 `ReportDrawer`。→ 抽公共卡片 + 历史表，保留各自特有块。

5. **聊天记录页自造气泡**（成立）
   统一组件 `MessageBubble.tsx` **只有 `LiveChatTranscript.tsx:286` 在用**；`Conversations.tsx` 绕过它自绘 2 处：RoundsView 内联 user 气泡 `rounded-[18px]…bubbleTone('user')`(:412) 与 assistant 气泡 `rounded-[18px]…bg-bg-card`(:419)，另有 `MessageBlock` `rounded-xl…bubbleTone(tone,'card')`(:502，FlatView 复用)。→ 主题/圆角一改就两边不一致。

6. **`chatStore.ts` 1092 行**（成立）
   `start:` 617→901 约 285 行（与报告数字吻合）。四大职责：连接与会话生命周期（617-901 / `retryHistory`:903 / `teardown`:1008）、多会话视图缓存（`sessionViews` / `dropSessionView`:967 / `restoreVisibleConversation`:1078）、历史分页 `loadOlderHistory`、消息暂存（`stageWebui`:1032 / `rollbackWebui`:1045 / `clearLocal` / `pushSystem`）。

7. **新旧色名靠翻译层并存**（成立）
   `webui/src/styles/index.css:58` 起 "Global text remap" 段，把 `.text-slate-50~600`(:63-69)、`.hover:text-slate-*`、`bg-white/5`·`/10`、`border-white/10`、`bg-black/*`(:77-84) 重映射到 `--c-*` 主题变量，**约 22 条**。这是旧 Tailwind 色名尚未收敛的直接证据。

---

## 五、档 3：卫生与可选（收益有限，或改动面大于收益）

8. **原子写统一**：9 处，只补 `fsync` 与临时文件清理，低优先级（见「二、高估」）。
9. **`tokens.py` 模块级副作用**：`tokens.py:21-26` `import cost_tracker; cost_tracker.install(); init_ledger()`，**无 guard**（依赖 Python 单次 import 防重装），且 `init_ledger` 仅在 `GA_ROOT` 已设时调用——测试里先 import 本模块再设根，ledger 就不会补初始化，**行为随 import 顺序变化**。修法（加 guard 或移入 lifespan）会碰启动路径，排在档 3 而非档 1，是因为它只在测试/特定顺序下触发。
10. **`WxContact` 双定义**：`schemas.py:166`(BaseModel) 与 `wechat_service.py:166`(@dataclass) 各一份——已确认成立，但属于类型重复，改动面清晰，随时可做。
11. **`conversations.py` 直接 zipfile vs `archive_messages.py` 588 行零写操作**：归档写路径绕过专门的 archive 模块，职责错位，但当前能正常工作。
12. **设置页 Panel 骨架未抽**（部分成立）：`Settings.tsx` 5 处 Panel 均为 `rounded-xl border border-line bg-bg-card p-4` + 标题 + 说明 + 控件的同构结构(283/338/366/462/580)，但字段各异，只是没抽骨架，收益小。
13. **上传错误处理两份**（部分成立，且**非逐字复制**）：`ImagePasteInput.tsx:131-158` 逐文件 catch 拼 `${f.name}：${errorMessageFromError(e,'上传失败')}`(:146) + 内联 `role=alert` 列表(:221)；`MyKey.tsx:68-84` 用专属 `myKeySyncErrorFromError(e)` + `dialog.alert`(:80)，下载共用(:105)。底层 `api/client.ts:372-390` 已统一抛错。两份 helper 不同，无公共上传错误 UI——统一属nice-to-have。

---

## 六、本次核查的边界（未覆盖）

- 报告原文未在仓库留档，本文条目来自 2026-09-14 日志中记录的核验结论 + 本次重新实地核查，**措辞可能与原报告不完全一致**。
- 未做动态验证（未起服务、未跑真机 worker）；档 1 三条均为**静态代码路径分析**得出的结论，第 1 条（缓存陈旧）最容易做一次真机复现验证。
- `goalhive_service.py` 的运行时行为（队列消费、abort 实际效果）未实测，仅从代码路径判断。


## 七、本轮继续复核（2026-09-15）

- `tests/test_conductor_*.py` 等定向集合：285 passed；全仓：792 passed, 2 skipped, 10 warnings，未出现失败。
- Conductor HTTP schema 对 operation_id、索引、策略、manifest 数量/长度/枚举及分页参数均有约束；路由写操作统一经 service/client，错误映射覆盖 4xx、503、其他 5xx。
- `server/run.py` 默认绑定 `127.0.0.1:8765`；可由本地 `mykey.py` 配置改 host。应用未见用户认证层，因此“外部 host + 无认证”是显式暴露配置下的部署风险，不作为默认漏洞。
- 尚未完成：对 LLM 偏好缓存、scheduled_chat misfire/coalesce、GoalHive 调度/abort 做运行时复核。
