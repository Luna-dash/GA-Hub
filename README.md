# GenericAgent Admin

**独立**的 Web 管理控制台，专门管理 [GenericAgent](https://github.com/lsdefine/GenericAgent) 项目。

> 🔒 **零侵入**：本项目与 GenericAgent 仓库**完全分离**，从不写入 GA 目录。
> 你可以随时在 GA 目录下 `git pull` 拉取上游更新，本管理工具完全不受影响。

## 它是什么

一个为 GenericAgent 提供的**现代化桌面管理界面**：

- 💬 **实时聊天**：直接和 Agent 对话，支持图片粘贴/拖放，Turn 自动折叠
- 🤖 **微信机器人**：扫码登录、联系人列表、消息记录、手动发文/图/文件、白名单
- 🗂️ **对话管理**：浏览/搜索/重命名/删除/导出 GA 的全部历史会话
- 🧠 **记忆 & SOP**：可视化编辑 GA 的 `global_mem.txt` / `*_sop.md`
- 🌳 **技能库浏览**：查看 `memory/skill_search/`
- ⚡ **LLM 切换**：可视化切换链路
- 🌀 **自主进化增强**：自定义 idle/cron/interval 触发计划，浏览历史报告

## 一键安装与启动

### macOS / Linux

```bash
cd GA-Hub
./install_webui.sh    # 一次性装依赖 + 构建前端
./start.command       # 启动；之后双击 start.command 即可
```

### Windows

```cmd
install_webui.bat
start.bat
```

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
| `~/.genericagent-admin/autonomous_schedules.json` | 自主进化定时计划 | ❌ |
| `~/.genericagent-admin/autonomous_runs.jsonl` | 触发历史 | ❌ |
| `~/.genericagent-admin/uploads/` | 前端粘贴/拖放的文件 | ❌ |
| `~/.wxbot/token.json` | 微信登录 token（与官方 wechatapp.py 共享） | ❌ |
| `<GA>/temp/wechat_media/` | 接收的微信媒体（GA 自己用） | ✅ |
| `<GA>/temp/autonomous_reports/` | Agent 自主任务的产出报告（沿用 SOP 约定） | ✅ |

> 上面 ✅ 的两类是 **agent 运行时数据**，本来就归 GA 自身管理；
> 它们已在 GA 的 `.gitignore` 中被忽略，`git pull` 不会冲突。

## 常见问题

**Q: 我的 GenericAgent 用 git 同步，会被覆盖吗？**
不会。本项目不动 GA 目录里的任何文件。你随时可以 `git pull`。

**Q: 我可以同时管理多个 GenericAgent 项目吗？**
当前是单 GA 配置。如需切换，进入"设置"页选择新目录并重启。

**Q: 我能不能不用桌面窗口，只用浏览器？**
可以。`python -m server.run` 然后浏览器打开 `http://127.0.0.1:8765`。

**Q: 端口被占了？**
`lsof -iTCP:8765 -iTCP:8766 -sTCP:LISTEN` 找到 PID 然后 `kill -9 <PID>`，
或者改 `mykey.py` 里 `webui_port=...`（如果 GA 配了的话），
或者设环境变量启动：`WEBUI_PORT=9000 ./start.command`。

**Q: 启动卡在"正在打开文件夹选择器…"？**
这是 pywebview 在等你选目录。请看你的 dock/任务栏，找到 macOS 的 Finder
对话框选择 GenericAgent 目录即可。

## 开发模式（前端热更新）

```bash
# Terminal 1
python -m server.run

# Terminal 2
cd webui
npm run dev   # → http://localhost:5173
```

## 目录结构

```
GA-Hub/                              # 本项目 — 完全独立
├── pyproject.toml
├── README.md
├── install_webui.sh / .bat          # 一键装依赖 + 构建
├── start.command / start.bat        # 双击启动
├── launch_webui.pyw                 # 启动入口（pywebview 原生窗口）
├── server/                          # FastAPI 后端
│   ├── _paths.py                    # 路径发现 + 配置（关键）
│   ├── main.py                      # 应用装配（setup mode / normal mode）
│   ├── run.py                       # CLI 入口
│   ├── routes/                      # 业务路由（agent / wechat / conv / memory / autonomous / setup / ...）
│   └── services/                    # 业务服务（agent / wechat / autonomous / event_bus）
└── webui/                           # Vite + React + TS 前端
    ├── src/
    │   ├── api/                     # client + 类型
    │   ├── components/              # ImagePasteInput / MessageBubble / ...
    │   ├── pages/                   # Settings + 8 个业务页
    │   └── ...
    └── dist/                        # 构建产物（自动被后端挂载）
```

## License

MIT
