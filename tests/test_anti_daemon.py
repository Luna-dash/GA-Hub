"""Standalone Agy runtime, profile isolation, login, and CloudCode usage ledger tests."""
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.routes import anti
from server.services import agy_profile, agy_runtime, agy_usage, anti_daemon as svc
from server.services import anti_engine, anti_profiles


def make_client(monkeypatch):
    monkeypatch.setattr(anti, "daemon", agy_runtime.AgyRuntimeManager())
    app = FastAPI()
    app.include_router(anti.router)
    return TestClient(app)


def test_runtime_status_start_stop_restart_without_external_daemon(tmp_path, monkeypatch):
    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_profile, "agy_executable_or_none", lambda: "C:/fake/agy.exe")
    monkeypatch.setattr(agy_profile, "has_local_credentials", lambda pid: pid == "default")
    monkeypatch.setattr(agy_runtime.AgyRuntimeManager, "_probe_version_once", lambda self, exe: "1.5.14")
    client = make_client(monkeypatch)

    st = client.get("/api/anti/status", headers={"X-GA-Hub-Action": "verify-anti-auth"}).json()
    assert st["state"] == "ready"
    assert st["agy_available"] is True
    assert st["auth_state"] == "authenticated"
    assert st["version"] == "1.5.14"

    assert client.post("/api/anti/stop").status_code == 403
    stopped = client.post("/api/anti/stop", headers={"X-GA-Hub-Action": "stop-anti"}).json()
    assert stopped["state"] == "stopped"

    started = client.post("/api/anti/start", headers={"X-GA-Hub-Action": "start-anti"}).json()
    assert started["state"] == "ready" and started["auth_state"] == "authenticated"

    restarted = client.post("/api/anti/restart", headers={"X-GA-Hub-Action": "restart-anti"}).json()
    assert restarted["state"] == "ready"


def test_first_status_version_probe_uses_create_no_window_on_windows(tmp_path, monkeypatch):
    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_profile, "agy_executable_or_none", lambda: "C:/fake/agy.exe")
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append((cmd, kwargs))
        return SimpleNamespace(returncode=0, stdout="1.5.16\n", stderr="")

    monkeypatch.setattr(agy_runtime.subprocess, "run", fake_run)
    client = make_client(monkeypatch)
    for _ in range(2):
        response = client.get("/api/anti/status")
        assert response.json()["version"] == "1.5.16"
    assert len(calls) == 1
    cmd, kwargs = calls[0]
    assert cmd == ["C:/fake/agy.exe", "--version"]
    assert kwargs["capture_output"] and kwargs["stdin"] == subprocess.DEVNULL
    if sys.platform == "win32":
        assert kwargs["creationflags"] & subprocess.CREATE_NO_WINDOW
        assert not (kwargs["creationflags"] & subprocess.DETACHED_PROCESS)
    else:
        assert "creationflags" not in kwargs


def test_missing_agy_binary_surfaces_unavailable(tmp_path, monkeypatch):
    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_profile, "agy_executable_or_none", lambda: None)
    client = make_client(monkeypatch)

    st = client.get("/api/anti/status").json()
    assert st["state"] == "unavailable"
    assert st["agy_available"] is False
    assert client.post("/api/anti/start", headers={"X-GA-Hub-Action": "start-anti"}).status_code == 503


def test_t3_profile_env_isolation_strips_keys_and_forces_file_storage(tmp_path, monkeypatch):
    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_profile, "agy_executable_or_none", lambda: "C:/fake/agy.exe")
    pid = "a" * 32
    base = {
        "PATH": "C:/bin",
        "GEMINI_API_KEY": "leaked",
        "GOOGLE_API_KEY": "leaked2",
        "ELECTRON_RUN_AS_NODE": "1",
    }
    env = agy_profile.clean_agy_env(pid, base, temp_dir=tmp_path / "run-tmp")
    assert "GEMINI_API_KEY" not in env
    assert "GOOGLE_API_KEY" not in env
    assert "ELECTRON_RUN_AS_NODE" not in env
    assert env["AGY_ACP_FORCE_FILE_STORAGE"] == "1"
    assert env["AGY_CLI_DISABLE_AUTO_UPDATE"] == "1"
    assert env["SSH_CONNECTION"] == "127.0.0.1 0 127.0.0.1 0"
    assert env["GEMINI_HOME"] == str(tmp_path / "agy-profiles" / "workspace" / "home" / ".gemini")

    vault_env = agy_profile.clean_agy_env(pid, base, vault_only=True)
    assert vault_env["GEMINI_HOME"] == str(tmp_path / "agy-profiles" / pid / "home" / ".gemini")

    ws_cmd = agy_profile.acp_spawn_command("C:/fake/agy.exe", pid)
    assert ws_cmd == [
        "C:/fake/agy.exe",
        "acp",
        "--gemini-dir",
        str(tmp_path / "agy-profiles" / "workspace" / "home" / ".gemini"),
        "--app-data-dir",
        "antigravity-cli",
    ]

    login_cmd = agy_profile.acp_spawn_command("C:/fake/agy.exe", pid, login=True)
    assert login_cmd == [
        "C:/fake/agy.exe",
        "acp",
        "--gemini-dir",
        str(tmp_path / "agy-profiles" / pid / "home" / ".gemini"),
        "--app-data-dir",
        "antigravity-cli",
        "--login",
    ]


def test_profile_rename_switch_capture_and_delete(tmp_path, monkeypatch):
    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_profile, "agy_executable_or_none", lambda: "C:/fake/agy.exe")
    fake_home = tmp_path / "home"
    monkeypatch.setattr(agy_profile.Path, "home", staticmethod(lambda: fake_home))
    monkeypatch.setattr(anti_engine, "project", lambda name: (tmp_path, tmp_path / "artifacts"))

    client = make_client(monkeypatch)
    headers = {"X-GA-Hub-Action": "manage-agy-profiles"}

    work = client.post("/api/anti/profiles", headers=headers, json={"name": "Work"}).json()
    renamed = client.patch(f"/api/anti/profiles/{work['id']}", headers=headers, json={"name": "Office"})
    assert renamed.status_code == 200 and renamed.json()["name"] == "Office"

    switched = client.post(f"/api/anti/profiles/{work['id']}/switch", headers=headers)
    assert switched.status_code == 200 and switched.json()["active"] == work["id"]
    assert client.post("/api/anti/profiles/default/switch", headers=headers).json()["active"] == "default"

    # Capture host credentials into isolated profile
    src_cli = fake_home / ".gemini" / "antigravity-cli"
    src_cli.mkdir(parents=True)
    (src_cli / "antigravity-oauth-token").write_text('{"token":{"access_token":"tok"}}', encoding="utf-8")
    captured = client.post("/api/anti/profiles/capture", headers=headers, json={"name": "Cloned"})
    assert captured.status_code == 200
    assert (tmp_path / "agy-profiles" / captured.json()["id"] / "home" / ".gemini" / "antigravity-cli" / "antigravity-oauth-token").is_file()

    assert client.delete(f"/api/anti/profiles/{captured.json()['id']}", headers=headers).status_code == 204


def test_windows_proxy_env_injection(monkeypatch):
    import winreg

    class FakeKey:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    reg_values = {"AutoConfigURL": None, "ProxyEnable": 1, "ProxyServer": "127.0.0.1:7890"}
    monkeypatch.setattr(winreg, "OpenKey", lambda *a: FakeKey())
    monkeypatch.setattr(winreg, "QueryValueEx", lambda key, name: (reg_values[name], 1))
    monkeypatch.setattr(agy_profile.os, "name", "nt")

    env = agy_profile.system_proxy_env({"PATH": ""})
    assert env["HTTP_PROXY"] == "http://127.0.0.1:7890"
    assert env["HTTPS_PROXY"] == "http://127.0.0.1:7890"


def test_direct_usage_probe_and_builtin_sqlite_ledger(tmp_path, monkeypatch):
    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_usage._paths, "ADMIN_DATA", tmp_path)
    client = make_client(monkeypatch)

    # Mock CloudCode probe directly without external AntiCLI
    monkeypatch.setattr(
        agy_usage,
        "probe_account_usage",
        lambda pid: {
            "state": "authenticated",
            "rows": [
                {"model": "Gemini", "limit": "Weekly Limit Remaining", "remaining_pct": 72.0, "resets_at": "2026-11-25T08:00:00Z"}
            ],
        },
    )
    usage = client.post("/api/anti/account-usage", headers={"X-GA-Hub-Action": "check-anti-usage"})
    assert usage.status_code == 200 and usage.json()["rows"][0]["remaining_pct"] == 72.0

    ledger = agy_usage.AgyLedger()
    ledger.record_run("r1", "gemini-4-hydrogen-high", "rate_limited", input_tokens=1000, output_tokens=500, cache_read_tokens=200, cooldown_seconds=30)
    pools = client.get("/api/anti/quota").json()
    g4 = next(p for p in pools if p["model_group"] == "gemini-4")
    assert g4["status"] == "cooling_down" and g4["cooldown_remaining_seconds"] > 0

    cal = client.post(
        "/api/anti/quota/calibrate",
        json={"model_group": "gemini-4", "remaining_pct": 85},
        headers={"X-GA-Hub-Action": "manage-anti-gateway"},
    )
    assert cal.status_code == 200 and cal.json()["calibrated_remaining_pct"] == 85

    assert client.post("/api/anti/breaker/reset", json={"model_group": "gemini-4"}, headers={"X-GA-Hub-Action": "manage-anti-gateway"}).status_code == 204
    stats = client.get("/api/anti/stats?window_hours=24").json()
    assert stats["total_runs"] == 1 and stats["total_tokens"] == 1500


def test_ledger_profile_isolation_migration_and_safety_guard(tmp_path, monkeypatch):
    import sqlite3

    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_usage._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_profile, "agy_executable_or_none", lambda: "C:/fake/agy.exe")
    monkeypatch.setattr(anti_engine, "project", lambda name: (tmp_path, tmp_path / "artifacts"))

    # Legacy DB without profile_id columns must migrate cleanly under 'default'.
    db = tmp_path / "anti_sessions.sqlite3"
    with sqlite3.connect(db) as conn:
        conn.executescript("""
            CREATE TABLE usage_ledger (
                run_id TEXT PRIMARY KEY, model TEXT NOT NULL, model_group TEXT NOT NULL,
                status TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
                thinking_tokens INTEGER NOT NULL DEFAULT 0, estimated_cost_usd REAL NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );
            CREATE TABLE quota_state (
                model_group TEXT PRIMARY KEY, cooldown_until TEXT,
                calibrated_remaining_pct REAL, calibrated_at TEXT, calibrated_note TEXT
            );
            INSERT INTO usage_ledger VALUES ('old', 'gemini-4-hydrogen-high', 'gemini-4', 'success', 400, 100, 0, 0, 0.01, '2026-11-21T00:00:00+00:00');
            INSERT INTO quota_state VALUES ('gemini-4', NULL, 77.0, '2026-11-21T00:00:00+00:00', 'legacy');
        """)

    ledger = agy_usage.AgyLedger(db)
    migrated = next(p for p in ledger.quota_pools(profile_id="default") if p["model_group"] == "gemini-4")
    assert migrated["calibrated_remaining_pct"] == 77.0

    # Cooling down default profile isolates and does NOT leak to work profile.
    work = agy_profile.add("Work")
    ledger.record_run("r_def", "gemini-4-hydrogen-high", "rate_limited", profile_id="default", input_tokens=500, cooldown_seconds=120)
    ok_def, reason_def = ledger.check_run_allowed("gemini-4-hydrogen-high", profile_id="default")
    ok_work, _ = ledger.check_run_allowed("gemini-4-hydrogen-high", profile_id=work.id)
    assert ok_def is False and "冷却期" in (reason_def or "")
    assert ok_work is True

    # Manual 0% calibration also blocks runs on that account until re-calibrated.
    ledger.calibrate_quota("gemini-4", 0.0, "empty", profile_id=work.id)
    ok_work2, reason_work2 = ledger.check_run_allowed("gemini-4-hydrogen-high", profile_id=work.id)
    assert ok_work2 is False and "0%" in (reason_work2 or "")

    client = make_client(monkeypatch)
    headers = {"X-GA-Hub-Action": "manage-agy-profiles"}
    client.post(f"/api/anti/profiles/{work.id}/switch", headers=headers)
    work_stats = client.get("/api/anti/stats?window_hours=24").json()
    assert work_stats["total_runs"] == 0


def test_sync_user_customizations_preserves_isolated_overrides(tmp_path, monkeypatch):
    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path / "admin")
    fake_home = tmp_path / "host_home"
    (fake_home / ".gemini").mkdir(parents=True)
    (fake_home / ".gemini" / "AGENTS.md").write_text("host rules", encoding="utf-8")
    monkeypatch.setattr(agy_profile.Path, "home", staticmethod(lambda: fake_home))

    prof = agy_profile.add("Isolated")
    agy_profile.prepare_profile(prof.id)
    dst = agy_profile.profile_gemini_dir(prof.id) / "AGENTS.md"
    assert dst.read_text(encoding="utf-8") == "host rules"

    dst.write_text("custom isolated rules", encoding="utf-8")
    agy_profile.prepare_profile(prof.id)
    assert dst.read_text(encoding="utf-8") == "custom isolated rules"

    agy_profile.ensure_workspace_ready()
    ws_agents = agy_profile.workspace_gemini_dir() / "AGENTS.md"
    assert ws_agents.read_text(encoding="utf-8") == "host rules"
    ws_agents.write_text("custom workspace rules", encoding="utf-8")
    agy_profile.ensure_workspace_ready()
    assert ws_agents.read_text(encoding="utf-8") == "custom workspace rules"


def test_worker_holds_profile_lock_until_child_exits(tmp_path, monkeypatch):
    from threading import Event

    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    profile = agy_profile.add("Isolated")
    exited, released = Event(), Event()
    release = agy_profile.release_profile_lock

    def release_and_signal(profile_id):
        release(profile_id)
        released.set()

    monkeypatch.setattr(agy_profile, "release_profile_lock", release_and_signal)
    monkeypatch.setattr(agy_runtime.child_job, "terminate_tree", lambda pid: False)
    monkeypatch.setattr(agy_runtime.child_job, "forget", lambda pid: None)
    worker = agy_runtime.AgySessionWorker(
        profile_id=profile.id, session_id="s1", workspace=tmp_path,
        executable="agy", version=None,
    )
    agy_profile.claim_profile_lock(profile.id)
    worker._profile_lock_held = True
    worker.proc = SimpleNamespace(
        pid=123, stdin=None, stdout=None,
        poll=lambda: 0 if exited.is_set() else None,
        wait=exited.wait,
    )
    temp_dir = worker.temp_dir = agy_profile.make_runtime_temp_dir(profile.id)
    try:
        worker.close()
        assert not released.is_set()
        assert temp_dir.is_dir()
    finally:
        exited.set()
    assert released.wait(3)
    assert not temp_dir.exists()


def test_idle_session_reaper_closes_stale_workers(tmp_path, monkeypatch):
    import time as pytime

    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_profile, "agy_executable_or_none", lambda: "C:/fake/agy.exe")

    mgr = agy_runtime.AgyRuntimeManager(idle_ttl=0.05, reaper_interval=0.02)
    try:
        worker = mgr.get_worker("db", "default", "s1", tmp_path)
        worker.last_used = pytime.monotonic() - 1.0
        assert mgr.reap_idle_workers() == 1
        assert worker._closed is True
        assert mgr.session_connected("db", "s1") is False
    finally:
        mgr.shutdown()


@pytest.mark.parametrize("operation", ["stop", "restart"])
def test_worker_drain_allows_manager_reads_but_rejects_new_work(tmp_path, monkeypatch, operation):
    import threading
    from concurrent.futures import ThreadPoolExecutor

    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_profile, "agy_executable_or_none", lambda: "fake-agy")
    monkeypatch.setattr(agy_runtime.subprocess, "run", lambda *a, **kw: SimpleNamespace(
        returncode=0, stdout="1.2.3", stderr="",
    ))
    mgr = agy_runtime.AgyRuntimeManager(idle_ttl=0)
    monkeypatch.setattr(mgr, "status", lambda **kw: None)
    db = tmp_path / "sessions.db"
    worker = mgr.get_worker(str(db), "default", "session", tmp_path)
    mgr.register_turn(db, "queued", worker)
    with pytest.raises(agy_profile.AgyProfileError) as busy:
        getattr(mgr, operation)()
    assert busy.value.status == 409
    mgr.unregister_turn(db, "queued")

    entered = threading.Event()
    release = threading.Event()
    original_close = worker.close

    def slow_close():
        entered.set()
        assert release.wait(5)
        original_close()

    def check_concurrent_calls():
        assert not mgr.session_connected(str(db), "session")
        with pytest.raises(agy_profile.AgyProfileError) as blocked:
            mgr.get_worker(str(db), "default", "session", tmp_path)
        assert blocked.value.status == 409

    monkeypatch.setattr(worker, "close", slow_close)
    with ThreadPoolExecutor(max_workers=2) as pool:
        draining = pool.submit(getattr(mgr, operation))
        try:
            assert entered.wait(2)
            pool.submit(check_concurrent_calls).result(timeout=2)
        finally:
            release.set()
        draining.result(timeout=5)
    if operation == "restart":
        replacement = mgr.get_worker(str(db), "default", "session", tmp_path)
        assert replacement is not worker
        with pytest.raises(agy_profile.AgyProfileError) as detached:
            mgr.register_turn(db, "old", worker)
        assert detached.value.status == 409
    mgr.shutdown()


@pytest.fixture
def runtime_manager(tmp_path, monkeypatch):
    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_profile, "agy_executable_or_none", lambda: "fake-agy")
    monkeypatch.setattr(agy_runtime.AgyRuntimeManager, "_probe_version_once", lambda *args: "1.2.3")
    mgr = agy_runtime.AgyRuntimeManager(idle_ttl=60, reaper_interval=3600)
    try:
        yield mgr
    finally:
        mgr.shutdown()


@pytest.mark.parametrize("operation", ["close_session", "replace", "reap", "switch", "clear", "delete", "shutdown"])
def test_slow_worker_close_does_not_hold_manager_lock(runtime_manager, tmp_path, monkeypatch, operation):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    mgr = runtime_manager
    profile = agy_profile.DEFAULT
    secondary = "secondary"
    monkeypatch.setattr(agy_profile, "snapshot", lambda: (
        profile, [SimpleNamespace(id=profile), SimpleNamespace(id=secondary)],
    ))

    def select(profile_id):
        nonlocal profile
        profile = profile_id

    monkeypatch.setattr(agy_profile, "select", select)
    changed = []
    activated = []
    monkeypatch.setattr(agy_profile, "clear_credentials", lambda pid: changed.append(pid))
    monkeypatch.setattr(agy_profile, "delete", lambda pid: changed.append(pid))
    monkeypatch.setattr(agy_profile, "sync_workspace_credentials_to_vault", lambda pid: None)
    monkeypatch.setattr(agy_profile, "activate_profile_in_workspace", lambda pid: activated.append(pid))
    db = str(tmp_path / "sessions.db")
    worker_profile = secondary if operation in {"clear", "delete"} else profile
    worker = mgr.get_worker(db, worker_profile, "same", tmp_path)
    new_workspace = tmp_path / "new"
    started, release = Event(), Event()
    close = worker.close

    def slow_close():
        started.set()
        assert release.wait(5)
        close()

    def probe():
        assert mgr.panel_status().active_count == 0
        assert not mgr.session_connected(db, "same")
        assert not changed
        assert not activated
        with pytest.raises(agy_profile.AgyProfileError) as blocked:
            mgr.get_worker(db, profile if operation == "switch" else worker_profile, "same", tmp_path)
        assert blocked.value.status == 409
        if operation == "shutdown" or operation == "switch":
            with pytest.raises(agy_profile.AgyProfileError) as blocked:
                mgr.get_worker(db, profile, "unrelated", tmp_path)
            assert blocked.value.status == 409
        else:
            if operation in {"clear", "delete"}:
                with pytest.raises(agy_profile.AgyProfileError) as blocked:
                    mgr.get_worker(db, worker_profile, "other-session", tmp_path)
                assert blocked.value.status == 409
            assert mgr.get_worker(db, profile, "unrelated", tmp_path) is not worker

    monkeypatch.setattr(worker, "close", slow_close)
    operations = {
        "close_session": lambda: mgr.close_session(db, "same"),
        "replace": lambda: mgr.get_worker(db, worker_profile, "same", new_workspace),
        "reap": lambda: mgr.reap_idle_workers(now=worker.last_used + 61),
        "switch": lambda: mgr.switch_profile(secondary),
        "clear": lambda: mgr.clear_profile_credentials(worker_profile),
        "delete": lambda: mgr.delete_profile(worker_profile),
        "shutdown": mgr.shutdown,
    }
    with ThreadPoolExecutor(max_workers=2) as pool:
        closing = pool.submit(operations[operation])
        try:
            assert started.wait(2)
            pool.submit(probe).result(timeout=2)
        finally:
            release.set()
        result = closing.result(timeout=5)

    with pytest.raises(agy_profile.AgyProfileError) as retired:
        worker.ensure_started(resume_conversation=None, add_dirs=[])
    assert retired.value.status == 409
    if operation in {"clear", "delete"}:
        assert changed == [worker_profile]
    if operation == "switch":
        assert activated == [secondary]
    if operation not in {"delete", "shutdown"}:
        replacement = mgr.get_worker(db, profile, "same", new_workspace)
        assert replacement is not worker
        if operation == "replace":
            assert result is replacement


def test_detached_session_stays_reserved_until_child_actually_exits(runtime_manager, tmp_path, monkeypatch):
    from threading import Event

    mgr = runtime_manager
    profile = agy_profile.DEFAULT
    worker = mgr.get_worker("db", profile, "same", tmp_path)
    allow_exit = Event()
    cleaned = Event()

    class SlowProcess:
        pid = 123
        stdin = stdout = None

        def poll(self):
            return 0 if allow_exit.is_set() else None

        def wait(self):
            return 0 if allow_exit.wait(5) else pytest.fail("fake child did not exit")

    worker.proc = SlowProcess()
    monkeypatch.setattr(agy_runtime.child_job, "terminate_tree", lambda pid: None)
    monkeypatch.setattr(agy_runtime.child_job, "forget", lambda pid: None)
    original_waiter = agy_runtime.threading.Thread

    def capture_waiter(*args, **kwargs):
        if kwargs.get("name") == "agy-acp-exit":
            target = kwargs["target"]

            def notify():
                try:
                    target()
                finally:
                    cleaned.set()

            kwargs["target"] = notify
        return original_waiter(*args, **kwargs)

    monkeypatch.setattr(agy_runtime.threading, "Thread", capture_waiter)
    try:
        mgr.close_session("db", "same")
        assert worker.exit_pending()
        assert mgr.get_worker("db", profile, "unrelated", tmp_path) is not worker
        with pytest.raises(agy_profile.AgyProfileError) as blocked:
            mgr.get_worker("db", profile, "same", tmp_path)
        assert blocked.value.status == 409
    finally:
        allow_exit.set()
        assert cleaned.wait(2)
    assert mgr.get_worker("db", profile, "same", tmp_path) is not worker


def test_models_endpoint_works_even_when_runtime_manually_stopped(tmp_path, monkeypatch):
    import json
    from types import SimpleNamespace

    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_profile, "agy_executable_or_none", lambda: "C:/fake/agy.exe")
    monkeypatch.setattr(
        agy_runtime.subprocess,
        "run",
        lambda *a, **kw: SimpleNamespace(
            returncode=0,
            stdout=json.dumps([{"id": "gemini-4-hydrogen-high", "display_name": "Gemini 4 Hydrogen (High)"}]),
        ),
    )
    mgr = agy_runtime.AgyRuntimeManager()
    monkeypatch.setattr(anti, "daemon", mgr)
    monkeypatch.setattr(anti, "AntiSessions", lambda: anti_engine.AntiSessions(tmp_path / "anti.sqlite", mgr))
    app = FastAPI()
    app.include_router(anti.router)
    client = TestClient(app)
    assert client.post("/api/anti/stop", headers={"X-GA-Hub-Action": "stop-anti"}).json()["state"] == "stopped"
    res = client.get("/api/anti/models")
    assert res.status_code == 200
    assert res.json()["items"][0]["id"] == "gemini-4-hydrogen-high"


def test_models_parses_agy_tsv_without_json_flag_and_default_env_preserves_keyring(tmp_path, monkeypatch):
    from types import SimpleNamespace

    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_profile, "agy_executable_or_none", lambda: "C:/fake/agy.exe")
    monkeypatch.setattr(agy_profile, "_read_windows_keyring_safely", lambda: None)

    default_env = agy_profile.clean_agy_env("default", {"PATH": "C:/bin", "WSL_INTEROP": "1", "ANTIGRAVITY_AGENT": "1"})
    assert default_env["AGY_ACP_FORCE_FILE_STORAGE"] == "1"
    assert default_env["GEMINI_HOME"] == str(tmp_path / "agy-profiles" / "workspace" / "home" / ".gemini")
    assert "WSL_INTEROP" not in default_env
    assert "ANTIGRAVITY_AGENT" not in default_env

    vault_env = agy_profile.clean_agy_env("default", {"PATH": "C:/bin"}, vault_only=True)
    assert vault_env["GEMINI_HOME"] == str(tmp_path / "agy-profiles" / "default" / "home" / ".gemini")

    captured_cmd = []

    def fake_run(cmd, *a, **kw):
        captured_cmd.append(cmd)
        assert kw["capture_output"] and kw["stdin"] == subprocess.DEVNULL
        if sys.platform == "win32":
            assert kw["creationflags"] & subprocess.CREATE_NO_WINDOW
            assert not (kw["creationflags"] & subprocess.DETACHED_PROCESS)
        else:
            assert "creationflags" not in kw
        return SimpleNamespace(
            returncode=0,
            stdout="gemini-4-neon-high\tGemini 4 Neon (High)\nclaude-opus-5-5-high\tClaude Opus 5.5 (High)\n",
            stderr="Fetching available models...\n",
        )

    monkeypatch.setattr(agy_runtime.subprocess, "run", fake_run)
    mgr = agy_runtime.AgyRuntimeManager()
    items = mgr.models("default")
    assert captured_cmd == [["C:/fake/agy.exe", "models"]]
    assert items == [
        {"id": "gemini-4-neon-high", "display_name": "Gemini 4 Neon (High)"},
        {"id": "claude-opus-5-5-high", "display_name": "Claude Opus 5.5 (High)"},
    ]


def test_isolated_profile_lock_and_clear_credentials_temp_cleanup(tmp_path, monkeypatch):
    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    p = agy_profile.add("isolated-work")
    temp_dir = agy_profile.make_runtime_temp_dir(p.id)
    (temp_dir / "unpack.tmp").write_text("junk", encoding="utf-8")
    cred_dir = agy_profile.profile_app_data_dir(p.id)
    cred_dir.mkdir(parents=True, exist_ok=True)
    (cred_dir / "antigravity-oauth-token").write_text("tok", encoding="utf-8")

    # Simulate an active external live PID holding the isolated profile lock
    lock_file = agy_profile._profile_lock_file(p.id)
    lock_file.parent.mkdir(parents=True, exist_ok=True)
    lock_file.write_text('{"pid": 999999}', encoding="utf-8")
    monkeypatch.setattr(agy_profile, "_is_pid_alive", lambda pid: pid == 999999)
    with pytest.raises(agy_profile.AgyProfileError) as blocked:
        agy_profile.claim_profile_lock(p.id)
    assert blocked.value.status == 409
    with pytest.raises(agy_profile.AgyProfileError):
        agy_profile.clear_credentials(p.id)

    # Once the external PID exits, claiming/clearing works and removes temp artifacts
    monkeypatch.setattr(agy_profile, "_is_pid_alive", lambda pid: False)
    agy_profile.claim_profile_lock(p.id)
    assert lock_file.is_file()
    agy_profile.release_profile_lock(p.id)
    res = agy_profile.clear_credentials(p.id)
    assert res["has_credentials"] is False
    assert not temp_dir.exists()
    assert not lock_file.exists()


def test_isolated_profile_lock_contention_between_processes(tmp_path, monkeypatch):
    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    profile = agy_profile.add("isolated-contention")
    child_code = """
import sys
from pathlib import Path
from server.services import agy_profile as p
p._paths.ADMIN_DATA = Path(sys.argv[1])
try:
    p.claim_profile_lock(sys.argv[2])
except p.AgyProfileError as exc:
    print(exc.status, flush=True)
    sys.exit(0)
print('acquired', flush=True)
sys.stdin.readline()
p.release_profile_lock(sys.argv[2])
"""
    cmd = [sys.executable, "-c", child_code, str(tmp_path), profile.id]
    child = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    try:
        assert child.stdout.readline().strip() == "acquired"
        # Remove only the test's compatibility marker: the kernel alone must
        # still reject both a new process and a conflicting profile mutation.
        agy_profile._profile_lock_file(profile.id).unlink()
        peer = subprocess.run(cmd, input="stop\n", capture_output=True, text=True, timeout=10, check=True)
        assert peer.stdout.strip() == "409"
        with pytest.raises(agy_profile.AgyProfileError) as blocked:
            agy_profile.clear_credentials(profile.id)
        assert blocked.value.status == 409
    finally:
        if child.poll() is None:
            child.terminate()
        child.communicate(timeout=10)
    # Process termination must release the OS lock even without Python cleanup.
    with agy_profile.profile_lock(profile.id):
        with agy_profile.profile_lock(profile.id):
            pass
        peer = subprocess.run(cmd, input="stop\n", capture_output=True, text=True, timeout=10, check=True)
        assert peer.stdout.strip() == "409"
    peer = subprocess.run(cmd, input="stop\n", capture_output=True, text=True, timeout=10, check=True)
    assert peer.stdout.strip() == "acquired"


def test_active_cooldown_by_profile_exposed_in_profiles_endpoint(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from server.routes import anti as anti_routes
    from server.services.agy_usage import AgyLedger

    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(anti_routes, "anti_profiles", agy_profile)
    p = agy_profile.add("cooldown-acc")
    ledger = AgyLedger(db=tmp_path / "anti_sessions.sqlite3")
    ledger.record_run("r1", "gemini-4-hydrogen-high", "rate_limited", profile_id=p.id, cooldown_seconds=90)

    cooldowns = ledger.active_cooldown_by_profile()
    assert 1 <= cooldowns[p.id] <= 90

    monkeypatch.setattr(anti_routes, "AntiSessions", lambda: type("S", (), {"ledger": ledger})())
    monkeypatch.setattr(anti_routes.daemon, "active_login_profile", lambda: None)
    app = FastAPI()
    app.include_router(anti_routes.router)
    with TestClient(app) as client:
        resp = client.get("/api/anti/profiles")
        assert resp.status_code == 200
        rows = {row["id"]: row for row in resp.json()["profiles"]}
        assert rows[p.id]["cooldown_seconds"] >= 1
        assert "cooldown_seconds" not in rows["default"]


@pytest.mark.parametrize("active", [False, True])
def test_session_worker_records_each_available_commands_snapshot_once(tmp_path, active):
    runtime = agy_runtime.AgyRuntimeManager()
    captured = []

    def on_commands(cmds):
        captured.append(cmds)
        runtime._record_commands("default", cmds)

    worker = agy_runtime.AgySessionWorker(
        profile_id="default",
        session_id="s-cmd",
        workspace=tmp_path,
        executable="agy",
        version=None,
        on_commands=on_commands,
    )
    if active:
        worker.active_turn = SimpleNamespace(
            touch=lambda: None,
            read_repair=SimpleNamespace(track_update=lambda update: update),
            normalizer=agy_runtime.SessionUpdateNormalizer(),
            on_event=lambda event: None,
        )

    def publish(items):
        worker._handle_session_update({
            "update": {
                "sessionUpdate": "available_commands_update",
                "availableCommands": items,
            }
        })

    fallback = runtime.commands("default")
    assert fallback
    items = [
        {"name": "compact", "description": "Compact context"},
        {"name": "workflow-x", "description": "Run custom workflow"},
    ]
    publish(items)
    assert captured == [items]
    assert runtime.commands("default") == items

    publish(None)  # Ignore a malformed update, not an explicit empty snapshot.
    assert captured == [items]
    assert runtime.commands("default") == items

    publish([])
    assert captured == [items, []]
    assert runtime.commands("default") == []
    assert runtime.commands("other-profile") == fallback


def test_code_login_expiration_explicit_cancel_and_reaper_restart(tmp_path, monkeypatch):
    import time

    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_profile, "agy_executable_or_none", lambda: sys.executable)

    # 1. Explicit cancel route terminates active code login and clears login_profile.
    mgr = agy_runtime.AgyRuntimeManager()
    monkeypatch.setattr(anti, "daemon", mgr)

    proc = subprocess.Popen(
        [sys.executable, "-c", "import sys, time; print('https://accounts.google.com/o/oauth2/auth', flush=True); time.sleep(30)"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        encoding="utf-8",
    )
    try:
        agy_profile.claim_profile_lock("default")
        flow = agy_profile.CodeLoginFlow(flow_id="flow-cancel", profile_id="default", process=proc)
        mgr._watch_login_process("default", proc, flow)
        mgr._code_login = flow
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline and flow.public_state()["phase"] != "waiting_code":
            time.sleep(0.05)
        assert mgr.active_login_profile() == "default"

        app = FastAPI()
        app.include_router(anti.router)
        client = TestClient(app)
        resp = client.post(
            "/api/anti/profiles/login/cancel/flow-cancel",
            headers={"X-GA-Hub-Action": "manage-agy-profiles"},
        )
        assert resp.status_code == 200
        assert resp.json()["phase"] == "cancelled"
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline and (tmp_path / "agy-profiles" / "default" / ".profile.lock").exists():
            time.sleep(0.05)
        assert mgr.active_login_profile() is None
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=5)

    # 2. Expired code login self-cancels via watchdog and releases profile lock without polling.
    proc2 = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(30)"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        encoding="utf-8",
    )
    try:
        agy_profile.claim_profile_lock("default")
        expired_flow = agy_profile.CodeLoginFlow(
            flow_id="flow-exp",
            profile_id="default",
            process=proc2,
            expires_at=time.monotonic() + 0.15,
        )
        mgr._watch_login_process("default", proc2, expired_flow)
        mgr._code_login = expired_flow
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline and expired_flow.phase not in ("cancelled", "failed"):
            time.sleep(0.05)
        assert expired_flow.public_state()["phase"] == "cancelled"
        assert mgr.active_login_profile() is None
    finally:
        if proc2.poll() is None:
            proc2.kill()
            proc2.wait(timeout=5)

    # 3. restart() after shutdown() clears _shutdown_event so _ensure_reaper_locked resumes.
    mgr.shutdown()
    assert mgr._shutdown_event.is_set()
    mgr.restart()
    assert not mgr._shutdown_event.is_set()


def test_cancel_during_pending_permission_replies_cancelled_outcome(tmp_path, monkeypatch):
    import json
    import threading
    import time

    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    sent_frames: list[dict] = []
    sent_lock = threading.Lock()
    prompt_seen = threading.Event()
    perm_replied = threading.Event()
    finish_prompt = threading.Event()

    worker = agy_runtime.AgySessionWorker(
        profile_id="default",
        session_id="s-perm-cancel",
        workspace=tmp_path,
        executable="agy",
        version=None,
    )
    worker.acp_session_id = "acp-s1"
    worker.init_result = {"agentInfo": {"version": "1.5.14"}}
    worker.setup_result = {"sessionId": "acp-s1"}
    worker.proc = SimpleNamespace(pid=999, stdin=None, stdout=None, poll=lambda: None)
    monkeypatch.setattr(worker, "ensure_started", lambda **kw: "acp-s1")

    def fake_send_frame(frame):
        with sent_lock:
            sent_frames.append(frame)
        method = frame.get("method")
        if method == "session/prompt":
            prompt_seen.set()
        elif "id" in frame and method is not None:
            with worker._rpc_lock:
                entry = worker._pending_rpcs.pop(frame["id"], None)
            if entry is not None:
                entry[1]["result"] = {}
                entry[0].set()
        elif "result" in frame and "outcome" in frame["result"]:
            perm_replied.set()
        elif method == "session/cancel":
            finish_prompt.set()

    monkeypatch.setattr(worker, "_send_frame", fake_send_frame)

    box: dict = {}

    def run_worker():
        box["result"] = worker.run_turn(
            run_id="r-perm",
            prompt_text="edit file",
            model="gemini-4-hydrogen-high",
            effort="high",
            mode="accept-edits",
            permission_mode="approval-required",
            resume_conversation=None,
            add_dirs=(),
            staged_paths=[],
            attachments=[],
            allowed_roots=[tmp_path],
            on_event=lambda evt: None,
        )

    thread = threading.Thread(target=run_worker, daemon=True)
    thread.start()
    try:
        assert prompt_seen.wait(2.0)
        perm_thread = threading.Thread(
            target=worker._handle_incoming_request,
            args=(
                77,
                "session/request_permission",
                {
                    "toolCall": {"toolCallId": "tc1", "kind": "edit", "title": "Edit note", "locations": [{"path": "a.txt"}]},
                    "options": [
                        {"optionId": "allow_1", "kind": "allow_once", "name": "Allow"},
                        {"optionId": "reject_1", "kind": "reject_once", "name": "Reject"},
                    ],
                },
            ),
            daemon=True,
        )
        perm_thread.start()
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline and (worker.active_turn is None or worker.active_turn.current_approval() is None):
            time.sleep(0.01)
        assert worker.active_turn is not None and worker.active_turn.current_approval() is not None

        worker.cancel_turn()
        assert perm_replied.wait(2.0)
        assert finish_prompt.wait(2.0)
        # Complete the prompt RPC after cancel arrives.
        with worker._rpc_lock:
            for req_id, (ev, rpc_box, *_rest) in list(worker._pending_rpcs.items()):
                rpc_box["result"] = {"stopReason": "cancelled"}
                ev.set()
                worker._pending_rpcs.pop(req_id, None)
        if worker.active_turn is not None:
            worker.active_turn.wake_event.set()
        thread.join(timeout=3.0)
        perm_thread.join(timeout=2.0)
    finally:
        worker.close(force=True)

    assert box["result"]["status"] == "cancelled"
    perm_reply = next(f for f in sent_frames if f.get("id") == 77)
    assert perm_reply["result"] == {"outcome": {"outcome": "cancelled"}}
    assert any(f.get("method") == "session/cancel" for f in sent_frames)


def test_soft_cancel_grace_timeout_auto_retires_dirty_worker(tmp_path, monkeypatch):
    import threading

    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_profile, "agy_executable_or_none", lambda: "fake-agy")
    monkeypatch.setattr(agy_runtime.AgyRuntimeManager, "_probe_version_once", lambda *args: "1.5.14")
    monkeypatch.setattr(agy_runtime, "CANCEL_GRACE_TIMEOUT", 0.12)
    monkeypatch.setattr(agy_runtime.child_job, "terminate_tree", lambda pid: False)
    monkeypatch.setattr(agy_runtime.child_job, "forget", lambda pid: None)

    mgr = agy_runtime.AgyRuntimeManager(idle_ttl=0)
    db = tmp_path / "sessions.db"
    worker = mgr.get_worker(str(db), "default", "s-grace", tmp_path)
    worker.acp_session_id = "acp-grace"
    worker.init_result = {"agentInfo": {"version": "1.5.14"}}
    worker.setup_result = {"sessionId": "acp-grace"}
    exited = threading.Event()
    worker.proc = SimpleNamespace(
        pid=5151, stdin=None, stdout=None,
        poll=lambda: 0 if exited.is_set() else None,
        wait=exited.wait,
    )
    monkeypatch.setattr(worker, "ensure_started", lambda **kw: "acp-grace")
    prompt_sent = threading.Event()
    closed_calls: list[bool] = []

    def fake_send(frame):
        method = frame.get("method")
        if method == "session/prompt":
            prompt_sent.set()
        elif "id" in frame and method is not None:
            with worker._rpc_lock:
                entry = worker._pending_rpcs.pop(frame["id"], None)
            if entry is not None:
                entry[1]["result"] = {}
                entry[0].set()

    orig_close = worker.close

    def tracked_close(*, force=False):
        closed_calls.append(force)
        exited.set()
        return orig_close(force=force)

    monkeypatch.setattr(worker, "_send_frame", fake_send)
    monkeypatch.setattr(worker, "close", tracked_close)

    box: dict = {}
    mgr.register_turn(db, "r-grace", worker)
    thread = threading.Thread(
        target=lambda: box.setdefault("result", worker.run_turn(
            run_id="r-grace", prompt_text="hang", model="gemini-4-hydrogen-high",
            effort="high", mode="plan", permission_mode="approval-required",
            resume_conversation=None, add_dirs=(), staged_paths=[], attachments=[],
            allowed_roots=[tmp_path], on_event=lambda e: None,
        )),
        daemon=True,
    )
    try:
        thread.start()
        assert prompt_sent.wait(2.0)
        assert mgr.cancel_turn(db, "r-grace") is True
        thread.join(timeout=3.0)
        assert not thread.is_alive()
    finally:
        exited.set()
        mgr.unregister_turn(db, "r-grace")

    assert box["result"]["status"] == "cancelled"
    assert worker._dirty is True
    assert True in closed_calls
    replacement = mgr.get_worker(str(db), "default", "s-grace", tmp_path)
    assert replacement is not worker
    mgr.shutdown()


def test_get_worker_waits_for_retiring_session_before_raising_409(tmp_path, monkeypatch):
    import threading
    import time

    assert agy_runtime.CANCEL_GRACE_TIMEOUT <= 2.5

    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_profile, "agy_executable_or_none", lambda: "fake-agy")
    monkeypatch.setattr(agy_runtime.AgyRuntimeManager, "_probe_version_once", lambda *args: "1.5.14")

    mgr = agy_runtime.AgyRuntimeManager(idle_ttl=0)
    db = tmp_path / "sessions.db"
    old_worker = mgr.get_worker(str(db), "default", "s-retire-wait", tmp_path)
    key = (str(db), "default", "s-retire-wait")
    closed_ev = threading.Event()
    with mgr._lock:
        mgr._workers.pop(key, None)
        old_worker._retired = True
        old_worker._dirty = True
        mgr._retiring[key] = (old_worker, closed_ev)

    def _finish_retire():
        time.sleep(0.06)
        closed_ev.set()

    threading.Thread(target=_finish_retire, daemon=True).start()
    replacement = mgr.get_worker(str(db), "default", "s-retire-wait", tmp_path)
    assert replacement is not old_worker

    # If retiring genuinely hangs beyond _retire_wait_timeout, 409 is still raised.
    mgr._retire_wait_timeout = 0.05
    stuck_closed = threading.Event()
    with mgr._lock:
        mgr._workers.pop(key, None)
        replacement._retired = True
        replacement._dirty = True
        mgr._retiring[key] = (replacement, stuck_closed)
    with pytest.raises(agy_profile.AgyProfileError) as exc_info:
        mgr.get_worker(str(db), "default", "s-retire-wait", tmp_path)
    assert exc_info.value.status == 409
    stuck_closed.set()
    mgr.shutdown()


def test_cancel_turn_aborts_hung_handshake_without_deadlock(tmp_path, monkeypatch):
    import threading
    import time

    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_profile, "agy_executable_or_none", lambda: sys.executable)
    monkeypatch.setattr(agy_runtime.AgyRuntimeManager, "_probe_version_once", lambda *args: "1.5.14")
    monkeypatch.setattr(agy_profile, "acp_spawn_command", lambda exe, pid, **kw: [exe, "-u", "-c", "import sys; sys.stdin.read()"])
    monkeypatch.setattr(agy_profile, "clean_agy_env", lambda pid, **kw: None)

    mgr = agy_runtime.AgyRuntimeManager(idle_ttl=0)
    db = tmp_path / "sessions.db"
    worker = mgr.get_worker(str(db), "default", "s-init-hang", tmp_path)
    mgr.register_turn(db, "r-init", worker)

    box: dict = {}
    thread = threading.Thread(
        target=lambda: box.setdefault("result", worker.run_turn(
            run_id="r-init", prompt_text="hello", model="gemini-4-hydrogen-high",
            effort="high", mode="plan", permission_mode="approval-required",
            resume_conversation=None, add_dirs=(), staged_paths=[], attachments=[],
            allowed_roots=[tmp_path], on_event=lambda e: None,
        )),
        daemon=True,
    )
    try:
        thread.start()
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline and worker.proc is None:
            time.sleep(0.02)
        assert worker.proc is not None

        t0 = time.monotonic()
        assert mgr.cancel_turn(db, "r-init") is True
        assert time.monotonic() - t0 < 2.0
        thread.join(timeout=4.0)
        assert not thread.is_alive()
    finally:
        mgr.unregister_turn(db, "r-init")
        mgr.shutdown()

    assert box["result"]["status"] == "cancelled"
    assert mgr.session_connected(str(db), "s-init-hang") is False


def test_inactivity_timeout_retires_worker_and_resets_process(tmp_path, monkeypatch):
    import threading

    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_profile, "agy_executable_or_none", lambda: "fake-agy")
    monkeypatch.setattr(agy_runtime.AgyRuntimeManager, "_probe_version_once", lambda *args: "1.5.14")
    monkeypatch.setattr(agy_runtime, "INACTIVITY_TIMEOUT", 0.12)
    monkeypatch.setattr(agy_runtime.child_job, "terminate_tree", lambda pid: False)
    monkeypatch.setattr(agy_runtime.child_job, "forget", lambda pid: None)

    mgr = agy_runtime.AgyRuntimeManager(idle_ttl=0)
    db = tmp_path / "sessions.db"
    worker = mgr.get_worker(str(db), "default", "s-inact", tmp_path)
    worker.acp_session_id = "acp-inact"
    worker.init_result = {"agentInfo": {"version": "1.5.14"}}
    worker.setup_result = {"sessionId": "acp-inact"}
    worker.proc = SimpleNamespace(pid=6161, stdin=None, stdout=None, poll=lambda: 0)
    monkeypatch.setattr(worker, "ensure_started", lambda **kw: "acp-inact")
    def fake_send(frame):
        method = frame.get("method")
        if method != "session/prompt" and "id" in frame and method is not None:
            with worker._rpc_lock:
                entry = worker._pending_rpcs.pop(frame["id"], None)
            if entry is not None:
                entry[1]["result"] = {}
                entry[0].set()

    monkeypatch.setattr(worker, "_send_frame", fake_send)

    mgr.register_turn(db, "r-inact", worker)
    try:
        res = worker.run_turn(
            run_id="r-inact", prompt_text="silent", model="gemini-4-hydrogen-high",
            effort="high", mode="plan", permission_mode="approval-required",
            resume_conversation=None, add_dirs=(), staged_paths=[], attachments=[],
            allowed_roots=[tmp_path], on_event=lambda e: None,
        )
    finally:
        mgr.unregister_turn(db, "r-inact")

    assert res["status"] == "timeout"
    assert "已重置后台进程" in res["error"]
    assert worker._closed is True
    replacement = mgr.get_worker(str(db), "default", "s-inact", tmp_path)
    assert replacement is not worker
    mgr.shutdown()


def test_manager_force_stop_and_restart_override_409(tmp_path, monkeypatch):
    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_profile, "agy_executable_or_none", lambda: "fake-agy")
    monkeypatch.setattr(agy_runtime.AgyRuntimeManager, "_probe_version_once", lambda *args: "1.5.14")

    mgr = agy_runtime.AgyRuntimeManager(idle_ttl=0)
    monkeypatch.setattr(mgr, "status", lambda **kw: agy_runtime.AntiDaemonStatus(state="ready"))
    db = tmp_path / "sessions.db"
    worker = mgr.get_worker(str(db), "default", "s-force", tmp_path)
    aborted: list[str] = []
    orig_abort = worker.force_abort
    monkeypatch.setattr(worker, "force_abort", lambda reason="": aborted.append(reason) or orig_abort(reason))
    mgr.register_turn(db, "r-force", worker)

    with pytest.raises(agy_profile.AgyProfileError) as blocked_stop:
        mgr.stop()
    assert blocked_stop.value.status == 409
    with pytest.raises(agy_profile.AgyProfileError) as blocked_restart:
        mgr.restart()
    assert blocked_restart.value.status == 409

    mgr.restart(force=True)
    assert aborted
    assert mgr._stopped_manually is False
    mgr.unregister_turn(db, "r-force")

    worker2 = mgr.get_worker(str(db), "default", "s-force", tmp_path)
    mgr.register_turn(db, "r-force-2", worker2)
    mgr.stop(force=True)
    assert mgr._stopped_manually is True
    mgr.unregister_turn(db, "r-force-2")
    mgr.shutdown()


def test_steer_turn_carries_prompt_across_end_turn_and_rejects_legacy_agy(tmp_path, monkeypatch):
    import threading

    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_profile, "agy_executable_or_none", lambda: "fake-agy")
    monkeypatch.setattr(agy_runtime.AgyRuntimeManager, "_probe_version_once", lambda *args: "1.5.14")

    mgr = agy_runtime.AgyRuntimeManager(idle_ttl=0)
    db = tmp_path / "sessions.db"

    # Legacy agy < 1.5.0 must reject steering cleanly with 409.
    legacy = mgr.get_worker(str(db), "default", "s-legacy", tmp_path)
    legacy.acp_session_id = "acp-legacy"
    legacy.version = "1.4.9"
    legacy.init_result = {"agentInfo": {"version": "1.4.9"}}
    legacy.setup_result = {"sessionId": "acp-legacy"}
    legacy.proc = SimpleNamespace(pid=7101, stdin=None, stdout=None, poll=lambda: None)
    legacy.active_turn = agy_runtime._ActiveTurn("r-leg", "plan", "approval-required", tmp_path, [tmp_path], lambda e: None)
    legacy.active_turn.prompt_queued.set()
    with pytest.raises(agy_profile.AgyProfileError) as legacy_err:
        legacy.steer_turn(prompt_text="steer", staged_paths=[], attachments=[], allowed_roots=[tmp_path])
    assert legacy_err.value.status == 409
    legacy.active_turn = None
    legacy.close(force=True)

    # agy >= 1.5.0 keeps turn alive while prompt1 ends with end_turn and prompt2 completes.
    worker = mgr.get_worker(str(db), "default", "s-steer", tmp_path)
    worker.acp_session_id = "acp-steer"
    worker.init_result = {"agentInfo": {"version": "1.5.14"}}
    worker.setup_result = {"sessionId": "acp-steer"}
    worker.proc = SimpleNamespace(pid=7102, stdin=None, stdout=None, poll=lambda: None)
    monkeypatch.setattr(worker, "ensure_started", lambda **kw: "acp-steer")

    prompt_ids: list[int] = []
    prompt1_seen = threading.Event()
    prompt2_seen = threading.Event()
    events: list[dict] = []

    def fake_send(frame):
        method = frame.get("method")
        rid = frame.get("id")
        if method == "session/prompt":
            prompt_ids.append(rid)
            if len(prompt_ids) == 1:
                prompt1_seen.set()
            elif len(prompt_ids) == 2:
                prompt2_seen.set()
        elif rid is not None and method is not None:
            with worker._rpc_lock:
                entry = worker._pending_rpcs.pop(rid, None)
            if entry is not None:
                entry[1]["result"] = {}
                entry[0].set()

    monkeypatch.setattr(worker, "_send_frame", fake_send)
    box: dict = {}
    mgr.register_turn(db, "r-steer", worker)
    t = threading.Thread(
        target=lambda: box.setdefault("result", worker.run_turn(
            run_id="r-steer", prompt_text="initial prompt", model="gemini-4-hydrogen-high",
            effort="high", mode="plan", permission_mode="approval-required",
            resume_conversation=None, add_dirs=(), staged_paths=[], attachments=[],
            allowed_roots=[tmp_path], on_event=events.append,
        )),
        daemon=True,
    )
    t.start()
    try:
        assert prompt1_seen.wait(2.0)
        worker._handle_session_update({"update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "阶段输出A"}}})
        steer_res = mgr.steer_turn(db, "r-steer", prompt_text="请补充单测", staged_paths=[], attachments=[], allowed_roots=[tmp_path])
        assert steer_res["steered"] is True
        assert prompt2_seen.wait(2.0)

        # Resolve prompt 1 (superseded) and verify turn keeps waiting for prompt 2.
        with worker._rpc_lock:
            e1 = worker._pending_rpcs.pop(prompt_ids[0], None)
        assert e1 is not None
        e1[1]["result"] = {"stopReason": "end_turn", "usage": {"inputTokens": 40, "outputTokens": 10}}
        e1[0].set()
        if len(e1) > 2 and e1[2] is not None:
            e1[2].set()

        t.join(timeout=0.08)
        assert t.is_alive()

        worker._handle_session_update({"update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "最终补充完成"}}})
        with worker._rpc_lock:
            e2 = worker._pending_rpcs.pop(prompt_ids[1], None)
        assert e2 is not None
        e2[1]["result"] = {"stopReason": "end_turn", "usage": {"inputTokens": 60, "outputTokens": 20}}
        e2[0].set()
        if len(e2) > 2 and e2[2] is not None:
            e2[2].set()

        t.join(timeout=2.0)
        assert not t.is_alive()
    finally:
        mgr.unregister_turn(db, "r-steer")

    res = box["result"]
    assert res["status"] == "success"
    assert res["progress_messages"] == ["阶段输出A"]
    assert res["answer"] == "最终补充完成"
    assert res["usage"]["input_tokens"] == 100
    assert res["usage"]["output_tokens"] == 30
    assert res["usage"]["estimated_cost_usd"] == pytest.approx(0.000375)
    assert len(res["usage"]["model_breakdown"]) == 1
    assert any(e.get("step", {}).get("kind") == "user_steer" and e.get("step", {}).get("detail") == "请补充单测" for e in events)
    mgr.shutdown()


def test_inactivity_paused_during_active_tool_and_ignores_metadata(tmp_path, monkeypatch):
    import threading
    import time

    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_profile, "agy_executable_or_none", lambda: "fake-agy")
    monkeypatch.setattr(agy_runtime.AgyRuntimeManager, "_probe_version_once", lambda *args: "1.5.14")
    monkeypatch.setattr(agy_runtime, "INACTIVITY_TIMEOUT", 0.12)
    monkeypatch.setattr(agy_runtime, "ACTIVE_TOOL_SILENT_TIMEOUT", 0.6)
    monkeypatch.setattr(agy_runtime.child_job, "terminate_tree", lambda pid: True)
    monkeypatch.setattr(agy_runtime.child_job, "forget", lambda pid: None)

    mgr = agy_runtime.AgyRuntimeManager(idle_ttl=0)
    db = tmp_path / "sessions.db"
    worker = mgr.get_worker(str(db), "default", "s-pause", tmp_path)
    worker.acp_session_id = "acp-pause"
    worker.init_result = {"agentInfo": {"version": "1.5.14"}}
    worker.setup_result = {"sessionId": "acp-pause"}
    worker.proc = SimpleNamespace(pid=7201, stdin=None, stdout=None, poll=lambda: 0)
    monkeypatch.setattr(worker, "ensure_started", lambda **kw: "acp-pause")

    prompt_sent = threading.Event()

    def fake_send(frame):
        method = frame.get("method")
        if method == "session/prompt":
            prompt_sent.set()
        elif "id" in frame and method is not None:
            with worker._rpc_lock:
                entry = worker._pending_rpcs.pop(frame["id"], None)
            if entry is not None:
                entry[1]["result"] = {}
                entry[0].set()

    monkeypatch.setattr(worker, "_send_frame", fake_send)
    box: dict = {}
    mgr.register_turn(db, "r-pause", worker)
    t = threading.Thread(
        target=lambda: box.setdefault("result", worker.run_turn(
            run_id="r-pause", prompt_text="long tool", model="gemini-4-hydrogen-high",
            effort="high", mode="plan", permission_mode="approval-required",
            resume_conversation=None, add_dirs=(), staged_paths=[], attachments=[],
            allowed_roots=[tmp_path], on_event=lambda e: None,
        )),
        daemon=True,
    )
    t.start()
    try:
        assert prompt_sent.wait(2.0)
        # Open long-running tool pauses 0.12s INACTIVITY_TIMEOUT.
        worker._handle_session_update({
            "update": {"sessionUpdate": "tool_call", "toolCallId": "tool-long", "kind": "execute", "title": "run_command", "status": "in_progress"}
        })
        time.sleep(0.18)
        assert t.is_alive()

        # Completing the tool resumes INACTIVITY_TIMEOUT; metadata update must NOT reset it.
        worker._handle_session_update({
            "update": {"sessionUpdate": "tool_call_update", "toolCallId": "tool-long", "status": "completed"}
        })
        worker._handle_session_update({"update": {"sessionUpdate": "available_commands_update", "availableCommands": []}})
        t.join(timeout=2.0)
        assert not t.is_alive()
    finally:
        mgr.unregister_turn(db, "r-pause")

    assert box["result"]["status"] == "timeout"
    mgr.shutdown()


def test_post_settle_continuation_and_terminal_stream_wait(tmp_path, monkeypatch):
    import base64
    import threading
    import time

    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_profile, "agy_executable_or_none", lambda: "fake-agy")
    monkeypatch.setattr(agy_runtime.AgyRuntimeManager, "_probe_version_once", lambda *args: "1.5.14")
    monkeypatch.setattr(agy_runtime, "POST_SETTLE_DEBOUNCE", 0.08)
    monkeypatch.setattr(agy_runtime, "POST_SETTLE_REPLY_QUIET_LIMIT", 0.5)
    monkeypatch.setattr(agy_runtime, "POST_SETTLE_COMMAND_HOLD_TIMEOUT", 0.5)

    mgr = agy_runtime.AgyRuntimeManager(idle_ttl=0)
    db = tmp_path / "sessions.db"
    worker = mgr.get_worker(str(db), "default", "s-post", tmp_path)
    worker.acp_session_id = "acp-post"
    worker.init_result = {"agentInfo": {"version": "1.5.14"}}
    worker.setup_result = {"sessionId": "acp-post"}
    worker.proc = SimpleNamespace(pid=7301, stdin=None, stdout=None, poll=lambda: None)
    monkeypatch.setattr(worker, "ensure_started", lambda **kw: "acp-post")

    prompt_req: list[int] = []
    prompt_sent = threading.Event()
    events: list[dict] = []

    def fake_send(frame):
        method = frame.get("method")
        if method == "session/prompt":
            prompt_req.append(frame["id"])
            prompt_sent.set()
        elif "id" in frame and method is not None:
            with worker._rpc_lock:
                entry = worker._pending_rpcs.pop(frame["id"], None)
            if entry is not None:
                entry[1]["result"] = {}
                entry[0].set()

    monkeypatch.setattr(worker, "_send_frame", fake_send)
    box: dict = {}
    mgr.register_turn(db, "r-post", worker)
    t = threading.Thread(
        target=lambda: box.setdefault("result", worker.run_turn(
            run_id="r-post", prompt_text="bg work", model="gemini-4-hydrogen-high",
            effort="high", mode="plan", permission_mode="approval-required",
            resume_conversation=None, add_dirs=(), staged_paths=[], attachments=[],
            allowed_roots=[tmp_path], on_event=events.append,
        )),
        daemon=True,
    )
    t.start()
    try:
        assert prompt_sent.wait(2.0)
        worker._handle_session_update({"update": {"sessionUpdate": "terminal_update", "terminalId": "term-bg", "command": "pytest"}})
        worker._handle_session_update({
            "update": {
                "sessionUpdate": "tool_call",
                "toolCallId": "tc-bg",
                "kind": "execute",
                "title": "run_command",
                "status": "in_progress",
                "rawInput": {"CommandLine": "pytest", "IsDaemon": True},
                "content": [{"type": "terminal", "terminalId": "term-bg"}],
            }
        })
        # Prompt settles on wire while background command is still active.
        with worker._rpc_lock:
            e = worker._pending_rpcs.pop(prompt_req[0], None)
        assert e is not None
        e[1]["result"] = {"stopReason": "end_turn"}
        e[0].set()
        if len(e) > 2 and e[2] is not None:
            e[2].set()

        time.sleep(0.06)
        assert t.is_alive()

        # Late terminal output chunk and post-settle agent wake reply.
        worker._handle_session_update({
            "update": {
                "sessionUpdate": "terminal_output_chunk",
                "terminalId": "term-bg",
                "data": base64.b64encode(b"build ok\n").decode("ascii"),
            }
        })
        worker._handle_session_update({"update": {"sessionUpdate": "terminal_update", "terminalId": "term-bg", "exitStatus": {"exitCode": 0}}})
        worker._handle_session_update({"update": {"sessionUpdate": "tool_call_update", "toolCallId": "tc-bg", "status": "completed"}})
        worker._handle_session_update({"update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "后台任务已完成"}}})
        worker._handle_session_update({"update": {"sessionUpdate": "usage_update", "inputTokens": 88, "outputTokens": 19}})

        t.join(timeout=2.0)
        assert not t.is_alive()
    finally:
        mgr.unregister_turn(db, "r-post")

    res = box["result"]
    assert res["status"] == "success"
    assert res["answer"] == "后台任务已完成"
    assert res["usage"]["input_tokens"] == 88
    assert res["usage"]["output_tokens"] == 19
    assert res["usage"]["estimated_cost_usd"] == pytest.approx(0.000275)
    assert len(res["usage"]["model_breakdown"]) == 1
    assert any(e.get("step", {}).get("output") == "build ok\n" for e in events)
    mgr.shutdown()


def test_manager_list_workers_and_supports_steering_flag(tmp_path, monkeypatch):
    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_profile, "agy_executable_or_none", lambda: "fake-agy")
    monkeypatch.setattr(agy_runtime.AgyRuntimeManager, "_probe_version_once", lambda *args: "1.5.14")

    mgr = agy_runtime.AgyRuntimeManager(idle_ttl=120)
    assert mgr.status(verify_auth=False).supports_steering is True

    db = tmp_path / "sessions.db"
    w_idle = mgr.get_worker(str(db), "default", "s-idle", tmp_path)
    w_idle.acp_session_id = "acp-idle"
    w_idle.proc = SimpleNamespace(pid=8001, stdin=None, stdout=None, poll=lambda: None)

    w_busy = mgr.get_worker(str(db), "default", "s-busy", tmp_path)
    w_busy.acp_session_id = "acp-busy"
    w_busy.proc = SimpleNamespace(pid=8002, stdin=None, stdout=None, poll=lambda: None)
    w_busy.active_turn = agy_runtime._ActiveTurn("r-busy", "plan", "approval-required", tmp_path, [tmp_path], lambda e: None)

    listed = mgr.list_workers(str(db))
    assert [item["session_id"] for item in listed] == ["s-busy", "s-idle"]
    assert listed[0]["state"] == "running" and listed[0]["pid"] == 8002 and listed[0]["active_run_id"] == "r-busy"
    assert listed[1]["state"] == "idle" and listed[1]["pid"] == 8001 and listed[1]["idle_ttl"] == 120

    w_busy.active_turn = None
    mgr.shutdown()


def test_rejected_model_keeps_acp_worker_alive_and_clean(tmp_path, monkeypatch):
    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_profile, "agy_executable_or_none", lambda: "fake-agy")
    monkeypatch.setattr(agy_runtime.AgyRuntimeManager, "_probe_version_once", lambda *args: "1.5.14")

    mgr = agy_runtime.AgyRuntimeManager(idle_ttl=0)
    db = tmp_path / "sessions.db"
    worker = mgr.get_worker(str(db), "default", "s-reject", tmp_path)
    close_calls = []

    worker.setup_result = {"models": {"availableModels": [{"modelId": "gemini-4-hydrogen-low"}]}}
    monkeypatch.setattr(worker, "ensure_started", lambda **kwargs: "conv-reject")
    monkeypatch.setattr(worker, "_rpc", lambda method, params, **kwargs: {})
    monkeypatch.setattr(worker, "is_alive", lambda: True)
    monkeypatch.setattr(worker, "close", lambda **kwargs: close_calls.append(kwargs))

    try:
        res1 = worker.run_turn(
            run_id="r-rej-catalog",
            prompt_text="hello",
            model="nonexistent-model",
            effort="high",
            mode="plan",
            permission_mode="approval-required",
            resume_conversation=None,
            add_dirs=(),
            staged_paths=[],
            attachments=[],
            allowed_roots=[tmp_path],
            on_event=lambda e: None,
            allow_auto_fallback=False,
        )
        assert res1["status"] == "rejected"
        assert worker._dirty is False
        assert worker._closed is False
        assert worker.active_turn is None
        assert close_calls == []

        def fail_set_model(method, params, **kwargs):
            if method == "session/set_model":
                raise agy_profile.AgyProfileError(400, "model rejected by runtime")
            return {}

        monkeypatch.setattr(worker, "_rpc", fail_set_model)
        res2 = worker.run_turn(
            run_id="r-rej-rpc",
            prompt_text="hello",
            model="gemini-4-hydrogen-low",
            effort="low",
            mode="plan",
            permission_mode="approval-required",
            resume_conversation=None,
            add_dirs=(),
            staged_paths=[],
            attachments=[],
            allowed_roots=[tmp_path],
            on_event=lambda e: None,
            allow_auto_fallback=False,
        )
        assert res2["status"] == "rejected"
        assert worker._dirty is False
        assert worker._closed is False
        assert worker.active_turn is None
        assert close_calls == []
    finally:
        mgr.shutdown()


def test_switch_profile_decoupled_from_active_turns_and_grant_controls(tmp_path, monkeypatch):
    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_profile, "agy_executable_or_none", lambda: "fake-agy")
    monkeypatch.setattr(agy_runtime.AgyRuntimeManager, "_probe_version_once", lambda *args: "1.5.14")
    monkeypatch.setattr(agy_profile, "has_local_credentials", lambda pid: True)

    secondary = agy_profile.add("备用账号")
    mgr = agy_runtime.AgyRuntimeManager(idle_ttl=0)
    db = tmp_path / "sessions.db"

    w_busy = mgr.get_worker(str(db), "default", "s-busy", tmp_path)
    w_busy.proc = SimpleNamespace(pid=9101, poll=lambda: None, stdin=None, stdout=None)
    w_busy.active_turn = SimpleNamespace(run_id="r-busy")
    w_busy.grants.allow_all_kinds.update({"read", "edit"})
    mgr.register_turn(db, "r-busy", w_busy)

    w_idle = mgr.get_worker(str(db), "default", "s-idle", tmp_path)
    idle_closed = []
    monkeypatch.setattr(w_idle, "close", lambda **kwargs: idle_closed.append(kwargs))

    try:
        assert mgr.session_grants(str(db), "s-busy") == ["edit", "read"]

        # Account switch is safely blocked with 409 while a turn is running in the shared workspace.
        with pytest.raises(agy_profile.AgyProfileError) as busy_err:
            mgr.switch_profile(secondary.id)
        assert busy_err.value.status == 409
        assert agy_profile.snapshot()[0] == "default"

        # Once active turn ends, switch succeeds, closes idle workers, activates workspace, and preserves grants!
        mgr.unregister_turn(db, "r-busy")
        w_busy.active_turn = None
        w_busy.proc = None
        busy_closed = []
        monkeypatch.setattr(w_busy, "close", lambda **kwargs: busy_closed.append(kwargs))

        mgr.switch_profile(secondary.id)
        assert agy_profile.snapshot()[0] == secondary.id
        assert agy_profile.active_workspace_profile() == secondary.id
        assert len(idle_closed) == 1 and len(busy_closed) == 1
        assert mgr.session_grants(str(db), "s-busy") == ["edit", "read"]

        with mgr.submission() as active_pid:
            assert active_pid == secondary.id

        assert mgr.clear_session_grants(str(db), "s-busy", kind="read") == ["edit"]
        assert mgr.session_grants(str(db), "s-busy") == ["edit"]
        assert mgr.clear_session_grants(str(db), "s-busy") == []
        assert mgr.session_grants(str(db), "s-busy") == []
    finally:
        mgr.unregister_turn(db, "r-busy")
        w_busy.active_turn = None
        w_busy.proc = None
        mgr.shutdown()


def test_orchestrator_neon_switches_without_spurious_thought_level_notice(tmp_path, monkeypatch):
    import threading
    from server.services import agy_models

    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    agy_models.reset_cache()
    monkeypatch.setattr(agy_profile, "agy_executable_or_none", lambda: "fake-agy")
    monkeypatch.setattr(agy_runtime.AgyRuntimeManager, "_probe_version_once", lambda *args: "1.5.16")

    mgr = agy_runtime.AgyRuntimeManager(idle_ttl=0)
    db = tmp_path / "sessions.db"
    worker = mgr.get_worker(str(db), "default", "s-orch", tmp_path)
    worker.init_result = {"agentCapabilities": {"promptCapabilities": {}}}
    worker.setup_result = {
        "configOptions": [
            {
                "id": "model",
                "category": "model",
                "type": "select",
                "currentValue": "gemini-4-neon",
                "options": [
                    {"value": "gemini-4-neon", "name": "Gemini 4 Neon"},
                    {"value": "gemini-pro-orchestrator-neon", "name": "Orchestrator (Neon)"},
                ],
            },
            {
                "id": "thought_level",
                "category": "thought_level",
                "type": "select",
                "currentValue": "high",
                "options": [{"value": "low"}, {"value": "medium"}, {"value": "high"}, {"value": "xhigh"}],
            },
        ],
    }

    rpc_calls = []
    events = []

    def fake_rpc(method, params, **kwargs):
        rpc_calls.append((method, params))
        if method == "session/set_config_option" and params.get("configId") == "model":
            return {
                "configOptions": [
                    {
                        "id": "model",
                        "category": "model",
                        "type": "select",
                        "currentValue": "gemini-pro-orchestrator-neon",
                        "options": [
                            {"value": "gemini-4-neon", "name": "Gemini 4 Neon"},
                            {"value": "gemini-pro-orchestrator-neon", "name": "Orchestrator (Neon)"},
                        ],
                    }
                ]
            }
        return {}

    def fake_send_frame(frame):
        if frame.get("method") == "session/prompt":
            req_id = frame["id"]
            with worker._rpc_lock:
                entry = worker._pending_rpcs.pop(req_id, None)
            if entry is not None:
                entry[1]["result"] = {}
                entry[0].set()

    monkeypatch.setattr(worker, "ensure_started", lambda **kwargs: "conv-orch")
    monkeypatch.setattr(worker, "_rpc", fake_rpc)
    monkeypatch.setattr(worker, "_send_frame", fake_send_frame)

    try:
        res = worker.run_turn(
            run_id="r-orch",
            prompt_text="run orchestrator",
            model="gemini-pro-orchestrator-neon",
            effort="high",
            mode="accept-edits",
            permission_mode="auto",
            resume_conversation=None,
            add_dirs=(),
            staged_paths=[],
            attachments=[],
            allowed_roots=[tmp_path],
            on_event=events.append,
        )
    finally:
        mgr.shutdown()

    assert res["status"] == "success"
    assert res["effective_model"] == "gemini-pro-orchestrator-neon"
    assert res["fallback_notice"] is None
    assert not any(
        m == "session/set_config_option" and p.get("configId") == "thought_level"
        for m, p in rpc_calls
    )
    assert not any((e.get("step") or {}).get("tool") == "runtime_notice" for e in events)


def test_auto_fallback_to_default_model_and_local_config_hot_reload(tmp_path, monkeypatch):
    import json
    from datetime import datetime, timezone
    from server.services import agy_models

    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    agy_models.reset_cache()
    monkeypatch.setattr(agy_profile, "agy_executable_or_none", lambda: "fake-agy")
    monkeypatch.setattr(agy_runtime.AgyRuntimeManager, "_probe_version_once", lambda *args: "1.5.16")

    # Verify 6-hour clock boundary math (00/06/12/18 local clock)
    sample = datetime(2026, 11, 25, 11, 45, 0).astimezone()
    assert agy_models.latest_scheduled_slot(sample).hour == 6
    assert agy_models.next_scheduled_slot(sample).hour == 12
    early = datetime(2026, 11, 25, 4, 15, 0).astimezone()
    assert agy_models.latest_scheduled_slot(early).hour == 0
    assert agy_models.next_scheduled_slot(early).hour == 6

    # Write local config directly and confirm hot-reload without restarting
    agy_models.patch_user_config(
        default_model="gemini-4-hydrogen-high",
        aliases={"old-hybrid": "gemini-4-hydrogen-high"},
        quota_rules=[{"pattern": "custom-hybrid", "group": "claude-3p"}],
        allow_auto_fallback=True,
    )
    assert agy_usage._model_group("custom-hybrid-v2") == "claude-3p"
    raw = json.loads(agy_models.config_path().read_text(encoding="utf-8"))
    assert raw["defaults"]["model"] == "gemini-4-hydrogen-high"

    mgr = agy_runtime.AgyRuntimeManager(idle_ttl=0)
    db = tmp_path / "sessions.db"
    worker = mgr.get_worker(str(db), "default", "s-fb", tmp_path)
    worker.init_result = {"agentCapabilities": {"promptCapabilities": {}}}
    worker.setup_result = {
        "models": {
            "currentModelId": "gemini-4-hydrogen-high",
            "availableModels": [{"modelId": "gemini-4-hydrogen-high", "name": "Gemini 4 Hydrogen (High)"}],
        }
    }

    events = []
    rpc_models = []

    def fake_rpc(method, params, **kwargs):
        if method == "session/set_model":
            rpc_models.append(params.get("modelId"))
        return {}

    def fake_send_frame(frame):
        if frame.get("method") == "session/prompt":
            req_id = frame["id"]
            with worker._rpc_lock:
                entry = worker._pending_rpcs.pop(req_id, None)
            if entry is not None:
                entry[1]["result"] = {}
                entry[0].set()

    monkeypatch.setattr(worker, "ensure_started", lambda **kwargs: "conv-fb")
    monkeypatch.setattr(worker, "_rpc", fake_rpc)
    monkeypatch.setattr(worker, "_send_frame", fake_send_frame)

    try:
        res = worker.run_turn(
            run_id="r-fb",
            prompt_text="run fallback",
            model="retired-model-x",
            effort="high",
            mode="plan",
            permission_mode="approval-required",
            resume_conversation=None,
            add_dirs=(),
            staged_paths=[],
            attachments=[],
            allowed_roots=[tmp_path],
            on_event=events.append,
        )
    finally:
        mgr.shutdown()

    assert res["status"] == "success"
    assert res["effective_model"] == "gemini-4-hydrogen-high"
    assert rpc_models == ["gemini-4-hydrogen-high"]
    assert res["fallback_notice"] and "retired-model-x" in res["fallback_notice"] and "gemini-4-hydrogen-high" in res["fallback_notice"]
    assert any(
        (e.get("step") or {}).get("tool") == "runtime_notice" and "gemini-4-hydrogen-high" in ((e.get("step") or {}).get("detail") or "")
        for e in events
    )


def test_models_sync_cloudcode_merge_and_orchestrator_settings_endpoints(tmp_path, monkeypatch):
    import json
    from server.services import agy_models

    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    agy_models.reset_cache()
    fake_home = tmp_path / "home"
    monkeypatch.setattr(agy_profile.Path, "home", staticmethod(lambda: fake_home))
    monkeypatch.setattr(agy_profile, "agy_executable_or_none", lambda: "C:/fake/agy.exe")
    monkeypatch.setattr(
        agy_runtime.subprocess,
        "run",
        lambda *a, **kw: SimpleNamespace(
            returncode=0,
            stdout=(
                "gemini-4-neon-high\tGemini 4 Neon (High)\n"
                "gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)\n"
                "gemini-pro-orchestrator-neon\tOrchestrator (Neon)\n"
            ),
            stderr="",
        ),
    )

    client = make_client(monkeypatch)
    synced = client.post("/api/anti/models/sync")
    assert synced.status_code == 200
    body = synced.json()
    ids = [m["id"] for m in body["items"]]
    assert "gemini-4-neon-high" in ids and "gemini-4-hydrogen-high" in ids and "gemini-pro-orchestrator-neon" in ids
    assert body["synced_at"] and body["next_sync_at"]
    assert agy_models.config_path().is_file()

    cfg_patch = client.patch(
        "/api/anti/models/config",
        json={"schedule_hours": [0, 6, 12, 18], "default_model": "gemini-4-hydrogen-high", "aliases": {"neon": "gemini-4-neon-high"}},
        headers={"X-GA-Hub-Action": "manage-anti-gateway"},
    )
    assert cfg_patch.status_code == 200 and cfg_patch.json()["aliases"] == {"neon": "gemini-4-neon-high"}

    # Preserve unrelated keys in shared workspace settings.json while editing flat orchestrator keys
    alt = agy_profile.add("Second")
    ws_settings = agy_profile.workspace_app_data_dir() / "settings.json"
    ws_settings.parent.mkdir(parents=True, exist_ok=True)
    ws_settings.write_text(json.dumps({"colorScheme": "tokyo night"}), encoding="utf-8")

    headers = {"X-GA-Hub-Action": "manage-agy-profiles"}
    assert client.get("/api/anti/profiles/default/orchestrator").json() == {"profile_id": "default", "planner": None, "executor": None}

    updated = client.patch(
        "/api/anti/profiles/default/orchestrator",
        json={"planner": "gemini-4-neon-xhigh", "executor": "gemini-4-hydrogen-high"},
        headers=headers,
    )
    assert updated.status_code == 200
    assert updated.json() == {"profile_id": "default", "planner": "gemini-4-neon-xhigh", "executor": "gemini-4-hydrogen-high"}
    saved_json = json.loads(ws_settings.read_text(encoding="utf-8"))
    assert saved_json["colorScheme"] == "tokyo night"
    assert saved_json["orchestrator"] == {"planner": "gemini-4-neon-xhigh", "executor": "gemini-4-hydrogen-high"}
    # Orchestrator settings are globally shared across accounts
    assert client.get(f"/api/anti/profiles/{alt.id}/orchestrator").json() == {
        "profile_id": alt.id,
        "planner": "gemini-4-neon-xhigh",
        "executor": "gemini-4-hydrogen-high",
    }

    cleared = client.patch(
        "/api/anti/profiles/default/orchestrator",
        json={"planner": None, "executor": None},
        headers=headers,
    )
    assert cleared.status_code == 200
    cleared_json = json.loads(ws_settings.read_text(encoding="utf-8"))
    assert "orchestrator" not in cleared_json and cleared_json["colorScheme"] == "tokyo night"

    # Models config also persists fixed-2 orchestrator presets & hidden model filters
    preset_patch = client.patch(
        "/api/anti/models/config",
        json={
            "orchestrator_presets": [
                {"id": "preset-1", "name": "  架构主力  ", "planner": "gemini-4-neon-xhigh", "executor": "gemini-4-hydrogen-medium"},
                {"id": "preset-2", "name": "", "planner": "gemini-4-carbon-high", "executor": "claude-sonnet-5-5-high"},
            ],
            "hidden_models": ["gpt-oss-120b", "gemini-3.8-flash", "gpt-oss-120b"],
        },
        headers={"X-GA-Hub-Action": "manage-anti-gateway"},
    )
    assert preset_patch.status_code == 422  # empty preset name rejected cleanly

    preset_patch_ok = client.patch(
        "/api/anti/models/config",
        json={
            "orchestrator_presets": [
                {"id": "preset-1", "name": "架构主力", "planner": "gemini-4-neon-xhigh", "executor": "gemini-4-hydrogen-medium"},
                {"id": "preset-2", "name": "稳健备份", "planner": "gemini-4-carbon-high", "executor": "claude-sonnet-5-5-high"},
                {"id": "preset-extra", "name": "忽略第三套", "planner": "gemini-4-argon-high", "executor": "gemini-4-hydrogen-high"},
            ],
            "hidden_models": ["gpt-oss-120b", "gemini-3.8-flash", "gpt-oss-120b"],
        },
        headers={"X-GA-Hub-Action": "manage-anti-gateway"},
    )
    assert preset_patch_ok.status_code == 200
    preset_data = preset_patch_ok.json()
    assert len(preset_data["orchestrator_presets"]) == 2
    assert preset_data["orchestrator_presets"][0] == {
        "id": "preset-1",
        "name": "架构主力",
        "planner": "gemini-4-neon-xhigh",
        "executor": "gemini-4-hydrogen-medium",
    }
    assert preset_data["hidden_models"] == ["gpt-oss-120b", "gemini-3.8-flash"]


def test_ensure_orchestrator_roles_recycles_mismatched_idle_workers_only(tmp_path, monkeypatch):
    import json

    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    agy_profile.prepare_workspace("default")
    ws_settings = agy_profile.workspace_app_data_dir() / "settings.json"
    ws_settings.write_text(json.dumps({"orchestrator": {"planner": "gemini-4-carbon-high", "executor": "gemini-4-hydrogen-high"}}), encoding="utf-8")

    mgr = agy_runtime.AgyRuntimeManager(idle_ttl=0)
    try:
        closed_workers: list[str] = []

        class StubWorker:
            def __init__(self, label: str, loaded: tuple[str | None, str | None], *, active_turn=None, has_proc=True):
                self.label = label
                self.loaded_orchestrator = loaded
                self.active_turn = active_turn
                self.proc = object() if has_proc else None

            def exit_pending(self) -> bool:
                return False

            def close(self, *, force: bool = True) -> None:
                closed_workers.append(self.label)

        w_idle_mismatch = StubWorker("idle-mismatch", ("gemini-4-carbon-high", "gemini-4-hydrogen-high"))
        w_idle_same = StubWorker("idle-same", ("gemini-4-neon-xhigh", "gemini-4-hydrogen-medium"))
        w_active_mismatch = StubWorker("active-mismatch", ("gemini-4-carbon-high", "gemini-4-hydrogen-high"), active_turn=object())

        with mgr._lock:
            mgr._workers[("db1", "default", "s-target")] = w_idle_mismatch  # type: ignore[assignment]
            mgr._workers[("db1", "default", "s-same")] = w_idle_same  # type: ignore[assignment]
            mgr._workers[("db1", "default", "s-busy")] = w_active_mismatch  # type: ignore[assignment]
            mgr._active_turns[("db1", "r-busy")] = w_active_mismatch  # type: ignore[assignment]

        mgr.ensure_orchestrator_roles(
            "db1",
            "default",
            "s-target",
            planner="gemini-4-neon-xhigh",
            executor="gemini-4-hydrogen-medium",
        )

        assert closed_workers == ["idle-mismatch"]
        saved = json.loads(ws_settings.read_text(encoding="utf-8"))
        assert saved["orchestrator"] == {"planner": "gemini-4-neon-xhigh", "executor": "gemini-4-hydrogen-medium"}
        assert ("db1", "default", "s-same") in mgr._workers
        assert ("db1", "default", "s-busy") in mgr._workers
    finally:
        mgr.shutdown()


def test_usage_probe_uses_official_cli_json_and_suppresses_untouched_reset(tmp_path, monkeypatch):
    import io
    import json
    from datetime import datetime, timedelta, timezone

    assert not hasattr(agy_usage, "probe_available_models")
    assert not hasattr(agy_usage, "DAILY_ENDPOINT")
    assert not hasattr(agy_usage, "PROD_ENDPOINT")

    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_usage._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_profile, "agy_executable_or_none", lambda: "C:/fake/agy.exe")

    work = agy_profile.add("Business Work")
    app_dir = agy_profile.profile_app_data_dir(work.id)
    app_dir.mkdir(parents=True, exist_ok=True)
    (app_dir / "settings.json").write_text(json.dumps({"auth": {"type": "oauth-business"}}), encoding="utf-8")
    (app_dir / "antigravity-oauth-token").write_text(
        json.dumps({"token": {"access_token": "valid-business-token", "refresh_token": "rtok"}}),
        encoding="utf-8",
    )

    now = datetime.now(timezone.utc)
    spawned: list[tuple[list[str], dict]] = []
    cli_payload = {
        "status": "SUCCESS",
        "command": {
            "name": "usage",
            "data": {
                "groups": [
                    {
                        "name": "Gemini models",
                        "buckets": [
                            {
                                "id": "gemini-5h",
                                "name": "Five Hour Limit Remaining",
                                "window": "5h",
                                "remaining_fraction": 1.0,
                                "reset_time": (now + timedelta(hours=5)).isoformat().replace("+00:00", "Z"),
                            },
                            {
                                "id": "gemini-argon-weekly",
                                "name": "Weekly Limit Remaining",
                                "window": "weekly",
                                "remaining_fraction": 0.55,
                                "reset_time": "2026-11-29T00:00:00Z",
                            },
                        ],
                    },
                    {
                        "name": "Claude & GPT models",
                        "buckets": [
                            {
                                "id": "3p-weekly",
                                "name": "Weekly Limit Remaining",
                                "window": "weekly",
                                "remaining_fraction": 0.72,
                                "reset_time": "2026-11-30T08:00:00Z",
                            },
                        ],
                    },
                ],
            },
        },
    }

    class FakeGroup:
        def terminate(self, pid):
            return True

        def close(self):
            pass

    def fake_spawn(cmd, **kwargs):
        spawned.append((cmd, kwargs))
        assert cmd == ["C:/fake/agy.exe", "-p", "/usage", "--output-format", "json", "--print-timeout", "15s"]
        assert kwargs["stdin"] == subprocess.DEVNULL
        assert kwargs["env"]["GEMINI_HOME"] == str(agy_profile.profile_vault_gemini_dir(work.id))
        return SimpleNamespace(
            pid=8801,
            returncode=0,
            stdout=io.StringIO(json.dumps(cli_payload)),
            stderr=io.StringIO(""),
            wait=lambda timeout=None: 0,
        )

    monkeypatch.setattr(agy_usage.child_job, "spawn", fake_spawn)
    monkeypatch.setattr(agy_usage.child_job, "create_process_group", lambda proc: FakeGroup())
    monkeypatch.setattr(agy_usage.child_job, "forget", lambda pid: None)

    client = make_client(monkeypatch)
    resp = client.post(
        f"/api/anti/account-usage?profile_id={work.id}",
        headers={"X-GA-Hub-Action": "check-anti-usage"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["state"] == "authenticated"
    assert body.get("account_tier") == "enterprise"
    assert len(spawned) == 1
    by_model = {(r["model"], r["limit"]): r for r in body["rows"]}
    assert by_model[("Gemini", "Five Hour Limit Remaining")]["remaining_pct"] == 100.0
    assert by_model[("Gemini", "Five Hour Limit Remaining")].get("resets_at") is None
    assert by_model[("Claude & GPT (shared)", "Weekly Limit Remaining")]["remaining_pct"] == 72.0
    assert by_model[("Gemini Argon", "Weekly Limit Remaining")]["remaining_pct"] == 55.0

    # Usage snapshot & tier persisted strictly under `work.id`
    profiles_resp = client.get("/api/anti/profiles").json()
    work_entry = next(p for p in profiles_resp["profiles"] if p["id"] == work.id)
    def_entry = next(p for p in profiles_resp["profiles"] if p["id"] == "default")
    assert work_entry["usage"]["min_remaining_pct"] == 55.0
    assert work_entry["account_tier"] == "enterprise"
    assert "usage" not in def_entry


def test_usage_probe_aborts_immediately_on_auth_required_and_timeout(tmp_path, monkeypatch):
    import io
    import json

    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_usage._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_profile, "agy_executable_or_none", lambda: "C:/fake/agy.exe")

    # 1. Profile with no local credentials short-circuits without spawning `agy`
    no_cred = agy_profile.add("Unauthenticated")
    spawn_count = 0

    def forbid_spawn(*args, **kwargs):
        nonlocal spawn_count
        spawn_count += 1
        raise AssertionError("Should not spawn agy when local credentials are missing")

    monkeypatch.setattr(agy_usage.child_job, "spawn", forbid_spawn)
    missing_report = agy_usage.probe_account_usage(no_cred.id)
    assert missing_report["state"] == "login_required"
    assert missing_report["rows"] == []
    assert spawn_count == 0

    # 2. Profile whose CLI prints `Authentication required` on stderr terminates immediately
    prof = agy_profile.add("Revoked Token")
    app_dir = agy_profile.profile_app_data_dir(prof.id)
    app_dir.mkdir(parents=True, exist_ok=True)
    (app_dir / "antigravity-oauth-token").write_text(
        json.dumps({"token": {"access_token": "revoked", "refresh_token": "rtok"}}),
        encoding="utf-8",
    )

    terminated: list[int] = []

    class FakeGroup:
        def terminate(self, pid):
            terminated.append(pid)
            return True

        def close(self):
            pass

    def spawn_auth_prompt(cmd, **kwargs):
        return SimpleNamespace(
            pid=8811,
            returncode=1,
            stdout=io.StringIO(""),
            stderr=io.StringIO("Authentication required. Please visit the URL to log in:\nWaiting for authentication (timeout 60s)...\n"),
            wait=lambda timeout=None: 1,
        )

    monkeypatch.setattr(agy_usage.child_job, "spawn", spawn_auth_prompt)
    monkeypatch.setattr(agy_usage.child_job, "create_process_group", lambda proc: FakeGroup())
    monkeypatch.setattr(agy_usage.child_job, "forget", lambda pid: None)

    auth_report = agy_usage.probe_account_usage(prof.id)
    assert auth_report["state"] == "login_required"
    assert auth_report["rows"] == []
    assert 8811 in terminated

    # 3. Timeout kills process tree and returns `unverified`
    terminated.clear()

    def spawn_timeout(cmd, **kwargs):
        def wait_timeout(timeout=None):
            raise subprocess.TimeoutExpired(cmd, timeout or 18)

        return SimpleNamespace(
            pid=8822,
            returncode=None,
            stdout=io.StringIO(""),
            stderr=io.StringIO(""),
            wait=wait_timeout,
        )

    monkeypatch.setattr(agy_usage.child_job, "spawn", spawn_timeout)
    timeout_report = agy_usage.probe_account_usage(prof.id)
    assert timeout_report["state"] == "unverified"
    assert timeout_report["rows"] == []
    assert "超时" in (timeout_report.get("detail") or "")
    assert terminated == [8822]


def test_refresh_profile_token_uses_official_agy_models_only(tmp_path, monkeypatch):
    import json
    from datetime import datetime, timedelta, timezone

    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_usage._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_profile, "agy_executable_or_none", lambda: "C:/fake/agy.exe")

    prof = agy_profile.add("Expiring CLI")
    tok_path = agy_profile.profile_app_data_dir(prof.id) / "antigravity-oauth-token"
    tok_path.parent.mkdir(parents=True, exist_ok=True)
    tok_path.write_text(
        json.dumps({
            "token": {
                "access_token": "expired-token",
                "refresh_token": "rtok",
                "expiry": (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat(),
            }
        }),
        encoding="utf-8",
    )

    spawn_calls = []
    terminated = []

    class FakeGroup:
        def terminate(self, pid):
            terminated.append(pid)
            return True

        def close(self):
            pass

    def spawn_refresh_success(cmd, **kwargs):
        spawn_calls.append((cmd, kwargs))
        assert cmd == ["C:/fake/agy.exe", "models"]
        assert kwargs["stdin"] == subprocess.DEVNULL
        assert kwargs["stdout"] == subprocess.DEVNULL
        assert kwargs["stderr"] == subprocess.DEVNULL
        if sys.platform == "win32":
            assert kwargs["creationflags"] & subprocess.CREATE_NO_WINDOW
            assert not (kwargs["creationflags"] & subprocess.DETACHED_PROCESS)
        tok_path.write_text(
            json.dumps({
                "token": {
                    "access_token": "fresh-token",
                    "refresh_token": "rtok",
                    "expiry": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
                }
            }),
            encoding="utf-8",
        )
        return SimpleNamespace(pid=7711, returncode=0, wait=lambda timeout=None: 0)

    monkeypatch.setattr(agy_usage.child_job, "spawn", spawn_refresh_success)
    monkeypatch.setattr(agy_usage.child_job, "create_process_group", lambda proc: FakeGroup())
    monkeypatch.setattr(agy_usage.child_job, "forget", lambda pid: None)

    assert agy_usage.refresh_profile_token(prof.id) == "ok"
    assert len(spawn_calls) == 1 and terminated == []

    # Timeout during `agy models` terminates Job Object tree and classifies as transient_error
    def spawn_refresh_timeout(cmd, **kwargs):
        def wait_timeout(timeout=None):
            raise subprocess.TimeoutExpired(cmd, timeout or 8)

        return SimpleNamespace(pid=7722, returncode=None, wait=wait_timeout)

    monkeypatch.setattr(agy_usage.child_job, "spawn", spawn_refresh_timeout)
    assert agy_usage.refresh_profile_token(prof.id) == "transient_error"
    assert terminated == [7722]

    # Missing refresh token on nonzero exit classifies as login_required
    tok_path.write_text(json.dumps({"token": {"access_token": "expired-only"}}), encoding="utf-8")
    monkeypatch.setattr(
        agy_usage.child_job,
        "spawn",
        lambda cmd, **kw: SimpleNamespace(pid=7733, returncode=1, wait=lambda timeout=None: 1),
    )
    assert agy_usage.refresh_profile_token(prof.id) == "login_required"


def test_ledger_exclusive_and_legacy_rows_keep_cache_ratio_bounded(tmp_path, monkeypatch):
    import sqlite3

    monkeypatch.setattr(agy_usage._paths, "ADMIN_DATA", tmp_path)
    db = tmp_path / "ledger_cache.sqlite3"
    ledger = agy_usage.AgyLedger(db)

    # Record a run with exclusive-like input (cached > input)
    ledger.record_run(
        "r-excl",
        "gemini-pro-orchestrator-neon",
        "success",
        input_tokens=778_033,
        output_tokens=90_537,
        cache_read_tokens=4_683_759,
        thinking_tokens=29_726,
    )
    # Also inject a legacy pre-fix SQLite row where input_tokens < cache_read_tokens
    with sqlite3.connect(db) as conn, conn:
        conn.execute(
            "INSERT INTO usage_ledger (run_id, profile_id, model, model_group, status, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, thinking_tokens, estimated_cost_usd, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("r-legacy", "default", "claude-4-sonnet", "claude-3p", "success", 1000, 100, 4000, 0, 0, 0.02, "2099-01-01T00:00:00+00:00"),
        )

    stats = ledger.stats(window_hours=0)
    assert 0.0 <= stats["cache_hit_ratio"] <= 1.0
    # Total input = (778033 + 4683759) + (1000 + 4000) = 5,466,792; cached = 4,687,759 -> ~0.8575
    assert abs(stats["cache_hit_ratio"] - (4_687_759 / 5_466_792)) < 0.001
    # output_tokens already includes thinking_tokens (90,537 + 100), not 90,537 + 29,726 + 100
    assert stats["total_tokens"] == 5_466_792 + 90_537 + 100
    # Cost of r-excl must include both non_cached (778,033) and cached (4,683,759) tokens (> $1.50)
    assert stats["estimated_cost_usd"] > 1.5

    # Low-cache ACP turn without totalTokens (cachedReadTokens <= inputTokens) must still fold cached into input
    low_cache_norm = agy_runtime.normalize_usage_payload({
        "inputTokens": 100_000,
        "cachedReadTokens": 40_000,
        "outputTokens": 5_000,
        "thoughtTokens": 1_000,
    })
    assert low_cache_norm == {
        "input_tokens": 140_000,
        "output_tokens": 5_000,
        "cache_read_tokens": 40_000,
        "thinking_tokens": 1_000,
    }
    ledger_low = agy_usage.AgyLedger(tmp_path / "ledger_low_cache.sqlite3")
    ledger_low.record_run(
        "r-low",
        "gemini-4-hydrogen-high",
        "success",
        input_tokens=low_cache_norm["input_tokens"],
        output_tokens=low_cache_norm["output_tokens"],
        cache_read_tokens=low_cache_norm["cache_read_tokens"],
        thinking_tokens=low_cache_norm["thinking_tokens"],
    )
    low_stats = ledger_low.stats(window_hours=0)
    assert low_stats["total_tokens"] == 145_000
    assert abs(low_stats["cache_hit_ratio"] - (40_000 / 140_000)) < 0.0005


def test_runtime_prompt_usage_replaces_stale_usage_update_and_normalizes_steer(tmp_path, monkeypatch):
    import threading

    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_profile, "agy_executable_or_none", lambda: "fake-agy")
    monkeypatch.setattr(agy_runtime.AgyRuntimeManager, "_probe_version_once", lambda *args: "1.5.14")

    mgr = agy_runtime.AgyRuntimeManager(idle_ttl=60)
    db = str(tmp_path / "sessions.db")
    worker = mgr.get_worker(db, "default", "s-usage", tmp_path)
    worker.acp_session_id = "acp-usage"
    worker.init_result = {"agentInfo": {"version": "1.5.14"}}
    worker.setup_result = {"sessionId": "acp-usage"}
    worker.proc = SimpleNamespace(pid=7103, stdin=None, stdout=None, poll=lambda: None)
    monkeypatch.setattr(worker, "ensure_started", lambda **kw: "acp-usage")

    prompt_ids: list[int] = []
    prompt1_seen = threading.Event()
    prompt2_seen = threading.Event()

    def fake_send_frame(frame):
        method = frame.get("method")
        rid = frame.get("id")
        if method == "session/prompt":
            prompt_ids.append(rid)
            if len(prompt_ids) == 1:
                prompt1_seen.set()
            elif len(prompt_ids) == 2:
                prompt2_seen.set()
        elif rid is not None and method is not None:
            with worker._rpc_lock:
                entry = worker._pending_rpcs.pop(rid, None)
            if entry is not None:
                entry[1]["result"] = {}
                entry[0].set()

    monkeypatch.setattr(worker, "_send_frame", fake_send_frame)

    events: list[dict] = []
    box: dict = {}
    mgr.register_turn(db, "r-usage", worker)
    t = threading.Thread(
        target=lambda: box.setdefault("result", worker.run_turn(
            run_id="r-usage", prompt_text="first", model="gemini-4-hydrogen-high",
            effort="high", mode="plan", permission_mode="approval-required",
            resume_conversation=None, add_dirs=(), staged_paths=[], attachments=[],
            allowed_roots=[tmp_path], on_event=events.append,
        )),
        daemon=True,
    )
    t.start()
    try:
        assert prompt1_seen.wait(2.0)
        # Mid-turn usage_update carries stale cache_read_tokens that must NOT leak into final PromptResponse.usage
        worker._handle_session_update({
            "update": {"sessionUpdate": "usage_update", "inputTokens": 999, "cachedReadTokens": 888, "outputTokens": 5}
        })
        assert mgr.steer_turn(db, "r-usage", prompt_text="second", staged_paths=[], attachments=[], allowed_roots=[tmp_path])["steered"]
        assert prompt2_seen.wait(2.0)

        with worker._rpc_lock:
            e1 = worker._pending_rpcs.pop(prompt_ids[0], None)
        assert e1 is not None
        e1[1]["result"] = {
            "stopReason": "end_turn",
            "usage": {"inputTokens": 100, "cachedReadTokens": 400, "outputTokens": 20},
        }
        e1[0].set()
        if len(e1) > 2 and e1[2] is not None:
            e1[2].set()

        with worker._rpc_lock:
            e2 = worker._pending_rpcs.pop(prompt_ids[1], None)
        assert e2 is not None
        e2[1]["result"] = {
            "stopReason": "end_turn",
            "usage": {"inputTokens": 200, "outputTokens": 30},
        }
        e2[0].set()
        if len(e2) > 2 and e2[2] is not None:
            e2[2].set()

        t.join(timeout=2.0)
        assert not t.is_alive()
    finally:
        mgr.unregister_turn(db, "r-usage")

    res = box["result"]
    # Prompt 1 normalized to 500 input / 400 cached / 20 out; Prompt 2 = 200 input / 30 out; stale 999/888 replaced!
    assert res["usage"]["input_tokens"] == 700
    assert res["usage"]["output_tokens"] == 50
    assert res["usage"]["cache_read_tokens"] == 400
    assert res["usage"]["estimated_cost_usd"] == pytest.approx(0.000855)
    assert len(res["usage"]["model_breakdown"]) == 1
    mgr.shutdown()


def test_workspace_credential_sync_back_and_hot_swap(tmp_path, monkeypatch):
    import json

    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_profile.Path, "home", staticmethod(lambda: tmp_path / "empty_host"))
    monkeypatch.setattr(agy_profile, "_read_windows_keyring_safely", lambda: None)
    monkeypatch.setattr(agy_profile, "agy_executable_or_none", lambda: "fake-agy")
    monkeypatch.setattr(agy_runtime.AgyRuntimeManager, "_probe_version_once", lambda *args: "1.5.16")

    alt = agy_profile.add("Business")
    def_app = agy_profile.profile_vault_app_data_dir("default")
    alt_app = agy_profile.profile_vault_app_data_dir(alt.id)
    def_app.mkdir(parents=True, exist_ok=True)
    alt_app.mkdir(parents=True, exist_ok=True)
    (def_app / "antigravity-oauth-token").write_text('{"token":{"access_token":"def-v1"}}', encoding="utf-8")
    (def_app / "jetski_state.pbtxt").write_bytes(b"def-jetski")
    (def_app / "settings.json").write_text(json.dumps({"auth": {"type": "oauth-personal"}}), encoding="utf-8")
    (alt_app / "antigravity-oauth-token").write_text('{"token":{"access_token":"alt-v1"}}', encoding="utf-8")
    (alt_app / "jetski_state.pbtxt").write_bytes(b"alt-jetski")
    (alt_app / "settings.json").write_text(json.dumps({"auth": {"type": "oauth-business"}}), encoding="utf-8")

    mgr = agy_runtime.AgyRuntimeManager(idle_ttl=0)
    try:
        agy_profile.activate_profile_in_workspace("default")
        ws_app = agy_profile.workspace_app_data_dir()
        (ws_app / "conversations").mkdir(parents=True, exist_ok=True)
        (ws_app / "conversations" / "shared-c1.db").write_bytes(b"shared-conv-bytes")
        mgr.set_profile_orchestrator("default", planner="gemini-4-neon-xhigh", executor="gemini-4-hydrogen-high")

        # Simulate agy acp refreshing default's access_token inside the shared workspace
        (ws_app / "antigravity-oauth-token").write_text('{"token":{"access_token":"def-refreshed"}}', encoding="utf-8")

        mgr.switch_profile(alt.id)
        assert json.loads((def_app / "antigravity-oauth-token").read_text(encoding="utf-8"))["token"]["access_token"] == "def-refreshed"
        assert json.loads((ws_app / "antigravity-oauth-token").read_text(encoding="utf-8"))["token"]["access_token"] == "alt-v1"
        assert (ws_app / "jetski_state.pbtxt").read_bytes() == b"alt-jetski"
        ws_settings = json.loads((ws_app / "settings.json").read_text(encoding="utf-8"))
        assert ws_settings["auth"]["type"] == "oauth-business"
        assert ws_settings["orchestrator"] == {"planner": "gemini-4-neon-xhigh", "executor": "gemini-4-hydrogen-high"}
        assert (ws_app / "conversations" / "shared-c1.db").read_bytes() == b"shared-conv-bytes"

        # Switching back restores the refreshed default token while preserving shared conversations & orchestrator
        mgr.switch_profile("default")
        assert json.loads((ws_app / "antigravity-oauth-token").read_text(encoding="utf-8"))["token"]["access_token"] == "def-refreshed"
        assert (ws_app / "jetski_state.pbtxt").read_bytes() == b"def-jetski"
        ws_settings2 = json.loads((ws_app / "settings.json").read_text(encoding="utf-8"))
        assert ws_settings2["auth"]["type"] == "oauth-personal"
        assert ws_settings2["orchestrator"] == {"planner": "gemini-4-neon-xhigh", "executor": "gemini-4-hydrogen-high"}
        assert (ws_app / "conversations" / "shared-c1.db").read_bytes() == b"shared-conv-bytes"
    finally:
        mgr.shutdown()


def test_workspace_lossless_migration_and_conversation_rescue(tmp_path, monkeypatch):
    import json
    import sqlite3

    admin = tmp_path / "admin"
    fake_home = tmp_path / "host"
    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", admin)
    monkeypatch.setattr(agy_profile.Path, "home", staticmethod(lambda: fake_home))

    alpha = agy_profile.add("Alpha")
    agy_profile.select(alpha.id)

    def write_sqlite(path: Path, val: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(path) as c, c:
            c.execute("CREATE TABLE t (v TEXT)")
            c.execute("INSERT INTO t VALUES (?)", (val,))

    alpha_app = agy_profile.profile_vault_app_data_dir(alpha.id)
    def_app = agy_profile.profile_vault_app_data_dir("default")
    write_sqlite(alpha_app / "conversations" / "conv-alpha.db", "alpha-data")
    write_sqlite(alpha_app / "conversation_summaries.db", "alpha-summary")
    (alpha_app / "brain" / "conv-alpha").mkdir(parents=True, exist_ok=True)
    (alpha_app / "brain" / "conv-alpha" / "notes.md").write_text("alpha brain", encoding="utf-8")
    (alpha_app / "settings.json").write_text(
        json.dumps({"auth": {"type": "oauth-personal"}, "orchestrator": {"planner": "gemini-4-neon-high"}}),
        encoding="utf-8",
    )
    write_sqlite(def_app / "conversations" / "conv-def.db", "def-data")

    agy_profile.ensure_workspace_ready()
    ws_app = agy_profile.workspace_app_data_dir()
    assert (ws_app / "conversations" / "conv-alpha.db").is_file()
    assert (ws_app / "conversations" / "conv-def.db").is_file()
    assert (ws_app / "brain" / "conv-alpha" / "notes.md").read_text(encoding="utf-8") == "alpha brain"
    assert (ws_app / "conversation_summaries.db").is_file()
    assert agy_profile.get_orchestrator_settings(alpha.id)["planner"] == "gemini-4-neon-high"
    # Legacy originals remain untouched (non-destructive migration)
    assert (alpha_app / "conversations" / "conv-alpha.db").is_file()

    # On-demand rescue from host ~/.gemini/antigravity-cli for historical default-profile sessions
    host_app = fake_home / ".gemini" / agy_profile.APP_DATA_DIR_NAME
    write_sqlite(host_app / "conversations" / "conv-host.db", "host-data")
    (host_app / "brain" / "conv-host").mkdir(parents=True, exist_ok=True)
    (host_app / "brain" / "conv-host" / "artifact.txt").write_text("rescued", encoding="utf-8")
    assert agy_profile.rescue_conversation_files("conv-host") is True
    with sqlite3.connect(ws_app / "conversations" / "conv-host.db") as c:
        assert c.execute("SELECT v FROM t").fetchone()[0] == "host-data"
    assert (ws_app / "brain" / "conv-host" / "artifact.txt").read_text(encoding="utf-8") == "rescued"


def test_quota_stats_breaker_calibrate_follow_profile_id_and_active_account(tmp_path, monkeypatch):
    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_usage._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_profile, "agy_executable_or_none", lambda: "fake-agy")
    monkeypatch.setattr(agy_profile.Path, "home", staticmethod(lambda: tmp_path / "empty_host"))
    monkeypatch.setattr(agy_profile, "_read_windows_keyring_safely", lambda: None)

    alt = agy_profile.add("Backup")
    db = tmp_path / "anti_sessions.sqlite3"
    ledger = agy_usage.AgyLedger(db)
    ledger.record_run("r-d1", "gemini-4-hydrogen-high", "rate_limited", profile_id="default", input_tokens=2000, cooldown_seconds=120)
    ledger.record_run("r-a1", "gemini-4-hydrogen-high", "success", profile_id=alt.id, input_tokens=500, output_tokens=100)

    mgr = agy_runtime.AgyRuntimeManager(idle_ttl=0)
    monkeypatch.setattr(anti, "daemon", mgr)
    monkeypatch.setattr(anti, "anti_profiles", agy_profile)
    monkeypatch.setattr(anti, "AntiSessions", lambda: anti_engine.AntiSessions(db, mgr))
    app = FastAPI()
    app.include_router(anti.router)
    with TestClient(app) as client:
        # Active == default: stats/quota default to 'default', explicit ?profile_id queries alt
        assert client.get("/api/anti/stats?window_hours=24").json()["total_tokens"] == 2000
        assert client.get(f"/api/anti/stats?window_hours=24&profile_id={alt.id}").json()["total_tokens"] == 600
        assert client.get("/api/anti/quota?profile_id=nonexistent").status_code == 404

        alt_pools = client.get(f"/api/anti/quota?profile_id={alt.id}").json()
        assert next(p for p in alt_pools if p["model_group"] == "gemini-4")["status"] == "normal"

        # Calibrate & breaker reset support explicit profile_id cleanly without touching other account
        cal_alt = client.post(
            f"/api/anti/quota/calibrate?profile_id={alt.id}",
            json={"model_group": "gemini-4", "remaining_pct": 42},
            headers={"X-GA-Hub-Action": "manage-anti-gateway"},
        )
        assert cal_alt.status_code == 200 and cal_alt.json()["calibrated_remaining_pct"] == 42
        def_pools = client.get("/api/anti/quota").json()
        def_g4 = next(p for p in def_pools if p["model_group"] == "gemini-4")
        assert def_g4["status"] == "cooling_down" and def_g4["calibrated_remaining_pct"] is None

        # Switch active account to alt -> default endpoints now target alt uniformly
        assert client.post(f"/api/anti/profiles/{alt.id}/switch", headers={"X-GA-Hub-Action": "manage-agy-profiles"}).status_code == 200
        assert client.get("/api/anti/stats?window_hours=24").json()["total_tokens"] == 600
        assert next(p for p in client.get("/api/anti/quota").json() if p["model_group"] == "gemini-4")["calibrated_remaining_pct"] == 42

        assert client.post(
            "/api/anti/breaker/reset?profile_id=default",
            json={"model_group": "gemini-4"},
            headers={"X-GA-Hub-Action": "manage-anti-gateway"},
        ).status_code == 204
        assert next(p for p in client.get("/api/anti/quota?profile_id=default").json() if p["model_group"] == "gemini-4")["status"] == "normal"
    mgr.shutdown()


def test_resume_fallback_injects_handoff_summary_and_401_transient_recovery(tmp_path, monkeypatch):
    import json

    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_profile, "agy_executable_or_none", lambda: "fake-agy")
    monkeypatch.setattr(agy_runtime.AgyRuntimeManager, "_probe_version_once", lambda *args: "1.5.16")

    def_app = agy_profile.profile_vault_app_data_dir("default")
    def_app.mkdir(parents=True, exist_ok=True)
    (def_app / "antigravity-oauth-token").write_text('{"token":{"access_token":"tok-1"}}', encoding="utf-8")

    # 1. Resume failure prepends fallback_handoff_context to prompt and emits fallback_notice
    worker = agy_runtime.AgySessionWorker(
        profile_id="default",
        session_id="s-handoff",
        workspace=tmp_path,
        executable="fake-agy",
        version="1.5.16",
    )
    worker.init_result = {"agentInfo": {"version": "1.5.16"}, "agentCapabilities": {"promptCapabilities": {}}}
    worker.setup_result = {"sessionId": "acp-new-fb", "models": {"currentModelId": "gemini-4-hydrogen-high"}}

    def fake_ensure_with_fallback(*, resume_conversation, add_dirs):
        if resume_conversation:
            worker.resumed_fallback = True
            worker._resume_fallback_reason = "resume failed"
        worker.acp_session_id = "acp-new-fb"
        return "acp-new-fb"

    dispatched_prompts: list[str] = []

    def fake_send_frame(frame):
        method = frame.get("method")
        rid = frame.get("id")
        if method == "session/prompt":
            blocks = frame["params"]["prompt"]
            dispatched_prompts.append(blocks[0]["text"])
            with worker._rpc_lock:
                entry = worker._pending_rpcs.pop(rid, None)
            if entry is not None:
                entry[1]["result"] = {"stopReason": "end_turn", "usage": {}}
                entry[0].set()
        elif rid is not None and method is not None:
            with worker._rpc_lock:
                entry = worker._pending_rpcs.pop(rid, None)
            if entry is not None:
                entry[1]["result"] = {}
                entry[0].set()

    monkeypatch.setattr(worker, "ensure_started", fake_ensure_with_fallback)
    monkeypatch.setattr(worker, "_send_frame", fake_send_frame)
    worker.proc = SimpleNamespace(pid=7199, stdin=None, stdout=None, poll=lambda: None)

    events: list[dict] = []
    res = worker.run_turn(
        run_id="r-fb",
        prompt_text="继续完成重构",
        model="gemini-4-hydrogen-high",
        effort="high",
        mode="plan",
        permission_mode="approval-required",
        resume_conversation="old-conv-id",
        add_dirs=(),
        staged_paths=[],
        attachments=[],
        allowed_roots=[tmp_path],
        on_event=events.append,
        fallback_handoff_context="[前文对话交接摘要]\n1. 用户: 先做梳理\n   助手: 已梳理完毕",
    )
    assert res["status"] == "success"
    assert "[前文对话交接摘要]" in dispatched_prompts[0]
    assert "继续完成重构" in dispatched_prompts[0]
    assert "原生上下文续接失败，已自动附带前文摘要继续对话" in (res.get("fallback_notice") or "")

    # 2. Transient 401 when refresh succeeds returns auth_transient=True & does not mark login_required
    agy_profile.activate_profile_in_workspace("default")
    monkeypatch.setattr(agy_usage, "refresh_profile_token", lambda pid: "ok")
    worker2 = agy_runtime.AgySessionWorker(
        profile_id="default",
        session_id="s-401",
        workspace=tmp_path,
        executable="fake-agy",
        version="1.5.16",
    )
    worker2.acp_session_id = "acp-401"
    worker2.init_result = {"agentInfo": {"version": "1.5.16"}}
    worker2.setup_result = {"sessionId": "acp-401"}
    worker2.proc = SimpleNamespace(pid=7200, stdin=None, stdout=None, poll=lambda: None)
    monkeypatch.setattr(worker2, "ensure_started", lambda **kw: "acp-401")

    def fake_send_401(frame):
        method = frame.get("method")
        rid = frame.get("id")
        if method == "session/prompt":
            with worker2._rpc_lock:
                entry = worker2._pending_rpcs.pop(rid, None)
            if entry is not None:
                entry[1]["error"] = {"code": -32000, "message": "401 UNAUTHENTICATED"}
                entry[0].set()
        elif rid is not None and method is not None:
            with worker2._rpc_lock:
                entry = worker2._pending_rpcs.pop(rid, None)
            if entry is not None:
                entry[1]["result"] = {}
                entry[0].set()

    monkeypatch.setattr(worker2, "_send_frame", fake_send_401)
    res_401 = worker2.run_turn(
        run_id="r-401",
        prompt_text="hi",
        model="gemini-4-hydrogen-high",
        effort="high",
        mode="plan",
        permission_mode="approval-required",
        resume_conversation=None,
        add_dirs=(),
        staged_paths=[],
        attachments=[],
        allowed_roots=[tmp_path],
        on_event=lambda e: None,
    )
    assert res_401["status"] == "cli_error"
    assert res_401.get("auth_transient") is True
    assert "瞬态 401" in (res_401.get("error") or "")
    assert worker2._dirty is True
    assert agy_profile.effective_auth_state("default") == "authenticated"


def test_default_clear_credentials_uses_vault_without_touching_host(tmp_path, monkeypatch):
    admin = tmp_path / "admin"
    fake_home = tmp_path / "host"
    host_tok = fake_home / ".gemini" / agy_profile.APP_DATA_DIR_NAME / "antigravity-oauth-token"
    host_tok.parent.mkdir(parents=True, exist_ok=True)
    host_tok.write_text('{"token":{"access_token":"host-tok"}}', encoding="utf-8")

    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", admin)
    monkeypatch.setattr(agy_profile.Path, "home", staticmethod(lambda: fake_home))
    monkeypatch.setattr(agy_profile, "_read_windows_keyring_safely", lambda: None)

    agy_profile.activate_profile_in_workspace("default")
    assert agy_profile.has_local_credentials("default") is True
    assert (agy_profile.workspace_app_data_dir() / "antigravity-oauth-token").is_file()

    cleared = agy_profile.clear_credentials("default")
    assert cleared["has_credentials"] is False
    assert agy_profile.has_local_credentials("default") is False
    assert not (agy_profile.profile_vault_app_data_dir("default") / "antigravity-oauth-token").exists()
    assert not (agy_profile.workspace_app_data_dir() / "antigravity-oauth-token").exists()
    assert agy_profile._default_host_import_disabled().is_file()
    # Host ~/.gemini credential file remains completely untouched!
    assert host_tok.read_text(encoding="utf-8") == '{"token":{"access_token":"host-tok"}}'


def test_stats_today_filters_from_local_midnight(tmp_path, monkeypatch):
    from datetime import datetime, timedelta, timezone

    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_usage._paths, "ADMIN_DATA", tmp_path)

    ledger = agy_usage.AgyLedger(tmp_path / "anti_sessions.sqlite3")
    local_midnight = datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
    before_midnight_utc = (local_midnight - timedelta(minutes=10)).astimezone(timezone.utc).isoformat()
    after_midnight_utc = (local_midnight + timedelta(minutes=1)).astimezone(timezone.utc).isoformat()

    with ledger._connect() as db, db:
        db.execute(
            "INSERT INTO usage_ledger (run_id, profile_id, model, model_group, status, input_tokens, output_tokens, created_at) "
            "VALUES (?,?,?,?,?,?,?,?)",
            ("run-yesterday", "default", "gemini-4-hydrogen", "gemini-4", "success", 1000, 100, before_midnight_utc),
        )
        db.execute(
            "INSERT INTO usage_ledger (run_id, profile_id, model, model_group, status, input_tokens, output_tokens, created_at) "
            "VALUES (?,?,?,?,?,?,?,?)",
            ("run-today", "default", "gemini-4-hydrogen", "gemini-4", "success", 250, 50, after_midnight_utc),
        )

    rolling_24h = ledger.stats(window_hours=24, profile_id="default", today=False)
    assert rolling_24h["total_runs"] == 2
    assert rolling_24h["total_tokens"] == 1400

    today_only = ledger.stats(window_hours=24, profile_id="default", today=True)
    assert today_only["window_hours"] == 0
    assert today_only["total_runs"] == 1
    assert today_only["success_runs"] == 1
    assert today_only["total_tokens"] == 300

    client = make_client(monkeypatch)
    monkeypatch.setattr(anti_engine, "AntiSessions", lambda: SimpleNamespace(ledger=ledger))
    resp = client.get("/api/anti/stats?today=true")
    assert resp.status_code == 200
    assert resp.json()["total_runs"] == 1
    assert resp.json()["total_tokens"] == 300

    # Verify record_run persists model_calls and generation_ms -> aggregated weighted tok/s.
    ledger.record_run(
        "run-metrics-today",
        "gemini-4-hydrogen",
        "success",
        profile_id="default",
        input_tokens=500,
        output_tokens=400,
        thinking_tokens=150,
        model_calls=4,
        generation_ms=5_000,
    )
    with_speed = client.get("/api/anti/stats?today=true").json()
    assert with_speed["total_runs"] == 2
    assert with_speed["model_calls"] == 4
    assert with_speed["tokens_per_sec"] == 80.0


def test_sync_user_customizations_refreshes_unmodified_copies(tmp_path, monkeypatch):
    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path / "admin")
    fake_home = tmp_path / "host_home"
    (fake_home / ".gemini").mkdir(parents=True)
    host_agents = fake_home / ".gemini" / "AGENTS.md"
    host_agents.write_text("host rules v1", encoding="utf-8")
    monkeypatch.setattr(agy_profile.Path, "home", staticmethod(lambda: fake_home))

    prof = agy_profile.add("Synced")
    agy_profile.prepare_profile(prof.id)
    dst = agy_profile.profile_gemini_dir(prof.id) / "AGENTS.md"
    assert dst.read_text(encoding="utf-8") == "host rules v1"

    # When host file updates and profile copy wasn't edited manually, sync refreshes it.
    host_agents.write_text("host rules v2", encoding="utf-8")
    agy_profile.prepare_profile(prof.id)
    assert dst.read_text(encoding="utf-8") == "host rules v2"

    # Once user customizes profile copy, later host updates do not clobber local edit.
    dst.write_text("local override", encoding="utf-8")
    host_agents.write_text("host rules v3", encoding="utf-8")
    agy_profile.prepare_profile(prof.id)
    assert dst.read_text(encoding="utf-8") == "local override"


def test_code_login_oauth_url_and_response_validation():
    good_url = (
        "https://accounts.google.com/o/oauth2/auth"
        "?response_type=code&client_id=abc&state=st-123"
        "&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback"
    )
    parsed = agy_profile._parse_oauth_authorization_url(good_url)
    assert parsed == (good_url, "https://antigravity.google/oauth-callback", "st-123")

    assert agy_profile._parse_oauth_authorization_url("https://evil.example/o/oauth2/auth?response_type=code&state=s&redirect_uri=https://antigravity.google/oauth-callback") is None
    assert agy_profile._parse_oauth_authorization_url("https://accounts.google.com/o/oauth2/auth?response_type=code&state=s&redirect_uri=https://evil.example/") is None

    # Raw auth code and matching callback URL succeed; state mismatch is rejected.
    assert agy_profile._validate_code_login_response("4/0AeanS0_abc-123", parsed[1], parsed[2]) == "4/0AeanS0_abc-123"
    cb_ok = "https://antigravity.google/oauth-callback?state=st-123&code=xyz"
    assert agy_profile._validate_code_login_response(cb_ok, parsed[1], parsed[2]) == cb_ok
    assert agy_profile._validate_code_login_response("https://antigravity.google/oauth-callback?state=wrong&code=xyz", parsed[1], parsed[2]) is None


def test_worker_session_load_fallback_and_broken_thread_run_turn(tmp_path, monkeypatch):
    import json
    import sqlite3

    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path / "admin")
    agy_profile.ensure_workspace_ready()
    app_dir = agy_profile.workspace_app_data_dir()
    (app_dir / "conversations").mkdir(parents=True, exist_ok=True)
    conv_db = app_dir / "conversations" / "conv-load-1.db"
    c = sqlite3.connect(conv_db)
    c.execute("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)")
    c.execute("INSERT INTO steps VALUES (0, 15, ?)", (b"prior",))
    c.commit()
    c.close()

    worker = agy_runtime.AgySessionWorker(
        profile_id="default",
        session_id="s-load",
        workspace=tmp_path,
        executable="agy",
        version="1.5.2",
    )
    methods_seen: list[str] = []

    class DummyProc:
        pid = 999
        stdin = None
        stdout = None

        def poll(self):
            return None

    def fake_rpc(method, params=None, *, timeout=60.0, cancel_event=None):
        methods_seen.append(method)
        if method == "initialize":
            return {"agentInfo": {"version": "1.5.2"}, "agentCapabilities": {"loadSession": True}}
        if method == "session/resume":
            raise agy_profile.AgyProfileError(502, "resume unsupported")
        if method == "session/load":
            return {
                "sessionId": "conv-load-1",
                "models": {"currentModelId": "gemini-4-hydrogen-high", "availableModels": [{"modelId": "gemini-4-hydrogen-high"}]},
            }
        return {}

    rt_tmp = tmp_path / "rt"
    rt_tmp.mkdir()
    monkeypatch.setattr(worker, "_rpc", fake_rpc)
    monkeypatch.setattr(agy_runtime.agy_profile, "activate_profile_in_workspace", lambda pid: None)
    monkeypatch.setattr(agy_runtime.agy_profile, "acp_spawn_command", lambda *a, **kw: ["agy"])
    monkeypatch.setattr(agy_runtime.agy_profile, "clean_agy_env", lambda *a, **kw: {})
    monkeypatch.setattr(agy_runtime.agy_profile, "make_runtime_temp_dir", lambda pid: rt_tmp)
    monkeypatch.setattr(agy_runtime.agy_profile, "claim_workspace_lock", lambda: None)
    monkeypatch.setattr(agy_runtime.agy_profile, "release_workspace_lock", lambda: None)
    monkeypatch.setattr(agy_runtime.child_job, "spawn", lambda *a, **kw: DummyProc())
    monkeypatch.setattr(agy_runtime.threading, "Thread", lambda *a, **kw: SimpleNamespace(start=lambda: None))

    sid = worker.ensure_started(resume_conversation="conv-load-1", add_dirs=())
    assert sid == "conv-load-1"
    assert "session/resume" in methods_seen and "session/load" in methods_seen
    assert "session/new" not in methods_seen
    assert worker.resumed_fallback is False

    # Now drive run_turn where upstream returns end_turn but logs INVALID_THINKING_SIGNATURE.
    def fake_send_broken(frame):
        rid = frame.get("id")
        if frame.get("method") == "session/prompt":
            conn = sqlite3.connect(conv_db)
            conn.execute(
                "INSERT INTO steps VALUES (1, 17, ?)",
                (b"INVALID_ARGUMENT (code 400): messages.1.content.0.thinking.signature: Field required",),
            )
            conn.commit()
            conn.close()
        if rid is not None:
            with worker._rpc_lock:
                entry = worker._pending_rpcs.pop(rid, None)
            if entry is not None:
                entry[1]["result"] = {"stopReason": "end_turn"}
                entry[0].set()

    monkeypatch.setattr(worker, "_send_frame", fake_send_broken)
    worker._closed = False
    res = worker.run_turn(
        run_id="run-broken",
        prompt_text="continue",
        model="gemini-4-hydrogen-high",
        effort="high",
        mode="plan",
        permission_mode="approval-required",
        resume_conversation="conv-load-1",
        add_dirs=(),
        staged_paths=[],
        attachments=[],
        allowed_roots=[tmp_path],
        on_event=lambda e: None,
    )
    assert res["status"] == "cli_error"
    assert res["thread_broken"] is True
    assert res["error_code"] == "INVALID_THINKING_SIGNATURE"
    assert worker._dirty is True

    # Also verify direct RPC error payload with Unsupported mime type triggers thread_broken reset.
    worker2 = agy_runtime.AgySessionWorker(
        profile_id="default",
        session_id="sess-mime-rpc",
        workspace=tmp_path,
        executable="agy",
        version="1.5.14",
    )
    worker2.init_result = {"agentInfo": {"version": "1.5.14"}}
    worker2.setup_result = {"sessionId": "conv-mime-1"}
    worker2.acp_session_id = "conv-mime-1"
    worker2.proc = DummyProc()
    monkeypatch.setattr(worker2, "ensure_started", lambda **kw: "conv-mime-1")

    def fake_send_mime(frame):
        rid = frame.get("id")
        if frame.get("method") == "session/prompt":
            with worker2._rpc_lock:
                entry = worker2._pending_rpcs.pop(rid, None)
            if entry is not None:
                entry[1]["error"] = {
                    "code": -32000,
                    "message": "Unsupported mime type: image/x-icon in contents.function_response.inline_data.",
                }
                entry[0].set()
                if len(entry) > 2 and entry[2] is not None:
                    entry[2].set()
        elif rid is not None:
            with worker2._rpc_lock:
                entry = worker2._pending_rpcs.pop(rid, None)
            if entry is not None:
                entry[1]["result"] = {}
                entry[0].set()
                if len(entry) > 2 and entry[2] is not None:
                    entry[2].set()

    monkeypatch.setattr(worker2, "_send_frame", fake_send_mime)
    res_mime = worker2.run_turn(
        run_id="r-mime-1",
        prompt_text="hi",
        model="gemini-4-hydrogen-high",
        effort="high",
        mode="plan",
        permission_mode="approval-required",
        resume_conversation="conv-mime-1",
        add_dirs=(),
        staged_paths=[],
        attachments=[],
        allowed_roots=[tmp_path],
        on_event=lambda e: None,
    )
    assert res_mime["status"] == "cli_error"
    assert res_mime["thread_broken"] is True
    assert res_mime["error_code"] == "UNSUPPORTED_FUNCTION_MIME"
    assert "image/x-icon" in res_mime["error"]
    assert worker2._dirty is True


def test_worker_run_turn_prefers_db_generation_ms_over_partial_stream(tmp_path, monkeypatch):
    import sqlite3

    from server.services import agy_protocol

    def _enc_varint(v: int) -> bytes:
        out = bytearray()
        while v >= 0x80:
            out.append((v & 0x7F) | 0x80)
            v >>= 7
        out.append(v)
        return bytes(out)

    def _enc_len(field_num: int, payload: bytes) -> bytes:
        return _enc_varint((field_num << 3) | 2) + _enc_varint(len(payload)) + payload

    def _enc_ts(sec: int, nanos: int = 0) -> bytes:
        body = bytearray(_enc_varint((1 << 3) | 0) + _enc_varint(sec))
        if nanos:
            body.extend(_enc_varint((2 << 3) | 0) + _enc_varint(nanos))
        return bytes(body)

    def _enc_step(sec_start: int, sec_end: int) -> bytes:
        meta = _enc_len(1, _enc_ts(sec_start)) + _enc_len(8, _enc_ts(sec_end))
        return _enc_len(5, meta)

    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path / "admin")
    agy_profile.ensure_workspace_ready()
    app_dir = agy_profile.workspace_app_data_dir()
    (app_dir / "conversations").mkdir(parents=True, exist_ok=True)
    conv_db = app_dir / "conversations" / "conv-speed.db"
    c = sqlite3.connect(conv_db)
    c.execute("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)")
    c.execute("INSERT INTO steps VALUES (0, 15, ?)", (_enc_step(1_764_000_000, 1_764_000_050),))
    c.commit()
    c.close()

    worker = agy_runtime.AgySessionWorker(
        profile_id="default",
        session_id="s-speed",
        workspace=tmp_path,
        executable="agy",
        version="1.5.2",
    )

    class DummyProc:
        pid = 998
        stdin = None
        stdout = None

        def poll(self):
            return None

    def fake_rpc(method, params=None, *, timeout=60.0, cancel_event=None):
        if method == "initialize":
            return {"agentInfo": {"version": "1.5.2"}, "agentCapabilities": {"loadSession": True}}
        if method == "session/resume":
            raise agy_profile.AgyProfileError(502, "resume unsupported")
        if method == "session/load":
            return {
                "sessionId": "conv-speed",
                "models": {"currentModelId": "gemini-4-hydrogen-high", "availableModels": [{"modelId": "gemini-4-hydrogen-high"}]},
            }
        return {}

    rt_tmp = tmp_path / "rt-speed"
    rt_tmp.mkdir()
    monkeypatch.setattr(worker, "_rpc", fake_rpc)
    monkeypatch.setattr(agy_runtime.agy_profile, "activate_profile_in_workspace", lambda pid: None)
    monkeypatch.setattr(agy_runtime.agy_profile, "acp_spawn_command", lambda *a, **kw: ["agy"])
    monkeypatch.setattr(agy_runtime.agy_profile, "clean_agy_env", lambda *a, **kw: {})
    monkeypatch.setattr(agy_runtime.agy_profile, "make_runtime_temp_dir", lambda pid: rt_tmp)
    monkeypatch.setattr(agy_runtime.agy_profile, "claim_workspace_lock", lambda: None)
    monkeypatch.setattr(agy_runtime.agy_profile, "release_workspace_lock", lambda: None)
    monkeypatch.setattr(agy_runtime.child_job, "spawn", lambda *a, **kw: DummyProc())
    monkeypatch.setattr(agy_runtime.threading, "Thread", lambda *a, **kw: SimpleNamespace(start=lambda: None))

    mono = [1000.0]
    monkeypatch.setattr(agy_protocol.time, "monotonic", lambda: mono[0])

    sid = worker.ensure_started(resume_conversation="conv-speed", add_dirs=())
    assert sid == "conv-speed"

    pending_steps: list[tuple[int, int, bytes]] = []

    def fake_send(frame):
        rid = frame.get("id")
        if frame.get("method") == "session/prompt":
            worker._handle_session_update({
                "sessionId": "conv-speed",
                "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "hello "}},
            })
            mono[0] += 0.8
            worker._handle_session_update({
                "sessionId": "conv-speed",
                "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "world"}},
            })
            conn = sqlite3.connect(conv_db)
            conn.executemany("INSERT INTO steps VALUES (?, ?, ?)", pending_steps)
            conn.commit()
            conn.close()
        if rid is not None:
            with worker._rpc_lock:
                entry = worker._pending_rpcs.pop(rid, None)
            if entry is not None:
                entry[1]["result"] = {
                    "stopReason": "end_turn",
                    "usage": {"inputTokens": 1000, "outputTokens": 500},
                }
                entry[0].set()

    monkeypatch.setattr(worker, "_send_frame", fake_send)

    def _run(run_id: str, steps: list[tuple[int, int, bytes]]) -> dict:
        pending_steps[:] = steps
        worker._closed = False
        return worker.run_turn(
            run_id=run_id,
            prompt_text="go",
            model="gemini-4-hydrogen-high",
            effort="high",
            mode="plan",
            permission_mode="approval-required",
            resume_conversation="conv-speed",
            add_dirs=(),
            staged_paths=[],
            attachments=[],
            allowed_roots=[tmp_path],
            on_event=lambda e: None,
        )

    # Case 1: Multi-call DB timestamps beat partial 800ms stream burst.
    res_timed = _run("run-timed", [
        (1, 15, _enc_step(1_764_000_100, 1_764_000_106)),
        (2, 132, _enc_step(1_764_000_106, 1_764_000_166)),
        (3, 15, _enc_step(1_764_000_167, 1_764_000_171)),
    ])
    assert res_timed["status"] == "success"
    assert res_timed["usage"]["model_calls"] == 2
    assert res_timed["usage"]["generation_ms"] == 10_000

    # Case 2: Multi-call untimed DB omits generation_ms instead of falling back to partial stream burst.
    res_untimed_multi = _run("run-untimed-multi", [
        (4, 15, b"dummy-call-1"),
        (5, 15, b"dummy-call-2"),
    ])
    assert res_untimed_multi["status"] == "success"
    assert res_untimed_multi["usage"]["model_calls"] == 2
    assert "generation_ms" not in res_untimed_multi["usage"]

    # Case 3: Single-call untimed DB safely falls back to normalizer streaming duration (800ms).
    res_untimed_single = _run("run-untimed-single", [
        (6, 15, b"dummy-single"),
    ])
    assert res_untimed_single["status"] == "success"
    assert res_untimed_single["usage"]["model_calls"] == 1
    assert res_untimed_single["usage"]["generation_ms"] == 800


def test_refresh_all_usage_endpoint_and_hourly_quota_sync_removed(tmp_path, monkeypatch):
    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    runtime = agy_runtime.AgyRuntimeManager(idle_ttl=0)
    try:
        assert not hasattr(runtime, "refresh_all_profiles_usage")
        assert not hasattr(runtime, "_quota_sync_thread")
        assert not hasattr(agy_runtime, "next_hourly_quota_slot")
        monkeypatch.setattr(anti, "daemon", runtime)
        app = FastAPI()
        app.include_router(anti.router)
        client = TestClient(app)
        resp = client.post(
            "/api/anti/account-usage/refresh-all",
            headers={"X-GA-Hub-Action": "check-anti-usage"},
        )
        assert resp.status_code == 404
    finally:
        runtime.shutdown()


def test_usage_probe_stable_order_dedup_and_preserves_cache_on_empty(tmp_path, monkeypatch):
    import io
    import json
    from datetime import datetime, timedelta, timezone

    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_usage._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_profile, "agy_executable_or_none", lambda: "C:/fake/agy.exe")

    prof = agy_profile.add("Stable Quota")
    app_dir = agy_profile.profile_app_data_dir(prof.id)
    app_dir.mkdir(parents=True, exist_ok=True)
    (app_dir / "antigravity-oauth-token").write_text(
        json.dumps({"token": {"access_token": "valid-token", "refresh_token": "rtok"}}),
        encoding="utf-8",
    )

    now = datetime.now(timezone.utc)
    # Reversed buckets + two Gemini 5h buckets that collapse to same display label + 180s skewed 100% resetTime
    payload = {
        "status": "SUCCESS",
        "command": {
            "name": "usage",
            "data": {
                "buckets": [
                    {
                        "id": "3p-weekly",
                        "window": "weekly",
                        "remaining_fraction": 0.65,
                        "reset_time": "2026-12-01T00:00:00Z",
                    },
                    {
                        "id": "gemini-argon-weekly",
                        "window": "weekly",
                        "remaining_fraction": 1.0,
                        "reset_time": (now + timedelta(days=7, seconds=180)).isoformat().replace("+00:00", "Z"),
                    },
                    {
                        "id": "gemini-5h-a",
                        "window": "5h",
                        "remaining_fraction": 0.8,
                        "reset_time": "2026-11-26T15:00:00Z",
                    },
                    {
                        "id": "gemini-5h-b",
                        "window": "5h",
                        "remaining_fraction": 0.4,
                        "reset_time": "2026-11-26T14:00:00Z",
                    },
                ],
            },
        },
    }
    return_empty = {"flag": False}

    class FakeGroup:
        def terminate(self, pid):
            return True

        def close(self):
            pass

    def fake_spawn(cmd, **kwargs):
        out = json.dumps({"status": "SUCCESS", "command": {"name": "usage", "data": {"groups": []}}}) if return_empty["flag"] else json.dumps(payload)
        return SimpleNamespace(
            pid=8833,
            returncode=0,
            stdout=io.StringIO(out),
            stderr=io.StringIO(""),
            wait=lambda timeout=None: 0,
        )

    monkeypatch.setattr(agy_usage.child_job, "spawn", fake_spawn)
    monkeypatch.setattr(agy_usage.child_job, "create_process_group", lambda proc: FakeGroup())
    monkeypatch.setattr(agy_usage.child_job, "forget", lambda pid: None)
    client = make_client(monkeypatch)

    resp = client.post(
        f"/api/anti/account-usage?profile_id={prof.id}",
        headers={"X-GA-Hub-Action": "check-anti-usage"},
    )
    assert resp.status_code == 200
    rows = resp.json()["rows"]
    assert [(r["model"], r["limit"], r["remaining_pct"]) for r in rows] == [
        ("Gemini", "Five Hour Limit Remaining", 40.0),
        ("Gemini Argon", "Weekly Limit Remaining", 100.0),
        ("Claude & GPT (shared)", "Weekly Limit Remaining", 65.0),
    ]
    assert rows[1].get("resets_at") is None

    # Transient empty probe must preserve existing cached quota rows on the profile.
    return_empty["flag"] = True
    empty_resp = client.post(
        f"/api/anti/account-usage?profile_id={prof.id}",
        headers={"X-GA-Hub-Action": "check-anti-usage"},
    )
    assert empty_resp.status_code == 200
    assert empty_resp.json()["rows"] == []

    listed = client.get("/api/anti/profiles").json()
    prof_entry = next(p for p in listed["profiles"] if p["id"] == prof.id)
    assert [(r["model"], r["remaining_pct"]) for r in prof_entry["usage"]["rows"]] == [
        ("Gemini", 40.0),
        ("Gemini Argon", 100.0),
        ("Claude & GPT (shared)", 65.0),
    ]










def test_ledger_split_models_quota_pools_and_legacy_backfill(tmp_path, monkeypatch):
    from datetime import datetime, timezone

    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_usage._paths, "ADMIN_DATA", tmp_path)

    ledger = agy_usage.AgyLedger(tmp_path / "split_ledger.sqlite3")
    # Simulate a legacy pre-upgrade row in usage_ledger without usage_ledger_models
    now_iso = datetime.now(timezone.utc).isoformat()
    with ledger._connect() as db, db:
        db.execute(
            "INSERT INTO usage_ledger (run_id, profile_id, model, model_group, status, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, thinking_tokens, model_calls, generation_ms, estimated_cost_usd, created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            ("run-legacy", "default", "gemini-3-pro-high", "gemini-3", "success", 1200, 100, 600, 0, 0, 1, 500, 0.0025, now_iso),
        )

    # Record a cross-family orchestrator split run (Gemini planner + Claude executor)
    ledger.record_run(
        "run-orch-split",
        "gemini-pro-orchestrator-neon",
        "success",
        profile_id="default",
        input_tokens=600_000,
        output_tokens=30_000,
        cache_read_tokens=200_000,
        cache_write_tokens=50_000,
        model_calls=3,
        generation_ms=1200,
        model_breakdown=[
            {
                "model": "gemini-4-neon",
                "display_name": "Gemini 4 Neon",
                "role": "planner",
                "calls": 1,
                "input_tokens": 200_000,
                "output_tokens": 10_000,
                "cache_read_tokens": 100_000,
                "cache_write_tokens": 0,
                "thinking_tokens": 0,
                "estimated_cost_usd": 0.465,
                "pricing_source": "catalog",
            },
            {
                "model": "claude-sonnet-5-5",
                "display_name": "Claude Sonnet 5.5",
                "role": "executor",
                "calls": 2,
                "input_tokens": 400_000,
                "output_tokens": 20_000,
                "cache_read_tokens": 100_000,
                "cache_write_tokens": 50_000,
                "thinking_tokens": 0,
                "estimated_cost_usd": 0.835,
                "pricing_source": "catalog",
            },
        ],
    )

    stats = ledger.stats(window_hours=24, profile_id="default")
    assert stats["total_runs"] == 2
    assert stats["estimated_cost_usd"] == pytest.approx(1.3025)
    by_model = {item["model"]: item for item in stats["by_model"]}
    assert set(by_model) == {"claude-sonnet-5-5", "gemini-4-neon", "gemini-3.1-pro"}
    assert by_model["claude-sonnet-5-5"]["roles"] == ["executor"]
    assert by_model["claude-sonnet-5-5"]["calls"] == 2
    assert by_model["gemini-4-neon"]["roles"] == ["planner"]
    assert by_model["gemini-3.1-pro"]["estimated_cost_usd"] == pytest.approx(0.0025)

    pools = {p["model_group"]: p for p in ledger.quota_pools("default")}
    assert pools["gemini-4"]["estimated_cost_7d_usd"] == pytest.approx(0.465)
    assert pools["claude-3p"]["estimated_cost_7d_usd"] == pytest.approx(0.835)
    assert pools["gemini-3"]["estimated_cost_7d_usd"] == pytest.approx(0.0025)

    ledger.delete_profile("default")
    after = ledger.stats(window_hours=24, profile_id="default")
    assert after["total_runs"] == 0
    assert after["by_model"] == []


def test_profile_manual_account_tier_patch_and_passive_protection(tmp_path, monkeypatch):
    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_usage._paths, "ADMIN_DATA", tmp_path)
    prof = agy_profile.add("工作号")
    client = make_client(monkeypatch)
    headers = {"X-GA-Hub-Action": "manage-agy-profiles"}

    # Empty patch payload is rejected with 422
    empty_resp = client.patch(f"/api/anti/profiles/{prof.id}", json={}, headers=headers)
    assert empty_resp.status_code == 422

    # Manually mark account tier as Ultra via PATCH
    patched = client.patch(
        f"/api/anti/profiles/{prof.id}",
        json={"account_tier": "ultra"},
        headers=headers,
    )
    assert patched.status_code == 200
    entry = patched.json()
    assert entry["id"] == prof.id
    assert entry["account_tier"] == "ultra"
    assert entry.get("account_tier_name") is None

    # Passive record_usage must NOT overwrite manually tagged tier
    agy_profile.record_usage(
        prof.id,
        "authenticated",
        [{"model": "Gemini", "limit": "Five Hour Limit Remaining", "remaining_pct": 88.0}],
        account_tier="free",
        account_tier_name="Free",
    )
    listed = client.get("/api/anti/profiles").json()
    entry_after_usage = next(p for p in listed["profiles"] if p["id"] == prof.id)
    assert entry_after_usage["account_tier"] == "ultra"
    assert entry_after_usage.get("account_tier_name") is None

    # Clearing tier with empty string removes manual override and allows passive extraction again
    cleared = client.patch(
        f"/api/anti/profiles/{prof.id}",
        json={"account_tier": ""},
        headers=headers,
    )
    assert cleared.status_code == 200
    entry_cleared = cleared.json()
    assert entry_cleared["id"] == prof.id
    assert entry_cleared.get("account_tier") is None
    assert entry_cleared.get("account_tier_name") is None

    agy_profile.record_usage(
        prof.id,
        "authenticated",
        [{"model": "Gemini", "limit": "Five Hour Limit Remaining", "remaining_pct": 85.0}],
        account_tier="pro",
        account_tier_name="Google AI Pro",
    )
    listed_again = client.get("/api/anti/profiles").json()
    entry_passive = next(p for p in listed_again["profiles"] if p["id"] == prof.id)
    assert entry_passive["account_tier"] == "pro"
    assert entry_passive["account_tier_name"] == "Google AI Pro"
