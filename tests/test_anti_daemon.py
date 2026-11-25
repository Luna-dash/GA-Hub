"""Standalone Agy runtime, profile isolation, login, and CloudCode usage ledger tests."""
import subprocess
import sys
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


def test_first_status_version_probe_is_detached_on_windows(tmp_path, monkeypatch):
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
        assert kwargs["creationflags"] == subprocess.DETACHED_PROCESS
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
    assert env["GEMINI_HOME"] == str(tmp_path / "agy-profiles" / pid / "home" / ".gemini")

    cmd = agy_profile.acp_spawn_command("C:/fake/agy.exe", pid, login=True)
    assert cmd == [
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
    monkeypatch.setattr(agy_profile, "clear_credentials", lambda pid: changed.append(pid))
    monkeypatch.setattr(agy_profile, "delete", lambda pid: changed.append(pid))
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
        with pytest.raises(agy_profile.AgyProfileError) as blocked:
            mgr.get_worker(db, profile if operation == "switch" else worker_profile, "same", tmp_path)
        assert blocked.value.status == 409
        if operation == "shutdown":
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

    default_env = agy_profile.clean_agy_env("default", {"PATH": "C:/bin", "WSL_INTEROP": "1", "ANTIGRAVITY_AGENT": "1"})
    assert "AGY_ACP_FORCE_FILE_STORAGE" not in default_env
    assert "WSL_INTEROP" not in default_env
    assert "ANTIGRAVITY_AGENT" not in default_env

    captured_cmd = []

    def fake_run(cmd, *a, **kw):
        captured_cmd.append(cmd)
        assert kw["capture_output"] and kw["stdin"] == subprocess.DEVNULL
        if sys.platform == "win32":
            assert kw["creationflags"] == subprocess.DETACHED_PROCESS
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
    assert res["usage"] == {"input_tokens": 100, "output_tokens": 30}
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
    assert res["usage"] == {"input_tokens": 88, "output_tokens": 19}
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

        # Global switch succeeds while another session is mid-turn, retiring idle workers only.
        mgr.switch_profile(secondary.id)
        assert agy_profile.snapshot()[0] == secondary.id
        assert len(idle_closed) == 1
        assert w_busy.active_turn is not None and w_busy.active_turn.run_id == "r-busy"
        assert (db, "r-busy") in mgr._active_turns

        with mgr.submission(profile_id="default") as pid_default:
            assert pid_default == "default"
        with mgr.submission(profile_id=secondary.id) as pid_sec:
            assert pid_sec == secondary.id

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
            stdout="gemini-4-neon-high\tGemini 4 Neon (High)\ngemini-pro-orchestrator-neon\tOrchestrator (Neon)\n",
            stderr="",
        ),
    )
    monkeypatch.setattr(
        agy_usage,
        "probe_available_models",
        lambda pid: {
            "state": "authenticated",
            "items": [
                {"id": "gemini-4-hydrogen", "display_name": "Gemini 4 Hydrogen", "efforts": ["low", "medium", "high"], "is_default": True},
                {"id": "gemini-pro-orchestrator-neon", "display_name": "Orchestrator (Neon)", "is_orchestrator": True},
            ],
        },
    )

    client = make_client(monkeypatch)
    synced = client.post("/api/anti/models/sync")
    assert synced.status_code == 200
    body = synced.json()
    ids = [m["id"] for m in body["items"]]
    assert "gemini-4-neon-high" in ids and "gemini-4-hydrogen" in ids and "gemini-pro-orchestrator-neon" in ids
    assert body["synced_at"] and body["next_sync_at"]
    assert agy_models.config_path().is_file()

    cfg_patch = client.patch(
        "/api/anti/models/config",
        json={"schedule_hours": [0, 6, 12, 18], "default_model": "gemini-4-hydrogen-high", "aliases": {"neon": "gemini-4-neon-high"}},
        headers={"X-GA-Hub-Action": "manage-anti-gateway"},
    )
    assert cfg_patch.status_code == 200 and cfg_patch.json()["aliases"] == {"neon": "gemini-4-neon-high"}

    # Preserve unrelated keys in ~/.gemini/antigravity-cli/settings.json while editing flat orchestrator keys
    default_settings = agy_profile.profile_app_data_dir("default") / "settings.json"
    default_settings.parent.mkdir(parents=True, exist_ok=True)
    default_settings.write_text(json.dumps({"colorScheme": "tokyo night"}), encoding="utf-8")

    headers = {"X-GA-Hub-Action": "manage-agy-profiles"}
    assert client.get("/api/anti/profiles/default/orchestrator").json() == {"profile_id": "default", "planner": None, "executor": None}

    updated = client.patch(
        "/api/anti/profiles/default/orchestrator",
        json={"planner": "gemini-4-neon-xhigh", "executor": "gemini-4-hydrogen-high"},
        headers=headers,
    )
    assert updated.status_code == 200
    assert updated.json() == {"profile_id": "default", "planner": "gemini-4-neon-xhigh", "executor": "gemini-4-hydrogen-high"}
    saved_json = json.loads(default_settings.read_text(encoding="utf-8"))
    assert saved_json["colorScheme"] == "tokyo night"
    assert saved_json["orchestrator"] == {"planner": "gemini-4-neon-xhigh", "executor": "gemini-4-hydrogen-high"}

    cleared = client.patch(
        "/api/anti/profiles/default/orchestrator",
        json={"planner": None, "executor": None},
        headers=headers,
    )
    assert cleared.status_code == 200
    cleared_json = json.loads(default_settings.read_text(encoding="utf-8"))
    assert "orchestrator" not in cleared_json and cleared_json["colorScheme"] == "tokyo night"


def test_usage_probe_t3_code_endpoints_proxy_and_untouched_reset_suppression(tmp_path, monkeypatch):
    import json
    from datetime import datetime, timedelta, timezone

    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_usage._paths, "ADMIN_DATA", tmp_path)
    agy_usage.clear_token_cache()

    work = agy_profile.add("Business Work")
    app_dir = agy_profile.profile_app_data_dir(work.id)
    app_dir.mkdir(parents=True, exist_ok=True)
    (app_dir / "settings.json").write_text(json.dumps({"auth": {"type": "oauth-business"}}), encoding="utf-8")
    (app_dir / "antigravity-oauth-token").write_text(
        json.dumps({
            "token": {
                "access_token": "valid-business-token",
                "expiry": (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat(),
            }
        }),
        encoding="utf-8",
    )

    monkeypatch.setattr(
        agy_profile,
        "system_proxy_env",
        lambda env: {**env, "HTTP_PROXY": "http://127.0.0.1:7890", "HTTPS_PROXY": "http://127.0.0.1:7890"},
    )
    proxied_session = agy_usage._make_http_session()
    assert proxied_session.proxies.get("https") == "http://127.0.0.1:7890"

    seen_calls = []
    now = datetime.now(timezone.utc)

    class FakeResp:
        def __init__(self, status_code, payload):
            self.status_code = status_code
            self._payload = payload

        def json(self):
            return self._payload

    class FakeSession:
        proxies = {}
        trust_env = True

        def post(self, url, headers=None, json=None, timeout=None, allow_redirects=True):
            seen_calls.append((url, timeout, allow_redirects))
            if url.startswith(agy_usage.PROD_ENDPOINT) and url.endswith(":retrieveUserQuotaSummary"):
                return FakeResp(200, {
                    "buckets": [
                        {
                            "bucketId": "gemini-5h",
                            "window": "5h",
                            "remainingFraction": 1.0,
                            "resetTime": (now + timedelta(hours=5)).isoformat().replace("+00:00", "Z"),
                        },
                        {
                            "bucketId": "3p-weekly",
                            "window": "weekly",
                            "remainingFraction": 0.72,
                            "resetTime": "2026-11-30T08:00:00Z",
                        },
                    ]
                })
            if url.startswith(agy_usage.DAILY_ENDPOINT) and url.endswith(":retrieveUserQuotaSummary"):
                return FakeResp(200, {
                    "buckets": [
                        # Duplicate bucketId should lose to PROD_ENDPOINT priority for oauth-business
                        {
                            "bucketId": "gemini-5h",
                            "window": "5h",
                            "remainingFraction": 0.1,
                            "resetTime": "2026-11-26T00:00:00Z",
                        },
                        {
                            "bucketId": "gemini-argon-weekly",
                            "window": "weekly",
                            "remainingFraction": 0.55,
                            "resetTime": "2026-11-29T00:00:00Z",
                        },
                    ]
                })
            return FakeResp(404, {})

    monkeypatch.setattr(agy_usage, "_make_http_session", lambda: FakeSession())

    client = make_client(monkeypatch)
    resp = client.post(
        f"/api/anti/account-usage?profile_id={work.id}",
        headers={"X-GA-Hub-Action": "check-anti-usage"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["state"] == "authenticated"
    assert len(seen_calls) == 2
    assert all(allow_redir is False and isinstance(to, tuple) for _, to, allow_redir in seen_calls)
    by_model = {(r["model"], r["limit"]): r for r in body["rows"]}
    # PROD_ENDPOINT priority kept 100.0% and suppressed untouched 5h rolling resetTime -> omitted/None
    assert by_model[("Gemini", "Five Hour Limit Remaining")]["remaining_pct"] == 100.0
    assert by_model[("Gemini", "Five Hour Limit Remaining")].get("resets_at") is None
    assert by_model[("Claude & GPT (shared)", "Weekly Limit Remaining")]["remaining_pct"] == 72.0
    assert by_model[("Gemini Argon", "Weekly Limit Remaining")]["remaining_pct"] == 55.0

    # Usage snapshot persisted strictly under `work.id`
    profiles_resp = client.get("/api/anti/profiles").json()
    work_entry = next(p for p in profiles_resp["profiles"] if p["id"] == work.id)
    def_entry = next(p for p in profiles_resp["profiles"] if p["id"] == "default")
    assert work_entry["usage"]["min_remaining_pct"] == 55.0
    assert "usage" not in def_entry


def test_usage_probe_refreshes_expired_cli_token_safely_without_pipe_hang(tmp_path, monkeypatch):
    import json
    from datetime import datetime, timedelta, timezone

    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_usage._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_profile, "agy_executable_or_none", lambda: "C:/fake/agy.exe")
    agy_usage.clear_token_cache()

    prof = agy_profile.add("Expiring CLI")
    tok_path = agy_profile.profile_app_data_dir(prof.id) / "antigravity-oauth-token"
    tok_path.parent.mkdir(parents=True, exist_ok=True)
    tok_path.write_text(
        json.dumps({
            "token": {
                "access_token": "expired-token",
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
        tok_path.write_text(
            json.dumps({
                "token": {
                    "access_token": "fresh-token",
                    "expiry": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
                }
            }),
            encoding="utf-8",
        )
        return SimpleNamespace(pid=7711, returncode=0, wait=lambda timeout=None: 0)

    monkeypatch.setattr(agy_usage.child_job, "spawn", spawn_refresh_success)
    monkeypatch.setattr(agy_usage.child_job, "create_process_group", lambda proc: FakeGroup())
    monkeypatch.setattr(agy_usage.child_job, "forget", lambda pid: None)

    class SuccessSession:
        def post(self, url, headers=None, json=None, timeout=None, allow_redirects=True):
            assert headers["Authorization"] == "Bearer fresh-token"
            return SimpleNamespace(
                status_code=200,
                json=lambda: {
                    "buckets": [
                        {
                            "bucketId": "gemini-weekly",
                            "window": "weekly",
                            "remainingFraction": 0.85,
                            "resetTime": "2026-11-30T08:00:00Z",
                        }
                    ]
                },
            )

    monkeypatch.setattr(agy_usage, "_make_http_session", lambda: SuccessSession())
    report = agy_usage.probe_account_usage(prof.id)
    assert report["state"] == "authenticated"
    assert report["rows"][0]["remaining_pct"] == 85.0
    assert len(spawn_calls) == 1 and terminated == []

    # Timeout during `agy models` must terminate Job Object tree and fail fast with clear detail
    tok_path.write_text(
        json.dumps({
            "token": {
                "access_token": "expired-token-2",
                "expiry": (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat(),
            }
        }),
        encoding="utf-8",
    )

    def spawn_refresh_timeout(cmd, **kwargs):
        def wait_timeout(timeout=None):
            raise subprocess.TimeoutExpired(cmd, timeout or 8)

        return SimpleNamespace(pid=7722, returncode=None, wait=wait_timeout)

    monkeypatch.setattr(agy_usage.child_job, "spawn", spawn_refresh_timeout)
    expired_report = agy_usage.probe_account_usage(prof.id)
    assert expired_report["state"] == "unverified"
    assert expired_report["rows"] == []
    assert "过期" in (expired_report.get("detail") or "")
    assert terminated == [7722]


def test_usage_probe_acp_token_memory_cache_and_logout_invalidation(tmp_path, monkeypatch):
    import json

    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_usage._paths, "ADMIN_DATA", tmp_path)
    agy_usage.clear_token_cache()

    prof = agy_profile.add("ACP Cached")
    tok_path = agy_profile.profile_app_data_dir(prof.id) / "acp_token.json"
    tok_path.parent.mkdir(parents=True, exist_ok=True)
    tok_path.write_text(
        json.dumps({
            "client_id": "cid",
            "client_secret": "csec",
            "refresh_token": "rtok",
            "project_id": "proj-1",
        }),
        encoding="utf-8",
    )

    oauth_calls = 0

    class CachingSession:
        def post(self, url, data=None, headers=None, json=None, timeout=None, allow_redirects=True):
            nonlocal oauth_calls
            if url == "https://oauth2.googleapis.com/token":
                oauth_calls += 1
                return SimpleNamespace(
                    status_code=200,
                    json=lambda: {"access_token": f"acp-tok-{oauth_calls}", "expires_in": 3600},
                )
            if url.endswith(":retrieveUserQuotaSummary"):
                return SimpleNamespace(
                    status_code=200,
                    json=lambda: {
                        "buckets": [{
                            "bucketId": "gemini-5h",
                            "window": "5h",
                            "remainingFraction": 0.9,
                            "resetTime": "2026-11-26T00:00:00Z",
                        }]
                    },
                )
            return SimpleNamespace(status_code=404, json=lambda: {})

    monkeypatch.setattr(agy_usage, "_make_http_session", lambda: CachingSession())
    first = agy_usage.probe_account_usage(prof.id)
    second = agy_usage.probe_account_usage(prof.id)
    assert first["state"] == "authenticated" and second["state"] == "authenticated"
    assert oauth_calls == 1

    agy_usage.clear_token_cache(prof.id)
    third = agy_usage.probe_account_usage(prof.id)
    assert third["state"] == "authenticated"
    assert oauth_calls == 2


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
    # Cost of r-excl must include both non_cached (778,033) and cached (4,683,759) tokens (> $1.50)
    assert stats["estimated_cost_usd"] > 1.5


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
    assert res["usage"] == {"input_tokens": 700, "output_tokens": 50, "cache_read_tokens": 400}
    mgr.shutdown()



