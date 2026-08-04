"""Public contract tests for lightweight GA-Hub session metadata.

The sidecar deliberately contains no chat messages: GA's raw archives and live
GeneraticAgent runtimes remain the only conversation truth sources.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient


def _client(tmp_path: Path, monkeypatch) -> TestClient:
    from server.routes import sessions
    from server.services.session_metadata import SessionMetadataStore

    monkeypatch.setattr(sessions, "_store", SessionMetadataStore(tmp_path))
    app = FastAPI()
    app.include_router(sessions.router)
    return TestClient(app)


def test_session_metadata_crud_is_message_free(tmp_path: Path, monkeypatch) -> None:
    with _client(tmp_path, monkeypatch) as client:
        created = client.post(
            "/api/sessions",
            json={"title": "Research", "llm_index": 2},
        )
        assert created.status_code == 201
        item = created.json()
        assert item["title"] == "Research"
        assert item["llm_index"] == 2
        assert item["status"] == "idle"
        assert "messages" not in item

        messages = client.get(f"/api/sessions/{item['id']}/messages")
        assert messages.status_code == 200
        assert messages.json() == {
            "session_id": item["id"],
            "archive_bound": False,
            "revision": None,
            "items": [],
        }

        listed = client.get("/api/sessions").json()
        assert listed["total"] == 1
        assert listed["items"] == [item]

        changed = client.patch(
            f"/api/sessions/{item['id']}", json={"title": "Renamed"}
        )
        assert changed.status_code == 200
        assert changed.json()["title"] == "Renamed"
        assert changed.json()["updated_at"] >= item["updated_at"]

        model = client.put(
            f"/api/sessions/{item['id']}/model", json={"llm_index": 7}
        )
        assert model.status_code == 200
        assert model.json()["llm_index"] == 7
        assert client.get(f"/api/sessions/{item['id']}").json()["llm_index"] == 7
        assert client.put(
            f"/api/sessions/{item['id']}/model", json={"llm_index": -1}
        ).status_code == 422

        assert client.delete(f"/api/sessions/{item['id']}").status_code == 204
        assert client.get(f"/api/sessions/{item['id']}").status_code == 404

    persisted = json.loads((tmp_path / "sessions.json").read_text("utf-8"))
    encoded = json.dumps(persisted)
    assert "messages" not in encoded
    assert persisted == {"schema_version": 1, "sessions": []}


def test_bound_missing_archive_is_structured_error_without_path_leak(
    tmp_path: Path, monkeypatch
) -> None:
    from server.routes import sessions

    missing = tmp_path / "private" / "missing-model-responses.txt"
    with _client(tmp_path, monkeypatch) as client:
        created = client.post("/api/sessions", json={"title": "Missing"}).json()
        sessions._store.bind_archive(created["id"], missing)

        response = client.get(f"/api/sessions/{created['id']}/messages")
        assert response.status_code == 409
        body = response.json()
        assert body["detail"]["code"] == "history_unavailable"
        assert str(missing) not in response.text


def test_bound_archive_parser_failure_is_stable_error(
    tmp_path: Path, monkeypatch
) -> None:
    from server.routes import sessions

    archive = tmp_path / "bound.txt"
    archive.write_text("not important", encoding="utf-8")

    def fail_parser(_path):
        raise ValueError("sensitive parser detail")

    with _client(tmp_path, monkeypatch) as client:
        from frontends import continue_cmd

        monkeypatch.setattr(continue_cmd, "extract_ui_messages", fail_parser)
        created = client.post("/api/sessions", json={"title": "Broken"}).json()
        sessions._store.bind_archive(created["id"], archive)

        response = client.get(f"/api/sessions/{created['id']}/messages")
        assert response.status_code == 409
        assert response.json() == {"detail": {"code": "history_unavailable"}}
        assert "sensitive parser detail" not in response.text


def test_bound_archive_projects_ga_messages_without_copying_body(
    tmp_path: Path, monkeypatch
) -> None:
    from server.routes import sessions

    archive = tmp_path / "model_responses_fixture.txt"
    archive_body = (
        '=== Prompt ===\n'
        '{"content":[{"type":"text","text":"hello archive"}]}\n'
        '=== Response ===\n'
        "[{'type': 'text', 'text': 'hello from GA'}]\n"
    )
    archive.write_text(archive_body, encoding="utf-8")

    with _client(tmp_path, monkeypatch) as client:
        created = client.post("/api/sessions", json={"title": "Bound"}).json()
        sessions._store.bind_archive(created["id"], archive)

        response = client.get(f"/api/sessions/{created['id']}/messages")
        assert response.status_code == 200
        body = response.json()
        assert body["session_id"] == created["id"]
        assert body["archive_bound"] is True
        assert body["revision"] == hashlib.sha256(archive.read_bytes()).hexdigest()
        assert [(item["role"], item["ordinal"]) for item in body["items"]] == [
            ("user", 0),
            ("assistant", 1),
        ]
        assert body["items"][0]["content"] == "hello archive"
        assert "hello from GA" in body["items"][1]["content"]
        assert len({item["id"] for item in body["items"]}) == 2

    sidecar = (tmp_path / "sessions.json").read_text("utf-8")
    assert "hello archive" not in sidecar
    assert "hello from GA" not in sidecar


def test_unknown_session_update_and_delete_return_404(tmp_path: Path, monkeypatch) -> None:
    with _client(tmp_path, monkeypatch) as client:
        assert client.patch("/api/sessions/missing", json={"title": "x"}).status_code == 404
        assert client.delete("/api/sessions/missing").status_code == 404


def test_sessions_router_is_wired_in_normal_mode(tmp_path: Path, monkeypatch) -> None:
    """Inspect the real app route table without starting GA background services."""
    from server import _paths
    from server.main import create_app

    monkeypatch.setattr(_paths, "GA_ROOT", tmp_path)
    paths = {route.path for route in create_app().routes}
    assert "/api/sessions" in paths
    assert "/api/sessions/{session_id}" in paths
