"""Standalone Agy runtime, profile isolation, login, and CloudCode usage ledger tests."""
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
    res = agy_profile.clear_credentials(p.id)
    assert res["has_credentials"] is False
    assert not temp_dir.exists()
    assert not lock_file.exists()


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
