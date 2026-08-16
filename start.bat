@echo off
:: Launch the production Tauri shell on Windows.
:: If this is a source checkout without a production artifact, start the
:: pywebview/WebUI recovery entry instead of exiting silently.

setlocal
cd /d "%~dp0"

set "TAURI_APP=src-tauri\target\release\ga-hub-desktop.exe"
if exist "%TAURI_APP%" (
  start "" "%TAURI_APP%"
  exit /b 0
)

set "TAURI_APP=src-tauri\target\x86_64-pc-windows-msvc\release\ga-hub-desktop.exe"
if exist "%TAURI_APP%" (
  start "" "%TAURI_APP%"
  exit /b 0
)

:: Explorer/hidden-VBS launches may not have the conda environment on PATH.
set "LAUNCHER=%~dp0launch_webui.pyw"
set "GA_PYTHONW=D:\APP\anaconda3\envs\ga\pythonw.exe"
if exist "%GA_PYTHONW%" (
  start "GA-Hub" /b "%GA_PYTHONW%" "%LAUNCHER%"
  exit /b 0
)

where pythonw.exe >nul 2>&1
if not errorlevel 1 (
  start "GA-Hub" /b pythonw.exe "%LAUNCHER%"
  exit /b 0
)

echo GA-Hub launcher unavailable: neither Tauri nor pythonw was found.
exit /b 1
