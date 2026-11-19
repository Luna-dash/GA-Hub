"""Tests for optional UI font pack manager and appearance routes."""
from __future__ import annotations

import hashlib
from pathlib import Path
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.routes.appearance import router as appearance_router
from server.services import font_service


def _woff2_bytes(tag: bytes = b"test") -> bytes:
    return b"wOF2" + b"\x00" * 16 + tag


def _make_client(tmp_path: Path, monkeypatch) -> TestClient:
    root = tmp_path / "fonts"
    monkeypatch.setattr(font_service, "default_font_manager", lambda: font_service.FontManager(root))
    app = FastAPI()
    app.include_router(appearance_router)
    return TestClient(app)


def test_font_catalog_defaults_and_preferences(tmp_path, monkeypatch):
    client = _make_client(tmp_path, monkeypatch)
    r = client.get("/api/appearance/fonts")
    assert r.status_code == 200
    body = r.json()
    assert body["active_pack"] == "system"
    assert body["bold_style"] == "restrained"
    ids = [p["id"] for p in body["packs"]]
    assert ids == ["harmonyos-sans-sc", "noto-sans-sc", "misans", "latin-only"]
    assert all(not p["installed"] for p in body["packs"])

    r2 = client.put("/api/appearance/fonts/preferences", json={"bold_style": "standard"})
    assert r2.status_code == 200
    assert r2.json()["bold_style"] == "standard"


def test_import_local_font_validates_and_serves_files(tmp_path, monkeypatch):
    client = _make_client(tmp_path, monkeypatch)

    bad = client.post(
        "/api/appearance/fonts/import",
        files={"file": ("evil.woff2", b"NOTAFONT1234567890", "font/woff2")},
    )
    assert bad.status_code == 400

    bad_ext = client.post(
        "/api/appearance/fonts/import",
        files={"file": ("script.exe", _woff2_bytes(), "application/octet-stream")},
    )
    assert bad_ext.status_code == 400

    good_bytes = _woff2_bytes(b"mycustomfont")
    ok = client.post(
        "/api/appearance/fonts/import",
        files={"file": ("MySans.woff2", good_bytes, "font/woff2")},
    )
    assert ok.status_code == 200
    state = ok.json()
    assert state["active_pack"] == "custom"
    custom = next(p for p in state["packs"] if p["id"] == "custom")
    assert custom["installed"] and custom["active"]

    manifest = client.get("/api/appearance/fonts/packs/custom/manifest")
    assert manifest.status_code == 200
    faces = manifest.json()["faces"]
    assert len(faces) == 1
    fname = faces[0]["file"]

    served = client.get(f"/api/appearance/fonts/packs/custom/files/{fname}")
    assert served.status_code == 200
    assert served.content == good_bytes
    assert "immutable" in served.headers.get("cache-control", "")

    traversal = client.get("/api/appearance/fonts/packs/custom/files/..%2Fpreferences.json")
    assert traversal.status_code in (400, 404)

    # Switching back to system keeps custom installed, deleting custom restores system cleanly.
    sys_resp = client.post("/api/appearance/fonts/activate", json={"pack_id": "system"})
    assert sys_resp.status_code == 200
    assert sys_resp.json()["active_pack"] == "system"

    client.post("/api/appearance/fonts/activate", json={"pack_id": "custom"})
    deleted = client.delete("/api/appearance/fonts/custom")
    assert deleted.status_code == 200
    assert deleted.json()["active_pack"] == "system"
    assert all(p["id"] != "custom" for p in deleted.json()["packs"])


def test_activate_uninstalled_returns_404(tmp_path, monkeypatch):
    client = _make_client(tmp_path, monkeypatch)
    r = client.post("/api/appearance/fonts/activate", json={"pack_id": "harmonyos-sans-sc"})
    assert r.status_code == 404


def test_latin_only_download_verifies_sha256_and_installs(tmp_path):
    mgr = font_service.FontManager(tmp_path / "fonts")
    blobs_by_url = {}
    patched_assets = []
    for item in font_service.LATIN_MONO_ASSETS:
        blob = _woff2_bytes(item["file"].encode("ascii"))
        digest = hashlib.sha256(blob).hexdigest()
        patched = {**item, "sha256": digest, "size": len(blob)}
        patched_assets.append(patched)
        for u in item["urls"]:
            blobs_by_url[u] = blob

    class FakeResp:
        def __init__(self, content: bytes):
            self._content = content
        def __enter__(self):
            return self
        def __exit__(self, *args):
            return False
        def raise_for_status(self):
            return None
        def iter_content(self, chunk_size=65536):
            yield self._content

    with mock.patch.object(font_service, "LATIN_MONO_ASSETS", tuple(patched_assets)), \
         mock.patch.object(font_service.requests, "get", side_effect=lambda u, **kw: FakeResp(blobs_by_url[u])):
        stage = tmp_path / "stage"
        stage.mkdir()
        manifest = font_service._install_latin_only(stage, lambda _n: None)
        assert manifest["mode"] == "latin-enhanced"
        assert len(manifest["faces"]) == 3
        for item in patched_assets:
            assert (stage / item["file"]).is_file()
