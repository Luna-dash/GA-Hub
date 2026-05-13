@echo off
:: 双击启动 GA-Hub Web 管理后台 (Windows)。
:: 第一次跑前请先执行 install_webui.bat。
::
:: mykey.py 不在 admin 这边 — 由 launch_webui.pyw 通过 GA_ROOT 找到
:: GenericAgent 主项目目录后再 import，这里不做检查。

cd /d "%~dp0"

:: 尝试激活 conda ga 环境（如果 conda 可用）
call "%USERPROFILE%\APP\anaconda3\condabin\conda.bat" activate ga 2>nul
if errorlevel 1 (
  where python >nul 2>&1 || (
    echo 未找到 python，请先安装 Python 3.10+ ^(https://www.python.org^)
    pause & exit /b 1
  )
)

start "" pythonw launch_webui.pyw
