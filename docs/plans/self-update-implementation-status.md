# GA-Hub self-update: fixed handoff status

## Delivered

The first external bootstrap upgrade succeeded (evidence: `D:/study/GA/temp/project_artifacts/GA-Hub-d795c16e/self-update-implementation/SWITCH-ACCEPTANCE.md`). Ongoing updates now have a reusable controller rather than a newly written switch script per release.

- Installed helper: `%USERPROFILE%\.genericagent-admin\updates\bin\ga-hub-update.exe`.
- One enabled on-demand update task, `GAHub-Update-c4bd4b18408f`, runs the fixed `worker` command under the interactive user. Its XML has no triggers. Release-specific values are persisted in `handoff.json`, not injected as arbitrary commands.
- Source API and Settings UI support prepare, request, separate approval, and status. The request resolves the owning desktop instead of accepting an arbitrary PID from HTTP.
- Worker verifies Windows Job independence, pins the old PID/creation time/executable and pair hashes, arms the plan, and publishes readiness before accepting approval.
- Approval starts a fixed 60-second countdown. There is no unbounded conversation-idle wait. After final candidate/old-pair verification, WM_CLOSE requests normal closure of the exact desktop window. No force kill, build or dependency installation occurs in the switch window.
- The watchdog observes `maintenance.json`; unresolved switch failures remain paused when the old desktop is gone. Candidate receipts/nonce, backend health and process identities are checked before atomic pointer publication. Completed-success records preserve launch identity across subsequent plans.
- `start.bat` and the watchdog use the installed helper with `--admin-data ... launch`, resolving `current.json` rather than a stale release path. Launch/recover safety checks remain in place.

## Normal operating cycle

1. Build and test the candidate while the current desktop remains running. Package a matching desktop/sidecar pair and calculate the trusted ZIP checksum.
2. Prepare the trusted local ZIP in Settings, then run isolated candidate preflight. A successful receipt matching the exact candidate is required before handoff. This checks frozen-sidecar setup HTTP/assets and graceful exit, not full desktop or GA core operation. SHA-256 detects corruption; it does not authenticate a publisher.
3. Wake the fixed independent worker. Wait for `ready`, then explicitly approve the 60-second countdown. In-flight work can be interrupted at normal desktop closure; no task-draining or continuation guarantee is implemented.
4. The worker waits for the old tracked processes to exit, launches the verified candidate, validates instance-specific readiness, then publishes success/current. Inspect persisted status after reconnecting.
5. On unresolved failure, do not start a competing version. Inspect state/processes; manual `recover --plan <ID> --confirm-all-exited` is permitted only after all known desktop/backend instances have exited. Rollback verifies the old pair but is not a data restore.

The installed helper also provides `request` and `approve` commands for an independent terminal, allowing the current preparation-only runtime to use the same fixed controller. Run `--help` for exact arguments. Do not use the archived first-switch scripts.

## Retirement

Four old one-shot probe/switch tasks were exported and disabled. Seven retired scripts were moved into `retired-once/once-scripts.zip` under the evidence directory. They are not active update entries. Current installed version, original pair backup, receipts, pointer, fixed helper and acceptance evidence were retained. The desktop watchdog remains a separate launcher task, not a second updater.

## Verification and activation boundary

- Backend updater/Windows Job regression suites: **47 passed**. Includes two successive isolated handoffs, unapproved timeout, and candidate/old-pair tampering during countdown without desktop closure.
- Update panel and Settings: **8 passed**, including separate request/approval; TypeScript noEmit passed.
- Watchdog PowerShell syntax passed. Installed helper status succeeded; fixed task XML and disabled retired tasks were inspected.
- Running backend health and `/api/updates` returned HTTP 200. Runtime OpenAPI exposes status/prepare/cancel only; new request/approve routes and UI require the next controlled desktop/sidecar rebuild. `/api/updates/status` is not a valid status route.
- This maintenance pass did not restart the desktop or perform another real switch. Two-cycle controller tests use a fake process host. Real fixed-task repeated upgrades, failed-candidate rollback and independent launcher/watchdog launch remain acceptance work. Invoking launch from a Hub-owned tool was correctly refused by the Job guard.
- No commit, push or cloud deployment was performed in this pass. Managed helper self-upgrade, publisher signatures and automatic data migration/restore remain outside the implemented scope.

## Boundary acceptance follow-up (2026-11-16)

- Source now enforces matching isolated-preflight admission before handoff and again at the executor gates. Preparing a ZIP verifies its actual archive SHA-256; rollback also requires instance-specific health rather than treating process creation as success.
- Full `scripts/build_all.py --full` completed with return code **0**: backend **1431 passed, 3 skipped** (plus **67 subtests**, **34 warnings**); frontend **104 test files / 987 tests passed**; frontend production build, frozen sidecar, Tauri desktop and final frozen-sidecar selftest succeeded.
- Focused boundary suites: **54 passed**; post-fix registration/logger/blocking/preflight regression: **34 passed**. API coverage report: **102/154**; this is not complete API coverage.
- The actual ZIP was prepared in a disposable update store, and its frozen sidecar passed isolated setup HTTP/assets checks and graceful shutdown. The receipt scope is `frozen-sidecar-setup-http-v1`; no production credentials/config were copied. Production desktop PID **29356** remained unchanged and port **5861** stayed healthy.
- Candidate: `boundary-release/GA-Hub-1.0.0-84215a6-dirty-windows-x64.zip`; SHA-256: `b7e537d33858379c3b9e2702070354ff2c2cddc038a7cd36f8bf8a78fae52f29`. This is a locally built dirty-worktree candidate, not a signed or committed release.
- New fixed helper built successfully and its `--help` returned 0: `boundary-helper/dist/ga-hub-update.exe`. **It has not replaced the installed helper.** New admission gates/UI therefore must not be described as active in the running desktop or installed helper.
- No production shutdown, countdown approval or second real switch occurred. Real repeated fixed-task upgrades, actual failed-candidate rollback, full desktop/single-instance acceptance and GA core operation remain unverified by this pass.
- Evidence root: `D:/study/GA/temp/project_artifacts/GA-Hub-d795c16e/self-update-implementation/`. See `BOUNDARY-ACCEPTANCE.md`, `boundary-build-result.json`, `boundary-build.log`, and `boundary-real-preflight-result.json`.
