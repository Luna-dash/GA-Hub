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
    # pywebview is retired — the facade must not carry bridge branches.
    assert "pywebview" not in desktop
    assert "restartDesktopBackend" in desktop

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

    assert "struct SidecarLifecycle<P>" in rust
    assert "lifecycle: Arc<Mutex<SidecarLifecycle<OwnedProcess>>>" in rust
    for phase in ("Spawning", "Running", "Ready", "Failed", "Stopping", "Stopped"):
        assert phase in rust
    assert "fn run_sidecar_supervisor" in rust
    assert "fn spawn_background_supervisor" in rust
    assert "fn desktop_backend_ready" in rust
    # In-place restart: identity survives, only Ready/Failed may claim.
    assert "fn restart_backend" in rust
    assert "struct SidecarIdentity" in rust
    assert "fn try_begin_restart" in rust
    assert "fn restartable" in rust
    assert "desktop_backend_ready,\n            restart_backend\n        ])" in rust
    assert "fn wait_http_ready(" in rust
    assert "child.try_wait()" in rust
    assert "sidecar exited before readiness" in rust
    assert "ready_response_matches(&response, token)" in rust
    assert "response.contains(token)" not in rust

    setup = rust.split(".setup(move |app| {", 1)[1].split(
        ".build(tauri::generate_context!())", 1
    )[0]
    assert "spawn_sidecar(port, &token)" not in setup
    assert "store_child" not in setup
    assert setup.index("WebviewWindowBuilder::new") < setup.index(
        "spawn_background_supervisor("
    )
    assert setup.index(".build()") < setup.index("spawn_background_supervisor(")

    supervisor = rust.split("fn run_sidecar_supervisor", 1)[1].split(
        "fn spawn_background_supervisor", 1
    )[0]
    assert "spawn(port, &token)" in supervisor
    assert "sidecar.commit_spawn(process, &exit)" in supervisor
    assert "stop_owned_process(&mut process)" in supervisor

    assert ".current_dir(sidecar_working_dir()?)" in rust
    assert "#[cfg(not(debug_assertions))]" in rust
    assert "env::current_exe()" in rust
    assert ".parent()" in rust
    assert ".current_dir(repo_root())" not in rust
    assert "command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED)" in rust


def test_tauri_single_instance_reveals_an_offscreen_window() -> None:
    rust = _read("src-tauri/src/main.rs")

    assert "fn main_window_is_offscreen" in rust
    assert "window.available_monitors()" in rust
    assert "fn reveal_main_window" in rust
    assert "window.is_minimized()" in rust
    assert "window.unminimize()" in rust
    assert "window.center()" in rust
    assert "reveal_main_window(&window)" in rust
    assert ".center()" in rust.split("WebviewWindowBuilder::new", 1)[1].split(
        ".build()?", 1
    )[0]


def test_local_app_router_gate_and_csp_contract() -> None:
    main = _read("webui/src/main.tsx")
    gate = _read("webui/src/runtime/DesktopRuntimeGate.tsx")
    live_chat = _read("webui/src/pages/LiveChat.tsx")
    conversations = _read("webui/src/pages/Conversations.tsx")
    index = _read("webui/index.html")
    config = json.loads(_read("src-tauri/tauri.conf.json"))

    assert "import { BrowserRouter } from 'react-router-dom'" in main
    assert "HashRouter" not in main
    assert "getRuntimeConfig" not in main
    assert "<BrowserRouter>" in main
    assert "</BrowserRouter>" in main
    assert "useParams<{ id?: string }>()" in conversations
    assert "const active = routeConversationId || null" in conversations
    assert "[active, setActive]" not in conversations
    assert "nav(`/conversations/${encodeURIComponent(c.id)}`)" in conversations
    assert "if (active === id) nav('/conversations', { replace: true })" in conversations
    assert "<DesktopRuntimeGate>" in main
    assert main.index("<DesktopRuntimeGate>") < main.index("<QueryClientProvider")
    assert "queryDesktopBackendReadiness" in gate
    assert "phase: 'starting'" in gate
    assert "phase: 'failed'" in gate

    # 启动加载层：墨点聚字动画（gahub-loader.js）取代 CSS 转圈。
    # loader 必须经外链脚本接入（CSP script-src 'self' 禁内联），
    # gate 在就绪/失败时负责调隐藏协议，starting 态不再自绘转圈。
    assert "/gahub-loader.js" in index
    assert "__GA_HUB_HIDE_LOADING__" in gate
    assert "animate-spin" not in gate

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
