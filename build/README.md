# Building installers

This directory contains everything needed to package GenericAgent-Admin into
double-clickable installers for **macOS** (`.dmg`) and **Windows** (`setup.exe`).

The launcher binary is **dual-mode**: the same executable runs as a GUI
launcher by default and as the uvicorn backend when invoked with
`--server-mode` (see `launch_webui.pyw:main`). This lets PyInstaller produce
a single bundled binary that re-spawns itself for the backend, without
shipping a Python interpreter we'd have to find at runtime.

The installers do **not** bundle GenericAgent itself — Admin runs against
whatever GA the user already has on disk, picked once on first launch via
the existing GA_ROOT discovery (`server/_paths.py`).

## Layout

```
build/
├── admin.spec        PyInstaller spec — same file used on mac and Windows
├── build_mac.sh      One-shot macOS build (npm → pyinstaller → create-dmg)
├── build_win.bat     One-shot Windows build (npm → pyinstaller → iscc)
├── installer.iss     Inno Setup script for Windows
└── README.md         this file
```

## Prerequisites

| Tool | macOS | Windows | Why |
|---|---|---|---|
| Python 3.11 or 3.12 | `brew install python@3.12` | python.org installer | Build host (not shipped to users — PyInstaller embeds its own copy) |
| Node.js LTS | `brew install node` | nodejs.org installer | `npm run build` of the React UI |
| PyInstaller >= 6.0 | `pip install --user 'pyinstaller>=6.0'` | same | Freezes Python + deps into the launcher binary |
| create-dmg | `brew install create-dmg` | — | Wraps `.app` into a styled `.dmg` |
| Inno Setup 6+ | — | `choco install innosetup` or download from jrsoftware.org | Wraps the onedir folder into a `setup.exe` |

The build scripts auto-install PyInstaller if it's missing (`pip install --upgrade`),
but expect Node and create-dmg/Inno Setup to be present.

## Building

### macOS

```sh
bash build/build_mac.sh
```

Produces:

- `build/dist/GenericAgent Admin.app` — run-in-place app bundle
- `build/GenericAgent-Admin-<version>.dmg` — drag-to-Applications installer

### Windows

```bat
build\build_win.bat
```

Produces:

- `build\dist\GenericAgent-Admin\` — onedir folder containing the `.exe`
- `build\GenericAgent-Admin-<version>-Setup.exe` — Inno Setup installer

### Version

Versions are read from `pyproject.toml` `[project].version`. Bump there;
both build scripts pick it up automatically.

## How the dual-mode binary works

`launch_webui.pyw:main` checks for `--server-mode` (or env
`GA_ADMIN_SERVER_MODE=1`) at the very top, BEFORE the GUI imports run. If
present it imports `server.run` and exits with its return code.

In dev:
- `python launch_webui.pyw` → GUI launcher → spawns `python -m server.run`
- `python launch_webui.pyw --server-mode` → uvicorn backend (drop-in for
  `python -m server.run`)

In a frozen build:
- Double-click the `.app` / `.exe` → GUI launcher → spawns
  `<self> --server-mode` (because `sys.executable` points at the frozen
  binary, not Python).

## End-user notes

These builds are **unsigned**. Tell users:

> **macOS**: Open the `.dmg`, drag "GenericAgent Admin" to Applications.
> The first time you run it, **right-click the app icon → Open** (don't
> just double-click). macOS will warn that the developer is unidentified;
> click Open to proceed. After this once, normal double-click works.
>
> **Windows**: Double-click `GenericAgent-Admin-<version>-Setup.exe`.
> If SmartScreen warns "Windows protected your PC", click "More info" →
> "Run anyway". The installer puts a shortcut in the Start Menu.

If you later get an Apple Developer account, sign + notarize by setting
`codesign_identity` in `admin.spec` and adding `--notarize` to the
`create-dmg` invocation; the SmartScreen warning on Windows requires an
EV code-signing cert to fully clear.

## Troubleshooting

**The `.app` window opens but is blank / black.**
Likely a missing pywebview platform backend. The spec lists
`webview.platforms.cocoa` and `.edgechromium` as hidden imports — verify
PyInstaller picked them up by grepping the build log for those names.

**`ModuleNotFoundError` at runtime for some `server.routes.X`.**
PyInstaller's `collect_submodules('server')` should grab everything under
`server/`, but if you've added a route that uses dynamic imports or
non-standard layouts you may need to add it explicitly to `hiddenimports`
in `admin.spec`.

**`from agentmain import …` fails.**
Expected in two situations: (a) GA_ROOT not yet picked — Admin runs in
setup mode and only `/api/setup/*` works until the user chooses a
GenericAgent directory; (b) the chosen directory isn't a real GA checkout
— `_paths.is_valid_ga_root` checks for `agentmain.py` and `memory/`.

**Build is huge (>200MB).**
`tkinter` and `test`/`unittest` are already excluded in the spec. Other
common culprits: `numpy`, `pandas`, `matplotlib`. Admin doesn't need them;
if pip pulled them in transitively, add to the `excludes` list in the spec.

**Build worked once, broken on next run.**
Stale `build/build/` cache. The build scripts now `rm -rf build/build
build/dist` before running pyinstaller, but if you're invoking pyinstaller
directly clear those by hand.
