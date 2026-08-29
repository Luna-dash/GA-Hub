# 构建策略 —— 让 GA-Hub 在任何机器上都能产出桌面端

## 三条路（按目标机器环境从全到无排序）

### 1. 本机一键构建（当前开发机）

```bat
python scripts\build_all.py
```

脚本完全路径无关：仓库放任何盘符任何目录都可以，解释器用"启动它的那个
python"，唯一硬性要求是它装了 `requirements.txt` 里的依赖。

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
2. 打开仓库 **Actions → desktop-build** 等待绿灯（首次约 15-25 分钟，
   之后有 cargo/npm 缓存会快很多）
3. 任务页底部 **Artifacts** 下载 `ga-hub-desktop-windows` → 解压即用

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
