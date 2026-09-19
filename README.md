# GenericAgent Admin

**独立**的 Web 管理控制台，专门管理 [GenericAgent](https://github.com/lsdefine/GenericAgent) 项目。

> 🔒 **源码工程独立，管理写入透明**：本项目不修改 GenericAgent Core 源码；作为正式管理前端，
> 会在用户操作下修改 GA 的 Memory、配置和运行状态文件。Memory 保存带版本冲突检测、
> Hub 侧写前备份和原子替换，不会静默覆盖已检测到的外部修改。
>
> ⚙️ **运行时耦合说明**：本工具对主 Agent 高语义能力采用**进程内 bridge/helper**，
> Conductor 通过 HTTP/SSE 协作。因此运行行为仍依赖这些受控入口的兼容性；若上游做了
> 不兼容改动，可能需要同步升级本工具。两者的边界是「源码工程独立、授权管理写入、
> 受控运行时集成」，而非「完全无关的独立系统」。

## 它是什么

一个为 GenericAgent 提供的**现代化桌面管理界面**：

- 💬 **实时聊天**：直接和 Agent 对话，支持图片粘贴/拖放、会话恢复与 Turn 自动折叠
- 🤖 **微信机器人**：扫码登录、联系人列表、消息记录、手动发文/图/文件、白名单
- 🗂️ **对话管理**：浏览/搜索/重命名/删除/导出 GA 的全部历史会话
- 🧠 **记忆 & SOP**：可视化编辑 GA 的 `global_mem.txt` / `*_sop.md`
- 🌳 **技能库浏览**：查看 `memory/skill_search/`
- ⚡ **LLM 切换**：可视化切换链路
- 🌀 **自主进化增强**：自定义 idle/cron/interval 触发计划，浏览历史报告

## 一键安装与启动

桌面入口是 **Tauri 单栈**（pywebview 启动器已退役）。

### Windows

```cmd
install_webui.bat      :: 一次性装依赖 + 构建前端
build_all.bat          :: 一键交付构建：前端 → sidecar → Tauri 壳 → 产物守卫
start.bat              :: 启动桌面版（未构建时给出指引）
```

### macOS / Linux（浏览器模式）

```bash
cd GA-Hub
./install_webui.sh     # 一次性装依赖 + 构建前端
./start.command        # 启动后端；浏览器打开 http://127.0.0.1:8765
```

任何平台都可以跳过桌面壳，直接用浏览器模式：`python -m server.run`。

## 首次启动

启动后会用 **原生文件夹选择器** 让你选 GenericAgent 项目目录。

被识别的目录必须包含：
- `agentmain.py`
- `memory/`

选中后路径保存到 `~/.genericagent-admin/config.json`，下次启动会自动读取。

> 也可以提前用 `GA_ROOT=/path/to/GenericAgent ./start.command` 跳过选择步骤。

## 路径自动发现

如果你已把 GenericAgent 放在以下任一位置，启动时会**自动检测**到，无需手动选择：

- `~/Desktop/HH/GenericAgent`（推荐，与本项目并列）
- `~/Desktop/GenericAgent`
- `~/GenericAgent`
- `~/Documents/GenericAgent`
- `~/Code/GenericAgent`、`~/src/GenericAgent`
- 同级目录 `../GenericAgent`

## 数据存储

| 路径 | 内容 | 是否在 GA 目录里 |
|---|---|---|
| `~/.genericagent-admin/config.json` | 已配置的 GA 路径 | ❌ |
| `~/.genericagent-admin/conversations_v2/` | 会话归档（index.json + 各会话 JSON） | ❌ |
| `~/.genericagent-admin/autonomous_schedules.json` | 自主进化定时计划 | ❌ |
| `~/.genericagent-admin/autonomous_runs.jsonl` | 自主进化触发历史 | ❌ |
| `~/.genericagent-admin/tasks_schedules.json` | 定时任务计划 | ❌ |
| `~/.genericagent-admin/tasks_runs.jsonl` | 定时任务触发历史 | ❌ |
| `~/.genericagent-admin/scheduled_chats.json` | 定时对话触发器（按会话） | ❌ |
| `~/.genericagent-admin/session_metadata/` | 会话侧车元数据（标签/偏好，不含消息） | ❌ |
| `~/.genericagent-admin/conversation_metadata/` | 派生的会话标题（titles.json） | ❌ |
| `~/.genericagent-admin/gahub_journal/journal.jsonl` | Conductor 引擎持久化日志 | ❌ |
| `~/.genericagent-admin/email_config.json` | 邮件通知配置 | ❌ |
| `~/.genericagent-admin/ui_preferences.json` | 侧边栏导航可见性 | ❌ |
| `~/.genericagent-admin/wechat_log.jsonl` | 微信消息日志 | ❌ |
| `~/.genericagent-admin/logs/` | 后端日志（backend.log） | ❌ |
| `~/.genericagent-admin/mykey-backups/` | mykey.py 编辑前的备份轮转 | ❌ |
| `~/.genericagent-admin/memory-backups/` | Memory 每次实际写入前的原始字节备份 | ❌ |
| `~/.genericagent-admin/uploads/` | 前端粘贴/拖放的文件 | ❌ |
| `~/.wxbot/token.json` | 微信登录 token（与官方 wechatapp.py 共享） | ❌ |
| `<GA>/memory/` | 用户通过“记忆 & SOP”页面授权编辑的 Memory 文件 | ✅ |
| `<GA>/temp/wechat_media/` | 接收的微信媒体（GA 自己用） | ✅ |
| `<GA>/temp/autonomous_reports/` | Agent 自主任务的产出报告（沿用 SOP 约定） | ✅ |

> `<GA>/memory/` 可能包含 Git 跟踪文件，保存后应像普通源码改动一样审阅、提交或暂存。
> `<GA>/temp/` 下两类运行时数据通常由 GA 的 `.gitignore` 忽略。

## 常见问题

**Q: 我的 GenericAgent 用 git 同步，会被覆盖吗？**
GA-Hub 不修改 GA Core 源码，但你在管理界面保存 Memory 或配置时会产生真实文件改动。
Memory 保存会检测版本冲突并先备份；执行 `git pull` 前仍应先检查 `git status`，提交或暂存本地改动。

**Q: 我可以同时管理多个 GenericAgent 项目吗？**
当前是单 GA 配置。如需切换，进入"设置"页选择新目录并重启。

**Q: 我能不能不用桌面窗口，只用浏览器？**
可以。`python -m server.run` 然后浏览器打开 `http://127.0.0.1:8765`。

**Q: 端口被占了？**
后端默认 `127.0.0.1:8765`，并会在 8766（端口+1）绑一个单实例锁。
`lsof -iTCP:8765 -iTCP:8766 -sTCP:LISTEN` 找到 PID 然后 `kill -9 <PID>`；
或者改 GA 目录 `mykey.py` 里 `webui_port=...`（如果 GA 配了的话）。

**Q: 启动后提示"Desktop app not built yet"？**
桌面版需要先构建一次：运行 `build_all.bat`（Windows）。之后 `start.bat` 会直接启动它。

**Q: 浏览器模式下保存 GA 目录后要重启？**
浏览器模式请手动重启后端（Ctrl+C 后重新执行启动命令）。Tauri 桌面版在设置页保存后会出现「重启后端」按钮，点击即原地重启，无需关窗。

## 开发模式（前端热更新）

```bash
# Terminal 1
python -m server.run

# Terminal 2
cd webui
npm run dev   # → http://localhost:5173
```

## 本地检查

改动提交前建议跑完整检查：安装 Python 开发依赖、运行后端 pytest、前端类型检查、前端生产构建。

```bash
# macOS / Linux
./check.sh
```

```cmd
:: Windows
check.bat
```

也可以手动分步执行：

```bash
python -m pip install -e ".[dev]"
python -m pytest -q
cd webui
npm run lint
npm run build
```

## 实时聊天的恢复协议

实时聊天以 **GA 原始 archive 为唯一持久消息正文真源**。GA-Hub 的 session
sidecar 只保存标题、模型、状态和 archive 定位信息，不复制或持久化聊天正文。

LiveChat 使用以下 session-scoped 链路：

1. 进入或切换会话时，通过 `GET /api/sessions/{id}/messages` 从 archive 的只读投影水合历史；
2. 发送、查询运行状态和停止分别使用 session HTTP API；
3. `WS /ws/sessions/{id}?after_event_id=<event_id>&epoch=<epoch>` 仅接收该会话的实时事件；
4. 首次连接返回当前 runtime/active-message snapshot；重连游标仍在保留窗口内时补发 replay；
5. 服务重启、游标超前或保留窗口已过时返回 `resync_required`，客户端清除旧游标并重新执行 HTTP 水合，然后建立新水位。

事件游标仅保证**当前服务进程、单实例 EventBus、有限内存保留窗口**内的增量恢复；
它不是跨进程持久化日志。当前部署边界仍是本机回环、单 worker；聊天执行统一经过
SessionCoordinator 准入（网页会话与微信/自主/定时等系统会话走同一扇门）。
abort 超时会保守地继续占用活动槽并提示重启服务，避免旧 worker 与新 run 并发污染。

兼容边界：LiveChat 新功能只使用 session HTTP + session WebSocket，session WS
是 receive-only。旧全局 `/ws/chat` 已随双聊天链路合并删除；强认证、多 worker、
跨重启续跑和完整消息分页不属于当前协议保证。

## 目录结构

```
GA-Hub/                              # 本项目 — 完全独立
├── pyproject.toml
├── README.md
├── install_webui.sh / .bat          # 一键装依赖 + 构建前端
├── build_all.bat / .command         # 一键交付构建（前端→sidecar→Tauri→产物守卫）
├── start.bat / start.command        # 双击启动（Windows=Tauri 桌面版；macOS/Linux=浏览器模式，桌面壳未交付）
├── scripts/
│   ├── build_all.py                 # 交付构建链核心逻辑
│   └── export_openapi.py            # OpenAPI 契约导出（docs/api/openapi.json）
├── server/                          # FastAPI 后端
│   ├── _paths.py                    # 路径发现 + 配置（关键）
│   ├── main.py                      # 应用装配（setup mode / normal mode）
│   ├── run.py                       # CLI 入口（浏览器模式）
│   ├── desktop_sidecar.py           # Tauri sidecar 入口（生命周期协议）
│   ├── routes/                      # 业务路由（agent / sessions / conductor / ...）
│   └── services/                    # 业务服务（agent / event_bus / scheduler / ...）
├── webui/                           # Vite + React + TS 前端
│   ├── src/
│   │   ├── api/                     # client + 类型
│   │   ├── components/              # ImagePasteInput / MessageBubble / ...
│   │   ├── pages/                   # Settings + 10 个业务页
│   │   └── ...
│   └── dist/                        # 构建产物（自动被后端挂载）
└── src-tauri/                       # Tauri 2 桌面壳（唯一桌面入口）
    └── src/main.rs                  # sidecar 生命周期 + 无缝重启
```

## License

MIT
