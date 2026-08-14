# GA-Hub Tauri 2 desktop shell

This shell is the production desktop lifecycle. `launch_webui.pyw` is retained only as an explicit source-checkout migration/recovery entry while native-dialog and release acceptance work completes.

## Runtime contract

- **Development:** `npm run desktop:dev` runs Vite and Tauri. The Rust shell starts `python -m server.desktop_sidecar` (override only with `GA_HUB_PYTHON`) from this checkout.
- **Production:** build a target-specific one-file Python sidecar with `python desktop/build_sidecar.py --target <triple>`, then run `npm run desktop:build -- --target <triple>`. Tauri `externalBin` packages it beside the shell.
- The sidecar binds only loopback and asks the OS for a free port. It emits `{event:"starting", port, instance_token}`; the window is created only after `/api/desktop/ready` returns that same token.
- Each shell owns only its child. Closing the main window writes a shutdown request to the child's stdin, waits 5 seconds, and kills only that child on timeout. Port occupants and prior pywebview services are never attached to or terminated.
- `tauri-plugin-single-instance` forwards a duplicate launch to the existing window, which is shown and focused.
- Native capabilities are intentionally narrow: the Web UI can use default dialog, notification, and opener permissions. Directory choice and export destination still come from user-initiated native dialogs; export text is written only to the selected path.
- `GA_ADMIN_DATA` and `GA_ROOT` retain the backend's existing contracts. Tests should set both to disposable paths; production does not rewrite or migrate user data.

## Prerequisites

Rust/Cargo are local developer prerequisites (Rust 1.77.2 or newer); they are not installed by repository scripts. Python packaging additionally requires PyInstaller in the selected build environment. Node dependencies are installed with `npm --prefix webui ci`.

## Verification

```powershell
python -m pytest tests/test_desktop_sidecar.py tests/test_launcher_lifecycle.py
npm --prefix webui test -- --run
npm --prefix webui run build
cargo check --manifest-path src-tauri/Cargo.toml
```

A release bundle is not valid unless the matching target-specific sidecar exists in `src-tauri/binaries`. Generated executables and build output are ignored by Git.
