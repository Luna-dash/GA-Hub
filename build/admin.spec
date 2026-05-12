# PyInstaller spec for GA-Hub desktop installer.
#
# Build:
#     pyinstaller build/admin.spec --noconfirm
#
# Output:
#     macOS:    build/dist/GenericAgent Admin.app
#     Windows:  build/dist/GA-Hub/  (folder + .exe inside)
#
# Same launcher binary serves two roles via argv dispatch (see
# launch_webui.pyw:main): default = GUI launcher, `--server-mode` = uvicorn
# backend. PyInstaller can't fork a Python interpreter from a frozen .app, so
# we re-spawn the same binary with the flag instead.
#
# Onedir mode (NOT onefile) �?_MEIPASS is fixed-on-disk, so the launcher
# re-spawn is instant. Onefile would re-extract on every spawn (~1s × 2).

# ruff: noqa  (PyInstaller specs run as Python in their own context)

import os
import sys
from pathlib import Path
from PyInstaller.utils.hooks import collect_submodules, collect_data_files

ROOT = Path(SPECPATH).parent.resolve()  # GA-Hub/
ENTRY = str(ROOT / "launch_webui.pyw")

# ── data: built frontend + any package data ───────────────────────
datas = []

dist_dir = ROOT / "webui" / "dist"
if not dist_dir.is_dir():
    raise SystemExit(
        f"[admin.spec] webui/dist/ not found at {dist_dir} �?"
        f"run `npm --prefix webui run build` before pyinstaller."
    )
datas.append((str(dist_dir), "webui/dist"))

# pywebview ships HTML/CSS shims for some platform backends �?collect them.
datas += collect_data_files("webview", include_py_files=False)

# ── hidden imports ────────────────────────────────────────────────
# uvicorn/asyncio import their workers via strings; PyInstaller can't see
# those statically. apscheduler triggers/executors are likewise dynamic.
hiddenimports = []
hiddenimports += collect_submodules("server")          # server.routes.*, server.services.*
hiddenimports += collect_submodules("uvicorn")
hiddenimports += collect_submodules("websockets")
hiddenimports += collect_submodules("apscheduler")
# pywebview platform backends �?only the host platform needs them but
# listing both is harmless (PyInstaller skips ones that fail to import).
hiddenimports += [
    "webview.platforms.cocoa",
    "webview.platforms.edgechromium",
    "webview.platforms.mshtml",
    "webview.platforms.winforms",
    "webview.platforms.gtk",
    "webview.platforms.qt",
]
# pywebview's Windows backend uses pythonnet (clr_loader �?pycparser �?# cffi); PyInstaller usually catches these via collect_submodules but
# they're occasionally missed when pywebview imports lazily.
if sys.platform == "win32":
    hiddenimports += [
        "clr_loader",
        "pythonnet",
        "cffi",
        "_cffi_backend",
    ]
    # pystray powers the system-tray icon on Windows. Its backend is
    # selected at import time via __init__ machinery PyInstaller can't see
    # statically, so list both the package and the win32 backend module.
    hiddenimports += collect_submodules("pystray")
# Misc shims uvicorn/anyio occasionally import indirectly.
hiddenimports += [
    "uvicorn.lifespan.on",
    "uvicorn.lifespan.off",
    "uvicorn.loops.auto",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.logging",
    "anyio._backends._asyncio",
]

# ── analysis ──────────────────────────────────────────────────────
a = Analysis(
    [ENTRY],
    pathex=[str(ROOT)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=[
        "tkinter",            # not used; saves ~30MB on mac
        "test",
        "unittest",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

# ── exe ───────────────────────────────────────────────────────────
APP_NAME = "GA-Hub"

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name=APP_NAME,
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,           # no terminal window on win/mac launch
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,  # unsigned; users right-click �?open on first run
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name=APP_NAME,
)

# ── macOS .app bundle ─────────────────────────────────────────────
if sys.platform == "darwin":
    app = BUNDLE(
        coll,
        name="GenericAgent Admin.app",
        icon=None,           # add build/icon.icns later if desired
        bundle_identifier="com.genericagent.admin",
        info_plist={
            "CFBundleName": "GenericAgent Admin",
            "CFBundleDisplayName": "GenericAgent Admin",
            "CFBundleShortVersionString": "0.2.8",
            "CFBundleVersion": "0.2.8",
            "LSUIElement": False,           # show in Dock + menu bar
            "LSMinimumSystemVersion": "11.0",
            "NSHighResolutionCapable": True,
            "NSRequiresAquaSystemAppearance": False,
            # AppleEvents permission for the osascript activation bridge
            # (`tell application "System Events" to set frontmost of …`).
            # Without this prompt text the OS shows a generic dialog.
            "NSAppleEventsUsageDescription":
                "GenericAgent Admin uses System Events to bring its window to the front on first launch.",
        },
    )

    # Helper bundle for headless backend subprocesses. Sharing ``coll``
    # means the same binaries / Python modules are reused �?only the
    # Info.plist differs. The build script (build/build_mac.sh) nests
    # this .app into the main app's ``Contents/Frameworks/`` so users
    # only see one bundle in /Applications.
    #
    # Why we need it: PyInstaller's frozen launcher inherits the parent
    # bundle's Info.plist. Spawning ``sys.executable --server-mode`` from
    # the main .app gives the backend a Dock icon (the user sees what
    # looks like a duplicate app). The helper has ``LSUIElement=True``
    # so it stays off the Dock entirely. ``launch_webui.py``'s
    # ``_helper_executable()`` resolves the nested binary at runtime.
    helper = BUNDLE(
        coll,
        name="GenericAgent Admin Helper.app",
        icon=None,
        bundle_identifier="com.genericagent.admin.helper",
        info_plist={
            "CFBundleName": "GenericAgent Admin Helper",
            "CFBundleDisplayName": "GenericAgent Admin Helper",
            "CFBundleShortVersionString": "0.2.8",
            "CFBundleVersion": "0.2.8",
            "LSUIElement": True,            # no Dock icon, no menu bar
            "LSBackgroundOnly": False,      # still allowed to draw windows if needed
            "LSMinimumSystemVersion": "11.0",
            "NSHighResolutionCapable": True,
        },
    )
