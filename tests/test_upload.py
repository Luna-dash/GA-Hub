import asyncio

from fastapi import FastAPI
from fastapi.testclient import TestClient

from server import _paths
from server.routes import upload


class _ChunkedUpload:
    def __init__(self, chunks):
        self._chunks = iter(chunks)

    async def read(self, size=-1):
        try:
            return next(self._chunks)
        except StopIteration:
            return b""


class _CancelledUpload:
    def __init__(self):
        self.reads = 0

    async def read(self, size=-1):
        self.reads += 1
        if self.reads == 1:
            return b"partial"
        raise asyncio.CancelledError


def _client(tmp_path, monkeypatch):
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    monkeypatch.setattr(_paths, "admin_uploads_dir", lambda: uploads)
    app = FastAPI()
    app.include_router(upload.router)
    return TestClient(app), uploads


def test_upload_writes_in_chunks_and_enforces_limit(tmp_path):
    target = tmp_path / "payload.bin"
    source = _ChunkedUpload([b"abc", b"def", b""])

    assert asyncio.run(upload._save_upload_stream(source, target, max_size=6)) == 6
    assert target.read_bytes() == b"abcdef"

    oversized = tmp_path / "oversized.bin"
    source = _ChunkedUpload([b"abcd", b"efg", b""])
    try:
        asyncio.run(upload._save_upload_stream(source, oversized, max_size=6))
    except upload.UploadTooLarge:
        pass
    else:
        raise AssertionError("oversized upload must be rejected")
    assert not oversized.exists()


def test_cancelled_upload_removes_partial_file(tmp_path):
    target = tmp_path / "cancelled.bin"

    try:
        asyncio.run(upload._save_upload_stream(_CancelledUpload(), target, max_size=100))
    except asyncio.CancelledError:
        pass
    else:
        raise AssertionError("upload cancellation must propagate")

    assert not target.exists()


def test_files_by_path_rejects_symlink_outside_allowed_root(tmp_path, monkeypatch):
    client, _ = _client(tmp_path, monkeypatch)
    temp_root = tmp_path / "ga-temp"
    outside = tmp_path / "outside.txt"
    temp_root.mkdir()
    outside.write_text("secret", encoding="utf-8")
    link = temp_root / "linked.txt"
    try:
        link.symlink_to(outside)
    except (OSError, NotImplementedError):
        import pytest
        pytest.skip("symlink creation is unavailable")

    monkeypatch.setattr(_paths, "temp_dir", lambda: temp_root)
    response = client.get("/api/files-by-path", params={"path": str(link)})

    assert response.status_code == 403


def test_files_by_path_rejects_resolved_path_outside_root(tmp_path, monkeypatch):
    temp_root = tmp_path / "ga-temp"
    temp_root.mkdir()
    apparent = temp_root / "linked.txt"
    outside = tmp_path / "outside.txt"
    outside.write_text("secret", encoding="utf-8")
    monkeypatch.setattr(_paths, "temp_dir", lambda: temp_root)
    monkeypatch.setattr(
        upload.os.path,
        "realpath",
        lambda value: str(outside) if str(value) == str(apparent) else str(value),
    )
    monkeypatch.setattr(upload.os.path, "isfile", lambda value: True)

    from fastapi import HTTPException
    try:
        upload._resolve_file_by_path(str(apparent))
    except HTTPException as exc:
        assert exc.status_code == 403
    else:
        raise AssertionError("resolved symlink outside root must be rejected")


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
