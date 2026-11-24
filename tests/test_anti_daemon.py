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
