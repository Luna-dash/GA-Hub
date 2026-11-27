@echo off
:: Launch the production Tauri shell on Windows.
:: The pywebview launcher has been retired — Tauri is the only desktop entry.
:: When a managed self-update exists (<USERPROFILE>\.genericagent-admin\updates\current.json),
:: ga-hub-desktop.exe automatically redirects via its sibling ga-hub-update.exe.
:: Without a built artifact, run build_all.bat once (or use browser mode:
::   python -m server.run  →  http://127.0.0.1:8765 ).

setlocal
cd /d "%~dp0"

set "TAURI_APP=src-tauri\target\x86_64-pc-windows-msvc\release\ga-hub-desktop.exe"
if exist "%TAURI_APP%" (
  start "" "%TAURI_APP%"
  exit /b 0
)

echo [Gyra] Desktop app not built yet.
echo   1. Run build_all.bat once to produce it, or
echo   2. Browser mode: python -m server.run  then open http://127.0.0.1:8765
pause
exit /b 1
