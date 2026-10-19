# 构建策略 —— 让 GA-Hub 在任何机器上都能产出桌面端

## 三条路（按目标机器环境从全到无排序）

### 1. 本机一键构建（当前开发机）

```bat
build_all.bat
```

（等价：`python scripts\build_all.py`，解释器就用启动它的那个 python。
`build_all.bat` 只做一件事——挑解释器，顺序是：`GA_HUB_PYTHON` → 本机已配置的
构建环境（本仓库默认 `D:\APP\anaconda3\envs\ga\python.exe`，其它机器上没有就跳过）
→ PATH 里的 `python`。换解释器：`set GA_HUB_PYTHON=<解释器路径>`。）

脚本完全路径无关：仓库放任何盘符任何目录都可以；唯一硬性要求是所选解释器装了
`requirements.txt` 里的依赖——缺依赖时预检直接失败并给出修复命令，不会静默换环境。

构建前先**退出正在运行的 GA-Hub**（含 sidecar 进程）：预检会检测产物文件锁并直接
报错（不会损坏旧产物）；占用状态下反复重试没有意义。构建期间脚本持有
`src-tauri\target\.build_all.lock`，两个构建并发时后到者会被预检挡下。

> ⚠️ **桌面构建唯一入口 = `build_all.bat`（或 `python scripts\build_all.py`）。`npm run desktop:build` 已改为拒绝式（运行即 exit 1 并指引 build_all）；历史版本 root script 曾是裸 `tauri build`，产物会落 host-target `src-tauri\target\release\`（非正式区，已两次污染仓库：2026-08-22、2026-09-23）。正式产物唯一路径 = `src-tauri\target\x86_64-pc-windows-msvc\release\`（build_all 链自动传 `--target`）。

### 2. 另一台电脑本地构建（有基础工具链）

前置：Node.js 18+、Rust（rustup，Windows 需 MSVC Build Tools）、Python 3.11+。

Windows MSVC 目标在统一 Python 入口的预检阶段自动加载 VS2017+ 的
`vcvarsall.bat`；BAT 和直接运行 Python 均适用，无需手工打开开发者终端。
预检按目标架构检查 cl/link、SDK rc 与系统/C 运行库，环境仅对当前构建进程及其
子进程生效，不修改全局 PATH。已就绪的匹配架构环境直接复用。
发现顺序：`GA_HUB_VCVARSALL` 显式路径 → vswhere（不以组件筛选空结果判未安装）
→ Program Files 下标准 VS 安装目录。非标准位置可设置 `GA_HUB_VCVARSALL`
指向 `VC\Auxiliary\Build\vcvarsall.bat`；显式指定失败不静默选择其它安装。
缺少工具链、SDK 或初始化失败以预检退出码 **2** 中止，不会先打包再撞链接错误。
自动架构选择支持 x64/x86/arm64，但完整构建仍仅 Windows x86_64 实测过。
然后：

```bat
git clone https://github.com/Luna-dash/GA-Hub.git
cd GA-Hub
python -m pip install -r requirements.txt
npm ci
npm ci --prefix webui
build_all.bat
```

产物：`src-tauri\target\x86_64-pc-windows-msvc\release\ga-hub-desktop.exe`

- 想换解释器：`set GA_HUB_PYTHON=<路径>`（默认用启动脚本的解释器）
- 预检会给出缺失项的针对性提示（npm / node_modules\tauri / cargo / PyInstaller），
  并自动检测产物占用与并发构建

### 3. 完全没有环境的机器 —— GitHub Actions 云端构建（推荐）

无需在任何机器上装任何工具链：

1. `git push` 到 main（或 Actions 页面手动 `workflow_dispatch`）
2. 打开仓库 **Actions → desktop-build** 等待绿灯（冷缓存 ~9 分钟，
   有 cargo/npm 缓存后 ~4-5 分钟）
3. 任务页底部 **Artifacts** 下载 `ga-hub-desktop-windows`，解压出
   **两个文件**——`ga-hub-desktop.exe` + `ga-hub-sidecar.exe`，
   **必须放在同一目录**（sidecar 是 Python 后端，主 exe 启动时从
   自己旁边解析它），双击主 exe 即用

工作流定义：`.github/workflows/desktop-build.yml`。

## 构建纪律与验收（任何 agent / 自动化适用）

- **唯一入口**：`build_all.bat` / `python scripts\build_all.py`。禁止绕过它手拼
  `tauri build` 或直接 PyInstaller 后自称「构建完成」——绕过产物不在正式路径，
  也不会经过产物守卫。`npm run desktop:build` 已禁用（运行即 exit 1 并指引入口）。
- **构建前**：退出正在运行的 GA-Hub（含 sidecar），释放产物文件锁；
  预检会自动检测占用并明确报错，占用状态下反复重试没有意义。
- **并发保护**：构建持有 `src-tauri\target\.build_all.lock`；两个构建
  并发时后到者预检直接失败，不会互踩 `target` 目录。
- **前端构建归 build_all 独占**：它先构建 `webui/dist`（sidecar 要把前端打进包里），
  因此 `tauri.conf.json` **不再配 `beforeBuildCommand`**。绕过硬跑 `tauri build` 更危险：
  它不会自动构建前端，只会把当前（可能已过期的）`webui/dist` 打进壳里。
- **成功判定以退出码 + 守卫输出为准**，不要用「命令没报错」当成功：
  - `0` = 成功；`2` = 预检失败（缺工具/依赖/应用未退出/并发构建）；`3` = 某阶段失败；
    `5` = 产物守卫失败。
  - 守卫**三重校验**语义一致（主 exe / sidecar 中间产物 / sidecar 交付副本）：
    缺失、为空、**未被本次构建重写** → 失败。没有合法的增量复用——前端每次重写
    `webui/dist` 使 cargo 必然重链，sidecar 先 unlink 再打包。
  - `3`（阶段失败）时守卫覆盖不到，脚本退出前会补一次**产物体检**：逐件报告
    本次已重写 / 仍是构建前的版本 / 不存在，出现「只刷新了一部分」会警告不要把
    这几件当交付物；退出码保持 `3`（与 `5` 是两条排查方向）。
- **发布前验证**：`python scripts\build_all.py --full` 会先跑后端 pytest（限定 `tests/`，
  自动注入 `GA_ROOT`/`PYTHONPATH`）与前端 vitest，再进入构建阶段；缺 GA 仓库或
  `webui/node_modules` 会在预检阶段（exit 2）就说清楚。
- 正式产物只有两处（必须同目录）：`src-tauri\target\x86_64-pc-windows-msvc\release\`
  下的 `ga-hub-desktop.exe` 与 `ga-hub-sidecar.exe`。Tauri 阶段**恒传 `--no-bundle`**：
  交付物就是这两个便携版 exe，安装包不在本链职责内。同目录下的 `ga_hub_desktop.pdb`、
  `resources/` 是构建副产物，不是交付内容。
- **平台与 CI 口径**：只有 `x86_64-pc-windows-msvc` 端到端验证过（`--target` 与
  `build_all.command` 的其它平台分支未实测）。Actions 有两个 workflow：
  `desktop-build` 是**便捷构建通道**（任何机器 push 后到 Actions 页面下载 exe），
  只跑 `build_all.py`，不带 `--full`；`webui-checks` 跑三项不依赖 GA 的前端检查
  （`tsc -b --noEmit`、vitest、api:check），**故意不阻断打包**（独立 workflow，
  产物可用性优先——这条通道的价值就是「没有开发环境的机器也能拿到能双击的 exe」）。
- **后端 pytest 不进 CI**（口径要诚实）：套件在**采集期**就依赖 GA 仓库——3 个服务
  模块（`agent_service.py:25`、`goalhive_service.py:20`、`wechat_service.py:32`）在导入
  期就要求 `GA_ROOT`，另有若干测试模块直接 `from frontends...` 导入。实测（空
  `ADMIN_DATA`、无 GA）：**17 errors 中断整跑，0 passed**；加
  `--continue-on-collection-errors` 也只能到 910 passed / 6 failed / 11 skipped
  （后端契约、token 台账、调度器关停那几条仍要 GA）。要让云端跑后端测试，得先把
  这批导入期耦合改成用时期（届时本段与 `webui-checks.yml` 的注释一起更新）。
  后端验证因此在本地做：`python scripts\build_all.py --full`（需 GA 仓库）。

> 这些规矩是怎么来的（每次污染、每个报错的完整排查过程）：
> [`archive/build-chain-incidents-20260927.md`](archive/build-chain-incidents-20260927.md)。
>
> 打包 sidecar 在用户机器上弹「Could not create temporary directory!」的根因
> （Windows 完整性标签沿工作区继承，导致产物以低完整性运行）：
> [`archive/windows-integrity-label-sidecar-tempdir-20261019.md`](archive/windows-integrity-label-sidecar-tempdir-20261019.md)。

## 运行时与构建时依赖的边界（为什么换机器构建是安全的）

- **构建时**只需要：`server/`、`webui/`、`src-tauri/`、`desktop/`、
  `requirements.txt` 里的 Python 包。GA 核心仓库（agentmain/frontends）
  **不参与构建**——PyInstaller 对这两个不可解析模块只发警告。
- **运行时**由应用内首次设置流程（Setup）指引用户指定 GA 仓库位置
  （ga_root）与其 Python 解释器（python_path），sidecar 在启动时把这些
  路径注入 sys.path——这就是 `import agentmain` 在冻结包里也能工作的原因。
- 也就是说：**构建产物通用，GA 核心按机器配置**。换机器 = 下载 exe +
  首次运行时指一下本机的 GA 仓库路径。


### 冻结 sidecar 的 GA 运行依赖（rich / durable rewind）

sidecar 冻结包只打包 GA-Hub 自身依赖（`requirements.txt`）；GA 运行时依赖
（如 `frontends.worldline` 唯一的第三方依赖 `rich`）由设置中指定的 GA
解释器提供。冻结 sidecar 默认使用该外部环境；主程序仍显式注入
`GA_HUB_ENABLE_EXTERNAL_SITE_PATHS=1`（`src-tauri/src/main.rs`），让启动契约
明确一致。仅在排查环境冲突时设置为 `0` 关闭；`server/_paths.py` 会把 GA
解释器的 site-packages 追加进 `sys.path`；若探测子进程无法启动（冻结父进程
场景下曾观察到子解释器启动卡死），则按解释器位置静态回退查找
`Lib/site-packages` 或 `lib/python3.*/site-packages`。

排障「会话运行环境恢复失败」：

- `GET /api/health/core-contract` 会报告 `rich` 与
  `frontends.gahub.bridge.rewind` 契约的可导入性；任一项变红，先核对设置里
  的 GA 解释器能否 `import rich`。
- 桌面版后端日志落盘在 admin-data 目录的 `logs/backend.log`
  （`GET /api/logs/backend` 可读），恢复失败同时会把截断原因写进接口返回
  （`error_mapping`）。


### 排障：`E0107 struct takes 3 generic arguments`（indexmap / autocfg 探针）

构建停在 `could not compile schemars` 并报上面这条 E0107 时，**不要**去调依赖版本：
这是 `indexmap 1.9.3` 的 build script 用 autocfg 探测 `has_std` 时**静默失败**（探针
经 `Stdio::piped()` 起 rustc，本机是这条路线的已知问题机器），于是 indexmap 编译成
no_std 形态、`IndexMap<K,V>` 变成三泛型。完整链路与 2026-09-27 复现实验见
[`archive/build-chain-incidents-20260927.md`](archive/build-chain-incidents-20260927.md) 第 10 条。

处置：`src-tauri/Cargo.toml` 里两处 `indexmap = { version = "1", features = ["std"] }`
（`[dependencies]` 与 `[build-dependencies]`，仅用于 feature 统一、代码不直接调用）
**不要删**——删了就回到探测路径。等升到不依赖 schemars 0.8 的 tauri 版本后才可移除。
