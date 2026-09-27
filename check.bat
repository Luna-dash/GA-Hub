@echo off
:: GA-Hub 本机校验入口（提交前跑这一套）。
::
::   1) 安装 Python 依赖（requirements.txt = 构建配方）
::   2) 前端：依赖 + 单测 + 类型检查 + API 契约 + 生产构建
::   3) pytest（后端 —— 需要 GA 核心仓库，见下面的提示）
::
:: 顺序不是随意的：tests/test_backend_api_smoke.py 的
:: test_built_spa_deep_link_and_hashed_entry_asset 断言 webui/dist 里的构建产物，
:: 所以**前端生产构建必须排在 pytest 之前** —— 否则新克隆上第 3 步必红。
::
:: 发布前的全量验证与打包是另一条链：python scripts\build_all.py --full
:: （口径与边界见 docs/BUILD.md）

setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "PY=python"
where %PY% >nul 2>&1 || (
  echo [ERR] 未找到 python，请先安装 Python 3.10+
  exit /b 1
)

echo == Python ==
%PY% --version

echo == Install Python deps ==
rem 用 requirements.txt（唯一可复现安装清单，钉版本），**不要**用
rem `pip install -e .[dev] --upgrade`：pyproject 声明的是松范围，--upgrade 会把运行时
rem 依赖升到比构建配方更新的版本 —— 于是"提交前检查"会悄悄改变 PyInstaller 打包进去
rem 的东西。dev 工具链（pytest/httpx）已在 requirements.txt 里。
%PY% -m pip install -r requirements.txt
if errorlevel 1 exit /b 1
%PY% -m pip install -e . --no-deps
if errorlevel 1 exit /b 1

echo == Detect Node.js package manager ==
set "PKG="
rem 统一使用 npm（主路径）；pnpm 仅作无 npm 环境的兜底
where npm >nul 2>&1 && set "PKG=npm"
if "%PKG%"=="" (
  where pnpm >nul 2>&1 && set "PKG=pnpm"
)
if "%PKG%"=="" (
  echo [ERR] 未检测到 npm/pnpm，请先安装 Node.js 18+
  exit /b 1
)
echo Using %PKG%
rem 必须带 call：Windows 上 npm/pnpm 是 .cmd，批处理里不带 call 直接调会**交出控制权
rem 且永不返回** —— 脚本会在这里静默结束、退出码还是 0（前端那半套一条都不跑）。
call %PKG% -v

pushd webui
echo == Install frontend deps ==
if "%PKG%"=="npm" (
  rem 与 CI / build_all 同一口径：plain npm ci（锁文件是冻结的，--legacy-peer-deps
  rem 会绕过锁文件校验；本链实测无需它）
  call %PKG% ci --no-audit --no-fund
) else (
  rem 纯 pnpm 环境兜底：不冻结锁文件
  call %PKG% install
)
if errorlevel 1 ( popd & exit /b 1 )

echo == Frontend tests ==
call %PKG% test -- --run
if errorlevel 1 ( popd & exit /b 1 )

echo == Frontend type-check ==
call %PKG% run lint
if errorlevel 1 ( popd & exit /b 1 )

echo == Frontend API contract ==
call %PKG% run api:check
if errorlevel 1 ( popd & exit /b 1 )

echo == Frontend build ==
call %PKG% run build
if errorlevel 1 ( popd & exit /b 1 )
popd

echo == Pytest ==
rem 后端套件需要 GA 核心仓库（agentmain/frontends）：把 GA_ROOT 指过去，或把 GA 克隆到
rem 与本仓库同级（默认 ..\GA）。没有它，pytest 会在采集期就中断（17 errors / 0 passed）。
rem 它还需要上一步产出的 webui/dist（test_backend_api_smoke 断言构建后的 SPA）。
%PY% -m pytest -q
if errorlevel 1 exit /b 1

echo.
echo [OK] All checks passed.
