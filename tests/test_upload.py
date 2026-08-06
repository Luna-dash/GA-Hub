from fastapi import FastAPI
from fastapi.testclient import TestClient

from server import _paths
from server.routes import upload


def _client(tmp_path, monkeypatch):
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    monkeypatch.setattr(_paths, "admin_uploads_dir", lambda: uploads)
    app = FastAPI()
    app.include_router(upload.router)
    return TestClient(app), uploads


def test_upload_accepts_unknown_extension_and_ignores_spoofed_mime(tmp_path, monkeypatch):
    client, uploads = _client(tmp_path, monkeypatch)

    response = client.post(
        "/api/upload",
        files={"file": ("very-long-custom-format.blorb", b"payload", "image/png")},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["name"] == "very-long-custom-format.blorb"
    assert body["mime"] == "application/octet-stream"
    assert body["size"] == 7
    assert (uploads / body["url"].rsplit("/", 1)[-1]).read_bytes() == b"payload"


def test_non_image_download_is_attachment_and_nosniff(tmp_path, monkeypatch):
    client, _ = _client(tmp_path, monkeypatch)
    uploaded = client.post(
        "/api/upload",
        files={"file": ("active.html", b"<script>alert(1)</script>", "text/html")},
    ).json()

    response = client.get(uploaded["url"])

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/octet-stream")
    assert response.headers["content-disposition"].startswith("attachment;")
    assert response.headers["x-content-type-options"] == "nosniff"


def test_raster_image_is_served_inline_for_preview(tmp_path, monkeypatch):
    client, _ = _client(tmp_path, monkeypatch)
    uploaded = client.post(
        "/api/upload",
        files={"file": ("preview.png", b"not-a-real-image", "application/octet-stream")},
    ).json()

    response = client.get(uploaded["url"])

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("image/png")
    assert "content-disposition" not in response.headers
    assert response.headers["x-content-type-options"] == "nosniff"
