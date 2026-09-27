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
  因此 `tauri.conf.json` **不再配 `beforeBuildCommand`**——否则每次构建都会重复构建
  前端（实测多花 ~9s），且主 exe 与 sidecar 内嵌的可能来自两次不同的构建。
  也正因如此，绕过入口裸跑 `tauri build` 更危险：它不会再自动构建前端，只会把
  当前 `webui/dist`（可能已过期）打进壳里。
- **成功判定以退出码 + 守卫输出为准**，不要用「命令没报错」当成功：
  - `0` = 成功；`2` = 预检失败（缺工具/依赖/应用未退出/并发构建）；`3` = 某阶段失败；
    `5` = 产物守卫失败。
  - `3`（阶段失败）时守卫覆盖不到，脚本会在退出前补一次**产物体检**：逐件报告
    本次已重写 / 仍是构建前的版本 / 不存在，出现「只刷新了一部分」会明确警告
    不要把这几件当交付物。退出码仍是 `3`——「阶段失败」与「产物守卫失败」是两条
    不同的排查方向。实测形态：sidecar 阶段成功、Tauri 阶段失败时，磁盘上就是
    「sidecar 新、主 exe 旧」的混搭，功能能跑但形式上已不是一次构建的产物。
  - 守卫**三重校验**（主 exe / sidecar 中间产物 / sidecar 交付副本）语义一致：
    缺失、为空 → 失败；**未被本次构建重写 → 失败**（说明写到了别的 target 目录，
    或这一步被跳过）。2026-09-26 冷/热各一次真实全链实测（114.0s / 93.2s）：三件
    产物每次都被重写——前端每次重写 `webui/dist`，Tauri build script 对 dist 每个
    文件都发 `rerun-if-changed`，cargo 因此必然重链；sidecar 先 unlink 再打包。
    所以「未重写」没有合法的增量复用解释，旧版的「警告放行」分支已删除。
  - 构建末尾打印三件产物的 **sha256 指纹**（前 16 位）+ 大小 + mtime，交付取证用。
    注意：同一份源码两次构建的指纹不同（exe / sidecar 都嵌入了构建期信息），
    指纹用来标识「哪一次构建」，不能用来判断两次构建是否一致。
  - 预检打印「非正式区残留产物」= `src-tauri\target\release\` 下有 exe——那是裸
    `tauri build` 的落点，应删除并纠正流程。
- **发布前验证**：`python scripts\build_all.py --full` 会先跑后端 pytest（限定 `tests/`，
  自动注入 `GA_ROOT`/`PYTHONPATH`）与前端 vitest，再进入构建阶段；缺 GA 仓库或
  `webui/node_modules` 会在预检阶段（exit 2）就说清楚。
- 正式产物只有两处（必须同目录）：`src-tauri\target\x86_64-pc-windows-msvc\release\`
  下的 `ga-hub-desktop.exe` 与 `ga-hub-sidecar.exe`。Tauri 阶段**恒传 `--no-bundle`**：
  交付物就是这两个便携版 exe。安装包（MSI/NSIS 实测每次 ~104MB、tauri 阶段多花
  15-24s，CI 也不上传）不在本链职责内——需要时另行打包，别把它塞回每次构建的固定
  代价。同目录下还有构建副产物（`ga_hub_desktop.pdb`、`resources/`），它们不是交付内容。

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


### 排障：`E0107 struct takes 3 generic arguments`（indexmap 的 autocfg 探针静默失败）

构建停在 `could not compile schemars`，报
`error[E0107]: struct takes 3 generic arguments but 2 generic arguments were supplied`。
它看起来像依赖版本冲突，实际是**探测失败**：

- `tauri-utils` / `tauri-build` / `tauri-plugin` 2.x 都依赖 `schemars 0.8`，而它的
  `preserve_order = ["indexmap"]` 只开 indexmap 的 `serde-1`，**不开 `std`**；
- `indexmap 1.9.3` 的 `build.rs` 在 `CARGO_FEATURE_STD` 缺席时会跑 autocfg 探针
  （`autocfg::new().emit_sysroot_crate("std")`）。该探针 spawn `rustc -`，并把源码写进
  **`Stdio::piped()`** 的 stdin；**探针失败是静默的**——不报错，只是不 emit
  `rustc-cfg=has_std`；
- 没有 `has_std` → indexmap 编译成 no_std 形态（`IndexMap<K, V, S>` 没有默认类型参数）
  → schemars 里 `IndexMap<K, V>` 的写法就报 E0107。
- 本机是 `Stdio::piped()` 的已知问题机器（`docs/archive/desktop-sidecar-spawn-pipe-busy-20260924.md`：
  `ERROR_PIPE_BUSY` / os error 231），所以这条失败路径在这台机器上偶发。

2026-09-27 实验（`temp/dsh_review/indexmap_probe/`）：无干扰连做 5 次
「clean indexmap + 重建」全部 `has_std=True`（探针当前正常，与「偶发」一致）；用
`RUSTC_WRAPPER` 强制探针失败即复现同一条 E0107 与 `could not compile schemars`；
同一失败场景下加上本仓库的修法（`Cargo.toml` 里 indexmap 显式
`features = ["std"]`，靠 feature 统一生效）编译通过，且 indexmap 的 build 输出为
`rustc-cfg=has_std=True` 且**无** `rustc-check-cfg`——证明它走的是
`Some(CARGO_FEATURE_STD)` 分支、**根本没起探针**，因此不受该失败面影响。

结论：`src-tauri/Cargo.toml` 里那两处 `indexmap = { version = "1", features = ["std"] }`
（`[dependencies]` 与 `[build-dependencies]`，仅用于 feature 统一，代码不直接调用）
**不要删**，删了就回到探测路径。等升到不依赖 schemars 0.8 的 tauri 版本后才可以移除
（indexmap 2.x 没有这个 build script 探针）。
