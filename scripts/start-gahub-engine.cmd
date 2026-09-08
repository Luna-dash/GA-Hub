@echo off
rem External GA-Hub engine launcher (idempotent "ensure engine" entry).
rem
rem Keeps the gahub_app engine process OUT of the ga-hub-sidecar parent chain:
rem Huorong's file/behavior protection suspends script interpreters spawned by
rem the PyInstaller sidecar (its trust-zone exemption does NOT cover this),
rem which made every hub-driven engine spawn hang with zero output until the
rem 60s health timeout. From this launcher the parent chain is
rem wscript/explorer -> cmd -> python, which runs untouched, and the hub
rem reuses a healthy engine on 18770 instead of spawning its own.
rem
rem Logic: if an engine already answers /health, do nothing. Otherwise kill
rem every stale gahub_app python (a hung one may hold the 18766 singleton
rem lock) and start a fresh engine. Env matches
rem server/services/conductor_client.py::_engine_spawn_env().
setlocal
set "GAHUB_DELIVERABLE_ROOTS=D:\study\GA,C:\Users\lunagent\GA-Deliverables"
set "GAHUB_JOURNAL_PATH=C:\Users\lunagent\.genericagent-admin\gahub_journal\journal.jsonl"
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 'http://127.0.0.1:18770/health'; if ($r.StatusCode -eq 200) { exit 0 } } catch { }; Get-CimInstance Win32_Process -Filter \"Name like 'python%%'\" | Where-Object { $_.CommandLine -match 'gahub_app' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; exit 1"
if %ERRORLEVEL% EQU 0 exit /b 0
"D:\APP\anaconda3\envs\ga\python.exe" -u "D:\study\GA\frontends\gahub_app.py" --host 127.0.0.1 --port 18770 >> "%TEMP%\gahub_app.log" 2>&1
endlocal
