# ADR 0001: Tauri Desktop Lifecycle and Progressive Replacement

- **Status:** Proposed
- **Date:** 2026-08-04
- **Scope:** Desktop packaging, local service lifecycle, and the transition from the existing pywebview shell to a Tauri shell.

## Context

The product has an existing pywebview startup entry, a FastAPI HTTP/WS service, and a Web UI with static mounting and API routes. The exact entry points, route names, and static-mount details remain implementation facts to be checked against source before an integration change. This ADR defines a safe desktop-lifecycle direction without asserting that a Tauri build or runtime has already been exercised.

A desktop shell must make the relationship between the window, the local backend, and user data explicit. It must also behave predictably when a user starts the application twice, when a configured port is occupied, when a window closes, when a backend stops unexpectedly, and when an upgrade is interrupted. Development needs short feedback loops and inspectable processes; production needs a controlled bundle, bounded permissions, recoverability, and upgrade behavior.

## Decision drivers

1. Preserve the currently usable pywebview path while the new shell is being prepared.
2. Keep local HTTP and WebSocket behavior observable and independently diagnosable.
3. Avoid silently broadening filesystem, navigation, or shell privileges in a desktop webview.
4. Make startup, shutdown, recovery, and data ownership deterministic.
5. Separate documented design from later Rust/Tauri installation and runtime evidence.

## Options considered

### Option A: Tauri supervises a packaged FastAPI sidecar

Tauri would launch, monitor, and stop a packaged FastAPI process, then load the local Web UI through the sidecar endpoint. Production packaging is cohesive and can give users one apparent application. The tradeoff is a larger packaging and signing surface, platform-specific process supervision, and more difficult diagnosis while the current Python entry and service contracts are still being verified. Development also needs a reliable distinction between a packaged sidecar and a developer-run backend.

### Option B: Tauri only connects to a separately launched local backend

Tauri would be a thin shell and would connect to a backend started by another command or launcher. This keeps the shell simple and can make backend logs and iteration convenient. It makes the desktop experience fragile: users must understand another lifecycle, stale processes can survive, ports can drift, and upgrade and recovery responsibilities are split across tools. It is useful as a temporary developer mode, not as the sole production lifecycle.

### Option C: Tauri coexists with pywebview and progressively replaces it

The existing pywebview shell remains a supported path while a Tauri shell is developed against the same Web UI and FastAPI contracts. Development can compare both shells and isolate shell-specific defects. Production can introduce Tauri incrementally after lifecycle, permission, and upgrade evidence exists. The cost is a period of duplicate launch paths, explicit mode selection, and a need to avoid claiming parity before both paths are tested.

## Decision

Choose **Option C: coexistence with progressive replacement**. The first phase is documentation and non-Rust preparation. pywebview remains the reference operational path while Tauri integration contracts, configuration, capability boundaries, and acceptance tests are prepared. Tauri may become the preferred production shell only after the acceptance evidence in this ADR is collected; this ADR does not authorize that promotion.

In development, both shells may target the same developer-controlled backend, with the shell mode and addresses visible in configuration and logs. This favors iteration and comparison over one-click convenience. In production, the selected shell must own or invoke a defined backend lifecycle rather than relying on an unexplained background process. A separately launched backend is retained only as an explicit developer or recovery mode.

## Address and configuration strategy

The Web UI address is a configurable local origin. In development it may use the frontend development server or the backend's static mount, as applicable to the source-verified setup. In production it uses the packaged/static Web UI location or the local FastAPI HTTP origin selected by the packaging design; the final choice is a release-specific, source-verified setting.

FastAPI HTTP and WebSocket traffic use one configured local bind address and an allocated port. The HTTP health endpoint and WebSocket endpoint must be recorded by the backend's actual routes before implementation. The pywebview and Tauri API surfaces are shell-local APIs, not substitutes for the FastAPI HTTP/WS contract; shell-specific bridge names remain to be verified from implementation.

Development defaults should use an explicit, documented port range and allow an override through the existing project configuration mechanism or an environment variable, whichever source is confirmed in code. Production should prefer a reserved per-application local port or a safe dynamically selected port communicated to the shell, with the selected value recorded in startup logs. No hard-coded port is treated as a verified fact by this ADR.

Configuration precedence, if already present, must be confirmed from source. Until then, the planned order is explicit command-line or launcher override, environment/config file, then documented default. Secrets are not part of this ADR and must never be placed in the document or logs.

## Lifecycle and operations

- Startup waits for the FastAPI health check before loading or declaring the Web UI ready; a timeout reports the selected address and actionable logs without exposing secrets.
- HTTP and WebSocket readiness are checked separately when the implementation distinguishes them; a passing HTTP check must not be used as proof that a WebSocket session works.
- Backend stdout/stderr and shell events go to an application log location with rotation or bounded retention defined by the implementation. Logs identify mode, address, lifecycle transitions, and failure cause.
- Closing the last application window requests an orderly backend shutdown when the shell owns that backend. The process is given a bounded graceful period before a targeted, verified fallback; unrelated processes are never touched.
- A window close must not silently delete user data or terminate a backend owned by another explicitly running session.
- Upgrade steps preserve the declared data directory, make migrations explicit, and retain a recovery path if an upgrade fails. Binary replacement and data migration are separate concerns.
- On backend failure, the shell shows a recoverable error, records the exit state, and may perform a bounded restart only when ownership and restart limits are known. Infinite restart loops are prohibited.
- Port conflict handling must fail clearly or choose an allowed alternative, then pass the actual address to the shell. It must not attach to an unknown process merely because a port responds.
- Repeated launch detection uses an application-specific single-instance mechanism and an explicit handoff/focus policy. It must not infer ownership from a generic Python process name.
- The data directory is application-scoped, separately documented from logs and binaries, and selected through the platform-appropriate user-data configuration. Temporary runtime files are distinct from durable user data.
- The two shell modes must not share mutable runtime state in a way that permits concurrent migration or corrupts a session; session and lock ownership are explicit.

## Security and shell boundaries

The initial Tauri capability set is minimal and default-deny. Only the window and APIs required by the verified Web UI are granted; permissions are added one at a time with a reason and an acceptance check. No broad filesystem, process, network, or shell capability is granted for convenience.

The CSP is restrictive and is derived from the actual Web UI resources and FastAPI origin. Inline code, arbitrary remote scripts, and wildcard origins are disallowed unless a source-verified requirement is documented and narrowly scoped. Navigation is limited to the application origin and approved local routes.

External links are opened through an explicit user action and an approved system-browser path, not by allowing arbitrary in-window navigation. The application does not silently follow untrusted redirects into a privileged shell context.

Filesystem access is limited to the application data locations and specific user-selected files required by a verified feature. Shell or command execution is disabled by default; if a future feature needs it, the command, arguments, origin, and result handling require a separate review. In particular, lifecycle cleanup must **never** batch-kill Python processes by process name. Only a process identity owned by this application and verified at the time of action may be targeted.

## Rust/Cargo boundary

Rust and Cargo are currently a missing prerequisite for the Tauri phase. The current phase performs documentation, source-contract inventory, configuration design, and other non-Rust preparation only. It does not install Rust or Cargo, build Tauri, launch a Tauri window, or claim a Tauri runtime result.

A later phase requires explicit authorization to install the toolchain, a reproducible environment check, and build gates for capabilities, CSP, packaging, and lifecycle behavior. A successful build alone is not runtime evidence. Any future report must distinguish static review, build output, and real-window/process observations.

## Explicit non-goals

This ADR does not rewrite the existing pywebview launcher, FastAPI service, Web UI routes, configuration, packaging, or CI. It does not select exact source symbols, invent route names, migrate user data, add a Rust crate, install a toolchain, or establish production parity. It does not authorize a service daemon, remote exposure, unrestricted shell execution, or background process cleanup.

## Rollback and failure containment

Before any future shell change, retain the existing pywebview launch path and its known configuration as the rollback path. A release can disable Tauri mode and return to pywebview without deleting the data directory. If a Tauri package fails health, permission, upgrade, or lifecycle checks, do not promote it; remove only the failed package artifact through the normal release process and keep the pywebview path available.

If a shared contract changes incompatibly, pin the shell to the last compatible Web UI/backend pair and restore the previous configuration. Data migrations must be reversible or backed up before execution; this ADR does not authorize a destructive migration. A port conflict, stale lock, or failed child process is an operational error to report and recover from, not a reason to kill unrelated processes.

## Acceptance evidence required later

The following must be demonstrated with real artifacts before Tauri replaces or becomes the default production shell:

1. A real window can start, load the verified Web UI, and close while the owned backend exits cleanly.
2. Process ownership, graceful cleanup, forced-fallback boundaries, and repeated launch behavior are observed, not inferred from static files.
3. A deliberately occupied port produces the documented conflict behavior without attaching to the occupant.
4. Stopping the backend and restarting the application demonstrates bounded recovery and preserves the data directory.
5. An upgrade or simulated failed upgrade demonstrates the documented rollback and data-preservation path.
6. Two sessions execute real overlapping work and show explicit isolation or a documented single-instance handoff; no static mock substitutes for this test.
7. HTTP health and a real WebSocket exchange are both observed for the selected configuration.
8. Capability, CSP, navigation, external-link, filesystem, and shell restrictions are inspected in the built application.

A static ADR, source reading, or successful compilation cannot be presented as real-window, real-process, cleanup, port-conflict, restart-recovery, or two-session acceptance. Source-unknown items—including the exact pywebview entry, FastAPI route and bind configuration, Web UI static/API mapping, data-path rules, and current logging behavior—remain risks until verified against source and runtime evidence.
