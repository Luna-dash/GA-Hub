# AGENTS.md —— 自动化协作须知

本仓库存在多方协作（含多个 AI agent）。所有涉及**构建 / 打包 / 发布 / 改动构建链**
的任务，先读 [`docs/BUILD.md`](docs/BUILD.md)——构建流程以它为准。

## 构建红线（不得绕过）

1. 桌面构建唯一入口 = `build_all.bat`（或 `python scripts\build_all.py`）。
   禁止手拼 `tauri build` / 直接 PyInstaller；`npm run desktop:build` 已禁用
   （运行即 exit 1 并指引入口）。绕过产物不在正式路径，也不经过产物守卫。
2. 构建前退出正在运行的 GA-Hub（含 sidecar）：预检自动检测产物文件锁并报错；
   不要在占用状态下反复重试。并发构建由 `src-tauri\target\.build_all.lock` 挡下。
3. 成功判定 = 退出码 + 守卫输出：`0` 成功；`2` 预检失败；`3` 阶段失败；
   `5` 产物守卫失败。不要用「命令没报错」「文件存在」当成功依据。
   守卫语义：三件产物（主 exe / sidecar 中间产物 / sidecar 交付副本）必须存在、
   非空、且被**本次构建重写**——未重写一律失败（实测不存在合法的增量复用：前端
   每次重写 dist、cargo 必然重链，sidecar 先 unlink 再打包）；
   构建末尾打印三件产物 sha256 指纹，供交付取证。
   退出码 `3` 时（守卫覆盖不到失败路径）脚本会补一次产物体检并明确警告「产物集
   不配套」，看到该警告不要把那几件当交付物。
4. 构建产物不进 git（`src-tauri/target/` 等已忽略）。

## 常用命令

- 后端测试：`python -m pytest tests -q`（pyproject 已限定 testpaths=tests/）
- 前端测试：`npm --prefix webui test -- --run`
- 发布前全量验证 + 构建：`python scripts\build_all.py --full`
- 交付物固定为便携版两个 exe（不再产出 MSI/NSIS 安装包）

## 改动构建链的约定

修改 `scripts/build_all.py`、`desktop/build_sidecar.py`、`src-tauri/tauri.conf.json`
或 `src-tauri/Cargo.toml` 时必须保持：
唯一入口（build_all；`npm run desktop:build` 保持拒绝式）、退出码约定（2/3/5，
含失败路径的产物体检）、产物守卫语义（缺失/为空/未被本次构建重写 = 失败）、
前端构建归 build_all 独占
（不要给 tauri.conf.json 加回 `beforeBuildCommand`）、交付物只有便携版两个 exe
（Tauri 阶段恒传 `--no-bundle`）、
并发锁（`.build_all.lock`）与占用预检、跨平台 sidecar 命名（`ga-hub-sidecar-<target>[.exe]`）。
`src-tauri/Cargo.toml` 里那两处 `indexmap = { version = "1", features = ["std"] }`
看起来没人调用，但**不能删**：schemars 0.8（tauri 工具链依赖）不带 indexmap/std 时，
indexmap 1.9.3 会跑 autocfg 探针（`Stdio::piped()` 起 rustc），探针静默失败就编译成
no_std 形态并报 `E0107`。原因与实测见 docs/BUILD.md 排障小节。
改动前先读 docs/BUILD.md「构建纪律与验收」。
