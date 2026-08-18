"""Static source contracts for Tauri-native desktop capabilities.

Cargo is a developer prerequisite, not a Python-test prerequisite.  These
checks keep the shell capability boundary observable even when Rust is not
installed locally.
"""
from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def test_native_plugins_are_declared_and_initialized() -> None:
    cargo = _read("src-tauri/Cargo.toml")
    rust = _read("src-tauri/src/main.rs")

    for plugin in ("dialog", "notification", "opener"):
        assert f'tauri-plugin-{plugin} = "2"' in cargo
        assert f"tauri_plugin_{plugin}::init()" in rust


def test_capability_remains_minimal_and_local() -> None:
    capability = json.loads(_read("src-tauri/capabilities/default.json"))

    assert capability["windows"] == ["main"]
    assert capability.get("remote") is None
    assert capability.get("urls", []) == []
    assert set(capability["permissions"]) == {
        "core:default",
        "core:window:allow-show",
        "core:window:allow-set-focus",
        "core:window:allow-maximize",
        "core:window:allow-unmaximize",
        "dialog:default",
        "notification:default",
        "opener:default",
    }


def test_frontend_uses_one_desktop_capability_facade() -> None:
    desktop = _read("webui/src/utils/desktop.ts")

    assert "from '@tauri-apps/plugin-opener'" in desktop
    assert "window.pywebview?.api" in desktop
    assert "source-checkout recovery path" in desktop

    for page in (
        "webui/src/pages/Conversations.tsx",
        "webui/src/pages/LiveChat.tsx",
        "webui/src/pages/Settings.tsx",
    ):
        source = _read(page)
        assert "pywebview.api.save_export" not in source
        assert "pywebview.api.select_directory" not in source
        assert "from '@/utils/desktop'" in source


def test_tauri_shutdown_is_immediate_for_the_window_and_graceful_for_the_sidecar() -> None:
    rust = _read("src-tauri/src/main.rs")
    cargo = _read("src-tauri/Cargo.toml")

    assert "const STOP_TIMEOUT: Duration = Duration::from_secs(5)" in rust
    assert '"--owned-stdin"' in rust
    assert ".stdin(Stdio::piped())" in rust
    assert 'stdin.write_all(b"\\n")' in rust
    assert "fn spawn_background_shutdown" in rust
    assert "thread::spawn(move ||" in rust
    assert "api.prevent_close()" in rust
    assert "window.hide()" in rust
    assert "wait_for_child_exit(process, STOP_TIMEOUT)" in rust
    assert "const FORCE_REAP_TIMEOUT: Duration = Duration::from_secs(2)" in rust
    assert "impl Drop for OwnedProcess" in rust
    assert "cleanup_complete" in rust
    assert "let _ = process.child.kill();" in rust
    assert "wait_for_child_exit(process, FORCE_REAP_TIMEOUT)" in rust

    assert "[target.'cfg(windows)'.dependencies]" in cargo
    assert 'windows-sys = { version = "0.59"' in cargo
    assert "JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE" in rust
    assert "CreateJobObjectW" in rust
    assert "SetInformationJobObject" in rust
    assert "AssignProcessToJobObject" in rust
    assert "TerminateJobObject" in rust
    assert "OwnedHandle::from_raw_handle" in rust
    assert '"Win32_System_Diagnostics_ToolHelp"' in cargo
    assert "CREATE_SUSPENDED" in rust
    assert "resume_suspended_main_thread" in rust
    assert "ResumeThread" in rust
    owned_spawn = rust.split("impl OwnedProcess", 1)[1]
    assert owned_spawn.index("job.assign(&child)") < owned_spawn.index(
        "resume_suspended_main_thread(child.id())"
    )

    assert "[target.'cfg(unix)'.dependencies]" in cargo
    assert 'libc = "0.2"' in cargo
    assert "command.process_group(0)" in rust
    assert "libc::waitid(" in rust
    assert "libc::WNOWAIT" in rust
    assert "group_swept" in rust
    assert "libc::kill(-process.process_group, libc::SIGTERM)" in rust
    assert "libc::kill(-process.process_group, libc::SIGKILL)" in rust
    assert "fn suspended_job_owns_and_terminates_descendant_tree" in rust

    for phase in ("Running", "Cleaning", "AllowExit"):
        assert phase in rust
    assert "ExitAction::WaitForCleanup => api.prevent_close()" in rust
    assert "ExitAction::WaitForCleanup => api.prevent_exit()" in rust
    assert "exit.allow_exit();" in rust


def test_tauri_startup_is_local_first_and_release_cwd_is_portable() -> None:
    rust = _read("src-tauri/src/main.rs")
    cargo = _read("src-tauri/Cargo.toml")

    assert 'rust-version = "1.85"' in cargo
    assert 'uuid = { version = "1", features = ["v4"] }' in cargo
    assert "Uuid::new_v4().to_string()" in rust
    assert 'WebviewUrl::App("index.html".into())' in rust
    assert "WebviewUrl::External" not in rust
    assert ".initialization_script(runtime_script)" in rust
    assert ".on_navigation(is_allowed_main_navigation)" in rust
    assert "new URL(window.location.href)" in rust
    assert "window.location.username" not in rust
    assert "window.location.password" not in rust
    assert 'location.protocol === "https:"' in rust
    assert 'location.hostname === "tauri.localhost" && location.port === ""' in rust
    assert 'location.username === "" && location.password === ""' in rust
    assert "Object.freeze" in rust
    for field in ("apiOrigin", "wsOrigin", "instanceToken", "desktop"):
        assert f'"{field}"' in rust

    assert "#[derive(Clone)]\nstruct OwnedSidecar" in rust
    assert "fn spawn_background_readiness" in rust
    assert "fn desktop_backend_ready" in rust
    assert "desktop_backend_ready\n        ])" in rust
    assert "fn wait_http_ready(" in rust
    assert "child.try_wait()" in rust
    assert "sidecar exited before readiness" in rust
    assert "ready_response_matches(&response, token)" in rust
    assert "response.contains(token)" not in rust

    setup = rust.split(".setup(move |app| {", 1)[1]
    assert setup.index("WebviewWindowBuilder::new") < setup.index("spawn_sidecar(port, &token)")
    assert setup.index("spawn_sidecar(port, &token)") < setup.index("owned.store_child(process)")
    assert 'owned.set_failed(format!("GA-Hub desktop startup: {error}"))' in setup
    assert setup.index(".build()") < setup.index("spawn_background_readiness(")

    assert ".current_dir(sidecar_working_dir()?)" in rust
    assert "#[cfg(not(debug_assertions))]" in rust
    assert "env::current_exe()" in rust
    assert ".parent()" in rust
    assert ".current_dir(repo_root())" not in rust
    assert "command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED)" in rust


def test_local_app_router_gate_and_csp_contract() -> None:
    main = _read("webui/src/main.tsx")
    gate = _read("webui/src/runtime/DesktopRuntimeGate.tsx")
    live_chat = _read("webui/src/pages/LiveChat.tsx")
    index = _read("webui/index.html")
    config = json.loads(_read("src-tauri/tauri.conf.json"))

    assert "BrowserRouter, HashRouter" in main
    assert "getRuntimeConfig().desktop ? HashRouter : BrowserRouter" in main
    assert "<DesktopRuntimeGate>" in main
    assert main.index("<DesktopRuntimeGate>") < main.index("<QueryClientProvider")
    assert "queryDesktopBackendReadiness" in gate
    assert "phase: 'starting'" in gate
    assert "phase: 'failed'" in gate

    # Hash routing owns the desktop URL. Feature pages must not mutate the
    # underlying Tauri asset path behind React Router's back.
    assert "window.history.replaceState" not in live_chat

    csp = config["app"]["security"]["csp"]
    image_sources = next(
        directive.strip()
        for directive in csp.split(";")
        if directive.strip().startswith("img-src ")
    )
    assert "http://127.0.0.1:*" in image_sources
    assert "http://localhost:*" in image_sources
    assert "api.qrserver.com" not in csp
    assert "fonts.googleapis.com" not in index
    assert "fonts.gstatic.com" not in index


def test_tauri_notifications_do_not_fall_back_to_backend() -> None:
    source = _read("webui/src/utils/notify.ts")

    assert "isTauriDesktop()" in source
    assert "sendNotification" in source
    assert "api.notify(title, opts.body || '')" in source
