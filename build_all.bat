@echo off
:: GA-Hub one-shot build (frontend, sidecar, Tauri shell, artifact guards).
:: Real logic lives in scripts\build_all.py; this launcher only picks the interpreter.
:: Keep this file ASCII-only: cmd.exe parses .bat in the OEM codepage,
:: and non-ASCII bytes here produce stray parse errors on some systems.
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
