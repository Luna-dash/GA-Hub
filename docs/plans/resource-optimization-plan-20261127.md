# GA-Hub 全栈资源占用优化与绿色更新体系重构方案

- **状态**：✅ 代码全部落地（Wave 1 – Wave 4 全部完成，待退出运行中 GA-Hub 后执行 `build_all.bat` 产出新包；2026-11-27）
- **决策来源**：2026-11-27 运行期实测诊断（连续运行 254 分钟现场进程树 + 内核套接字/模块采样 + 磁盘占用审计）与全项设计访谈（`/grill-me`）共同锁定。
- **范围**：全量 **P0 + P1 + P2**，按 **4 个独立可测试、可提交的波次（Wave 1 – Wave 4）** 分步落地；任何涉及构建链的波次均遵守 [`AGENTS.md`](../../AGENTS.md) 与 [`docs/BUILD.md`](../BUILD.md) 纪律。

---

## 1. 实测基线与目标指标

### 1.1 问题基线（2026-11-27 本机运行 254 分钟实测）

| 观测维度 | 实测基线 | 已核实核心根因 |
|---|---|---|
| **WebView2 进程组 (6 进程)** | **~852–896 MB WS / ~631–668 MB Private**，累计 CPU **1,848 s**，Renderer ↔ GPU 管道流量 **7.9 GB** | ① `.ga-session-dot-running` 用非合成属性 `box-shadow` 跑 60/120 FPS 无限动画；② 三层全屏噪点宣纸 PNG 叠加击穿纯色瓦片剔除；③ 滚动区右侧常驻 4 个 `backdrop-blur-md` 浮层；④ 启动 `@2x` 星空 `<canvas>` 顶高 Skia 256 MB 显存池；⑤ `AntiChat`/`AntiTaskProgress` 零节流 `O(N²)` SSE 渲染 + 1s 整页重绘 + 折叠 `<details>` 全挂载；⑥ `chatStore` 3–4 倍字符串重复 + `markdownRenderCache` 48 棵树永不清理 |
| **Sidecar 后端 (`ga-hub-sidecar.exe`)** | **323 MB WS / 1,230 MB Private Commit**，**132 线程**，**52 个 `ProactorEventLoop`**，累计读 **3.75 GB**，冷启动 **6.5–12.7 s** | ① `HubSessionProjectionService` 无条件为 50 个历史会话各起独立线程 + EventLoop，每 5s 死循环重连 `:19736`；② PyInstaller 误打包 `numpy` + `libscipy_openblas64`（25.8 MB），32 核未设 `OPENBLAS_NUM_THREADS=1` 吃掉 ~900 MB Commit；③ 打包 85.9 MB `node.exe` 导致 `--onefile` 每次冷启动解压 180.6 MB / 1,101 文件；④ `anti_engine` 逐 token `synchronous=FULL` 刷盘、`EventBus(1000)` 累积拷贝、`feishu_service` 每 5s 全机 `psutil.process_iter` |
| **受管子进程（飞书 + Agy ACP）** | `fsapp.py` **133 MB WS / 951 MB Commit**；4 个 `agy.exe acp` 共 **~2.0 GB WS** | ① 飞书组件已弃用但仍在 180s 后无条件自启 + 1 Hz 轮询日志；② `AgyRuntimeManager._workers` 闲置 TTL 30 分钟且无数量上限；③ 子进程未加 `CREATE_NO_WINDOW` 伴生 5 个 `conhost.exe` |
| **磁盘占用与残留** | `%TEMP%\_MEI*` **7.49 GB**（63 目录）；`agy-profiles` **4.23 GB**；`EBWebView` **471 MB** | ① 44 个无哨兵旧 `_MEI*`（6.79 GB）被 `mei_cleanup.rs` 判为 `foreign`；② `agy_profile.py` 重定向 `USERPROFILE` 未透传 `RUSTUP_HOME`/`CARGO_HOME` 导致重复下载 **1.93 GB** Rust 工具链；③ 每次随机端口令 `EBWebView/Cache` 堆积 **325 MB** |

### 1.2 优化后目标指标

| 指标维度 | 当前基线 | Wave 1–3 后预期 | Wave 4 完成总预期 |
|---|---:|---:|---:|
| WebView2 进程组 Private / WS | ~650 MB / ~880 MB | ~280–340 MB / ~460 MB | **~250 MB / ~420 MB** |
| Sidecar Private Commit / WS | 1,230 MB / 323 MB | ~160–220 MB / ~150 MB | **~130 MB / ~130 MB** |
| Sidecar 常驻线程 / 事件循环 | 132 线程 / 52 Loops | ~20–28 线程 / 1 Loop | **~18–24 线程 / 1 Loop** |
| Agy ACP 多会话切换后驻留 RAM | 2.0+ GB（无上限） | 0.2–0.6 GB（双活 LRU） | **0.2–0.6 GB** |
| 静置 / 最小化前后端合计 CPU | ~8%–15% 单核 | < 0.3% | **< 0.1%** |
| Sidecar 交付体积 / 冷启动耗时 | 83 MB (`--onefile` 181 MB 解包) / 6.5–12.7 s | ~22–28 MB（去 Node/NumPy） / ~3–4 s | **~35 MB 目录免解压 / 1.2–2.0 s** |
| 磁盘冗余回收 | ~12.2 GB 堆积 | 回收 ~8–10 GB + 杜绝复发 | **彻底消灭 `%TEMP%\_MEI*` 写入** |

---

## 2. 已锁定的核心架构决策

1. **去飞书组件 + 保留轻量抽象 IM 接口**：彻底删除 `feishu_service`、`routes/feishu`、180s 自启、1 Hz 日志轮询及 `/api/feishu/*` OpenAPI；后端保留 `IMAdapter` Protocol + `IMRegistry` + 通用事件主题 `im:*` + `GET /api/im/status` 只读端点。无适配器注册时**零线程、零子进程、零后台轮询**，Dashboard 不渲染空卡片。
2. **彻底移除 GA 官方 Hub (`:19736`) 会话投影**：已切换至 Nova / `remote_access`，直接移除 `HubSessionProjectionService`、`official_hub` 桥接挂载与冗余旧单例 `AgentService.instance()` 启动。
3. **后台进程均衡回收策略**：
   - 空闲 `agy.exe acp` 最多常驻 **2 个**（LRU 淘汰非 `busy` 进程），闲置 **10 分钟**自动关闭（活跃会话永不误杀；切回已回收会话时通过现有 `session/resume` / `session/load` 无感恢复）；Windows 子进程补齐 `CREATE_NO_WINDOW`。
   - 原生 GA `SessionCoordinator._runtimes` 最多常驻 **5 个**空闲会话，闲置 **30 分钟**卸载。
4. **前端视觉无损 GPU 方案**：
   - 呼吸圆点改用 `::after` `transform + opacity` 合成动画 + `document.hidden` 后台暂停；Ultra 流光保留可见态动效，去掉常驻 `will-change` 并在后台暂停。
   - 宣纸纹理三层合一：删去被遮挡的两层，保留最底一层固定纸面（文字在静止纸面上滚动）并无损压缩纹理文件。
   - 仅移除滚动区右侧 4 个 90%–95% 不透明小导航胶囊（`ConversationTurnMinimap` 刻度条/页码钮、`TranscriptNavDock` 跳底/上下节钮）的 `backdrop-blur-md` 改为实底 `bg-bg-card`；弹窗、菜单、模态框毛玻璃全部保留。
   - 启动星空画布 `gahub-loader.js` 限制 `dpr = 1`，并在主界面显现前提前释放纹理。
5. **磁盘治理策略**：
   - `agy_profile.py` 隔离 `USERPROFILE` 时透传宿主机工具链缓存环境变量（`RUSTUP_HOME`、`CARGO_HOME`、`PIP_CACHE_DIR`、`UV_CACHE_DIR`、`NPM_CONFIG_CACHE` 等），杜绝重复下载 GB 级工具链。
   - `.gemini` 历史对话数据**不自动静默删除**；在设置页新增“存储空间与缓存清理”面板，展示分类体积并由用户显式触发清理。
   - 扩展 `mei_cleanup.rs` 指纹以回收历史无哨兵旧 `_MEI*`（6.79 GB）。
6. **移除 85.9 MB 内置 `node.exe`**：用纯 Python 原生移植 `messagePresentation`（`remoteMessagePage` / `remoteProgress`），建立前后端共享的黄金契约测试集（同时跑 `vitest` 与 `pytest`）防止规则漂移。
7. **绿色便携 `--onedir` + 极简 Rust 一键更新体系**：保持 `--no-bundle` 纯绿色免安装形态（不写系统注册表），Sidecar 迁移为 `--onedir`（`sidecar/` 子目录），废弃原 9 个重型 Python 更新模块、Windows 计划任务、60 秒倒计时与多步审批；改由极简 Rust 更新切换助手（~500 KB）实现“后台下载校验（支持 GitHub Release 签名包与本地 ZIP 双来源）→ 解压版本目录 → 一键重启原子切换 → 探活失败自动回滚”。

---

## 3. 四波次详细实施路线

### Wave 1：后端止血、去飞书/IM 接口、去 Hub 投影与流式 I/O 优化

> **不触碰打包脚本与构建契约**，全量后端测试与 OpenAPI 契约即可直接验证。

#### W1.1 去除飞书实现并引入轻量抽象 IM 接口
- **删除**：
  - `server/services/feishu_service.py`、`server/routes/feishu.py`
  - `server/main.py` 中的 `FEISHU_AUTO_START_DELAY_SECONDS`、`_delayed_feishu_autostart`、启动期 `FeishuService` 初始化与日志监控线程、`SPA_ROUTES` 中的 `"feishu"`
  - `server/services/app_services.py` 的 `feishu` 字段、`server/schemas.py` 的 `Fs*`/`FeishuProcessStatus` 模型、`server/event_topics.py` 的 `FEISHU_*` 常量
  - `server/services/service_registry.py` 中的 `_feishu` reader
  - 前端遗留 `/feishu` 重定向、通道图标与测试断言（`App.tsx`、`FileCitation.tsx`、`LiveChatTranscript.tsx`、相关 `*.test.*`）
  - 对应旧飞书单测（`tests/test_feishu_routes.py`、`tests/test_feishu_service.py` 等）
- **新增**：
  - `server/services/im_adapter.py`：定义 `IMAdapter`（`Protocol`：`id`, `name`, `status()`, `start()`, `stop()`, `send_text(...)`, `shutdown()`）与线程安全 `IMRegistry`（支持注册/注销/状态聚合，无适配器时返回空列表、零后台开销）。
  - `server/routes/im.py`：提供只读 `GET /api/im/status`（返回已注册适配器列表及摘要；空注册表返回 `{"configured": false, "adapters": []}`）。
  - `server/event_topics.py`：定义通用 `IM_STARTED = "im:started"`、`IM_STOPPED = "im:stopped"`、`IM_MESSAGE = "im:message"`、`IM_STATUS = "im:status"`。
  - `ServiceRegistry` 动态遍历 `IMRegistry`：有适配器时展示其状态卡片，空注册表时不展示占位卡片。
- **契约同步**：运行 `scripts/export_openapi.py` 与 `npm --prefix webui run api:generate` 更新 `docs/api/openapi.json` 和 `webui/src/api/generated/schema.d.ts`。

#### W1.2 彻底移除 GA 官方 Hub (`:19736`) 投影与旧单例 `AgentService`
- 删除 `server/services/hub_session_projection.py` 与 `tests/test_hub_session_projection.py`（及 `tests/test_official_hub_bridge.py`）。
- 从 `server/main.py` 移除 `start_hub_session_projection` / `stop_hub_session_projection` 以及启动期冗余的 `AgentService.instance()` 构造与 `start_run_thread()`（确认 `SessionLifecycle` / `SessionCoordinator` 接管全部会话后清理 `app_services.agent` 的非必要构造）。
- 从 `server/services/agent_service.py` 移除 `official_hub.attach(self)` / `detach()`；从 `server/services/core_contract.py` 移除 `frontends.gahub.bridge.official_hub` 检查项；清理 `server/constants.py` 中 `ENV_GAHUB_HUB_PROJECTION_*`。

#### W1.3 子进程池与会话运行时均衡回收
- `server/services/agy_runtime.py`：
  - 新增 `MAX_IDLE_WORKERS = 2`，将 `IDLE_SESSION_TTL` 从 `1800.0` 调为 `600.0`（10 分钟）。
  - 在 `_acquire_worker` / 新建 worker 路径中，若空闲（`not worker.busy`）worker 数超过上限，按 `last_used` LRU 顺序优雅关闭最旧的空闲 worker。
  - Windows 下 `subprocess.Popen` 补齐 `creationflags |= subprocess.CREATE_NO_WINDOW`（`0x08000000`），消除伴生 `conhost.exe`。
- `server/services/session_coordinator.py`：
  - 为 `_runtimes` 增加空闲 LRU + TTL 回收器（上限 `MAX_IDLE_RUNTIMES = 5`、闲置 `IDLE_RUNTIME_TTL = 1800.0` 秒），仅回收非运行且无活跃 WS 订阅的会话运行时。
- `server/services/ga_external_worker.py`：为外部 Web 工具子进程增加 15 分钟空闲自动回收。

#### W1.4 流式 I/O、内存放大、空闲轮询与线程池收敛
- `server/services/anti_engine.py`：
  - `events_db` 建连后立刻执行 `PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=15000;`。
  - 对高频 `message.delta` / `step.update` 在内存队列中按 **100 ms** 批量事务写盘（遇到终态/审批/非 delta 事件及 `finally` 立即刷盘）。
  - 活跃 run 在内存中维护当前事件列表增量视图，`stream_events` SSE 直接消费内存事件，不再每 0.6s 连开 3 个 SQLite 连接。
- `server/services/event_bus.py` & `server/services/agent_service.py`：
  - `bus.publish()` 增加 `ephemeral: bool = False` 参数；`chat:next` 设为 `ephemeral=True`（实时推送给在线订阅者但不写入 1,000 槽 `_history` 环），同时在 `_json_safe` 中对基础不可变类型短路。
- `server/routes/sessions.py`：Compact WS 订阅循环改为 `asyncio.Event` + **60 ms** 合并节流后调用 `send_snapshot()`。
- `server/services/conductor_store.py` & `conductor_recovery.py`：
  - `ConductorStore` 改为 `PRAGMA synchronous=NORMAL`；`DELETE ... NOT IN` 裁剪改为每 N 批触发而非每次写盘触发。
  - 无活跃 Conductor 任务时挂起 5s `sync()`/`commands` 轮询，收到启动/SSE 事件后再唤醒。
- `server/services/scheduled_chat_service.py`、`autonomous_scheduler.py`、`mykey_auto_sync.py`：0 启用条目时进入条件变量无限等待，新增/修改配置时唤醒。
- `server/main.py` & `server/routes/upload.py`：显式绑定有界默认 `ThreadPoolExecutor(max_workers=8)`，将 AnyIO 默认线程限制器收紧至 `12`，移除 `upload.py` 独立 `_FILE_POOLS`。
- `server/routes/tokens.py` & `server/services/archive_messages.py`：改为按文件路径单槽 `(mtime_ns, size)` 缓存（覆盖旧版本而非在 `@lru_cache` 中堆积历史版本）。

#### W1.5 `agy_profile.py` 宿主机工具链环境变量透传
- `server/services/agy_profile.py`（L1361 附近）：在覆盖 `USERPROFILE`/`HOME` 前，将宿主机真实目录对应的 `RUSTUP_HOME`（`<real_home>/.rustup`）、`CARGO_HOME`（`<real_home>/.cargo`）、`PIP_CACHE_DIR`、`UV_CACHE_DIR`、`NPM_CONFIG_CACHE`、`GOMODCACHE` 显式透传给子进程（保留用户已显式设置的环境变量优先），防止 Agy 在 profile 内重复下载工具链。

#### Wave 1 验收标准
- 新增单测：IM 注册表与 `/api/im/status`、ACP 2-worker LRU 与 10m TTL 回收、`SessionCoordinator` 5-runtime LRU、SQLite 批量刷盘事务数验证、`EventBus` ephemeral 不入 history、`agy_profile` 工具链环境变量透传。
- 全量回归：`python -m pytest tests -q`、`npm --prefix webui test -- --run`、`npm --prefix webui run api:check` 全部通过。

---

### Wave 2：前端 GPU 无损优化、流式降载、内存瘦身与设置页清理面板

#### W2.1 GPU 与动画无损优化
- `webui/src/styles/index.css`：
  - 将 `.ga-session-dot-running` 重写为 `::after` 伪元素 `transform: scale()` + `opacity` 合成层动画；删除死规则 `body { background-attachment: fixed; }`。
  - 在 `document.hidden`（给 `<html>` 同步 `data-page-hidden="true"`）时，全局暂停 `.ga-session-dot-running`、`.ga-account-pill--ultra::after`、`.cursor-blink::after`、`ScheduleClockFace` 旋转等纯装饰动画。
- `webui/src/styles/ga-actions.css`：`.ga-account-pill--ultra::after` 保留流光动画，移除常驻 `will-change: transform, opacity`。
- `webui/src/components/PageShell.tsx` & `webui/src/styles/index.css` & `webui/src/assets/textures/`：
  - 移除 `PageShell.tsx` 外层 `<section>` 和内层滚动 `<div>` 上的重复 `.ga-paper-canvas`，仅保留 `.app-aurora` 单层固定宣纸底板。
  - 将 3 张 520 KB 噪点 PNG 无损转压为 8-bit 灰度/索引 PNG 或无损 WebP（预计缩减至 ~30–50 KB）。
- `webui/src/components/ConversationTurnMinimap.tsx` & `webui/src/components/TranscriptNavDock.tsx`：移除这 4 个 90%–95% 不透明小导航胶囊上的 `backdrop-blur-md`，改为 `bg-bg-card`（保留边框与阴影；弹窗/模态框毛玻璃保持不动）。
- `webui/public/gahub-loader.js`：画布分辨率限制 `dpr = 1`；`dismiss()` 时先将画布 `width = height = 0` 释放显存再做轻量 CSS 淡出。

#### W2.2 `AntiChat` / `LiveChat` 流式节流、重渲染隔离与后台轮询休眠
- `webui/src/pages/AntiTaskProgress.tsx`：
  - SSE `onPayload` 改为写入 `pendingEventsRef` 缓冲队列，通过 **80 ms** 定时器/rAF 批量增量合并到 `steps`/`partial`/`progressMessages`（`O(Δ)` 替代 `O(N²)`）。
  - `<details>` 折叠时按 `{open && <ol>...</ol>}` 懒挂载步骤 DOM；run 结束后复位 `startedLive` 并释放非活跃 `anti-run-events` 缓存。
- `webui/src/pages/AntiChat.tsx` & `webui/src/pages/ThemeTasks.tsx`：
  - 抽离 `<LiveRunElapsed />` 独立叶子组件承载 1s 计时器；将 `useDraftStore` 订阅下沉至独立 `<AntiComposer />` 子组件。
  - 用 `useMemo` 包装 `FileLinkContext.Provider` / `FileTransferConclusion.Provider`；SSE 已连接时将 `anti-live`/`anti-runs`/`anti-queue` 轮询降频为低频兜底（如 10s）或由 SSE 终态事件触发单次刷新。
- `webui/src/pages/LiveChat.tsx` & `LiveChatTranscript.tsx`：
  - `FileLinkContext.Provider` 用 `useMemo` 稳定；`ConversationTurnMinimap` 包裹 `React.memo`；`scheduledChats.length === 0` 时不启动 60s 定时器；稳定 `renderChatMessage` 避免 `msgs.length` 变化触发全量虚拟行重渲染。
- 全站后台休眠：为 `AntiChat`、`AntiDaemonControl`、`ThemeTasks`、`TokenStats`、`MyKey` 补齐 `refetchIntervalInBackground: false`；`DesktopRuntimeGate`（3s IPC）、`useNowTick`、`NovaSettingsPanel`、`UpdateSettingsPanel`（空闲态停止 2s 轮询）全部加 `visibilitychange` 暂停；删除 `useSessionUnreadEffects.ts:156` 在 `setQueryData` 后多余的 `invalidateQueries`。

#### W2.3 V8 堆内存、Markdown 管线与静态包体瘦身
- `webui/src/utils/markdownRenderCache.ts` & `webui/src/components/MarkdownView.tsx`：
  - 上限调整为 `MAX_ENTRIES = 20`、`MAX_SOURCE_CHARACTERS = 350_000`；在自定义 `code`/`td`/`th` 解构剔除 `node` 属性防止 HAST AST 泄漏；切换会话与离开聊天路由时调用 `clearMarkdownRenderCache()`。
  - 异步按需 `import('katex')` + `import('katex/dist/katex.min.css')`（移除 `main.tsx` 的启动期全局 `katex.min.css`）；`rehype-highlight` 收敛为 ~15 种常用开发语言。
- `webui/src/utils/mathMarkdown.ts`：用轻量线性词法扫描器（或内置 `remark` 插件）取代前置完整 `markdownParser.parse(src)`，消除含 `$` 文本的双重 AST 解析。
- `webui/src/stores/chatStore.ts`：修正字符预算统计覆盖 `content + segments + turnSegments`，将上限调整为活跃 1.5M / 后台最多 2 会话共 2M，离开 `/chat` 路由超 60s 后释放后台缓存视图与闲置会话 WS。
- `webui/src/components/AttachmentImage.tsx`：添加 `loading="lazy" decoding="async"`，配合后端缩略图尺寸上限（如最大边 512px，点击看原图）。
- `webui/src/components/SidebarNav.tsx`：路由预加载增加 180 ms hover 防抖（或 `onPointerDown` 触发）。
- `webui/src/hooks/useConductorRuntimeEffects.ts`：全局仅维护轻量徽标计数，4,000 条活动日志与聊天历史在进入 `/conductor` 时按需拉取。
- 静态资源清理：删除未引用的 452.7 KB 伪 `webui/public/favicon.svg`，压缩 `favicon.ico` 至 ~15 KB；Vite 构建过滤掉 KaTeX 冗余 `.woff`/`.ttf` 仅保留 `.woff2`；`tailwind.config.js` 排除 `*.test.{ts,tsx}`。

#### W2.4 设置页“存储空间与缓存清理”面板
- 后端新增只读统计与手动清理路由（`server/routes/storage.py` 或并入 `system.py`）：
  - 分类扫描体积：旧 `_MEI*` 临时目录、`agy-profiles` 重复工具链缓存（`.rustup`/`.cargo`）、`runtime-tmp`、`uploads/`、`logs/`、`.gemini/conversations` & `brain`、`EBWebView/Default/Cache`（标注只读或重启清理说明）。
  - 提供分项手动清理动作（带二次确认、跳过当前被占用的活跃文件/会话）；`.gemini` 对话历史仅在用户显式勾选点击后执行，绝不静默自动删除。
- 前端在 `Settings` 页新增“存储与缓存”区块展示分类占用与一键清理按钮。

#### Wave 2 验收标准
- 前端测试 `npm --prefix webui test -- --run`、`tsc -b --noEmit`、`npm --prefix webui run build` 全绿；`webui/dist` 总大小降至 ≤2.5 MB。
- 实机验证：开启会话运行 10 分钟后，WebView2 GPU/Renderer 跨进程 IPC 流量大幅下降，窗口最小化后 CPU 趋近 0%。

---

### Wave 3：纯 Python 移植 `messagePresentation`（去 `node.exe`）、PyInstaller 裁剪与 Rust 壳优化

#### W3.1 纯 Python 原生实现 `messagePresentation` 并移除 `node.exe`
- **黄金契约测试先行**：从现有 `webui/src/utils/assistantTranscript.test.ts`、`runningTranscript.test.ts`、`messagePresentation` 及 `assets/remote_access/` 用例中提炼共享黄金数据集 `tests/fixtures/message_presentation_golden.json`（覆盖普通多轮、思考块、代码块内协议字面量、compact `ask_user`、进度摘要、截断边界等）。
- **双端对齐测试**：新增 `webui/src/utils/messagePresentation.golden.test.ts` 与 `tests/test_message_presentation_golden.py`，确保 TS 与 Python 实现对同一输入产出**逐字段 100% 一致**的结果。
- **Python 原生替换**：在 `server/services/message_presentation.py`（可拆分为 `transcript_protocol.py` + `message_presentation.py`）中直接同步/线程内计算 `page()` 与 `progress()`，彻底移除 `_MessagePresentationWorker` 子进程与 stdio JSON 管道。
- **清理 Node 打包链**：
  - 删除 `desktop/node_runtime.py`、`tests/test_node_runtime.py`、`server/services/message-presentation-worker.ts` & `.cjs`；精简 `assets/remote_access/build-remote.cjs` 仅编 `remote.js`。
  - 从 `desktop/build_sidecar.py` 移除 `stage_node` 与 `runtime/node` 参数；更新 `server/desktop_sidecar.py --selftest` 直接自检 Python 原生 compact 转换。
  - 更新 `docs/BUILD.md` 与 `assets/nova/CONNECTOR.md` 中关于“Sidecar 依赖内置/PATH Node.js”的过时说明。

#### W3.2 PyInstaller 依赖裁剪、OpenBLAS 防护与历史 `_MEI*` 清理
- `server/desktop_sidecar.py` 最顶部（任何 `import` 之前）设置：
  `os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")`, `OMP_NUM_THREADS="1"`, `MKL_NUM_THREADS="1"`, `NUMEXPR_NUM_THREADS="1"`。
- `desktop/sidecar_archive.py` 扩展 `EXCLUDED_MODULES` 并在 `verify_sidecar_archive()` 中强制拦截：`numpy`, `scipy`, `matplotlib`, `pandas`, `torch`, `cryptography`, `Pythonwin`, `pywin`, `win32ui`, `win32com`, `_pytest`, `pytest`, `pygments`, `setuptools`, `pkg_resources`, `watchfiles`, `tornado`, `unittest`。
- `src-tauri/src/mei_cleanup.rs`：扩展 `carries_our_fingerprint()`，除 `gahub_sidecar_bundle.json`/`.dist-info` 外，同步识别包含 `server/` + (`webui/` 或 `assets/remote_access/`) 的历史无哨兵 GA-Hub `_MEI*` 目录，并优化 `live_bundle_dirs()` 避免因系统无关高权限 `python.exe` 拒绝访问而中断整次清理（仅对本用户会话/可读进程做精确模块校验）。

#### W3.3 Tauri Rust 壳编译与监管优化
- `src-tauri/Cargo.toml` `[profile.release]`：调整为 `lto = "thin"`、`codegen-units = 1`、`strip = "symbols"`（**严格保留两处 `indexmap = { version = "1", features = ["std"] }` 不动**）。
- `src-tauri/src/main.rs`：`watch_ready_sidecar` 改为在监管线程中通过阻塞等待进程句柄（或退出信号）感知退出，移除 250 ms 轮询循环。

#### Wave 3 验收标准
- 退出运行中的 GA-Hub 后执行 `python scripts\build_all.py --full` 返回码 `0`，`--selftest` 通过。
- 验证新产出的 `ga-hub-sidecar.exe` 内不含 `node.exe`、`numpy`/`libscipy_openblas64`、`Pythonwin`、`cryptography`、`_pytest`。

---

### Wave 4：`--onedir` 目录交付与极简 Rust 绿色更新体系重构（P2 契约升级）

> 本波次会显式升级便携交付布局与更新契约（`DATA_EPOCH = 2`），同步更新 `AGENTS.md`、`docs/BUILD.md`、`scripts/build_all.py`、`scripts/package_release.py` 与 `.github/workflows/desktop-build.yml`。

#### W4.1 Sidecar 迁移至 `--onedir` 预解压目录
- **目标绿色便携目录结构**：
  ```text
  GA-Hub/
    ga-hub-desktop.exe        # Tauri 主壳 (~5 MB)
    ga-hub-update.exe         # 极简 Rust 绿色启动/更新切换助手 (~500 KB)
    sidecar/                  # PyInstaller --onedir 预解压目录（冷启动零解压、零 _MEI*）
      ga-hub-sidecar.exe
      _internal/...
    manifest.json             # 版本号、data_epoch=2、全部交付文件 SHA-256 清单
  ```
- **打包与壳适配**：
  - `desktop/build_sidecar.py` 将 `--onefile` 改为 `--onedir`，输出整棵 `sidecar/` 目录（同样移除向 Sidecar 重复拷贝 `webui/dist`——若仅需在开启浏览器调试桥或远程访问时提供静态文件，改为单份共享或明确按需开关）。
  - `src-tauri/src/main.rs` 的 `sidecar_command()` 在 release 模式下解析同目录 `sidecar/ga-hub-sidecar.exe`（并保留 `GA_HUB_SIDECAR` 覆盖）；不再依赖 Tauri `externalBin` 的隐式单文件拷贝。
  - `scripts/build_all.py` 升级产物守卫：原子替换整棵 `sidecar/`，校验 `ga-hub-desktop.exe`、`ga-hub-update.exe`、`sidecar/ga-hub-sidecar.exe` 及 `_internal/` 均被本次构建刷新，继续执行 `sidecar/ga-hub-sidecar.exe --selftest` 与 `ga-hub-update.exe --help`。

#### W4.2 极简 Rust 绿色更新体系（取代旧 9 模块 Python 更新器 + 计划任务）
- **废弃与移除**：
  - 删除 10 MB PyInstaller 打包脚本 `scripts/build_update_helper.py`、`scripts/update_helper_entry.py`、`scripts/install_update_task.ps1`、`server/update_helper.py`。
  - 精简/合并原 `server/services/update_*.py`（9 个模块收敛为 2 个精简模块：`update_client.py` 负责版本检查/下载/校验/解压到候选目录 + `update_state.py` 负责简洁状态机 `idle → downloading → ready → switching → idle/failed`），彻底取消 Windows 计划任务、60 秒强制倒计时与 `request`/`approve` 多步审批仪式。
- **新 Rust 更新助手（`src-tauri` Cargo workspace 新增轻量 `ga-hub-update` binary，~500 KB）**：
  - **纯绿色、免安装、不写注册表**，只管理 `~/.genericagent-admin/updates/` 下的 `versions/<ver>/` 与 `current.json`（及上一版本 `previous` 指针）。
  - **支持双来源**：
    1. **GitHub Releases 自动检查与下载**：读取 Release `manifest.json`（含版本、ZIP 哈希/签名与文件清单），后台下载并校验后解压至 `versions/<ver>/`。
    2. **本地构建 ZIP 直接导入**：用户在设置页选择本地 `GA-Hub-<ver>-windows-x64.zip`，走同一套清单校验与解压流程。
  - **一键“重启并更新”流程**：
    1. 后台校验与解压就绪后，UI 展示单一按钮**「立即重启并更新」**。
    2. 用户点击后，主程序通过 `CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW` 拉起 `ga-hub-update.exe switch --plan <id> --wait-pid <desktop_pid>`，随后主程序正常优雅关闭。
    3. Rust 助手等待旧主进程与 sidecar 退出（最多 5s，超时按 Job/PID 兜底）→ 原子写入新 `current.json` → 启动新版 `ga-hub-desktop.exe` 并轮询其就绪回执（最多 30s）。
    4. **自动回滚**：若新版启动崩溃或 30s 未就绪，Rust 助手立即终止残余新版进程、原子恢复旧 `current.json` 并重新拉起旧版桌面端，同时写入清晰失败原因供设置页展示。
  - **升级过渡说明**：从旧版 `DATA_EPOCH = 1`（三文件 `--onefile`）升级到 `DATA_EPOCH = 2`（`--onedir`）需手动解压替换一次绿色目录（`~/.genericagent-admin` 内全部用户配置、对话、Agy profile 100% 原样继承），此后所有新版之间均享有一键秒级更新与自动回滚。

#### Wave 4 验收标准
- 同步更新 `AGENTS.md`、`docs/BUILD.md`、`scripts/build_all.py`、`scripts/package_release.py`、`.github/workflows/desktop-build.yml` 及全部构建/更新契约测试。
- 执行 `python scripts\build_all.py --full` 返回码 `0`，完成两轮真实绿色目录切换验收（正常一键升级 + 故意损坏候选版触发自动回滚）。

---

## 4. 风险清单与执行前提

1. **重建窗口期约束**：Wave 3 与 Wave 4 执行 `build_all.bat` / `python scripts\build_all.py --full` 前必须先退出当前运行中的 GA-Hub（含通过 Antigravity ACP 挂载的会话），避免产物文件锁导致预检 exit 2。
2. **契约测试防回归**：
   - Wave 1 改动路由后必须同步运行 `export_openapi.py` 与 `webui` `api:generate` / `api:check`。
   - Wave 3 移植 `messagePresentation` 前必须先落地双端黄金测试集，禁止“先删 Node 再补测”。
   - Wave 3 修改 `src-tauri/Cargo.toml` 时严禁触碰两处 `indexmap = { version = "1", features = ["std"] }`。
3. **本机工作区既有改动提醒**：基线 `62fcf82` 时刻工作区存在未提交改动 `src-tauri/Cargo.toml`，后续开工前需先核对该文件现有 diff，避免误覆盖。
