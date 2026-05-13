' start_hidden.vbs — 隐藏窗口启动 start.bat（无黑框闪烁）
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run Chr(34) & Replace(WScript.ScriptFullName, "start_hidden.vbs", "start.bat") & Chr(34), 0, False
