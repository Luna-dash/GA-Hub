@echo off
:: 一键安装 GenericAgent Web 管理后台依赖（Windows）。
::
::   1) Python：pip install -e ".[webui]"
::   2) 前端：  pnpm install && pnpm build  （或 npm）
::
:: 跑完后双击 start.bat 即可。

setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "PY=python"
where %PY% >nul 2>&1 || (
  echo [ERR] 未找到 python，请先安装 Python 3.10+ ^(https://www.python.org^)
  pause & exit /b 1
)

echo == Python ==
%PY% --version

echo == Install Python deps ==
%PY% -m pip install -e . --upgrade
if errorlevel 1 (
  echo [ERR] pip install 失败
  pause & exit /b 1
)

echo == Detect Node.js ==
set "PKG="
where pnpm >nul 2>&1 && set "PKG=pnpm"
if "%PKG%"=="" (
  where npm >nul 2>&1 && set "PKG=npm"
)
if "%PKG%"=="" (
  echo [WARN] 未检测到 pnpm/npm。请先安装 Node.js 18+ ^(https://nodejs.org^) 再重跑。
  echo [WARN] 也可以只用后端：python -m server.run
  pause & exit /b 0
)
echo Using %PKG%
%PKG% -v

echo == Install webui deps ==
pushd webui
if "%PKG%"=="npm" (
  call %PKG% install --legacy-peer-deps --no-audit --no-fund
) else (
  call %PKG% install
)
if errorlevel 1 ( popd & echo [ERR] %PKG% install 失败 & pause & exit /b 1 )

echo == Build webui ==
call %PKG% run build
if errorlevel 1 ( popd & echo [ERR] %PKG% run build 失败 & pause & exit /b 1 )
popd

if not exist "webui\dist\index.html" (
  echo [ERR] 前端构建失败：webui\dist\index.html 不存在
  pause & exit /b 1
)

echo.
echo ===========================================
echo  Done. To start:  double-click start.bat
echo                  or run: %PY% launch_webui.pyw
echo ===========================================
echo.
pause
