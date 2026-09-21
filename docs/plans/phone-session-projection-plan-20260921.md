# 手机端会话投影方案分析（2026-09-21）

> 目标：手机端 ① 读取 GA-Hub 各会话 ② 继续对话 ③ 远程指导进行中任务。
> 结论先行：可行，且官方通道已"半通"。主推 **方向 A：把每个会话投影成官方 hub 的一个 peer**——手机零改造、零新增网络暴露，直接命中 ①+②；③ 见 G3 限制与 v2 路线。

## 1. 现状（已实测的硬事实）

### 手机侧能看到什么
- 官方 hub 数据模型只有两层：**peers**（注册的设备/进程）× 每个 peer 一份**任务流**（task=一次 put，outputs=该任务的各步骤文本）。没有"会话/聊天"对象（GA 仓 `frontends/hub.py` 仅 262 行）。
- 手机 app = hub.html 同构 UI：peer 列表 → 点入 → 消息流（输入=气泡、输出=可折叠步骤）+ 输入框 + 停止/llm 切换；数据面 = peers / messages / seg / put / abort / llms / llm。
- 传输：本地 19736(bus)/19737(web) → `/pair` 配对 → WebRTC 直连或官方加密中继（E2E，密钥只在手机）；hub 与手机之间已有全套鉴权，**不需要动网络**。
- 实况：手机上唯一 peer = `gahub-<pid>`（sidecar 主服务），名下只有一条 L4 定时任务流——因为桥按设计只申报"单点窄控制面"。

### GA-Hub 侧有什么
- 24 个会话 = 独立 GA 原生档案（`archive_path`）+ 按会话的隔离运行时；有 sessions/messages/conversations/events 全套 API；`read_archive_messages()` 把档案解析成消息序列 `{role, content, ordinal, timestamp}`。
- `SessionCoordinator` 提供无头原语（全部已有 HTTP 路由在用）：
  - `submit(text, session_id=…, source=…, images=…, llm_key=…)` —— **冷启动**该会话运行时并投喂消息（=继续对话）；
  - `side_question(session_id, q)` —— 运行中旁路问答（btw）；
  - `abort_if_current(session_id)`、`runtime_state(session_id)`。
- 现桥（GA 仓 `frontends/gahub/bridge/official_hub.py`）只做了"主服务单个 peer"：put 闭包 → `service.submit(source="hub")`，忙→`busy/409`；attach 单点绑定 + 换绑事务保护。

### 为什么不一致
hub 的世界观 = 「进程 × 任务流」，GA-Hub 的世界观 = 「会话 × 对话档案」。桥只把主服务挂进去，会话体系从未进入注册面 → 手机只见"定时任务"。这是**结构错位，不是 bug**。

## 2. 方向 A：会话 → 多 peer 投影（推荐）

### 设计
新增一个投影服务（GA-Hub server 侧新模块，不碰现有单点桥）：
1. **注册**：为每个非 system 会话建一个 `HubClient`，`fixed=True`、name=`gh-<sid[:8]>`（稳定身份，重启不变）。注意：官方 `hub.connect()` 不暴露 fixed/state/on_ev/sub，**须直接实例化 `HubClient` 类**（两者都在 262 行的 hub.py 里）。
2. **四钩子映射**：

   | hub 钩子 | 会话语义实现 |
   |---|---|
   | get_outputs | 读档案 → 轮次投影：user 消息=input，后续 assistant 消息=outputs 步骤；取最近 N 轮；按内容 revision 缓存 |
   | put_task | `coordinator.submit(text, session_id, source="hub")`（内置冷启动）；忙→`{'error','code':'busy'}`→409 |
   | abort | `coordinator.abort_if_current(session_id)` |
   | state | `runtime_state()` → `{'run': 是否在跑}` |

3. **生命周期**：随会话存储事件 attach/detach（新建→新 peer；删除→下线）；主服务 peer 保留（定时任务值守面不动）。
4. **显示**：手机 peer 标题由 hub 自动取"最后一条任务 input"= **该会话最近一条用户消息**（天然聊天预览）；历史消息=轮次任务流（观感≈"用户气泡+折叠助手步骤"，hub.html 同款）。

### 能力命中
- **G1 读会话 ✅**：列表=会话清单（24+1），点开=历史轮次，可滚动/分段拉取。
- **G2 继续对话 ✅**：输入框→put→同会话续跑（空闲自动唤醒、忙时 409 提示"运行中"），跑完落档案→下次刷新可见新轮次。闭环。
- **G3 远程指导 ⚠️ 部分**：
  - 运行中**可看** run 旗标 + 已完成轮次进度；
  - **不可**（官方协议无运行中注入通道）：中途插话。可选路径：①等本轮结束再发；②中止(abort)后重发修正指令；③v2 增强：put 遇忙→`side_question` 旁路问答，把 Q&A 回显为运行中任务的附加步骤（借 GA-Hub btw 能力，"准插话"）。
- 实时性：v1 以轮次为单位（poll 刷新）；v2 可加 turn-end 事件 emit + 运行中增长步骤（active_message_snapshot）准实时。

### 风险与未知（为什么先冒烟）
- 手机 app 对**多 peer** 的 UX 未验证：列表长度 24+、排序、刷新节奏、折叠行为、put 后表现——决定产品形态（全量投影 or 最近活跃 K 个）。
- 投影语义=任务流形态（非原生聊天），接受度需真机看。
- 大档案窗口化策略（最近 N 轮、分页）。
- 验证手段：本机 `http://127.0.0.1:19737/` hub.html = 手机同款数据面，桌面浏览器先回归；然后真机。

### 成本
- Phase 0 冒烟：0.5–1 天（直建 2 个 peer：1 假数据演示 + 1 真会话，手机上看形态）
- Phase 1 核心：2–3 天（投影服务+四钩子+生命周期+契约测试+打包 rebuild）
- Phase 2 体验：1–2 天（事件推送/增长步骤/排序过滤/窗口化）
- Phase 3 可选：btw 映射、llm 切换映射到会话模型

## 3. 方向 B：把 GA-Hub 自身 WebUI 送上手机（全保真备选）

- **B1 局域网直连**：放开 host + **新增 auth**（当前 backend 强制 loopback 且无 token，任何远程暴露前必须先过这关）；手机同网浏览器用完整 webui。
- **B2 远程**：自建隧道（Tailscale / Cloudflare Tunnel，已有 CF）→ 全功能（流式、btw、会话管理、全部页面）。SSE/WS 经隧道可用。
- 代价：auth+host 改造 2–3 天 + 网络运维；手机 webui 体验未验证（desktop-first 布局）。
- **已排除**：复用官方 p2p 中继渲染 webui——中继协议是 app 专用的自定义 WS（非 HTTP 隧道），需自写客户端，投入产出不成比例。

## 4. 推荐路线

A 为主线（直接命中"读会话+续聊"、零暴露面、零手机改造），B 作为"要全保真时"的后续选项（先 B1 后 B2）。
推进：**Phase 0 冒烟（半天，先让手机上出现"会话"试形态）→ 用户确认形态 → Phase 1 立项实现**。

## 5. 决策点

1. 按 A 线推进？先做 Phase 0 冒烟验证手机多会话 UX？
2. 会话范围：全部（24+）or 最近活跃 K？
3. 要不要并行评估 B（全保真 webui 上手机）？

## 6. 实现锚点（关键文件/行为）

- `GA/frontends/hub.py`：HubClient 类(L19，fixed/state/on_ev/sub 仅此处)；hello(L62)；`_build`(L82-98，title=最后 input)；seg 增量 tail(L105)；busy→409 映射(L160)。
- `GA/frontends/gahub/bridge/official_hub.py`：put 模板(L96-108)；attach 守卫(L111-173)（新投影服务旁挂，不照抄单点约束）。
- `GA-Hub server/routes/sessions.py`：submit_run(L515-534)；btw(L537-556)；abort(L652+)；messages(L431+ 窗口读取)。
- `GA-Hub server/services/session_coordinator.py`：RuntimeHandle{submit/btw/active_message_snapshot}；coordinator{side_question/abort_if_current/runtime_state}。
- `GA-Hub server/services/archive_messages.py`：`_items_from_messages`(L165-184) → 投影数据源。
- 代码归位：GA 仓 git 跟踪 `frontends/gahub`（19 文件）；GA-Hub server 经 GA_ROOT 引用；投影服务建议放 GA-Hub server 侧，两仓边界不变（hub 依然不反向 import gahub）。交付走 `build_all.bat` 重建 sidecar。


---

## 7. 实施设计与修改面（定稿 2026-09-21）

> 用户已选定 A 线。本节为实现基线；关键面均已实盘核证（§6 锚点 + 本轮补充）。

### 7.1 架构一句话
GA-Hub 主后端进程内新增「会话投影服务」：把每个用户会话投影为官方 hub 的一个 peer（`gh-<id前8>`），四个钩子全部映射到既有权威面——读=档案轮次折叠、写=coordinator.submit、停=abort_if_current、状态=runtime_state。GA 仓零改动；既有单点桥（`gahub-<pid>`，定时任务值守面）原样保留、并行共存。

### 7.2 修改面清单（完整）
| # | 文件 | 动作 | 内容 | 量级 |
|---|---|---|---|---|
| 1 | `server/services/hub_session_projection.py` | 新增 | 投影服务核心（对账器 + 每会话 peer + 折叠 + 缓存 + 启停） | ~380-450 行 |
| 2 | `tests/test_hub_session_projection.py` | 新增 | 单测 + 真实 hub 模块契约测试 | ~300 行 |
| 3 | `temp/hub_projection_smoke.py` | 新增(临时/不入库) | Phase0 冒烟脚本（1 假 peer 演示 + 1 真会话） | ~150 行 |
| 4 | `server/main.py` | 修改 | `_startup()` 末尾（L406 后）启动；`_shutdown()` 开头停止 | 共 +10~12 行 |

- **明确不碰**：GA 仓全部（hub.py / official_hub.py / p2p / gahub 其余）；GA-Hub 的 routes、session_coordinator、session_metadata、archive_messages、agent_service、app_services、前端 webui、打包脚本。
- 打包：懒加载 import 与现有 L323-328 懒加载模式一致，PyInstaller 静态收集可覆盖；Phase1 出口含 `build_all` 重建 sidecar 冒烟验证。

### 7.3 接线（main.py 两处，均 try/except 降级）
启动（`_startup()` 末尾，L405-406 legacy title 迁移之后）：
```python
try:
    from .services.hub_session_projection import start_hub_session_projection
    start_hub_session_projection()
except Exception:
    log.exception("hub session projection start failed")
```
停止（`_shutdown()` 开头，admission gate 之前；未启动为 no-op）：
```python
try:
    from .services.hub_session_projection import stop_hub_session_projection
    await asyncio.to_thread(stop_hub_session_projection)
except Exception:
    log.exception("hub session projection stop failed")
```

### 7.4 投影规则（数据语义，均已实盘核证）
- **会话范围（默认）**：`kind ∈ {"user", None}`（legacy 行按 user 处理）——实盘 = 24 个；`kind == "system"`（如 `system-scheduled_tasks`）默认不上（webui 列表本就隐藏 system；定时任务已有桥值守面）。`GAHUB_HUB_PROJECTION_INCLUDE_SYSTEM=1` 可纳入。
- 排除纯档案行：`is_archive_metadata_id(id)`（标题残留行，无运行时）。
- 上限 50（`GAHUB_HUB_PROJECTION_MAX`）。
- **轮次折叠**：`read_archive_messages(path, limit=K)` 取尾部窗口（K 默认 40 项）→ `role=user` 开新 task（input=content）；`role=assistant` 追加 steps；窗口首为 assistant 时归入 input="" 的 task（与 hub `_build` 的 title=最后非空 input 天然兼容）。
- **命名**：`gh-<session_id[:8]>`，`fixed=True`（稳定条目，重启不换名）。双后端并存竞合见 §7.7；env `GAHUB_HUB_PROJECTION_SUFFIX` 供开发实例避让。

### 7.5 四个钩子（全部薄封装 + 兜底）
| 钩子 | 实现 | 错误映射 |
|---|---|---|
| `get_outputs` | ①stat 签名 (mtime_ns,size) 比对，未变→返回缓存（零 IO）②变则 `read_archive_messages(limit=K)` 折叠 ③异常→上次缓存或 `[]`，绝不外抛 | 无（空即空） |
| `put_task(text)` | worker 线程 `coordinator.submit(text, session_id=sid, source="hub")`（含冷启动）；join ≤14s 超时先回 ok（后台续跑记日志；hub ask 约 15s 弃响应） | 忙（AgentBusyError / SessionControlBusyError）→ `{'error':msg,'code':'busy'}`；其余→ `nosupport` |
| `abort` | `abort_if_current(session_id=sid)`；`SessionNotActiveError` → `{'ok':1}`（幂等） | 异常→错误码；正常 `{'ok':1}` |
| `state` | `peek_coordinator()`（**不构造**）；None→`{'run':False}`；否则 `runtime_state(sid).status != STATUS_IDLE` → `{'run':bool}` | 异常→ `{'run':False}` |

依赖获取（均既有面 + 仓内先例）：
- 协调器：函数内懒 `from .routes.sessions import _get_coordinator, peek_coordinator`（先例：conversations.py:330 同款懒 import）。
- 会话存储：自建 `SessionMetadataStore()` 实例（先例：conversations.py:65 / tokens.py:17；`_shared_store_lock` + 跨实例缓存槽，安全）。

### 7.6 性能预算（硬约束，来自 hub 实测）
- hub 服务端对 peer 轮询 `ask(timeout=3s)`，失败进 `pdead` 15s（**手机列表消失**）→ `get_outputs` 必须"stat 未变即回缓存"，仅变更时一次尾窗读取；启动对账时**全量预热**（首屏零懒加载）。
- 断线自愈：客户端 5s 重连（hub.py `_loop`）；服务端 `peers.get(name) is ws` 守卫防旧连接捣乱（hub.py L204 附近）。
- 每 peer 一个 WS+线程：24 个≈24 条本地回环连接，成本可忽略。

### 7.7 已知边界（记录，不阻塞）
- 双后端（dev + 打包）同跑：同名 fixed peer 后连者占位；前者连接悬空不重连→其下线后条目暂缺至重启。缓解：Suffix env（开发侧加后缀）。
- 官方 App 对多 peer 列表的排序/上限未知 → Phase0 真机实测（本轮实盘 24 个候选）。
- 运行中插话（G3 完整态）v1 不支持：给"等轮末/先止后发"；v2 走 put 忙→`side_question`。

### 7.8 测试与验证阶梯
1. 单测：折叠纯函数 / 缓存命中不重读 / 对账 attach-detach 与过滤 / 错误映射。
2. 契约：测试内加载**真实 GA hub 模块**（复用 `_load_real_hub_module` 先例），断言钩子输出被 `_build` 接受、服务端收发闭环。
3. 回归：GA-Hub 全量 pytest 无红。
4. 人测：本机 hub.html（`http://127.0.0.1:19737/`，手机同款数据面）→ 手机真机（读/续聊/中止/复核）→ `build_all` 重建 sidecar 冒烟。

### 7.9 里程碑
- **P0（0.5-1d）**：冒烟脚本直连本机 hub，手机看 UX 形态（假 1 + 真 1 会话）；出口 = 用户对 UX 拍板（命名/列表长度/折叠/发送与停止）。
- **P1（2-3d）**：服务落地 + 测试 + 桌面/手机全验 + build 冒烟；出口 = 手机实操一轮真实任务通过。
- **P2（后置）**：事件驱动即时更新（取代 20s 对账延迟）/ put 忙→`side_question` 运行中插话 / llm 切换、项目过滤等增强。
