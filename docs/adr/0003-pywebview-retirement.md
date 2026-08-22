# ADR 0003: pywebview 退役，Tauri 成为唯一桌面入口

日期：2026-08
状态：已采纳（supersedes [0002](0002-tauri-production-lifecycle.md) 的"迁移/恢复入口"过渡条款）

## 背景

ADR 0002 将 Tauri owned-sidecar supervisor 确立为唯一受支持的生产桌面生命周期，
并把 pywebview 启动器降级为显式命名的迁移/恢复入口，约定"在验收标准保持满足一个
发布周期后删除"。此后：

- Tauri 壳经多个发布周期验证：single-instance、owned sidecar 生命周期
  （Job Object / process group）、原生 dialog/notification/opener、随机端口 +
  instance token readiness 握手均稳定运行；
- `start.bat` 早已是"Tauri 优先、pywebview 兜底"结构，pywebview 路径实际无人使用；
- 项目交付事实上以 Windows 为主（`project_memory.md` 的构建链、桌面快捷方式）。

## 决策

1. **删除 pywebview 启动器** `launch_webui.pyw` 及其生命周期测试；前端移除全部
   pywebview 桥接分支（`utils/desktop.ts` facade、类型声明、相关注释）。
2. **启动脚本收敛**：`start.bat` 不再兜底到 pywebview，未构建时提示运行
   `build_all.bat` 或使用浏览器模式；`start.command`（macOS）退化为浏览器模式。
3. **依赖清理**：从 `pyproject.toml` 移除 `pywebview`。
4. **第三分发路径一并移除**：`build/`（PyInstaller spec + Inno Setup + Nuitka 链）
   整目录删除，其版本一致性测试断言同步移除。
5. **交付链固化**：新增根目录 `build_all.bat` / `build_all.command`
   （核心逻辑 `scripts/build_all.py`），替代 project_memory 中的三步人肉命令。

## 后果

- 浏览器模式（`python -m server.run`）保留，是唯一的非 Tauri 使用方式；
- 回滚路径不再是 pywebview，而是 git 历史（文件可随时恢复）；
- macOS 原生窗口栈随 pywebview 移除而消失，macOS 用户走浏览器模式；
  若未来需要 mac 桌面壳，应基于 Tauri 补齐而非恢复 pywebview。
