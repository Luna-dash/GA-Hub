# TUI v3 vs GA-Hub WebUI 功能差距清单

> 生成日期：2026-05-28
> 对比基准：
> - **TUI v3**：`D:\study\GA\frontends\tui_v3.py`（216 KB，textual / prompt-toolkit 终端前端）
> - **WebUI**：`D:\study\GA-Hub`（server/routes/ + webui/src/pages/ + components/）
>
> 两者都是 GA 本体（`ga.py` / `agentmain.py`）的前端壳，本文档聚焦于"TUI v3 有而 WebUI 没有对应"的功能。

图例：✅ 已实现 ・ 🟡 部分实现 / 形态变了 ・ ❌ 完全缺失

---

## 一、Slash 命令 / 核心交互

| TUI v3 命令 | 含义 | GA-Hub 对应 | 状态 |
|---|---|---|---|
| `/help` | 命令面板 / 帮助列表 | `Cmd/Ctrl+K` CommandPalette（搜索式启动器） | ✅ 形态不同但更强 |
| `/new [name]` | 新建会话 | `POST /api/agent/new`、LiveChat `/new` 命令、CommandPalette "新建对话" | ✅ |
| `/clear` | 仅清显示，不动 LLM 历史 | LiveChat 里只有"新建对话"（会清 LLM 上下文） | ❌ **没有"只清前端不动后端"** |
| `/sessions` | 列出所有会话 | Conversations 页 + `/api/agent/sessions` | ✅ |
| `/continue [n\|name]` | 列出 / 恢复历史会话 | `POST /api/agent/sessions/{idx}/restore`、Conversations.restore | ✅ |
| `/rename <name>` | 重命名当前会话 | Conversations 列表里的 ✏ 按钮（`api.renameConversation`） | 🟡 **只能在会话管理页改，LiveChat 内没有内联重命名** |
| `/rewind [n]` | 回退最近 n 轮（移除 n 条历史） | `agent_service.py` 里 grep 不到 rewind | ❌ **后端 + 前端都没有**（高价值，TUI 用户依赖此功能纠错） |
| `/stop` | 中止当前任务 | `POST /api/agent/abort` + LiveChat 中止按钮 + Esc | ✅ |
| `/cost` | 当前会话 token 用量 | 后端无 cost API；前端无显示 | ❌ **完全缺失** |
| `/llm [n]` | 查看 / 切换模型 | Llms 页 + LiveChat header picker + `POST /api/llms/switch` | ✅ |
| `/status` | 会话状态 | Sidebar 角标 + Dashboard | ✅ |
| `/export [clip\|file\|all]` | 导出最后回复（剪贴板/文件/日志路径） | `GET /api/conversations/{cid}/export` 整会话 md/json | 🟡 **只能整会话导出；无"只导最后回复 / 复制到剪贴板 / 取日志路径"** |
| `/verbose` | 工具调用审计面板（↑↓选, Enter 切换, c 复制） | MessageBubble 显示 tool 调用，但**没有专门的审计面板/折叠浏览器** | 🟡 |
| `/btw <q>` | **旁问 — side-agent 不打断主 agent** | 后端 `agent_service.py` 没有 btw / side-agent；前端无入口 | ❌ **完全缺失**（TUI Tip 反复推荐） |
| `/review [request]` | **in-session 代码审查（直接出报告）** | 无 | ❌ |
| `/language [code]` | 切换界面语言 | 全站硬编码中文 + 无 i18n 框架（仅 cronstrue 按 navigator.language 自动） | ❌ **没有语言切换器** |
| `/quit` | 退出 | 浏览器关 tab；托盘菜单/exit 在 launch_webui 已实现 | ✅（语义不同） |

## 二、键盘 / 输入体验

| TUI v3 | WebUI 对应 | 状态 |
|---|---|---|
| `Esc` 撤回提问 / 清草稿 / 停任务 | LiveChat 中有"中止任务"，但没有"撤回最后一次提问"逻辑 | 🟡 |
| `Ctrl+O` 折叠/展开所有工具 chip（每个折成一行） | MessageBubble 渲染工具调用，但**没有全局折叠快捷键** | ❌ |
| `Ctrl+Z / Ctrl+Y` 输入框撤销/重做 | 浏览器 textarea 原生支持 | ✅ |
| `Ctrl+L` 强制重画（睡眠唤醒后修复） | Web 不需要 | N/A |
| `Shift+方向键` 选中文字 | 浏览器原生 | ✅ |
| 多行输入 `Ctrl+J / Shift+Enter`，`Enter` 发送 | LiveChat 已实现 Shift+Enter | ✅ |
| 粘贴图片/文件 → `[Image #N]` / `[File #N]` 占位符，退格整块删除 | `ImagePasteInput.tsx` 实现了上传；占位符语义+整块删除需复查 | 🟡 |
| `ask_user [多选]` → 自动切多选 picker | 无 askUser 多选 UI（grep 无结果） | ❌ **agent 互动里的多选回答没有 UI** |

## 三、面板 / 视觉

| TUI v3 | WebUI 对应 | 状态 |
|---|---|---|
| **计划模式（Plan mode）** "计划完成 (n/n)" / "计划模式已激活" | LiveChat / Conversations 都没显示 plan 进度 | ❌ |
| 工具调用审计独立面板 | 无独立面板，只在气泡里 | 🟡 |
| Tip 轮播（启动后底部 Tip 流） | 无 | ❌ |
| 单会话 scrollback / 多会话占位提示 | 多会话已实现 | — |

---

## 四、WebUI 反向多出的功能（TUI 没有）

对称记录，说明分工差异，不算缺失：

- 微信机器人（`WechatBot.tsx` + `routes/wechat.py`）
- 自主进化 / 周期性 schedule（`Autonomous.tsx` + `routes/autonomous.py`）
- 邮件通知 / Tasks 邮件配置（`Tasks.tsx` + `routes/tasks.py` + `services/notify_service.py`、`email_service.py`）
- MyKey 链路配置（API Key 多 session 编排，~40 KB 巨页）
- Memory & SOP 在线编辑（`routes/memory.py`）
- Skills 浏览（`Skills.tsx`）
- Conversations 归档 zip 浏览
- Dashboard / Settings / 主题切换
- 全局 CommandPalette（Cmd/Ctrl+K）

---

## 五、TODO 优先级（按价值排序）

### 🔴 高价值缺失（TUI 老用户最容易抱怨）

1. **`/rewind` 回退 N 轮** — 后端 + 前端都缺，纠错刚需
2. **`/btw` 旁问 side-agent** — TUI Tip 反复推荐，WebUI 完全没接
3. **`/cost` token 用量** — 后端无 API，前端无显示
4. **`/review` in-session 代码审查** — 无入口

### 🟠 中价值缺失

5. **`/language` 语言切换** + 引入 i18n 框架
6. **`/clear` 只清显示不清后端** — 现在只有"清空 + 新建会话"，无法保留 LLM 上下文只刷视图
7. **`/export` 子模式** — 只导最后回复 / 复制到剪贴板 / 给日志路径
8. **askUser 多选 picker** — agent 主动询问时多选回答的 UI
9. **工具调用审计面板** + **`Ctrl+O` 全局折叠工具 chip**
10. **计划模式进度条** "计划 (done/total)" 显示

### 🟡 低价值 / 形态不同

11. LiveChat 内联 `/rename`、内联 `/sessions` 切换（现在要去 Conversations 页）
12. Esc "撤回最后一次提问"语义
13. 启动 Tip 轮播

---

## 六、复查记录 / 已澄清的误判

### 6.1 PowerShell 显示乱码 ≠ 文件乱码
- **SidebarNav.tsx / CommandPalette.tsx 文件本身是正常 UTF-8**，没有 mojibake。
  - 之前 PowerShell `Select-String` 显示出 `浠琛ㄧ` `寰淇℃満鍣ㄤ` 等错码，是 PS 默认编码读 UTF-8 文件的**控制台显示乱码**，与文件内容无关。
  - 用 `file_read` 直读已验证（SidebarNav.tsx 第 7-17 行 / CommandPalette.tsx 第 110-118 行）。
  - 教训：以后核查源码编码用 `file_read` 或 `[System.IO.File]::ReadAllBytes` + `UTF8.GetString`，不要相信 `Select-String` 的 line 字段。

### 6.2 "为什么 GA-Hub 后端缺这些功能"的根因（2026-05-28 查证）
TUI v3 的高价值命令（`/btw` `/cost` `/review` `/conductor` `/rewind`）**并不是 TUI 壳层的本地逻辑**，GA core 全都有独立实现：

| 命令 | GA core 实现位置 | 性质 |
|---|---|---|
| `/btw` | `frontends/btw_cmd.py` + `chatapp_common.py` 里 `op == "/btw"` 分发 | 独立模块 |
| `/cost` | `frontends/cost_tracker.py`（按 `ga-tui-agent-<id>` 做 thread 查询） | 独立模块 |
| `/review` | `frontends/review_cmd.py` + inline prompt 文件 + `chatapp_common.py` 分发 | 独立模块 |
| `/conductor` | `frontends/conductor.py`（**这次合并 upstream 才新增**） | 独立模块 |
| `/rewind` | `frontends/tuiapp.py` 里 `truncate history`，底层是 history 操作 | 半壳层，可抽 |

**根因**：GA-Hub 的后端 `server/services/agent_service.py` 自实现了一套精简会话流，**绕过了 `frontends/chatapp_common.py` 的命令 dispatcher**，所以那些 `op == "/xxx"` 分支整片没接上。

**补接路径**（已确认）：
1. 在 `agent_service.py` 里加一层 dispatcher，复用 `frontends/chatapp_common.py` 的 op 路由
2. 或者更轻：直接 `import` 各 `*_cmd.py`，在 `/agent` 路由收到 `/btw xxx`、`/cost`、`/review` 时分发
3. `/rewind` 需要单独工作：把 `tuiapp.py` 里的 truncate 逻辑抽到 `frontends/history_ops.py` 之类的共享模块

## 七、参考源码定位

| 关注点 | 文件 |
|---|---|
| TUI v3 命令分发 | `D:\study\GA\frontends\tui_v3.py`（`/help` 字面量、`_cmd_language`、key_bindings） |
| **GA core 命令 dispatcher** | `D:\study\GA\frontends\chatapp_common.py`（`op == "/xxx"` 路由表，**GA-Hub 应复用**） |
| `*_cmd.py` 模块 | `D:\study\GA\frontends\{btw_cmd, review_cmd, continue_cmd, conductor, cost_tracker}.py` |
| 新增 slash_cmds 框架 | `D:\study\GA\frontends\slash_cmds.py`（2026-05 upstream 新增 530 行） |
| WebUI 命令面板 | `D:\study\GA-Hub\webui\src\components\CommandPalette.tsx` |
| WebUI 聊天页 | `D:\study\GA-Hub\webui\src\pages\LiveChat.tsx` |
| 会话管理 | `D:\study\GA-Hub\webui\src\pages\Conversations.tsx` + `server/routes/conversations.py` |
| Agent 服务（后端核心，待补接 dispatcher） | `D:\study\GA-Hub\server\services\agent_service.py`、`server/routes/agent.py` |
| 后端路由总览 | `server/routes/{agent,autonomous,conversations,events,logs,memory,mykey,notify,tasks,upload,wechat}.py` |

---

## 八、本次 GA 本体 upstream 合并新增（2026-05-28，50 commits）

合并后 HEAD = `26d2746`，备份 tag = `pre-upstream-merge-20260528-142721`。

新功能里**与 GA-Hub 后端缺口直接相关**的：

| 上游新增 | 说明 | 对 GA-Hub 的意义 |
|---|---|---|
| `/conductor` (`frontends/conductor.py`) | 多 agent 编排 | 第五节 TODO 自动新增一条 🔴 |
| `/resume` | 恢复中断的会话 | GA-Hub 的"会话归档→重连"语义可对齐 |
| `! shell magic` | `!` 打头直执 shell 命令 | LiveChat 输入框可加同款语法糖 |
| `frontends/slash_cmds.py`（+530 行） | **统一 slash 命令框架** | **优先复用它，而不是手抄 dispatcher** |
| `llmcore._fix_messages` 重写 | 消息修复逻辑 | agent_service 调用 llmcore 时自动受益，无需改 |
| `tuiapp_v2.py` +1457 行 / `tui_v3.py` +1059 行 | TUI 大量修复 | 不影响 GA-Hub，但 tui_v3 命令清单可能要回头复查一遍 |
| `memory/L4_raw_sessions/salient_mining_sop.md` | L4 salient mining | 与 Memory 编辑页有交集 |

> **结论调整**：第五节 TODO 不必从零造轮子，应优先评估 `frontends/slash_cmds.py` 是否能直接被 `agent_service.py` import / 复用。这条排在所有 🔴 之前作为"先做调研"。

