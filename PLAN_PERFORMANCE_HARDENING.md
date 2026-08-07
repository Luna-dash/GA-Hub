# GA-Hub 性能与健壮性优化计划

日期：2026-08-07  
基线：`15e6448`（工作区已确认干净）

## 目标与执行约束

本计划针对审查后用户指定的第 2–11 项优化。执行采用纵切面 TDD：每一项先增加能稳定复现行为的测试，再做最小实现，最后运行相关回归和完整测试。不得改变 GenericAgent 原始会话文件的事实来源，不把 ZIP 内容转发/持久化为新的会话事实，也不引入未经需求授权的认证或协议破坏性变更。

每项完成标准：

1. 有失败测试或等价可重复的回归证据；
2. 实现只覆盖当前行为，不顺手做无关重构；
3. 相关测试和完整测试通过；
4. 失败路径、临时文件、线程和资源均有清理；
5. 记录兼容性边界和未量化的残余风险。

## 实施进度（2026-08-07）

- [x] 第2项：上传已改为 1 MiB 异步分块写盘，50 MiB 超限立即清理并返回 413；`tests/test_upload.py` 已覆盖分块、边界和清理。
- [x] 第3项：`files-by-path` 已改为 `realpath + commonpath` 校验，拒绝允许根内 symlink 指向根外；跨平台模拟测试通过，Windows 实体 symlink 测试因当前权限跳过。
- [x] 第4项：ZIP 条目预览增加 10 MiB 声明值预检及 64 KiB 分块硬上限，超限返回 413；小条目、双重超限、缺失、损坏和资源关闭测试共 5 项通过。
- [x] 第5项：会话列表、标题元数据访问及全文搜索整体移入 `asyncio.to_thread`，并发心跳与原返回语义测试通过。
- [x] 第6项：基于归档文件名、`mtime_ns`、大小的轻量目录签名维护线程安全 ID 索引；增删改名自动刷新、删除后显式失效、重复 basename 保留原排序首项，相关会话回归 12 项通过。
- [x] 第7项：新增单一 `ConversationMetadataAdapter`，标题新写只进入 `SessionMetadataStore`，旧 `ConversationTitleStore` 仅用于一次性读取迁移并清理；主存储以 resolved archive path 原子查找/upsert/删除，并对同一 metadata 文件跨实例共享锁。迁移、主源优先、稳定 ID/重命名、绑定冲突、精确删除、并发测试通过；相关回归 34 项及全量 `157 passed, 1 skipped, 10 subtests passed`。
- [x] 第8项：详情、导出和恢复中的阻塞 GA 解析/恢复移至工作线程；恢复在线程内顺序执行原生 restore 与投影，事件发布保留在事件循环；相关回归 12 项及全量 `161 passed, 1 skipped, 10 subtests passed`。
- [x] 第9项：集中前端会话 query key 与定向缓存更新/失效，完整区分 `q/offset/limit`；QueryClient 行为测试及前端全量 `38 passed`、类型检查、生产构建通过。
- [x] 第10项：补齐索引并发首次刷新与上传取消清理等压力/异常测试；定向矩阵 `29 passed, 1 skipped`。
- [x] 第11项：收敛 lifespan 后台任务、Agent、scheduler 与 token persistence 的停机顺序和单例释放；生命周期定向测试 `8 passed`。

### 2. 上传改为流式分块（已确认）

**证据**：`server/routes/upload.py:167-171` 使用 `await file.read()` 后才检查 50 MiB，并将整个 bytes 对象写盘；请求大小越界时会先把超限内容读入内存。

**方案**：以固定大小 chunk 循环读取，累计大小超过 50 MiB 立即删除已写临时文件并返回 413；成功后原子 rename 到最终文件名，异常时清理临时文件。返回的 size、mime、文件名协议保持不变。

**测试**：chunk 边界、恰好 50 MiB、超过限制、读写异常清理、成功响应。

### 3. 修复文件服务 symlink 越界（已确认）

**证据**：`files-by-path` 对用户路径调用 `abspath` 并使用字符串前缀判断；未解析 symlink，允许 GA temp 或 upload 目录中的链接指向目录外文件。`reveal` 是显式本机打开操作，仍需保持其既有 allowlist 与相对路径语义，不与下载接口混淆。

**方案**：统一使用 `Path.resolve(strict=True)` 后用 `relative_to` 做目录边界判断；根目录也解析；拒绝解析后越界、目录和不存在目标。保留 Windows 路径行为和现有 HTTP 状态语义。

**测试**：普通文件、目录前缀相似路径、相对路径、temp/upload 内外 symlink（平台不支持 symlink 时跳过并保留普通路径测试）。

### 4. 限制 ZIP 解压后读取大小（已确认）

**证据**：`read_zip_entry` 在 `server/routes/conversations.py:281-283` 对指定条目执行无上限 `f.read()`；压缩炸弹或大条目可占满内存。当前接口是服务端读取条目供 UI 预览，并非直接转发给 GA 后台。

**方案**：先检查 `ZipInfo.file_size`，超过上限直接 413；对未知/不可信声明仍以分块读取并累计硬上限，超限中止，不构造完整 bytes。响应编码与现有预览格式保持兼容，统一配置常量。

**测试**：小条目、声明大小超限、读取过程中超限、缺失条目、损坏 ZIP、资源关闭。

### 5. 会话搜索移出事件循环（已确认）

**证据**：会话搜索路径逐个读取归档全文，并由 async 路由直接调用同步文件解析；大型归档会阻塞 FastAPI event loop。

**方案**：将 CPU/磁盘型搜索工作封装为同步 helper，通过 `asyncio.to_thread`（或 FastAPI 线程池）执行；限制并发不改变搜索结果和排序。不得在线程中访问非线程安全的请求状态。

**测试**：结果等价、异常传播、并发请求不阻塞轻量 async 响应的行为测试；必要时对 helper 做隔离单测。

### 6. 建立会话 ID 索引（已确认）

**证据**：`conversations.py:_session_by_id` 每次线性遍历 `list_sessions()`；标题绑定也逐次扫描元数据。`ConversationRepository` 已有独立 v2 index，但历史 GA 原生会话路由没有使用它，不能直接当作该问题已解决。

**方案**：在会话服务层建立带失效/刷新策略的 ID→archive record 索引，以归档目录状态为准；列表刷新、删除/恢复及 mtime 变化时更新；找不到或路径变化时安全重建，不能返回陈旧路径。先保持现有按 mtime 倒序。

**测试**：索引命中、首次构建、文件新增/删除/改名后的刷新、重复 basename/异常文件、排序保持不变。

### 7. 统一会话元数据和标题来源（已确认）

**证据**：历史会话同时读取 `SessionMetadataStore` 和 `ConversationTitleStore`；`_conversation_title` 先按 archive_path 查 session metadata，再回退 title store，写入时又可能只更新其中一处，存在双写/冲突和孤儿记录。

**方案**：定义单一会话元数据适配层，以稳定会话 ID 和解析后的 archive path 绑定，标题只从一个 store 读写；提供一次性兼容读取/迁移旧 title sidecar，成功写入新来源后不再产生分裂写入。删除归档时清理关联元数据，无法绑定时不误删其他会话。

**测试**：旧数据兼容、读优先级迁移、重命名、绑定冲突、删除清理和并发写入。

### 8. 资源/磁盘 I/O 生命周期收敛（已完成）

**确认结果**：调用图和源码核验确认，历史会话详情、导出与恢复均在 `async` 路由内同步执行 GA 归档解析；恢复还连续执行 GA `restore()` 与再次归档解析，真实存在阻塞事件循环的风险。另一方面，主用 `SessionMetadataStore`、`ConversationTitleStore` 和偏好存储已经采用唯一临时文件、`os.replace` 与 `finally` 清理，因此没有为不存在的原子写缺口制造新抽象。

**实施**：详情和导出的 `_ga_extract` 通过 `asyncio.to_thread` 执行；恢复新增最小同步 seam `_restore_archive`，在线程内顺序执行 GA 原生 `restore()` 和归档投影，快照清理与事件发布仍留在事件循环线程。GA 原生解析器只接受文件路径且自行读取，因此没有复制其私有解析逻辑，也没有修改 GA 源码。

**验证**：heartbeat 测试确认详情、导出、恢复的慢 I/O 不再阻塞事件循环；异常注入确认 `SessionMetadataStore` 在 `os.replace` 失败时保留旧文件且不残留 `.tmp`；重复详情/导出请求结果一致。第 8 项局部测试 `12 passed`（仅第三方 protobuf Python 3.14 弃用警告）。

### 9. 查询/列表重复工作降低（已完成）

**确认结果**：前端已经全局使用 TanStack Query（默认 `staleTime=5s`），相同 query key 的并发读取会复用同一个底层 Promise，失败结果不会作为成功数据缓存，因此不存在需要另造缓存层的“每次渲染都重复请求”问题。真实缺口是会话列表/详情 key 和 mutation 失效规则散落在页面与命令面板；旧列表 key 没有完整表达 `limit`，重命名成功后同时失效列表与详情会立即再次解析详情，且列表/详情标题短暂不一致；删除任意非当前条目也会错误清空当前详情选择。

**实施**：新增集中式 `conversationKeys`，列表 key 完整包含 `q/offset/limit`，详情 key 包含会话 ID；历史页和 Command Palette 均改用统一协议。重命名使用后端返回的最终标题立即同步所有已缓存列表摘要和目标详情，只失效列表前缀以重算搜索成员关系，不再重读未变化的消息详情。删除只移除目标详情缓存并失效列表，且仅在删除当前选中条目时清空选择。保持既有 5 秒 TTL、排序和 UI 行为，没有增加第二套缓存。

**验证**：QueryClient 行为测试覆盖相同 key 并发只调用一次底层请求、错误不产生成功缓存、`q/offset/limit` 参数隔离、重命名后列表/详情同步及列表失效、删除仅移除目标详情并失效列表；前端全量 `38 passed`，`tsc -b --noEmit` 和 Vite production build 均通过。tracked 前端调用点扫描确认会话列表查询均已使用集中 key。

### 10. 增加压力和异常测试（已完成）

**确认结果**：第2–9项测试已覆盖上传/ZIP 大小边界、symlink 越界、事件循环 heartbeat、sidecar 并发写和原子替换失败；补充盘点发现两个真实缺口：会话索引缺少并发首次刷新验证，上传流在 `asyncio.CancelledError` 取消时因只捕获 `Exception` 会遗留部分文件。

**实施**：新增8线程同步起跑的索引压力测试，确认同一签名只触发一次底层扫描且所有读取一致；新增上传取消异常测试，并将上传流清理范围扩展为 `BaseException`，确保取消时删除部分文件后原样传播取消。压力测试均使用短等待、临时文件和明确屏障，不引入生产规模假设。

**验证**：定向异常/压力矩阵 `29 passed, 1 skipped`，覆盖上传分块/超限/取消清理、ZIP 声明与实际流上限/缺失/损坏/关闭、索引刷新与8线程并发、搜索/详情/导出/恢复 heartbeat、sidecar 60线程并发与原子替换失败清理。取消测试在修复前稳定失败并确认残留文件，修复后通过。

### 11. 收敛单例和生命周期管理（已完成）

**证据**：`main.py` lifespan 负责启动/关闭，但 `AgentService`、scheduler、token persistence 等服务通过各自 `instance()`/模块级状态管理；Token 已有后台线程 singleton 保护，但仍需确保多次 app lifespan、测试 teardown 和启动失败路径不会遗留线程或重复服务。

**实施**：由 lifespan 显式持有 Feishu 延迟启动 task，关闭时先取消并 `await` 其 `finally`，再按生产者到依赖者的顺序停止 TaskScheduler、AutonomousScheduler、Feishu watcher、Agent worker，最后停止 token persistence。Agent worker 采用 abort + 队列哨兵 + 有界 join；Autonomous idle loop 改为 Event 可中断等待并有界 join；TaskScheduler、AgentService 与 AutonomousScheduler 仅在自身 worker 确实退出后释放单例，避免超时状态下产生新旧双实例。Feishu watcher 保留可重启实例并在再次启动时清除 stop Event。

**验证**：生命周期定向测试 `8 passed`，覆盖延迟 task 取消并等待、Agent 主动/空闲退出、Agent 与 Autonomous 超时不误释单例、两个 scheduler 干净重建、Autonomous idle 线程即时唤醒退出，以及 Feishu 同实例 watcher 停止后重启。相关 token/Agent/backend 回归矩阵 `19 passed, 10 subtests passed`。

## 执行顺序

1. 2 → 3 → 4：先处理输入/文件安全和内存上限；
2. 5 → 6 → 7：再处理历史会话 I/O、索引和数据来源；
3. 8 → 9：依据调用图补齐资源与重复请求优化；
4. 10：补齐跨项异常/压力回归；
5. 11：最后收敛生命周期并运行全量验证，避免单例改动掩盖前述问题。

## 验证命令与交付物

- 后端：`pytest -q`
- 若修改前端：按 `package.json` 的生产构建/测试命令执行
- 静态检查：Python 编译及 Git diff 检查
- 交付：本计划、实现 diff、逐项测试证据、残余风险说明；不自动 push，除非另行要求。

## 暂不纳入

认证/CSRF、监听地址策略、GA 原生归档格式和 L4 归档规则不在本批次修改范围；它们属于独立安全/产品决策，避免与本次性能健壮性改动混杂。
