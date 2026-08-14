# ADR 0002: Tauri as the Production Desktop Lifecycle

Date: 2026-08-14

## Status

Accepted. Supersedes ADR 0001's Option C coexistence policy after its implementation milestones and sidecar lifecycle acceptance. ADR 0001 remains useful history, but it no longer defines the production shell.

## Context

GA-Hub now has two shell implementations:

- A Tauri 2 supervisor that starts an owned FastAPI sidecar on an allocated loopback port, verifies a startup token through `/api/desktop/ready`, creates the window only after readiness, forwards duplicate launches to the existing window, and owns shutdown of only that child process.
- A legacy pywebview launcher with fixed-port discovery/cleanup, tray behavior, shell-local file/dialog APIs, and considerable platform-specific recovery code.

Continuing to present both as ordinary production entry points keeps lifecycle ownership ambiguous, duplicates packaging work, and makes recovery dependent on who happened to start the backend.

## Decision

The Tauri owned-sidecar supervisor is the only supported production desktop lifecycle. pywebview is downgraded to an explicitly named migration/recovery entry point; it is not used for new production packages and will be removed after all acceptance criteria below remain satisfied through a release cycle.

The production contract is:

1. Tauri starts exactly one sidecar it owns. It never adopts or kills a process by port, process name, or any identity it did not create.
2. The sidecar binds loopback on an allocated port and emits `starting` with its PID, port, and instance token.
3. The shell creates the webview only after the same token is returned by `/api/desktop/ready`.
4. Closing the main window requests graceful sidecar shutdown, waits five seconds, then kills only that owned child.
5. A duplicate shell launch focuses the existing window instead of starting another backend.
6. Browser/server-only and developer modes remain available through `python -m server.run` and `npm run desktop:dev`; they are not production package lifecycles.

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
