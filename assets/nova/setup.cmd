@echo off
cd /d "%~dp0"
where python >nul 2>nul || (echo Install Python 3.11+ and enable Add to PATH first. & pause & exit /b 1)
where node >nul 2>nul || (echo Install Node.js LTS first. & pause & exit /b 1)
python -m venv .venv
if errorlevel 1 goto failed
.venv\Scripts\python.exe -m pip install "aiohttp>=3.13,<4" "psutil>=6,<8" "pywin32>=308"
if errorlevel 1 goto failed
echo Setup complete. Run pair.cmd next.
pause
exit /b 0
:failed
echo Setup failed. Check the error above.
pause
exit /b 1
