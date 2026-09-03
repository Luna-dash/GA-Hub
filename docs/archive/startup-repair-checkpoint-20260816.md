GA-Hub desktop startup repair checkpoint (2026-08-16)

Verified source change:
- server/_paths.py: external_python_site_paths() returns [] in PyInstaller-frozen mode unless GA_HUB_ENABLE_EXTERNAL_SITE_PATHS=1.
- tests/test_paths_python.py: 14 passed.

Verified sidecar rebuild:
- desktop/build_sidecar.py completed PyInstaller build.
- src-tauri/binaries/ga-hub-sidecar-x86_64-pc-windows-msvc.exe and temp/desktop-sidecar-build/dist/ga-hub-sidecar.exe matched at 44,796,675 bytes, timestamp 2026-08-16 11:21:33.

Current build:
- Cargo was not on PATH; absolute cargo path is C:\Users\lunagent\.cargo\bin\cargo.exe.
- cargo build --release --manifest-path src-tauri\Cargo.toml was started in background; it reached compilation of tauri, plugins, and ga-hub-desktop. Verify completion before launch.

Next validation:
- Confirm src-tauri/target/release/ga-hub-desktop.exe timestamp/size updated.
- Launch via the real Desktop GA-Hub shortcut/start.bat, then verify process, window, backend listener/readiness and sidecar logs. Do not treat build completion alone as startup validation.
