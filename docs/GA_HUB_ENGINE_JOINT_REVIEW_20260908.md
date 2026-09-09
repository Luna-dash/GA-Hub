# GA-Hub / GA 引擎联合代码分析

日期：2026-09-08

本次重点覆盖 Conductor 的完整调用链：React 页面和状态存储、Hub 路由及 service/client、GA 侧调度池、流式监控、交付校验和事件日志。普通 LiveChat、微信及 Tauri 壳未作同等深度审计。仅进行代码分析、隔离复现和定向测试，未修改生产代码或向运行中的引擎派发任务。

最终核对基线：GA-Hub `85a0a7b`，GA `aba30f7`；GA 引擎目录与测试时的 `101f4d5` 一致。分析期间 Hub 从 `510e010` 增加了进程回收修复 `f2979fa` 和启动脚本调整；已经按最新代码复核，不将已修复的子进程泄漏列为待办。原有 `.zcode/` 未动；GA 原有 `memory/` 改动在分析期间由其他工作提交为 `aba30f7`，本次未修改。

## 结论与优先级

优先投入控制面响应、准入一致性和事件恢复。以下 7 项均有隔离复现证据；其中第 3 项包含两种独立触发方式。P1 表示会阻断正常工作、突破资源约束或使运行状态失真，应优先修复；P2 表示局部功能或诊断能力受损。

| 编号 | 优先级 | 优化点 | 可观察影响 | 改动量 |
| --- | --- | --- | --- | --- |
| 1 | P1 | 修正跨盘允许目录校验 | 默认 C 盘交付目录仍被拒绝为 422 | 小 |
| 2 | P1 | 将查询链中的阻塞 HTTP 移出事件循环 | Conductor 慢查询拖住其他 API 和 WebSocket | 小 |
| 3 | P1 | 统一派单、待验收、恢复和返工的准入规则 | 待验收提前释放占用；返工突破上限并重叠输出路径 | 中 |
| 4 | P1 | 让里程碑和总时限独立于输出队列空闲 | 连续流式输出绕过总时限及里程碑检查 | 中 |
| 5 | P1 | 游标只确认成功处理的连续事件 | 处理失败或丢帧后，重连不能补齐事件 | 中至大 |
| 6 | P1 | 为快照增加单调版本和有序发布 | 旧 running 快照覆盖新 stopped 快照 | 中 |
| 7 | P2 | 保留引擎结构化错误及校验证据 | 页面只收到错误码，缺失失败文件及检查明细 | 小 |

## 1. 跨盘目录校验提前终止

证据：[Hub 默认允许目录](D:/study/GA-Hub/server/services/conductor_client.py:98)；[引擎路径校验](D:/study/GA/frontends/gahub/gahub_app.py:921)。

Hub 的默认根列表在这台机器上是 `D:/study/GA` 和 `C:/Users/lunagent/GA-Deliverables`。引擎在 `any(...)` 外捕获 `commonpath` 的 `ValueError`；校验 C 盘目标时，第一个 D 盘根目录引发异常，后面的 C 盘根目录没有机会匹配。

隔离复现：使用上述两根目录，`D:/study/GA/a.md` 通过，`C:/Users/lunagent/GA-Deliverables/a.md` 被拒绝，错误信息同时还将 C 盘目录列为允许目录。此校验被 Deliverable、MilestoneCheck 等模型复用。

建议：逐个根目录处理跨盘异常，继续检查其他根；统一大小写和 realpath 规则。[交付检查已有逐根继续的实现](D:/study/GA/frontends/gahub/conductor_delivery.py:181)，可收敛为一个公共路径判定。补充多根、多盘、根顺序互换及链接边界用例。

## 2. Hub 查询路由阻塞事件循环

证据：[chat 路由](D:/study/GA-Hub/server/routes/conductor.py:136)、[log 路由](D:/study/GA-Hub/server/routes/conductor.py:252)、[status 路由](D:/study/GA-Hub/server/routes/conductor.py:273)；[同步 status 转发](D:/study/GA-Hub/server/services/conductor_service.py:1166)；[requests 调用](D:/study/GA-Hub/server/services/conductor_client.py:338)。

上述 `async def` 路由直接调用同步 service，最终通过 `requests` 等待引擎。`_status_payload` 同样在 start、stop 和 settings 的异步路由尾部同步调用。引擎响应慢时，整个 Hub 事件循环被占用；客户端当前默认 HTTP 超时是 10 秒。前端 status 每 12 秒轮询，因此这是常用路径。

隔离复现：把上游同步查询延迟设为 250ms，同时安排 10ms 心跳。status、chat、log 的心跳实际分别在 250.3ms、250.4ms、250.6ms 才执行。

建议：复用现有 `asyncio.to_thread` 转发边界，覆盖完整查询与状态组装，而非只移动 start/stop 主操作。先保持同步 client，避免为本次修复引入全局异步重构；随后再评估按线程复用 HTTP Session 和减少重复状态查询。增加慢上游下的并发心跳测试。

## 3. 准入规则在状态和入口之间不一致

证据：[完成时写入 COMPLETED](D:/study/GA/frontends/gahub/conductor_core.py:612)；[worker_is_active](D:/study/GA/frontends/gahub/conductor_core.py:692)；[派单准入](D:/study/GA/frontends/gahub/gahub_app.py:1434)；[恢复与返工入口](D:/study/GA/frontends/gahub/gahub_app.py:1617)。

第一种情况：`on_display(done=True)` 同时设为 `review_status=pending` 和 `terminal_event=COMPLETED`，但 `worker_is_active` 对任何非空 terminal_event 都返回 False。生产中的待验收 worker 因此提前释放并发槽和输出路径占用，与代码注释承诺相反。真实完成转换的复现结果是：active 数从 1 变为 0，review 仍为 pending。

第二种情况：只有新建 worker 经过 `_dispatch_gate + check_dispatch_admission`。input/rework 重新启动旧 worker 时没有检查全局容量和输出路径冲突。复现中设置全局上限为 1，并放入一个运行中的 worker 和一个失败的旧 worker，两者声明相同输出路径：新派单正确返回 `global_inflight_limit`，返工旧 worker 却成功，active 数从 1 变为 2。

建议：区分“执行完成”和“工作流最终关闭”，待验收继续持有约定的资源；所有进入 running 的入口统一执行容量、请求预算、生命周期和路径所有权校验。容量检查和占用登记必须处于同一事务中，失败时回滚；同一请求多个 worker 并发返工的请求级预算也应原子预留。

测试缺口：[当前 pending 用例](D:/study/GA/tests/test_conductor.py:2104) 手工创建的 pending 没有设置 COMPLETED，未覆盖生产完成路径。应通过实际 `on_display` 进入 pending，再校验后续派单和返工。

## 4. 有输出时不执行总时限和里程碑检查

证据：[监控循环](D:/study/GA/frontends/gahub/gahub_app.py:519)；[里程碑检查](D:/study/GA/frontends/gahub/gahub_app.py:562)；[总时限检查](D:/study/GA/frontends/gahub/gahub_app.py:580)。

所有检查都位于 `except queue.Empty`。生产默认 `MONITOR_POLL_SECONDS=5`，只要输出帧间隔始终小于 5 秒，便不会进入该分支。持续有输出的 worker 可以超过 3600 秒 attempt 时限，且里程碑无法按期判断。它不是“计时起点被刷新”，而是“检查根本没有运行”。

隔离复现：attempt 已开始 7200 秒，队列预置 100 个 next 和一个 done；全部 101 帧被消费，里程碑调用数为 0，终止调用数为 0。

建议：以 monotonic 定时节拍运行 watchdog，无论本次读取是否获得输出都检查到期项；让文件/归档探测频率独立于 chunk 频率，避免修复后变成每个 chunk 都读归档。补充持续输出、队列积压、静默和 generation 切换场景。

测试缺口：[声称持续输出的现有测试](D:/study/GA/tests/test_gahub_app.py:754) 实际启动的是空队列，因而只验证静默分支。

## 5. 事件游标在成功处理前前移

证据：[Hub 先推进 jseq](D:/study/GA-Hub/server/services/conductor_service.py:1386)；[重连从游标之后回放](D:/study/GA-Hub/server/services/conductor_service.py:1313)；[GA 队列满时静默丢帧](D:/study/GA/frontends/gahub/gahub_state.py:76)。

`_on_sse_event` 先把 cursor 提升为已见最大序号，再调用 handler；handler 出错时只记录异常。重连只读取 `seq > cursor`，因此该失败事件不会再次收到。类似地，SSE 队列满时丢掉一个事件，之后更大的 jseq 到达也会越过缺口。仅保存“见过的最大 seq”不等于“已成功应用的连续 seq”。

隔离复现：cursor=3，处理 jseq=4 时注入 handler 异常；cursor 仍变为 4，下一次 journal 请求使用 after_seq=4，跳过了失败事件。

建议：传递 handler 成败，仅确认已成功应用的事件；检测缺口并从 journal 顺序补齐，或让 live SSE 仅唤醒一个有序 journal 消费器。非持久化快照和日志单独处理。注意 `engine_started` 等日志记录未必直接发为 SSE，不能简单要求每个 SSE 的 jseq 恰好 +1；缺口应以 journal 为准完成对账。handler 应按事件身份保持幂等，并在恢复失败时暴露 degraded 状态。

验收重点：注入 handler 失败、队列溢出、乱序、重复、重连及重启，验证最终 workflow 和 pool 状态与权威状态一致。

## 6. 并行输出可能让旧快照覆盖新状态

证据：[GA 快照发布](D:/study/GA/frontends/gahub/gahub_app.py:277)；[Hub 无条件替换镜像](D:/study/GA-Hub/server/services/conductor_service.py:1422)；[前端无条件替换](D:/study/GA-Hub/webui/src/stores/conductorStore.ts:129)。

引擎在 `_snap_lock` 外捕获并编码快照，仅对去重 key 加锁，广播也在锁外。多个 monitor 并发时，线程 A 可以先捕获 running，线程 B 随后捕获并发布 stopped，A 最后再发布旧 running。Hub 和前端没有引擎 snapshot revision 来拒绝旧数据，前端本地 revision 只保护 HTTP 水合与实时事件之间的竞争。

隔离复现：用线程屏障固定此顺序，实际广播次序为 `[stopped, running]`。最后一个旧快照会让页面状态倒退，也影响基于 Hub 镜像的超时警告。

建议：短期把快照捕获、去重和发布排入同一个有序发布入口；长期在权威状态提交时递增 revision，输出一致快照，Hub/前端拒绝旧 revision。序号不能只在迟到的广播时分配，否则仍会给旧内容分配新序号。

可合并的性能优化：每帧目前都构造全池快照、做全量 JSON 编码再去重；改为脏 worker 合并推送，摘要按 worker 内容版本缓存，prompt/manifest 等静态大字段放详情接口。先保持完成、验收和失败事件及时送达，再量化帧率及载荷。

## 7. 引擎验收错误的证据在 HTTP 转发中丢失

证据：[引擎 completion_unverified 响应](D:/study/GA/frontends/gahub/gahub_app.py:1682)；[client 只提取 error 字符串](D:/study/GA-Hub/server/services/conductor_client.py:348)；[路由再次转为字符串](D:/study/GA-Hub/server/routes/conductor.py:57)。

引擎 409 会返回 done_marker、缺失文件、quality_checks 和校验详情，但 client 构造 `GahubProcessError` 时只保留 `body.error`。异常穿过路由后，前端实际收到 `detail: completion_unverified`。路由中处理 `result['error']` 并保留证据的分支在真实非 2xx HTTP 响应下不会进入，因为 client 已经抛出异常。

隔离复现：输入含 `error/id/done_marker/deliverables_missing/quality_checks` 的 409 响应，通过真实 client 和 `_dispatch_through_engine` 后，输出只剩 `409 + completion_unverified`。

建议：client 对 JSON 错误保存完整结构，并单独提取用于日志的 message；路由原样保留已约定的结构化 detail。补充 engine 非 2xx 到 Hub 路由的真实转发测试，避免用 service 返回 dict 的替身代替上游 409。

## 后续性能与维护优化

### Journal 按游标定位，避免每页全量读解析

[read_events](D:/study/GA/frontends/gahub/conductor_journal.py:163) 每次先读取整个文件，再从头 JSON 解析到目标 seq；启动时也全量读文件及拆行。Hub 分页回放会重复付出这项成本。

合成基准：本机 Python 3.12、Windows 文件系统，固定约 240 字节的 JSONL 事件，查询最后 1 条，3 次热读。内存为 tracemalloc 测得的 Python 分配峰值，不是进程 RSS。

| 事件数 | 文件大小 | 读取最后 1 条耗时 | Python 峰值内存 |
| --- | --- | --- | --- |
| 1,000 | 0.23 MiB | 2.0-2.3ms | 0.50 MiB |
| 10,000 | 2.29 MiB | 21.2-22.0ms | 4.97 MiB |
| 100,000 | 22.97 MiB | 228.4-239.2ms | 49.77 MiB |

当前本机 journal 只有 101,704 字节，因此这项列为后续优化，不是当前主要瓶颈。可先流式逐行读取降低峰值内存，再用稀疏 `seq -> byte offset` 索引优化靠后读取；只有数据量与检索需求增长后再考虑 SQLite、轮转和检查点。保留源日志的持久性保证，不以直接关闭 fsync 作为默认提速方案。

### 建立跨仓库协议契约

Hub 的 OpenAPI/TS 生成只覆盖 Hub 自己，无法验证 GA 引擎变化。例如引擎已支持 `plan_milestones`，但 Hub 派单请求 schema/client 尚未透传；引擎 detail 的 max_len 上限为 100,000，Hub 路由允许 1,000,000；暂停/拒绝等引擎能力也未全部公开到 Hub。部分差异可以是产品选择，应由明确的映射和契约测试表达。

建议：引擎提供 protocol version/capabilities，Hub 显式校验；增加“真实 Hub route + client + 真实 GA FastAPI schema/endpoint + fake Agent”的测试层，不调用付费模型。优先覆盖上述已复现的边界。随后按 client/事件投影/workflow/准入职责拆分大模块，避免仅按文件长度拆分。

## 验证记录

使用已有 `D:/APP/anaconda3/envs/ga/python.exe`，Python 3.12.13、FastAPI 0.136.1、pytest 9.1.1。默认系统 Python 3.10 缺少 FastAPI，已切到现有 GA 环境完成测试，无依赖安装。

- Hub：`test_conductor_hub_engine_chain`、`test_conductor_journal_replay`、`test_conductor_event_lifecycle`、`test_conductor_route_lifecycle`、`test_conductor_service_shutdown`、`test_blocking_routes` 共 120 passed；最新 `test_conductor_service_surface` 28 passed。
- GA：`test_conductor`、`test_gahub_app`、`test_conductor_journal` 共 171 passed；`test_conductor_checks`、`test_conductor_milestones` 共 20 passed。
- 前端：Conductor 页面、store、RuntimeEffects 和 presentation 共 51 passed。
- 另进行了上文的隔离复现和合成性能测试。临时数据已清理；没有调用真实模型、修改交付文件或操作运行中的服务。
- GA 测试有一条 `PytestUnhandledThreadExceptionWarning`：`test_worker_silent_wakes_supervisor` 的 pool 替身缺少 `evaluate_milestones`，后台线程在发出 warning 后退出，而测试仍显示通过。另有第三方 protobuf 弃用警告。建议将后台线程异常纳入失败门禁并修正替身。
- 本次未跑全仓库全量回归、真实 LLM 长跑或桌面 E2E，不能据此声明整个产品没有其他问题。

推荐实施顺序：先完成 1、2、7 这批边界修复；随后统一 3、4 的资源约束；再联合处理 5、6 的有序事件和状态恢复；最后依据实际数据量实施 journal 和快照性能优化。每一批都以对应复现转换为回归测试作为验收标准。
