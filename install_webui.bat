@echo off
:: 一键安装 GenericAgent Web 管理后台依赖（Windows）。
::
::   1) Python：pip install -r requirements.txt（构建配方、钉版本）
::   2) 前端：  npm install && npm run build  （统一 npm）
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
rem 用 requirements.txt（构建配方、钉版本）而不是 pip install -e . --upgrade：
rem pyproject 声明的是松范围，--upgrade 会把运行时依赖升到比配方更新的版本。
%PY% -m pip install -r requirements.txt
if errorlevel 1 (
  echo [ERR] pip install 失败
  pause & exit /b 1
)
%PY% -m pip install -e . --no-deps
if errorlevel 1 (
  echo [ERR] pip install -e . 失败
  pause & exit /b 1
)

echo == Detect Node.js ==
set "PKG="
rem 统一使用 npm（主路径）；pnpm 仅作无 npm 环境的兜底
where npm >nul 2>&1 && set "PKG=npm"
if "%PKG%"=="" (
  where pnpm >nul 2>&1 && set "PKG=pnpm"
)
if "%PKG%"=="" (
  echo [WARN] 未检测到 npm/pnpm。请先安装 Node.js 18+ ^(https://nodejs.org^) 再重跑。
  echo [WARN] 也可以只用后端：python -m server.run
  pause & exit /b 0
)
echo Using %PKG%
rem 必须带 call：Windows 上 npm/pnpm 是 .cmd，批处理里不带 call 直接调会**交出控制权
rem 且永不返回** —— 脚本会在这里静默结束（退出码还是 0），前端依赖与构建一条都不跑。
call %PKG% -v

echo == Install webui deps ==
pushd webui
if "%PKG%"=="npm" (
  rem 用 npm ci 而不是 npm install：实测 npm install（哪怕已同步）会改写已跟踪的
  rem webui/package-lock.json（把一堆 peer:true 翻成 dev:true），把工作区弄脏。
  rem --legacy-peer-deps 保留：安装机上的 npm 版本可能与锁文件解析有差异。
  call %PKG% ci --legacy-peer-deps --no-audit --no-fund
) else (
  call %PKG% install
)
if errorlevel 1 ( popd & echo [ERR] %PKG% ci 失败 & pause & exit /b 1 )

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
echo                  (desktop build: build_all.bat)
echo  Browser mode :  %PY% -m server.run
echo ===========================================
echo.
pause
