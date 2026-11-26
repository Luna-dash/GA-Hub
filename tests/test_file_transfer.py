import sqlite3

from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.routes import file_transfer as routes
from server.services import file_transfer as transfer


def test_manual_index_ignores_legacy_records_and_can_be_cleared(tmp_path, monkeypatch):
    monkeypatch.setattr(transfer._paths, "ADMIN_DATA", tmp_path)
    final = tmp_path / "summary.md"
    final.write_text("final", encoding="utf8")
    legacy = tmp_path / "intermediate.md"
    legacy.touch()
    with sqlite3.connect(transfer.FileTransfer().db) as db:
        db.execute("CREATE TABLE files (path TEXT)")
        db.execute("INSERT INTO files VALUES (?)", (str(legacy),))
    app = FastAPI()
    app.include_router(routes.router)
    endpoint = "/api/file-transfer"
    with TestClient(app) as client:
        assert client.get(endpoint).json() == []
        body = dict(path=str(final), engine="chat", session_id="chat-session")
        for invalid in (str(tmp_path), "summary.md", str(tmp_path / "absent")):
            assert client.post(endpoint, json=body | dict(path=invalid)).status_code == 422
        assert client.post(endpoint, json=body).status_code == 204
        assert client.post(endpoint, json=body | dict(engine="anti", session_id="anti-session")).status_code == 204
        row, = client.get(endpoint).json()
        assert row["name"] == final.name and row["available"] and row["size"] > 0
        renamed = final.rename(final.with_suffix(".old"))
        assert client.get(endpoint).json()[0]["available"] is False
        assert client.delete(endpoint).status_code == 204
        assert client.get(endpoint).json() == []
        assert renamed.is_file() and legacy.is_file()



def test_reply_document_requires_explicit_save_and_remains_after_clear(tmp_path, monkeypatch):
    monkeypatch.setattr(transfer._paths, "ADMIN_DATA", tmp_path)
    app = FastAPI()
    app.include_router(routes.router)
    endpoint = "/api/file-transfer"
    directory = tmp_path / "transfer_documents"
    text = "# \u7ed3\u8bba\n\n[output](D:/study/result.md)\n"
    with TestClient(app) as client:
        assert client.get(endpoint).json() == []
        body = {"session_id": "reply-session", "project": "demo"}
        assert client.post(endpoint + "/reply", json=body | {"engine": "chat", "text": " \n"}).status_code == 422
        assert not directory.exists()
        for source in ("chat", "anti"):
            request = body | {"engine": source, "text": text}
            assert client.post(endpoint + "/reply", json=request).status_code == 204
        rows = client.get(endpoint).json()
        assert [row["engine"] for row in rows] == ["anti", "chat"]
        assert len(list(directory.iterdir())) == 2
        for row in rows:
            assert row["available"] and row["session_id"] == "reply-session" and row["project"] == "demo"
            assert row["name"].startswith("结论-")
            assert not row["name"].startswith("demo-")
            assert len(row["name"].removesuffix(".md")) <= 26
            document = directory / row["name"]
            assert document.suffix == ".md" and str(document.resolve()) == row["path"]
            assert document.read_bytes() == text.encode("utf8")
        assert client.delete(endpoint).status_code == 204
        assert client.get(endpoint).json() == []
        assert len(list(directory.iterdir())) == 2


def test_clear_documents_deletes_staged_files_and_keeps_external_files(tmp_path, monkeypatch):
    monkeypatch.setattr(transfer._paths, "ADMIN_DATA", tmp_path)
    app = FastAPI()
    app.include_router(routes.router)
    endpoint = "/api/file-transfer"
    image = tmp_path / "preview.png"
    image.write_bytes(b"\x89PNG\r\n\x1a\nfake")
    report = tmp_path / "report.pdf"
    report.write_bytes(b"%PDF-1.4\n")
    archive = tmp_path / "bundle.zip"
    archive.write_bytes(b"PK\x03\x04")
    with TestClient(app) as client:
        assert client.delete(endpoint + "/documents").json() == {"deleted": 0}
        for artifact in (image, report, archive):
            assert client.post(endpoint, json={"path": str(artifact), "engine": "anti", "session_id": "s1", "project": "demo"}).status_code == 204
        assert client.post(endpoint + "/reply", json={"text": "# 方案\n\n细节说明", "engine": "chat", "session_id": "s1", "project": "demo"}).status_code == 204
        rows = client.get(endpoint).json()
        names = [row["name"] for row in rows]
        assert any(name.startswith("方案-") and name.endswith(".md") for name in names)
        assert {"preview.png", "report.pdf", "bundle.zip"}.issubset(set(names))

        resp = client.delete(endpoint + "/documents")
        assert resp.status_code == 200
        assert resp.json() == {"deleted": 1}
        assert list((tmp_path / "transfer_documents").iterdir()) == []
        remaining_names = [row["name"] for row in client.get(endpoint).json()]
        assert sorted(remaining_names) == ["bundle.zip", "preview.png", "report.pdf"]
        assert image.is_file() and report.is_file() and archive.is_file()

        # Works cleanly even when indexed list was already cleared first.
        assert client.post(endpoint + "/reply", json={"text": "待清理结论", "engine": "anti", "session_id": "s1"}).status_code == 204
        assert client.delete(endpoint).status_code == 204
        assert len(list((tmp_path / "transfer_documents").iterdir())) == 1
        assert client.delete(endpoint + "/documents").json() == {"deleted": 1}
        assert list((tmp_path / "transfer_documents").iterdir()) == []
