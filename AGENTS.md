# AGENTS.md —— 自动化协作须知

本仓库存在多方协作（含多个 AI agent）。所有涉及**构建 / 打包 / 发布 / 改动构建链**的
任务，先读 [`docs/BUILD.md`](docs/BUILD.md)（契约与纪律）。想知道"为什么是这样、
以前踩过什么"，读
[`docs/archive/build-chain-incidents-20260927.md`](docs/archive/build-chain-incidents-20260927.md)。

## 构建红线（不得绕过）

1. 桌面构建唯一入口 = `build_all.bat`（或 `python scripts\build_all.py`）。
   禁止手拼 `tauri build` / 直接 PyInstaller；`npm run desktop:build` 已禁用
   （运行即 exit 1 并指引入口）。绕过产物不在正式路径，也不经过产物守卫。
2. 构建前退出正在运行的 GA-Hub（含 sidecar）：预检自动检测产物文件锁并报错；
   不要在占用状态下反复重试。并发构建由 `src-tauri\target\.build_all.lock` 挡下。
3. 成功判定 = 退出码 + 守卫输出：`0` 成功；`2` 预检失败；`3` 阶段失败；
   `5` 产物守卫失败。不要用「命令没报错」「文件存在」当成功依据。
   守卫语义：三件产物（主 exe / sidecar 中间产物 / sidecar 交付副本）必须存在、
   非空、且被**本次构建重写**；`3` 时脚本会补一次产物体检，看到「产物集不配套」
   的警告就不要把那几件当交付物。
4. 构建产物不进 git（`src-tauri/target/` 等已忽略）。

## 常用命令

- 后端测试：`python -m pytest tests -q`（pyproject 已限定 testpaths=tests/）
- 前端测试：`npm --prefix webui test -- --run`
- 发布前全量验证 + 构建：`python scripts\build_all.py --full`
- 交付物 = 便携版两个 exe（本链不产出 MSI/NSIS 安装包）

## 过程产物去哪（仓根不许堆东西）

仓根是公共广场。散件堆在这里的代价是实测过的：`git status` 信噪比 **1:47**，而且
`git add -A` 会把本机用户名/绝对路径/自建端点一起提交。更要紧的是**修法必须换**：
2026-09-23 的卫生审查把当时那批散件逐条写进 `.gitignore`，**两天后又长出 32 条**
（09-24 新增 19 条、09-25 新增 13 条）——命名式 ignore 是快照，不是机制。

现在的规矩（由 `tests/test_repo_hygiene.py` 守，越界即红并告诉你该放哪）：

1. **临时/调试产物**（探针脚本、结果快照、diff 文本、截图、分析目录）→ 一律放
   `temp/`（已忽略）。清运时放 `temp/archive-scattered-<YYYYMMDD>/` 按类别归档，
   **移动不删除**（2026-09-23 的先例），可随时搬回。
2. **一次性报告/发现**（诊断、审查、实验记录）→ `docs/archive/`，命名
   `kebab-case-YYYYMMDD.md`；**归档时同步修引用链**，否则断链。
3. **不许**在仓根新建散件（护栏会红）。
4. 确有必要加根目录文件（新入口脚本等）→ 同时更新该测试的 `ROOT_FILES` 白名单，
   让「加一个根目录文件」是一个决定，而不是顺手的事。

## 改动构建链的约定

改 `scripts/build_all.py`、`desktop/build_sidecar.py`、`src-tauri/tauri.conf.json` 或
`src-tauri/Cargo.toml` 时，保持这些契约（细节见 docs/BUILD.md）：

- 唯一入口；`npm run desktop:build` 保持拒绝式
- 退出码 `2/3/5` 与失败路径的产物体检
- 产物守卫语义：缺失 / 为空 / 未被本次构建重写 = 失败
- 前端构建归 build_all 独占——**不要**给 tauri.conf.json 加回 `beforeBuildCommand`
- 交付物只有便携版两个 exe——Tauri 阶段恒传 `--no-bundle`
- 并发锁 `.build_all.lock` 与占用预检
- Windows MSVC 环境在 Python 统一入口预检自动加载、校验架构及 SDK；失败 exit 2，
  仅当前进程及子进程生效，不修改全局 PATH；非标准 VS 可用 `GA_HUB_VCVARSALL`
- 跨平台 sidecar 命名 `ga-hub-sidecar-<target>[.exe]`
- `src-tauri/Cargo.toml` 里那两处 `indexmap = { version = "1", features = ["std"] }`
  看起来没人调用，但**不能删**（原因见事故记录第 10 条）

改动前先读 docs/BUILD.md「构建纪律与验收」。
