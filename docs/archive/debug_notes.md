# GA-Hub Tauri 桌面启动修复 - 排查与修复状态 (2026-08-16 09:45)

## 已确认根因 1（已修复）
sidecar 的 `_stdin_shutdown` 线程在 PyInstaller 无控制台环境中 `sys.stdin.buffer.readline()`
立即返回 EOF，被误判为"主人请求停止" → `server.should_exit=True` → Uvicorn 刚
`running` 即 `Shutting down` → 壳 `wait_http_ready` 永不成功 → (原40s) 超时 panic → abort 0xC0000409。
- 修复：`server/desktop_sidecar.py` 的 `_stdin_shutdown`：EOF 时 return（不设 should_exit），
  仅收到真正字节（Tauri `stop_owned` 写 `\n`）才触发优雅退出。
- 验证：修复后 sidecar 不再立即 shutdown；后端能跑到 `Uvicorn running on 127.0.0.1:<port>`。

## 已确认根因 2（进行中）
后端 `_startup()` 极慢：从 `Started server process` 到 `Application startup complete` 约 3 分钟，
> READY_TIMEOUT=180s → 壳超时 panic → 崩溃。
- stderr 可见：启动阶段调 `D:\APP\anaconda3\envs\ga\python.exe -c 'import json, site, sys...'`
  (site-packages 探测) 5s 超时；还有
  `server.routes.sessions has no attribute 'scheduled_chat_service'`（被 SchedulerHost.start_all 捕获，不阻塞）。
- 独立运行时 430s 仍无监听端口 + 日志仅 1174B 不增长 → 怀疑 stdout 块缓冲 + 慢在 import/初始化。

## 已改文件（勿丢）
- D:\study\GA-Hub\server\desktop_sidecar.py（_stdin_shutdown EOF保护）
- D:\study\GA-Hub\src-tauri\src\main.rs（lossy + READY_TIMEOUT=180s；早前）
- D:\study\GA-Hub\src-tauri\Cargo.toml（恢复常规 panic=abort 的 release；早前）
- D:\study\GA-Hub\src-tauri\binaries\ga-hub-sidecar-x86_64-pc-windows-msvc.exe（已重建 44.8MB 09:40）
- 已复制覆盖 target\release\ga-hub-sidecar.exe

## 关键日志/时间线
- 修复后壳 pid 9084：09:40:49 启动，09:44:51 崩（约 242s）：未见 shutdown_requested/立即shutdown，
  Uvicorn running on 60421 后壳已超时 panic → 说明启动全程耗时 ~240s，远超 180s。
- 独立 sidecar（binaries 新 exe）430s 无监听。注意：日志写入被块缓冲/文件锁，需用 FileShare.ReadWrite 读。

## 下一步
1. 用 `-u` 无缓冲重跑 sidecar 独立时序，或直接改用 stderr 重定向（stderr 无缓冲）确认各阶段真实时间。
2. 找到 startup 慢点：可能 site-packages 探测、scheduled_chats e2e、core contract probe、AgentService 启动。
   用 Python cProfile 或加日志时间戳。
3. 修复慢点后重打包 sidecar → 启动壳验证 ready 200 + 主窗口 GA-Hub。
4. 备份：binaries 旧 exe 可在 git 找到（已 ignored，注意）。
5. 桌面快捷方式最终指向 Tauri 壳或更新 start.bat。

## 坑
- PowerShell 无 heredoc；写临时 .py 再执行。
- PS 命令里 `Stop-Process -Id 9068,21716` 逗号会被截断 → 分开或 -Filter。
- makefile: 工具超时不会杀子进程。
- 日志文件被占用时 System.IO.File 读不到 → 换名字或等句柄释放。