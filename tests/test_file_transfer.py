from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.routes import file_transfer as routes
from server.services import file_transfer as transfer


def test_shared_index_only_records_final_file_citations_and_clear_keeps_files(tmp_path, monkeypatch):
    monkeypatch.setattr(transfer._paths, "ADMIN_DATA", tmp_path / "data")
    workspace = tmp_path / "work"
    workspace.mkdir()
    final = workspace / "交付 文件.md"
    artifact = workspace / "anti.md"
    intermediate = workspace / "scratch.md"
    for file in (final, artifact, intermediate):
        file.write_text(file.name, encoding="utf8")
    store = transfer.FileTransfer()
    store.record("chat", "chat-session", project_path=str(workspace), answer=(
        "<thinking>[private](scratch.md)</thinking>\n"
        "<summary>[private](scratch.md)</summary>\n"
        "```text\n[scratch](scratch.md)\n```\n"
        f"[交付](<{final.name}>)\n`{final}`\n"
        "[remote](https://example.invalid/file.md) [missing](missing.md)"
    ))
    store.record("anti", "anti-session", artifact=str(artifact))
    app = FastAPI()
    app.include_router(routes.router)
    with TestClient(app) as client:
        endpoint = "/api/file-transfer"
        rows = client.get(endpoint).json()
        assert [(row["name"], row["session_id"], row["engine"]) for row in rows] == [
            (artifact.name, "anti-session", "anti"), (final.name, "chat-session", "chat"),
        ]
        assert all(row["available"] and row["size"] > 0 for row in rows)
        intermediate.unlink()
        artifact.rename(artifact.with_suffix(".old"))
        assert client.get(endpoint).json()[0]["available"] is False
        assert client.delete(endpoint).status_code == 204
        assert transfer.FileTransfer().list() == []
        assert final.is_file() and artifact.with_suffix(".old").is_file()


def test_chat_input_attachment_is_not_reindexed(tmp_path):
    pasted = tmp_path / "input.md"
    pasted.touch()
    store = transfer.FileTransfer(tmp_path / "index.sqlite3")
    store.record("chat", "next", answer=f"`{pasted}`", exclude=(str(pasted),))
    assert store.list() == []
