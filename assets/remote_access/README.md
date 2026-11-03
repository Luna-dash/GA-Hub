# GA-Hub 远程会话与指令

## 使用

1. 在运行 GA-Hub 的 Windows 电脑上保持 GA-Hub 打开、用户已登录且电脑不休眠。
2. 使用已配置的用户名和密码；凭据保存在 Windows 凭据管理器 `GA-Hub/remote-access/password`（`UserName` 为用户名，`CredentialBlob` 为密码），不写入源码。本机 **http://127.0.0.1:47832/** 面板仍只展示密码，不能轮换账号；该面板仅监听回环地址，不经过公网转发。
3. 在手机或另一台电脑打开 **https://gahub.lunadash.me/**，输入用户名和密码登录；表单使用标准 `username` / `current-password` 自动填充字段，支持浏览器密码管理器识别。登录 Cookie 有效期为 12 小时（网关重启需重新登录），退出会清除 Cookie。

侧栏按 GA-Hub 的实际绑定关系分类：绑定项目的会话归入对应项目，未绑定的归入「自由会话」；组标题显示类型和会话总数，项目路径可悬停查看。有项目分组时每组默认预览最近 3 条，当前会话始终保留，可展开全部或收起；搜索时展示所有匹配。支持标题/项目/路径搜索、全部/运行中/收藏筛选。收藏仅保存在当前浏览器，不修改本机会话。手机首屏为全屏会话列表，点击会话进入独立聊天视图；顶部返回按钮回到列表，支持浏览器前进/后退及会话直达链接。返回列表会清空当前聊天显示，但保留当前页面内的会话草稿；前进恢复会话时可继续编辑。聊天工具、模型选择、过程展开/收起、刷新和退出集中在底部工具抽屉。

手机适配验收（2026-10-31）：构建、11 项网关测试、聊天浏览器回归及 `check-mobile-flow.py` 均通过。验证首屏列表、工具抽屉、返回后轮询不恢复旧消息、前进恢复草稿、直达链接返回；320×568、390×844、430×932、844×390、390×420、1440×1000 均无横向溢出且输入区在视口内。修复 Markdown 表格对齐内联样式触发 CSP 的问题，未放宽安全策略。证据保留在 `temp/remote-access-20261031/mobile-flow-checks.json`、`mobile-flow-list.png`、`mobile-flow-chat.png`、`mobile-flow-tools.png`。验证使用桌面 Chrome 的移动/触控模拟和指定公网节点解析；缩小视口仅模拟键盘占用，不等于 iOS/Android 真机软键盘验收，也不证明所有运营商 DNS 可达。本轮未发送真实指令；控制台仅剩 favicon 404。

分类补充验收：公网数据中的 6 个项目组与 20 个自由会话逐组计数一致；预览、展开全部、当前会话可见、自由会话搜索、绑定项目标题、轮询保留折叠及桌面/手机无溢出通过，零 JS 异常。证据 `temp/remote-access-20261031/grouping-checks.json`，截图 `grouping-desktop.png`、`grouping-mobile.png`，回归脚本 `check-grouping.py`。

聊天区区分用户气泡和助手回复：正文支持 Markdown（表格、代码等），运行中逐轮显示轻量摘要和响应，完成后过程默认折叠；不向手机交付具体工具参数或结果。支持一键展开/收起过程、复制消息、回到最新消息。自动刷新尽量保留滚动与折叠状态。保留加载更早消息和运行状态；当前会话进度使用 WebSocket 推送，断线时自动重连并以快照校准，列表每 5 秒刷新。选择已有会话，在底部输入指令点击“发送指令”（或 Ctrl/Cmd+Enter）。运行时发送按钮切换为停止按钮，可请求停止当前运行；每条消息最多附加 8 个文件，每个文件不超过 20 MiB，附件可在发送前移除。这是本机会话的真实运行，不是留言：模型可按该会话权限调用工具、操作文件等；请勿分享登录密码。

会话忙碌时禁止提交新指令，不做排队。每条消息最多 6000 字符，可附加最多 8 个文件、每个文件不超过 20 MiB；发送按钮在运行期间变为停止按钮。支持从首页主标题栏的加号按钮新建会话：选择已有项目或「自由会话」，确认后自动进入。消息按纯文本展示，不执行消息里的 HTML。列表一次返回全部普通会话，系统内部通道默认不显示，历史消息按批加载。草稿仅保存在当前页面内存，切换会话保留、刷新页面不保留。

聊天顶部的「当前模型」下拉框可切换当前会话的模型，选择后自动保存，下条指令生效。运行期间不可切换；模型列表来自本机配置，可点击 ↻ 刷新。模型不存在或保存失败时会显示提示，刷新确认后再重试。

模型切换验收：11 项网关回归通过；公网浏览器验证 12 个模型、实际切换和刷新持久化、桌面及 390px 手机无横向溢出、零 JS 异常。测试会话已恢复原绑定。证据 `temp/remote-access-20261031/model-checks.json`、`model-desktop.png`、`model-mobile.png`，回归脚本 `check-model.py`。此轮未逐一调用各模型生成回复。

## 新建会话（2026-11-01）

首页主标题栏新增 SVG 加号按钮，点击打开项目选择弹窗，默认「自由会话」，也可选择本机已注册且有效的项目。确认后创建会话并进入聊天页；取消不创建。项目目录不接受浏览器任意指定，网关只接受本机项目白名单映射的不透明编号。

新增受鉴权及同源校验保护的 GET `/api/projects` 和 POST `/api/sessions`。创建请求保留同一 request_id 用于失败重试；项目绑定失败时保留已创建会话以继续绑定，避免重复创建。去重状态仅在当前网关进程内，网关重启或结果持续不明时应先查看列表。

验收：构建成功，27 项网关、11 项视图和 9 项产物安全回归全部通过。公网实际创建自由会话及 NOVA 项目会话，均自动进入并在列表可见；同 request_id 重试返回同一会话。320/390/430/1440px 明暗主题共 8 组无横向溢出，取消正常、无 JS 异常，公网 JS/CSS 与本地构建摘要一致。使用独立 Chrome 固定公网节点解析，不代表所有网络或真机均已验收；未发送模型指令。证据：`temp/remote-access-20261031/check-new-session.py`、`new-session-checks.json`、`new-session-*-mobile.png`。

## 明暗主题（2026-11-01）

点击首页左上角 Logo 切换主题，选择保存在当前浏览器。亮色保留淡褐纸感；暗色统一为中性近黑背景（`#0c0c0c`）、石墨灰面板及柔白文字，标题栏、输入框、项目分组、按钮、浮层遮罩和阴影共用主题变量，仅错误、警告与收藏保留语义色。

公网验收：线上 CSS 与本地 SHA-256 一致；320/390/430/1440px 明暗共 8 组无横向溢出，切换及刷新持久化、真实会话与模型面板通过，零 JS 异常。暗色主要正文/背景对比度 15.82:1，次要文字/输入底色 7.42:1；11 项视图回归通过。使用桌面 Chromium 固定公网节点解析，不等于真机及所有网络验收。证据保留在 `temp/remote-access-20261031/`：`check-black-theme.py`、`theme-black-checks.json`、`theme-black-*.png` 和 `theme-light-home-mobile.png`。浏览器测试等待 DOM 应使用 locator；当前 CSP 下字符串形式的 `wait_for_function` 会触发 unsafe-eval 限制，不应为测试放宽 CSP。

## 产出物展示与下载（2026-11-01）

助手最终回复中引用 `[FILE:文件路径]` 后，远程会话页会展示文件卡片：文件名、格式、大小及下载按钮。已有历史回复中的有效引用也能识别，每条回复最多显示 8 个文件。当前版本是文件信息展示及下载，不包含图片、PDF 或 Office 的页内预览。

- 当前仅允许 `D:/study/GA-Hub/temp` 和 `D:/study/GA/temp` 内的普通文件；推荐使用绝对路径。`temp/...` 相对引用仅在两个根目录中唯一匹配时有效，不开放任意磁盘路径。
- 单文件最大 256 MiB；隐藏目录、敏感命名、密钥/数据库等受限扩展、硬链接及越界链接不发布。此过滤不等于内容脱敏，发布前仍须确认文件内容适合交付。
- 下载必须登录，链接绑定当前登录和会话，最长有效 30 分钟；失效后刷新会话重新获取。文件删除或发生变化时旧链接拒绝下载。文件不上传第三方存储，本机必须在线且原文件仍存在。
- 强制附件下载，不执行文件内 HTML。文件卡只依据助手最终正文的引用生成，不依据用户输入或具体工具输出生成。

验收：33 项 Python 安全/网关回归与 11 项视图回归通过；公网真实历史展示 5 张文件卡，390px 移动模拟视口无横向溢出、零 JS 异常；实际点击下载 PNG 成功，文件名、响应长度与下载字节完全一致（2,716,487 字节）。线上 JS 与本地构建 SHA-256 一致。浏览器使用独立进程固定 EdgeOne 节点解析，不等于所有网络或 iOS/Android 真机均已验收。证据：`temp/remote-access-20261031/artifact-live-checks.json`、`artifact-live-mobile.png`。

回归命令：仓库根目录运行 `node assets/remote_access/test_remote_view.cjs`；在 `assets/remote_access` 目录运行 `python -m unittest test_artifacts test_gateway`。

## 链路和源码

`浏览器 → EdgeOne gahub.lunadash.me (HTTPS) → Cloudflare gahub.lunadash.cc.cd → Cloudflare Tunnel → 127.0.0.1:47831 → GA-Hub sidecar 动态端口`

- EdgeOne 站点：`zone-3svvagr3dk8s`，专用域名，免费证书自动托管。
- Cloudflare Tunnel：`6288bdea-280f-484f-81fb-98218afceb3b`；源站 Host 转为主域。
- `gateway.py`：密码登录、内存会话、读取白名单、精确文本/附件发送及运行停止入口，自动发现 `ga-hub-sidecar.exe` 回环监听端口。
- `remote.html` / `remote.js` / `remote.css`：独立会话读写页面，不依赖桌面 SPA。修改页面源模块后运行 `node assets/remote_access/build-remote.cjs`，生成页面和投影 worker bundle。
- `supervisor.py`：守护网关及 cloudflared；以端口 47833 防重复启动。
- 自启动：当前用户 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 的 `GAHubRemoteAccess`。这是**用户登录启动**，不是系统服务；未实测重新登录/重启电脑。

启动命令（当前部署环境）：

```powershell
& 'D:\APP\anaconda3\envs\ga\pythonw.exe' 'D:\study\GA-Hub\assets\remote_access\supervisor.py'
```

Python 依赖：aiohttp、psutil、pywin32。cloudflared 位于 `%LOCALAPPDATA%\GA-Hub-Remote\bin\cloudflared.exe`。凭证只保存在当前用户 Windows Credential Manager 的 `GA-Hub/remote-access/password` 与 `GA-Hub/remote-access/tunnel-token`，不要复制到命令行、源码或日志。

## 安全与边界

- HTTPS 登录 Cookie 为 `__Host-`、Secure、HttpOnly、SameSite=Strict，12 小时有效；网关重启会清空登录。
- 密码错误限流；跨来源及直接设置/密钥/记忆接口禁止。开放会话读取、受 Origin 保护的 GET `/api/projects` 和 POST `/api/sessions`、仅含 key/name 的 GET `/api/llms`、受 Origin 保护的 POST `/api/upload`、精确 POST `/api/sessions/{id}/runs`、POST `/api/sessions/{id}/abort` 和 PUT `/api/sessions/{id}/model`。发送 JSON 只允许 text/request_id/upload_ids，附件为 multipart 且受大小和数量限制；模型切换 JSON 只允许 llm_key，并校验可用模型及会话空闲状态。
- 请求编号去重在网关内存保留 12 小时（最多 1024 项），重启清空；结果不确定时先查看会话状态，不要盲目重发。
- 47832 管理面板不得映射公网；不要将 sidecar 动态端口直接映射公网。
- 远程访问不等于脱敏：会话正文仍可能含敏感内容。请勿分享密码；云边缘服务会终止 TLS。
- Cloudflare 源站域也可进入相同登录页，仍受同一鉴权保护；正常使用主域，**不保证所有国内运营商/反诈策略均放行**。

## 运维

日志：`%LOCALAPPDATA%\GA-Hub-Remote\gateway.log` 与 `tunnel.log`。

网关/隧道异常退出后，supervisor 每 5 秒检查并拉起。临时停服须先准确定位 `supervisor.py` 的 Python PID 及其子进程，先停 supervisor，再停归属已确认的子进程；不能按进程名称批量结束 Python/cloudflared。永久停用可移除上述单个 Run 值，并按需停用专用隧道/域名。切勿修改既有 `ga` 域及其他服务。

排障：
- 登录页能开、会话接口 503：先检查本机 GA-Hub 是否打开、sidecar 是否在运行。
- 登录后反复跳转：检查 Cookie、浏览器安全策略、网关日志；`Referrer-Policy` 使用 `same-origin`，不能改为导致表单 Origin 为 null 的 `no-referrer`。
- 域名不能解析：2026-10-31 实测默认 DNS `192.168.2.1`（HWRT.lan）返回 NXDOMAIN；指定 AliDNS `223.5.5.5` 则返回 `43.174.246.106` / `43.174.247.106`，Google 公共 DNS 查询也正常。异常在默认解析路径，是否为缓存尚未证实；本机 flushdns 返回 1，未修改系统 DNS 或 hosts。可先用手机移动数据等另一网络验证，再按需处理路由器 DNS。
- 证书状态：EdgeOne 已实测 `online` / `deployed`；不要反复申请证书。

## 验收（2026-10-31）

主域已通过 Chrome 无代理、严格 TLS 校验的真实登录和读取（测试时仅在独立浏览器进程固定 EdgeOne DNS，以绕过本机负缓存）：46 个会话，历史消息 40→80，刷新后仍保留 80；390px 视口无横向溢出，零页面 JS 错误。Cookie 安全属性、拒绝写入、退出后 401 已验证。源站 HTTPS 也验证通过。

证据：仓库 `temp/remote-access-20261031/` 中的 `browser-checks.json`、`local-checks.json`、`mobile.png`；该目录不入库。未测试全运营商连通性、电脑重启和长时间断网恢复。

## 双向消息验收（2026-10-31）

8 项隔离网关回归通过，覆盖未登录、Origin、精确写白名单、格式/长度、并发幂等及 409 透传。Chrome 经主域 HTTPS 选择独立验收会话，点击发送获得 202/running，收到 `REMOTE_BIDIRECTIONAL_OK_20261031`，最终状态 idle/completed；刷新后消息仍在，390px 无横向溢出，零 JS 错误。证据 `temp/remote-access-20261031/send-browser-checks.json` 和 `send-mobile.png`；回归命令 `python assets/remote_access/test_gateway.py`。此测试未调用工具执行实际文件或系统操作。

## Chat 展示与维护（2026-10-31）

源码为 `remote-app.js`（交互）、`remote-view.js`（分组与消息卡片）、`remote-render.jsx`（复用桌面解析器与安全 Markdown）；在仓库根目录执行 `node assets/remote_access/build-remote.cjs` 生成 `remote.js`，需要已安装 webui 的依赖。无需外部 CDN 或放宽网关安全策略。

公网 Chrome 验收通过：7 个项目、47 个会话；过程默认折叠、逐轮展开、全展开/收起、轮询保留折叠状态、收藏筛选、桌面与 390px 手机无横向溢出。再次真实发送获得 202，新助手回复落档，刷新可见，零 JS 异常。补充渲染用例通过，覆盖多轮、问询轮排除重复、Markdown、脚本/危险链接/外部图片不执行或不加载。

证据位于 `temp/remote-access-20261031/`：`chat-browser-checks.json`、`render-checks.json`、`send-browser-checks.json`、`chat-desktop.png`、`chat-mobile.png`、`chat-mobile-sessions.png`。测试脚本同目录。已知非阻断项：浏览器默认请求 `/favicon.ico` 返回 404；未测试全运营商或长期断线恢复。收藏和展开偏好不跨设备同步。

## 手机轻量视图

- 首页筛选激活态使用透明背景、强调文字和下划线，与 Logo 按钮区分；会话页标题区只保留会话标题，运行状态放入工具面板。
- 远程页面历史请求使用 `view=compact`。网关在本机读取完整记录后，借助持久 Node 子进程 `compact-worker.cjs` 复用 WebUI 转录解析器，向浏览器返回正文以及 `progress` 内的逐轮编号、摘要和轻量响应。剔除工具参数、结果及思考，移除原始 turn_segs，保留 ordinal/分页字段；问询的问题和选项保留。Markdown 代码块中的协议字面量保留。
- 当前活动另用鉴权 GET `/api/sessions/{id}/progress`：网关通过回环 WebSocket 读取初始快照，将同一 run 的物理分段合并后做轻量投影。手机每轮并行读取历史与活动，不再只等任务结束落档。活动与归档按运行/逻辑身份去重，已有未完成分段不会遮住当前进度。
- 本机原始记录和不带 compact 参数的接口不变；这是公网传输/手机解析减载，不减少后端原始历史读取，也不是增量推送。页面可见时每 3 秒尝试同步，前次请求未结束则跳过，恢复可见时立即同步；网络与浏览器后台节流仍可能使实际间隔变长。轮数优先依据校验过的原生分段（包含最终响应轮），无可信分段时才回退文本解析。
- 部署需 Node 在网关进程 PATH 内；运行 `node assets/remote_access/build-remote.cjs` 同时生成页面及 worker bundle。更新 worker 后需重启投影子进程或网关。投影失败返回 502，不回退传输完整工具记录。
- 验收：网关 14 项测试通过；公网明暗主题、320/390/1440px、返回列表、历史分页、工具面板及零 JS 异常通过。真实工具密集样本最近 40 条消息 JSON 从 8,901,425 字节降至 59,405 字节（压缩前，约减少 99.3%），响应另启用 gzip；不代表端到端耗时同比下降。
- 本轮复验脚本与必要截图保留在 `temp/remote-access-20261031/check-compact-v2.py`、`compact-v2-checks.json`、`compact-v2-*-list.png` 和 `compact-v2-*-chat.png`。

### 会话页控件精简（2026-11-01）

旧轮次展开按钮移至过程摘要首行，改为 SVG 图标并保留无障碍名称与展开状态；移除最终正文前的“回复”标签、输入区说明。模型设置仅保留选择框；模型/发送状态节点只供读屏，不占视觉空间。移除控件时同步清理脚本引用，模型按钮维护弹窗展开状态。

构建、8 项视图回归及静态 DOM 引用检查通过。公网真实登录后验证模型列表（12 项）、遮罩关闭和列表往返；320/390/430/1440px 明暗主题共 8 组受控消息布局均无溢出，旧摘要展开/收起正常、无 JS 异常。本轮未发送真实指令或改变实际模型配置。移动弹窗通过位移移出视口关闭，测试应检查视口与 aria-expanded，而非仅用 to_be_hidden。证据：`temp/remote-access-20261031/check-conversation-polish.py`、`conversation-polish-checks.json`、`conversation-polish-model.png`、`conversation-polish-chat.png`。

### 手机信息密度优化（2026-11-01）

手机列表将标题、运行状态、日期合并为一行，标题过长省略但状态保留；收紧项目组和列表留白。聊天页压缩段落、列表、摘要和消息间距，保留原字号；输入框与发送按钮并排，去掉输入区冗余说明。紧凑规则限于 ≤760px，桌面布局保留。

验收：构建及 6 项视图回归通过；Chrome 中 320/390/430/1440px、明暗主题共 8 组通过。390px 受控样本列表行高 59→46px，输入区约 124→74px，聊天可用高度约增加 61px。主域 HTTPS 真实登录后 CSS/JS 与本地文件摘要一致，真实列表单行状态、聊天输入/发送并排、返回列表均通过，无横向溢出与 JS 异常。另验 320×568、390×420、844×390 下多行输入和发送按钮仍在视口内。本轮未发送真实指令，缩小视口不等于真机软键盘验收；公网浏览器固定 EdgeOne 节点解析，不代表所有网络可达。

证据：`temp/remote-access-20261031/check-density.py`、`density-checks.json`、`density-live-checks.json`、`density-live-list.png`、`density-live-chat.png`（本地验收文件，不入库）。

### 逐轮进度修正验收（2026-11-01）

18 项网关回归通过，覆盖活动快照增长、原生分段计数、续跑合并、跨运行隔离、鉴权和工具内容剔除。新版网关和 bundle 已部署；主域 HTTPS 实际登录、真实历史及进度端点返回 200，历史包含逐轮摘要。

浏览器受控活动快照验收：未结束时轮数从 1 增至 2 用时 2.906 秒，轮询间隔约 2.97/3.00/3.02 秒；折叠状态跨刷新保留，完成落档只有一条助手消息，320/390/1440px 无横向溢出，零 JS 异常。证据为 `temp/remote-access-20261031/check-progress.py`、`progress-browser-checks.json`、`progress-live-mobile.png`。测试时没有实际运行中的会话，因此增长与落档使用浏览器受控响应，不能等同于一次真实模型任务的全链路运行验收；真实后端快照接口及历史读取已单独验证。公网浏览器仍使用独立进程固定 EdgeOne 节点解析，不代表所有网络可达。


## 刷新解耦与实时推送（2026-11-02）

当前会话通过受鉴权和同源校验保护的 `/api/sessions/{id}/live` WebSocket 接收裁剪后的进度；网关按会话共享本机上游订阅，合并密集事件并只保留待发送的最新快照。原始工具记录不通过该端点公开。连接使用心跳及退避重连，重连以权威快照恢复。

历史读取与进度读取独立启动；切换会话取消旧请求并校验请求代次，避免旧响应覆盖新会话。页面内缓存最近 12 个会话历史，返回时先显示缓存；任务结束及连接恢复时补读历史。会话列表独立每 5 秒刷新，隐藏页面关闭当前订阅，恢复可见时重新同步。

已构建并仅重启独立网关，未改动桌面及隧道。52 项回归全部通过：网关 30、产物安全 9、视图 13。受控浏览器中，历史请求延迟 2 秒时进度在 161 毫秒显示；连续推送、切换会话旧响应隔离、断线恢复和心跳保持均通过，零 JS 异常。这是受控场景结果，不是公网真实任务的端到端延迟指标。

公网实际登录后验证单条 WebSocket 收到真实快照及心跳响应，线上 JS/CSS 与本地构建哈希一致，390px 视口无横向溢出、零 JS 异常。公网使用独立 Chrome 固定 EdgeOne 节点解析，不代表所有网络可达或手机真机验收；本轮未发送真实模型任务，真实任务增长及完成落档仍由回归和受控浏览器覆盖。

证据保留在工作空间产物目录 `D:/study/GA/temp/project_artifacts/GA-Hub-d795c16e/remote-refresh-implementation/`：`browser-results.json`、`public-results.json`、两份浏览器检查脚本、截图及三份回归日志。更新网关会清空登录，已有页面需刷新并重新登录。
