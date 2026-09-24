# 构建策略 —— 让 GA-Hub 在任何机器上都能产出桌面端

## 三条路（按目标机器环境从全到无排序）

### 1. 本机一键构建（当前开发机）

```bat
python scripts\build_all.py
```

脚本完全路径无关：仓库放任何盘符任何目录都可以，解释器用"启动它的那个
python"，唯一硬性要求是它装了 `requirements.txt` 里的依赖。

> ⚠️ **桌面构建唯一入口 = `build_all.bat`（或 `python scripts\build_all.py`）。严禁直接运行 `npm run desktop:build`**——root script 是裸 `tauri build`，产物会落 host-target `src-tauri\target\release\`（非正式区，已两次污染仓库：2026-08-22、2026-09-23）。正式产物唯一路径 = `src-tauri\target\x86_64-pc-windows-msvc\release\`（build_all 链自动传 `--target`）。

### 2. 另一台电脑本地构建（有基础工具链）

前置：Node.js 18+、Rust（rustup，Windows 需 MSVC Build Tools）、Python 3.11+。
然后：

```bat
git clone https://github.com/Luna-dash/GA-Hub.git
cd GA-Hub
python -m pip install -r requirements.txt
npm ci
npm ci --prefix webui
python scripts\build_all.py
```

产物：`src-tauri\target\x86_64-pc-windows-msvc\release\ga-hub-desktop.exe`

- 想换解释器：`set GA_HUB_PYTHON=<路径>`（默认用启动脚本的解释器）
- 预检会给出缺失项的针对性提示（npm / cargo / PyInstaller）

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
