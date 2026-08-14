@echo off
:: Launch the production Tauri shell on Windows.
:: If this is a source checkout without a production artifact, use
:: launch_webui.pyw explicitly as the legacy migration/recovery entry.

setlocal
cd /d "%~dp0"

set "TAURI_APP=src-tauri\target\release\ga-hub.exe"
if exist "%TAURI_APP%" (
  start "" "%TAURI_APP%"
  exit /b 0
)

echo GA-Hub Tauri production executable not found: %TAURI_APP%
echo Build it with: npm run desktop:build
echo Recovery entry: pythonw launch_webui.pyw
exit /b 1
