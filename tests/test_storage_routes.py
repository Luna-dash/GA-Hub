"""Tests for storage usage summary and manual cache cleanup routes."""
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.routes import storage as storage_route


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

    # Agy toolchain cache & .gemini history
    cargo_cache = admin_data / "agy-profiles" / "workspace" / "home" / ".cargo"
    cargo_cache.mkdir(parents=True)
    (cargo_cache / "crate.bin").write_bytes(b"c" * 4096)

    gemini_dir = admin_data / "agy-profiles" / "workspace" / "home" / ".gemini" / "antigravity-cli" / "conversations"
    gemini_dir.mkdir(parents=True)
    (gemini_dir / "history.jsonl").write_bytes(b"h" * 1024)
    oauth = admin_data / "agy-profiles" / "workspace" / "home" / ".gemini" / "oauth_creds.json"
    oauth.write_text('{"token":"keep"}', encoding="utf-8")

    monkeypatch.setattr(storage_route._paths, "ADMIN_DATA", admin_data)
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
    assert by_id["agy_gemini_history"]["bytes"] == 1024
    assert by_id["agy_gemini_history"]["caution"] is True
    if "webview_cache" in by_id:
        assert by_id["webview_cache"]["cleanable"] is False

    # Cleaning safe categories must NOT touch .gemini or unrelated _MEI dirs
    clean = client.post(
        "/api/storage/cleanup",
        json={"categories": ["mei_temp", "agy_toolchain_cache", "webview_cache"]},
    )
    assert clean.status_code == 200
    clean_body = clean.json()
    assert clean_body["reclaimed_bytes"] >= 2048 + 4096
    assert not legacy_mei.exists()
    assert other_mei.exists()
    assert not cargo_cache.exists()
    assert (gemini_dir / "history.jsonl").exists()
