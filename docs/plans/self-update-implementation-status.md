# Gyra (GA-Hub) self-update implementation status (DATA_EPOCH = 2)

## Current architecture (Wave 4 — pure-Rust green updater + `--onedir` sidecar)

The legacy PyInstaller update helper (`updates/bin/ga-hub-update.exe`), Windows Scheduled Task (`GAHub-Update-*`), `handoff.json`, and 60-second countdown ceremony have been retired.

Ongoing portable updates use a lightweight (~600 KB) pure-Rust `ga-hub-update.exe` shipped directly beside `ga-hub-desktop.exe` and the `--onedir` `sidecar/` directory:

- **Deliverable layout (`schema: 2`, `data_epoch: 2`, `layout: "onedir"`)**:
  - `ga-hub-desktop.exe`
  - `ga-hub-update.exe`
  - `sidecar/ga-hub-sidecar.exe` + `sidecar/_internal/`
  - `build-info.json` / `update-manifest.json` / `README.txt` (in release ZIPs; local `build_all.py` builds carry version in `gahub_sidecar_bundle.json`)
- **Sources**:
  - Official stable GitHub Releases (`Luna-dash/GA-Hub`, pinned HTTPS allowlist + `SHA256SUMS.txt` + `build-info.json` verification)
  - Explicitly trusted local ZIP packages (`POST /api/updates/prepare`, optional external SHA-256 + full internal manifest SHA-256 verification)
- **One-click switch & automatic rollback**:
  1. `POST /api/updates/apply` verifies the candidate hashes, transitions `state.json` to `switching` (`switch_started: false`) **before** launching detached `ga-hub-update.exe switch`, and restores `prepared` if process launch fails.
  2. `ga-hub-update.exe` re-verifies every file's SHA-256 (recording `failed` with `switch_started: false` on any pre-switch failure), sends `WM_CLOSE` to the old desktop PID and waits up to 15s for graceful exit, atomically updates `current.json` via `MoveFileExW`, and launches the candidate with `GA_HUB_UPDATE_NONCE` + `GA_HUB_UPDATE_RECEIPT`.
  3. Health verification requires both a matching startup receipt and HTTP 200 from `GET /api/updates/ready` with matching `X-Update-Nonce` and `ready || diagnostic_ready == true`.
  4. On success, `state.json` transitions to `succeeded` and stale candidate directories (keeping at most 1 previous version) are pruned. On failure, `current.json` is atomically restored, `state.json` transitions to `rolled_back`, and `--old-exe` is relaunched.
- **Shortcut redirect & manual recovery**:
  - Launching `ga-hub-desktop.exe` (including via `start.bat`) runs `follow_current_update()`, redirecting to `updates/current.json` via the sibling `ga-hub-update.exe launch` when a managed update exists.
  - Pre-switch failures (`state: "failed", switch_started: false`) can be cleared directly in Settings → Updates. Unresolved failures can be cleared manually after all instances exit via `ga-hub-update.exe --admin-data <dir> recover [--plan <id>]`.
