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
