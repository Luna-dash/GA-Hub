@echo off
:: Launch the production Tauri shell on Windows.
:: The pywebview launcher has been retired — Tauri is the only desktop entry.
:: Without a built artifact, run build_all.bat once (or use browser mode:
::   python -m server.run  →  http://127.0.0.1:8765 ).

setlocal
cd /d "%~dp0"

:: Once managed updates exist, never fall back silently to a stale build.
if exist "%USERPROFILE%\.genericagent-admin\updates\current.json" (
  "%USERPROFILE%\.genericagent-admin\updates\bin\ga-hub-update.exe" --admin-data "%USERPROFILE%\.genericagent-admin" launch
  exit /b
)

:: First installation only.
set "TAURI_APP=src-tauri\target\x86_64-pc-windows-msvc\release\ga-hub-desktop.exe"
if exist "%TAURI_APP%" (
  start "" "%TAURI_APP%"
  exit /b 0
)

echo [GA-Hub] Desktop app not built yet.
echo   1. Run build_all.bat once to produce it, or
echo   2. Browser mode: python -m server.run  then open http://127.0.0.1:8765
pause
exit /b 1
