# GA-Hub Tauri 2 desktop shell

This shell is the production desktop lifecycle and the only desktop entry. The legacy pywebview launcher (`launch_webui.pyw`) has been retired; browser mode remains available via `python -m server.run`. One-shot delivery builds go through the repo-root `build_all.bat` / `build_all.command`, which wrap `scripts/build_all.py`.

## Runtime contract

- **Development:** `npm run desktop:dev` runs Vite and Tauri. The Rust shell starts `python -m server.desktop_sidecar` (override only with `GA_HUB_PYTHON`) from this checkout.
- **Production:** build a target-specific one-file Python sidecar with `python desktop/build_sidecar.py --target <triple>`, then run `npm run desktop:build -- --target <triple>`. Tauri `externalBin` packages it beside the shell, and the packaged process uses the executable directory instead of a build-machine repository path. The release artifact is canonical only under `src-tauri/target/<triple>/release/`; never run a bare `tauri build` without `--target` (a host-target `target/release/` copy would recreate the duplicate-entry problem).
- **In-place restart:** the `restart_backend` command stops the owning sidecar (same stdin shutdown protocol as window close) and respawns it with the identical port/instance token, so the SPA's injected runtime config stays valid. Restarts are only accepted from Ready/Failed phases — Spawning/Running still belong to the live supervisor thread, and shutdown coordination keeps its existing exclusivity.
- Tauri first allocates a loopback port and random instance identity, opens the bundled local SPA, and injects the HTTP/WS origins before page JavaScript. It then starts the sidecar. A native startup gate keeps API queries and sockets stopped until `/api/desktop/ready` returns that exact token in the background, so the first frame no longer waits for Python imports; missing, blocked, or otherwise unstartable sidecars are reported inside the already-visible startup screen instead of terminating the shell.
- Production uses Tauri's local asset URL and hash routing; browser/server mode keeps its same-origin clean URLs. The backend admits only explicit Tauri origins and loopback development origins for CORS/WebSockets.
- Each shell owns only the process tree it created. The sidecar receives `--owned-stdin`, so an unexpected shell exit closes the owner pipe. Windows assigns the child and descendants to a kill-on-close Job Object; Unix launches it in an independent process group, requests graceful shutdown on owner EOF, and arms a 12-second hard group-exit deadline. Closing the main window hides it immediately, enters a single `Cleaning` phase, then a Rust worker writes a shutdown request and waits up to 5 seconds while FastAPI runs its shutdown hooks. A timed-out Windows job is terminated as a unit; a timed-out Unix group receives TERM and then KILL. Repeated close/exit requests remain blocked until cleanup enters `AllowExit`. Port occupants are never attached to or terminated.
- `tauri-plugin-single-instance` forwards a duplicate launch to the existing window, which is shown and focused.
- Native capabilities are intentionally narrow: the Web UI can use default dialog, notification, and opener permissions. Directory choice and export destination still come from user-initiated native dialogs; export text is written only to the selected path.
- On first use, the setup screen requires a valid GenericAgent directory and persists it as `ga_root` in `~/.genericagent-admin/config.json`; the desktop shell also exposes a native directory picker. This configured `GA_ROOT` is independent from the sidecar process working directory.
- `GA_ADMIN_DATA` and `GA_ROOT` retain the backend's existing contracts. Tests should set both to disposable paths; production does not rewrite or migrate user data.

## Prerequisites

Rust/Cargo are local developer prerequisites (Rust 1.85 or newer, matching the locked desktop dependency graph); they are not installed by repository scripts. Python packaging additionally requires PyInstaller in the selected build environment. Node dependencies are installed with `npm --prefix webui ci`.

## Verification

```powershell
python -m pytest tests/test_desktop_sidecar.py
npm --prefix webui test -- --run
npm --prefix webui run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

A release bundle is not valid unless the matching target-specific sidecar exists in `src-tauri/binaries`. Generated executables and build output are ignored by Git.
