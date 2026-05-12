@echo off
:: 双击启动 GenericAgent Web 管理后台 (Windows)。
:: 第一次跑前请先执行 install_webui.bat。
::
:: 使用 conda ga 环境启动，避免双击时落到系统 Python。

cd /d "%~dp0"

call "D:\APP\anaconda3\condabin\conda.bat" activate ga
if errorlevel 1 (
  echo [ERR] 激活 conda 环境 ga 失败
  pause & exit /b 1
)

where python >nul 2>&1 || (
  echo [ERR] 未找到 ga 环境内的 python
  pause & exit /b 1
)

where pythonw >nul 2>&1 || (
  echo [ERR] 未找到 ga 环境内的 pythonw
  pause & exit /b 1
)

start "" pythonw launch_webui.pyw
