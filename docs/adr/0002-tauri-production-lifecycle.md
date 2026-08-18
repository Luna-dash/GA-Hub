# ADR 0002: Tauri as the Production Desktop Lifecycle

Date: 2026-08-14

## Status

Accepted. Supersedes ADR 0001's Option C coexistence policy after its implementation milestones and sidecar lifecycle acceptance. ADR 0001 remains useful history, but it no longer defines the production shell.

## Context

GA-Hub now has two shell implementations:

- A Tauri 2 supervisor that starts an owned FastAPI sidecar on an allocated loopback port, creates a local-asset window immediately, verifies a startup token through `/api/desktop/ready` in the background, forwards duplicate launches to the existing window, and owns shutdown of only that child process.
- A legacy pywebview launcher with fixed-port discovery/cleanup, tray behavior, shell-local file/dialog APIs, and considerable platform-specific recovery code.

Continuing to present both as ordinary production entry points keeps lifecycle ownership ambiguous, duplicates packaging work, and makes recovery dependent on who happened to start the backend.

## Decision

The Tauri owned-sidecar supervisor is the only supported production desktop lifecycle. pywebview is downgraded to an explicitly named migration/recovery entry point; it is not used for new production packages and will be removed after all acceptance criteria below remain satisfied through a release cycle.

The production contract is:

1. Tauri starts exactly one sidecar process tree it owns. It never adopts or kills a process by port, process name, or any identity it did not create. Windows ownership is a kill-on-close Job Object; Unix ownership is an independent process group. The sidecar also watches an explicit owner-stdin contract so an unexpected shell exit is observable as EOF; Unix arms a 12-second hard group-exit deadline after that EOF in case graceful application shutdown stalls.
2. The sidecar binds loopback on an allocated port and emits `starting` with its PID, port, and instance token.
3. The shell creates the local-asset webview with an immutable runtime identity and random loopback HTTP/WebSocket origins injected before application JavaScript, then attempts to spawn the sidecar. The frontend remains in a local startup gate until the background supervisor receives the exact same token from `/api/desktop/ready`; no API query or WebSocket starts before that transition. Sidecar lookup, antivirus, spawn, process-tree assignment, and ownership-store failures transition the visible gate to `Failed` instead of tearing down the shell.
4. Closing the main window hides it immediately. A `Running` / `Cleaning` / `AllowExit` state machine prevents every close and exit request while a background Rust worker requests graceful sidecar shutdown and waits up to five seconds for application shutdown hooks. On timeout it terminates the owned Windows job or sends TERM followed by KILL to the owned Unix process group; only after cleanup does Tauri permit exit.
5. A duplicate shell launch focuses the existing window instead of starting another backend.
6. Browser/server-only and developer modes remain available through `python -m server.run` and `npm run desktop:dev`; they are not production package lifecycles.
7. Release startup resolves its working directory from the installed executable, never from the repository path embedded at compile time. The configured GenericAgent root remains a separate backend setting persisted in `~/.genericagent-admin/config.json`.
8. Tauri asset origins and loopback development origins share one explicit HTTP CORS/WebSocket Origin policy. Opaque and external origins are rejected; command-line WebSocket clients without an Origin header remain supported.

## Migration and rollback

`start.bat` prefers a built Tauri production executable. If it is absent, it names the legacy recovery entry and exits with guidance rather than silently selecting a second production identity. macOS/Linux source startup remains on the recovery path until a corresponding Tauri artifact is distributed.

A failed production upgrade can be rolled back to the previous Tauri package. The legacy pywebview entry remains a source-checkout recovery path until deletion, and no rollback deletes or rewrites user data.

## Acceptance before pywebview removal

- Real-window startup, close, restart, duplicate-launch, and backend-crash behavior on each packaged platform.
- Owned-child exit within the shutdown deadline, with no orphaned sidecar after window close or shell crash.
- Sidecar startup-token mismatch, bind failure, timeout, and partial-upgrade recovery.
- Upgrade preserves `GA_ADMIN_DATA` and existing GA_ROOT configuration without migration.
- Native replacement or explicit acceptance decisions for directory selection, file save/open dialogs, external-link opening, notifications, and taskbar identity.
- Release-package capability/CSP review and signing/notarization result.

Static review and a successful build do not by themselves satisfy these criteria.
