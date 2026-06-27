@echo off
:: Run the full local validation suite for GA-Hub.
::
::   1) Install Python runtime + dev dependencies
::   2) Run pytest
::   3) Run frontend type-check
::   4) Run frontend production build

setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "PY=python"
where %PY% >nul 2>&1 || (
  echo [ERR] 未找到 python，请先安装 Python 3.10+
  exit /b 1
)

echo == Python ==
%PY% --version

echo == Install Python dev deps ==
%PY% -m pip install -e ".[dev]" --upgrade
if errorlevel 1 exit /b 1

echo == Pytest ==
%PY% -m pytest -q
if errorlevel 1 exit /b 1

echo == Detect Node.js package manager ==
set "PKG="
where pnpm >nul 2>&1 && set "PKG=pnpm"
if "%PKG%"=="" (
  where npm >nul 2>&1 && set "PKG=npm"
)
if "%PKG%"=="" (
  echo [ERR] 未检测到 pnpm/npm，请先安装 Node.js 18+
  exit /b 1
)
echo Using %PKG%
%PKG% -v

pushd webui
echo == Install frontend deps ==
if "%PKG%"=="npm" (
  call %PKG% install --legacy-peer-deps --no-audit --no-fund
) else (
  call %PKG% install
)
if errorlevel 1 ( popd & exit /b 1 )

echo == Frontend type-check ==
call %PKG% run lint
if errorlevel 1 ( popd & exit /b 1 )

echo == Frontend build ==
call %PKG% run build
if errorlevel 1 ( popd & exit /b 1 )
popd

echo.
echo [OK] All checks passed.
