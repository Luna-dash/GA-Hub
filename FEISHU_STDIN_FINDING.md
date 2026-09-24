# 飞书检查超时：stdin生命线因果实验（2026-09-24）

本报告取代 DIAGNOSIS.md 中 stdout PIPE 致卡、收发全部正常等未经验证的断言。

## 新证据
1. stdin_busy_probe.py：stdout始终PIPE；空闲stdin管道0.032s退出；父线程os.read同一管道时4s超时且无输出；仅改stdin=DEVNULL后0.031s正常。
2. stdin_service_probe.py：调用D:\study\GA-Hub真实FeishuService._run_check(False,10)，仅在测试进程包装subprocess.run更换stdin。空闲管道6.657s ready/ok=true；被读取管道10.031s超时；相同忙管道但子进程stdin=DEVNULL时5.140s ready/ok=true。输出仍PIPE。
3. stdin_release_probe.py：子Python卡2秒后，仅向自建测试管道写1字节解除父线程读取，子进程随即STARTED并以0退出。未向生产管道写入。
4. 生产PID31996 exe为D:\study\GA-Hub\src-tauri\target\x86_64-pc-windows-msvc\release\ga-hub-sidecar.exe，cmdline确认含--owned-stdin。
5. 当前源码desktop_sidecar.py:79 dup(stdin.fileno)，139 os.read(fd,1)，224-228启动desktop-owner-stdin线程。feishu_service.py:428检查未指定stdin（继承）；518常驻启动明确DEVNULL。

## 结论与边界
已在本机独立复现并逆转“共享stdin管道存在挂起读取→Python子进程启动阻塞”。源码与运行参数吻合，强支持它是生产check超时原因；不是stdout=PIPE本身的问题。内核内部锁机制尚未通过完整符号栈证明。尚未对运行中的打包进程应用修复并复测API，因此不称生产故障已修复。

建议最小修复：_run_check的subprocess.run显式stdin=subprocess.DEVNULL，保留stdout PIPE；另审计save_keys/send_text等非交互子进程同类遗漏。不要改生命线读取为无效监控，不要向生产stdin写字节（会请求退出）。打包版本须重新构建并经授权重启后验收。

飞书ready仅凭据非空，长连接日志不等价端到端收发验证。消息接收→Agent→回复仍未验收。生产源码、密钥与进程未修改。

## 修复落盘与验证（2026-09-24 晚）
- 三处已修（纯增量 `stdin=subprocess.DEVNULL`）：`_run_check`、`save_keys`、`send_text`（server/services/feishu_service.py）。
- 验证 1：定向回归 `test_check_send_save_pin_devnull_stdin` 通过；文件级 17 passed（新增 1）。
- 验证 2：全量 `pytest tests` = 992 passed / 2 skipped / 47s。
- 验证 3：真实服务代码 A/B/A 单变量（stdin_pin_after_fix_verify.py）：修复源码 5.18s ok → 模拟旧继承 12.02s 超时 → 修复源码 4.72s ok。
- 修复前生产现场（sidecar :6718 /api/feishu/check）：25.1s 超时；子进程 CPU=0 僵死（6s 快照）。

## 部署状态（打包版验收待授权）
- sidecar 为 PyInstaller onefile（45.4MB，内嵌 server 快照）→ 源码修复必须重新构建（`python scripts/build_all.py`，先退出 GA-Hub 以免产物被锁），重启应用后复测 `/api/feishu/check` 验收。
- 构建配方与产物守卫见 scripts/build_all.py；今日 15:04/15:06 产物即为其输出（壳管道修复）。
