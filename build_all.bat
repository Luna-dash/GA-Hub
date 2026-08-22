@echo off
:: GA-Hub 一键交付构建：前端 → sidecar → Tauri 壳 → 产物守卫。
:: 逻辑都在 scripts\build_all.py，这里只负责挑解释器。
setlocal
cd /d "%~dp0"
set "PYTHONUTF8=1"

set "PY=%GA_HUB_PYTHON%"
if "%PY%"=="" (
  if exist "D:\APP\anaconda3\envs\ga\python.exe" (
    set "PY=D:\APP\anaconda3\envs\ga\python.exe"
  ) else (
    set "PY=python"
  )
)

"%PY%" scripts\build_all.py %*
exit /b %errorlevel%
