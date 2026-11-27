"""Tests for storage usage summary, tiered Agy GC policy, and cache cleanup routes."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
import sqlite3

from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.routes import storage as storage_route
from server.services import agy_profile, agy_storage_gc
from server.services.anti_engine import AntiSessions


def test_storage_summary_and_cleanup(tmp_path: Path, monkeypatch) -> None:
    admin_data = tmp_path / "admin-data"
    temp_dir = tmp_path / "temp"
    admin_data.mkdir()
    temp_dir.mkdir()

    # Legacy pre-sentinel _MEI directory
    legacy_mei = temp_dir / "_MEI99901"
    (legacy_mei / "server").mkdir(parents=True)
    (legacy_mei / "webui").mkdir(parents=True)
    (legacy_mei / "server" / "payload.bin").write_bytes(b"x" * 2048)

    # Unrelated _MEI directory must NEVER be matched or deleted
    other_mei = temp_dir / "_MEI88888"
    other_mei.mkdir()
    (other_mei / "unrelated.txt").write_text("keep", encoding="utf-8")

    # Agy toolchain cache & tiered .gemini workspace
    cargo_cache = admin_data / "agy-profiles" / "workspace" / "home" / ".cargo"
    cargo_cache.mkdir(parents=True)
    (cargo_cache / "crate.bin").write_bytes(b"c" * 4096)

    cli_dir = admin_data / "agy-profiles" / "workspace" / "home" / ".gemini" / "antigravity-cli"
    conv_dir = cli_dir / "conversations"
    conv_dir.mkdir(parents=True)
    active_db = conv_dir / "live-root-1.db"
    active_db.write_bytes(b"a" * 2048)
    orphan_db = conv_dir / "orphan-root-1.db"
    orphan_db.write_bytes(b"o" * 1024)
    old_ts = (datetime.now(timezone.utc) - timedelta(days=2)).timestamp()
    os.utime(orphan_db, (old_ts, old_ts))

    # Seed anti_sessions.sqlite3 with live-root-1 so orphan-root-1 is classified as L0
    hub_db = admin_data / "anti_sessions.sqlite3"
    svc = AntiSessions(db=hub_db)
    with svc.connect() as conn, conn:
        conn.execute(
            "INSERT INTO sessions (id, project, workspace, title, conversation, updated_at) VALUES (?,?,?,?,?,?)",
            ("sid-1", "demo", str(tmp_path), "Live", "live-root-1", datetime.now(timezone.utc).isoformat()),
        )

    oauth = admin_data / "agy-profiles" / "workspace" / "home" / ".gemini" / "oauth_creds.json"
    oauth.write_text('{"token":"keep"}', encoding="utf-8")

    monkeypatch.setattr(storage_route._paths, "ADMIN_DATA", admin_data)
    monkeypatch.setattr(agy_storage_gc._paths, "ADMIN_DATA", admin_data)
    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", admin_data)
    monkeypatch.setattr(storage_route.tempfile, "gettempdir", lambda: str(temp_dir))

    app = FastAPI()
    app.include_router(storage_route.router)
    client = TestClient(app)

    resp = client.get("/api/storage/summary")
    assert resp.status_code == 200
    body = resp.json()
    by_id = {cat["id"]: cat for cat in body["categories"]}
    assert by_id["mei_temp"]["bytes"] == 2048
    assert by_id["mei_temp"]["cleanable"] is True
    assert by_id["mei_temp"]["caution"] is False
    assert by_id["agy_toolchain_cache"]["bytes"] == 4096
    assert by_id["agy_gc_l0"]["bytes"] == 1024
    assert by_id["agy_gc_l0"]["cleanable"] is True
    assert by_id["agy_gc_l0"]["caution"] is False
    assert by_id["agy_gc_l3"]["caution"] is True
    assert by_id["agy_active_core"]["bytes"] == 2048
    assert by_id["agy_active_core"]["cleanable"] is False
    if "webview_cache" in by_id:
        assert by_id["webview_cache"]["cleanable"] is False

    # Cleaning safe categories + L0 must NOT touch active_core, oauth, or unrelated _MEI dirs
    clean = client.post(
        "/api/storage/cleanup",
        json={"categories": ["mei_temp", "agy_toolchain_cache", "agy_gc_l0", "webview_cache"]},
    )
    assert clean.status_code == 200
    clean_body = clean.json()
    assert clean_body["reclaimed_bytes"] >= 2048 + 4096 + 1024
    assert not legacy_mei.exists()
    assert other_mei.exists()
    assert not cargo_cache.exists()
    assert not orphan_db.exists()
    assert active_db.exists()
    assert oauth.exists()

    # Policy GET / PATCH endpoints
    pol_get = client.get("/api/storage/agy-gc-policy")
    assert pol_get.status_code == 200
    assert pol_get.json()["policy"]["auto_enabled"] is True
    assert pol_get.json()["policy"]["l3_cold_roots_enabled"] is False

    pol_patch = client.patch(
        "/api/storage/agy-gc-policy",
        json={"l2_idle_retention_days": 14, "l3_cold_roots_enabled": True},
    )
    assert pol_patch.status_code == 200
    assert pol_patch.json()["policy"]["l2_idle_retention_days"] == 14
    assert pol_patch.json()["policy"]["l3_cold_roots_enabled"] is True
