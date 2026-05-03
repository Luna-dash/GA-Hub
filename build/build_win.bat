@echo off
rem Build a Windows installer (setup.exe) for GenericAgent-Admin.
rem
rem Prerequisites (one-time):
rem   * Python 3.11 or 3.12 with pip on PATH
rem   * Node.js LTS                                  (for `npm run build`)
rem   * Inno Setup 6+                                https://jrsoftware.org/isdl.php
rem   * pyinstaller (auto-installed if missing)
rem
rem Usage:
rem   build\build_win.bat
rem
rem Output:
rem   build\dist\GenericAgent-Admin\        onedir folder + .exe (run-in-place)
rem   dist\GenericAgent-Admin-<ver>-Setup.exe   Inno Setup installer

setlocal enabledelayedexpansion

cd /d "%~dp0\.."

rem ── version from pyproject.toml ─────────────────────────────────
for /f "delims=" %%v in ('python -c "import tomllib;print(tomllib.load(open(\"pyproject.toml\",\"rb\"))[\"project\"][\"version\"])"') do set VERSION=%%v
echo Building GenericAgent-Admin %VERSION%

rem ── 1/4 build webui ────────────────────────────────────────────
echo.
echo ==^> [1/4] Building webui (npm)
pushd webui
if not exist node_modules (
    call npm ci || goto :error
)
call npm run build || goto :error
popd

rem ── 2/4 clean ──────────────────────────────────────────────────
echo.
echo ==^> [2/4] Cleaning previous build output
if exist build\build rmdir /s /q build\build
if exist build\dist rmdir /s /q build\dist
if exist build\GenericAgent-Admin-%VERSION%-Setup.exe del /q build\GenericAgent-Admin-%VERSION%-Setup.exe

rem ── 3/4 pyinstaller ────────────────────────────────────────────
echo.
echo ==^> [3/4] Running pyinstaller
python -c "import PyInstaller" 2>nul
if errorlevel 1 (
    echo     pyinstaller missing - installing
    python -m pip install --upgrade "pyinstaller>=6.0" || goto :error
)
python -m PyInstaller build\admin.spec --noconfirm --workpath build\build --distpath build\dist || goto :error

if not exist "build\dist\GenericAgent-Admin\GenericAgent-Admin.exe" (
    echo ERROR: GenericAgent-Admin.exe not produced - check pyinstaller log above
    goto :error
)

rem ── 4/4 Inno Setup ─────────────────────────────────────────────
echo.
echo ==^> [4/4] Running Inno Setup compiler
set "ISCC="
if exist "%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe" set "ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
if not defined ISCC if exist "%ProgramFiles%\Inno Setup 6\ISCC.exe" set "ISCC=%ProgramFiles%\Inno Setup 6\ISCC.exe"
if not defined ISCC where iscc >nul 2>nul && set "ISCC=iscc"

if not defined ISCC (
    echo     Inno Setup not found.
    echo     Install from: https://jrsoftware.org/isdl.php
    echo     The onedir build is still usable directly:
    echo         build\dist\GenericAgent-Admin\GenericAgent-Admin.exe
    exit /b 0
)

"%ISCC%" /Qp build\installer.iss || goto :error

echo.
echo OK.
echo    EXE:   build\dist\GenericAgent-Admin\GenericAgent-Admin.exe
echo    Setup: build\GenericAgent-Admin-%VERSION%-Setup.exe
exit /b 0

:error
echo.
echo BUILD FAILED. See messages above.
exit /b 1
