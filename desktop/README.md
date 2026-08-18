# GA-Hub Tauri 2 desktop shell

This shell is the production desktop lifecycle. `launch_webui.pyw` is retained only as an explicit source-checkout migration/recovery entry while native-dialog and release acceptance work completes.

## Runtime contract

- **Development:** `npm run desktop:dev` runs Vite and Tauri. The Rust shell starts `python -m server.desktop_sidecar` (override only with `GA_HUB_PYTHON`) from this checkout.
- **Production:** build a target-specific one-file Python sidecar with `python desktop/build_sidecar.py --target <triple>`, then run `npm run desktop:build -- --target <triple>`. Tauri `externalBin` packages it beside the shell, and the packaged process uses the executable directory instead of a build-machine repository path.
- The sidecar binds only loopback and asks the OS for a free port. Tauri immediately opens the bundled local SPA and injects its random HTTP/WS origins plus instance identity before page JavaScript. A native startup gate keeps API queries and sockets stopped until `/api/desktop/ready` returns that exact token in the background, so the first frame no longer waits for Python imports.
- Production uses Tauri's local asset URL and hash routing; browser/server and pywebview recovery modes keep their existing same-origin clean URLs. The backend admits only explicit Tauri origins and loopback development origins for CORS/WebSockets.
- Each shell owns only its child. Closing the main window hides it immediately, then a Rust worker writes a shutdown request to the child's stdin and waits up to 5 seconds while FastAPI runs its shutdown hooks. Only a timed-out owned child is force-killed. Port occupants and prior pywebview services are never attached to or terminated.
- `tauri-plugin-single-instance` forwards a duplicate launch to the existing window, which is shown and focused.
- Native capabilities are intentionally narrow: the Web UI can use default dialog, notification, and opener permissions. Directory choice and export destination still come from user-initiated native dialogs; export text is written only to the selected path.
- On first use, the setup screen requires a valid GenericAgent directory and persists it as `ga_root` in `~/.genericagent-admin/config.json`; the desktop shell also exposes a native directory picker. This configured `GA_ROOT` is independent from the sidecar process working directory.
- `GA_ADMIN_DATA` and `GA_ROOT` retain the backend's existing contracts. Tests should set both to disposable paths; production does not rewrite or migrate user data.

## Prerequisites

Rust/Cargo are local developer prerequisites (Rust 1.85 or newer, matching the locked desktop dependency graph); they are not installed by repository scripts. Python packaging additionally requires PyInstaller in the selected build environment. Node dependencies are installed with `npm --prefix webui ci`.

## Verification

```powershell
python -m pytest tests/test_desktop_sidecar.py tests/test_launcher_lifecycle.py
npm --prefix webui test -- --run
npm --prefix webui run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

A release bundle is not valid unless the matching target-specific sidecar exists in `src-tauri/binaries`. Generated executables and build output are ignored by Git.
