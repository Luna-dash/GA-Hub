# 打包 sidecar 启动即报「Could not create temporary directory!」的根因（Windows 完整性标签）

日期：2026-10-19 · 影响：`ga-hub-sidecar.exe` 在用户机器上双击/被主程序拉起即弹窗失败，`python scripts\build_all.py --full`
的 `test_packaged_sidecar_exits_when_owner_pipe_closes`、`test_packaged_sidecar_preserves_owner_stdin_shutdown` 两条红。

## 现象

- 弹窗：`Error / Could not create temporary directory!`，退出码 `-1`（`4294967295`），耗时约 0.1 s。
- 同一份 exe：`TEMP` 指工作区（`D:\study\GA-Hub\**`）内目录时正常打印；指 `%TEMP%`、`C:\Windows\Temp`、
  `D:\` 根、桌面/文档下任意目录时一律失败。
- 一个 3 行的 PyInstaller `--onefile` 空程序也能复现，说明与业务代码、PyInstaller 版本无关。
- Python/ctypes 复刻 `GetTempPathW` + `_wtempnam` + `CreateDirectoryW`（含 PyInstaller 的 SDDL 安全描述符）
  在任何目录都返回成功 —— 这正是长时间误判的原因。

## 根因

工作区目录带**可继承的低完整性标签**（`Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`）。在它下面新建的每个
文件都会继承这个标签；而**带 Low 标签的 exe 启动后进程本身就是低完整性级别**。低完整性进程在常规位置创建目录
会被 `NO_WRITE_UP` 拦下，返回 `ERROR_ACCESS_DENIED(5)`。

PyInstaller onefile 启动第一步就是 `pyi_create_temporary_application_directory()` → `<TEMP>\_MEI<pid>`，
建目录失败即 `PYI_ERROR("Could not create temporary directory!")` 并退出。工作区内的目录同样是 Low 标签，
所以只有解包到工作区里才能成功 —— 这解释了“只有某些目录能跑”的全部观察。

证据（`temp\crtprobe.c`，MSVC `/MT` 静态 CRT，与 bootloader 同一条 CRT 路径）：

```
TEMP=D:\study\GA-Hub\temp\tmp-b4      RID=4096(Low)   CreateDirectoryW -> OK
TEMP=D:\study\tmp-b2                  RID=4096(Low)   CreateDirectoryW -> FAILED err=5
TEMP=C:\Users\lunagent\AppData\Local\Temp  RID=4096   CreateDirectoryW -> FAILED err=5
```

同一个 cmd.exe（`whoami` 自报 Medium）里跑 `crtprobe.exe` 却报 Low，说明差别在**文件标签**而不是调用方；
`icacls temp\crtprobe.exe` 显示 `Mandatory Label\Low Mandatory Level:(I)(NW)`。

## 修复

把**构建产物目录**的完整性标签改成可继承的 Medium，新产物就不再继承 Low：

```powershell
icacls "src-tauri\target"   /setintegritylevel (OI)(CI)Medium
icacls "src-tauri\binaries" /setintegritylevel (OI)(CI)Medium
# 已存在的产物单独补一次
icacls "<exe 路径>" /setintegritylevel Medium
```

普通机器上文件没有显式标签，该命令等价于默认（Medium），不改变行为；不需要管理员权限。
改完后 `crtprobe.exe` 自报 `RID=8192`、`CreateDirectoryW -> OK`，最小 onefile 正常输出。

验证（不依赖“命令没报错”）：

```powershell
icacls "src-tauri\target\x86_64-pc-windows-msvc\release\ga-hub-sidecar.exe" | Select-String Mandatory  # 应为 Medium
python scripts\build_all.py --full
```

## 教训

- 「同一份 exe 换个目录就成功/失败」优先怀疑**文件系统标签/ACL**，而不是打包参数。
- 用 Python 复刻 Windows API 成功**不能**推翻打包含义：进程完整性级别由**文件标签**决定，
  `python.exe` 自己没标签，所以它永远跑在 Medium。
- 判成功只看：退出码、产物守卫输出、以及“进程自报 RID + 真实创建目录”的观测。
