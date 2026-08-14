"""Public contract tests for lightweight GA-Hub session metadata.

The sidecar deliberately contains no chat messages: GA's raw archives and live
GeneraticAgent runtimes remain the only conversation truth sources.
"""
from __future__ import annotations

import hashlib
import json
import logging
import threading
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
    tmp_path: Path, monkeypatch, caplog
) -> None:
    caplog.set_level(logging.WARNING, logger="server.routes.sessions")
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

    assert f"session_id={created['id']}" in caplog.text
    assert "code=history_unavailable" in caplog.text
    assert str(missing) not in caplog.text


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
        assert response.json() == {"detail": {
            "code": "history_unavailable",
            "detail": "历史消息暂时不可用，请稍后重试。",
        }}
        assert "sensitive parser detail" not in response.text


def test_bound_archive_projects_ga_messages_without_copying_body(
    tmp_path: Path, monkeypatch
) -> None:
    from server.routes import sessions

    archive = tmp_path / "model_responses_fixture.txt"
    archive_body = (
        '=== Prompt === 2026-08-05 09:10:11\n'
        '{"content":[{"type":"text","text":"hello archive"}]}\n'
        '=== Response === 2026-08-05 09:10:12\n'
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
        assert [item["timestamp"] for item in body["items"]] == [
            "2026-08-05T09:10:11",
            "2026-08-05T09:10:12",
        ]
        assert len({item["id"] for item in body["items"]}) == 2

    sidecar = (tmp_path / "sessions.json").read_text("utf-8")
    assert "hello archive" not in sidecar
    assert "hello from GA" not in sidecar


def test_legacy_archive_without_header_times_projects_null_timestamps(tmp_path: Path) -> None:
    from server.services.archive_messages import read_archive_messages

    archive = tmp_path / "legacy_archive.txt"
    archive.write_text(
        '=== Prompt ===\n'
        '{"content":[{"type":"text","text":"legacy question"}]}\n'
        '=== Response ===\n'
        "[{'type': 'text', 'text': 'legacy answer'}]\n",
        encoding="utf-8",
    )

    items = read_archive_messages(archive)["items"]
    assert [item["role"] for item in items] == ["user", "assistant"]
    assert [item["timestamp"] for item in items] == [None, None]


def test_scheduled_dispatch_matches_coordinator_submit_contract(
    tmp_path: Path, monkeypatch
) -> None:
    from server.routes import sessions
    from server.services.scheduled_chat_service import ScheduledChat
    from server.services.session_metadata import SessionMetadataStore

    store = SessionMetadataStore(tmp_path)
    row = store.create(title="Scheduled", llm_index=7)
    calls = []

    class StrictCoordinator:
        def submit(self, text, *, session_id, source, images, llm_index):
            calls.append({
                "text": text,
                "session_id": session_id,
                "source": source,
                "images": images,
                "llm_index": llm_index,
            })

    monkeypatch.setattr(sessions, "_store", store)
    monkeypatch.setattr(sessions, "_coordinator", StrictCoordinator())
    sessions._dispatch_scheduled_chat(ScheduledChat(
        id="task-1",
        session_id=row["id"],
        text="run later",
        images=["image.png"],
        scheduled_for=2.0,
        created_at=1.0,
    ))

    assert calls == [{
        "text": "run later",
        "session_id": row["id"],
        "source": "scheduled",
        "images": ["image.png"],
        "llm_index": 7,
    }]


def test_project_registry_create_and_session_binding_api(tmp_path: Path, monkeypatch) -> None:
    from frontends import workspace_cmd
    from server.routes import sessions
    from server.services.session_coordinator import SessionCoordinator
    from server.services.session_metadata import SessionMetadataStore

    projects = [{
        "name": "alpha-1234",
        "path": "D:/work/alpha",
        "last_used": 42,
        "mem_lines": 3,
        "dangling": False,
    }]
    monkeypatch.setattr(workspace_cmd, "registry_list", lambda: projects)
    monkeypatch.setattr(workspace_cmd, "prepare", lambda path: {
        "ok": True,
        "name": "beta-5678",
        "target": path,
        "link": "D:/study/GA/temp/beta-5678",
        "mem_text": "",
        "warning": "",
        "error": "",
    })

    class Agent:
        pass

    class Handle:
        stream_id = "stream-project"

        def __init__(self) -> None:
            self.completed = threading.Event()

        @property
        def finished(self) -> bool:
            return self.completed.is_set()

    class Runtime:
        def __init__(self) -> None:
            self.agent = Agent()
            self.handle = Handle()
            self.submissions = []

        def submit(self, text, **kwargs):
            self.submissions.append({
                "text": text,
                "project_name": getattr(self.agent, "_ga_project_mode_name", None),
                **kwargs,
            })
            return self.handle

    runtime = Runtime()
    completion_observed = threading.Event()
    store = SessionMetadataStore(tmp_path)
    row = store.create(title="Project session")
    coordinator = SessionCoordinator(
        lambda _session_id: runtime,
        poll_interval=0.001,
        on_state_change=lambda state: (
            completion_observed.set() if state.completed_run_id else None
        ),
    )
    coordinator.configure_if_idle(row["id"], lambda _runtime: None)
    coordinator._runtimes[row["id"]] = runtime
    monkeypatch.setattr(sessions, "_store", store)
    monkeypatch.setattr(sessions, "_coordinator", coordinator)

    app = FastAPI()
    app.include_router(sessions.router)
    with TestClient(app) as client:
        listed = client.get("/api/projects")
        assert listed.status_code == 200
        assert listed.json() == {"total": 1, "items": projects}

        removed = []
        monkeypatch.setattr(
            workspace_cmd,
            "remove",
            lambda name: (
                removed.append(name)
                or {
                    "ok": True,
                    "name": name,
                    "link_removed": True,
                    "source_preserved": True,
                }
            ),
        )
        store.update(row["id"], {
            "project_name": "alpha-1234",
            "project_path": "D:/work/alpha",
        })
        still_bound = client.delete("/api/projects/alpha-1234")
        assert still_bound.status_code == 409
        assert still_bound.json()["detail"]["code"] == "project_still_bound"
        assert still_bound.json()["detail"]["session_ids"] == [row["id"]]
        assert removed == []

        store.update(row["id"], {"project_name": None, "project_path": None})
        deleted = client.delete("/api/projects/alpha-1234")
        assert deleted.status_code == 204
        assert removed == ["alpha-1234"]
        missing = client.delete("/api/projects/missing")
        assert missing.status_code == 404
        assert removed == ["alpha-1234"]

        created = client.post("/api/projects", json={"path": "D:/work/beta"})
        assert created.status_code == 201
        assert created.json() == {
            "name": "beta-5678",
            "path": "D:/work/beta",
            "memory_path": "",
            "dangling": False,
        }

        bound = client.put(
            f"/api/sessions/{row['id']}/project",
            json={"name": "alpha-1234", "path": "D:/work/alpha"},
        )
        assert bound.status_code == 200
        assert bound.json()["project_name"] == "alpha-1234"
        assert bound.json()["project_path"] == "D:/work/alpha"
        assert runtime.agent._ga_project_mode_name == "alpha-1234"

        submitted = client.post(
            f"/api/sessions/{row['id']}/runs",
            json={"text": "hello project", "source": "webui", "images": []},
        )
        assert submitted.status_code == 202
        submitted_payload = submitted.json()
        assert submitted_payload["status"] == "running"
        assert len(runtime.submissions) == 1
        submission = runtime.submissions[0]
        assert submission == {
            "text": "hello project",
            "project_name": "alpha-1234",
            "source": "webui",
            "images": [],
            "llm_index": None,
            "session_id": row["id"],
            "run_id": submitted_payload["run_id"],
        }
        runtime.handle.completed.set()
        assert completion_observed.wait(1.0)

        unbound = client.delete(f"/api/sessions/{row['id']}/project")
        assert unbound.status_code == 200
        assert unbound.json()["project_name"] is None
        assert unbound.json()["project_path"] is None
        assert not hasattr(runtime.agent, "_ga_project_mode_name")


def test_project_binding_rejects_unknown_or_running_session(tmp_path: Path, monkeypatch) -> None:
    from frontends import workspace_cmd
    from server.routes import sessions
    from server.services.session_coordinator import SessionCoordinator
    from server.services.session_metadata import SessionMetadataStore

    monkeypatch.setattr(workspace_cmd, "registry_list", lambda: [{
        "name": "alpha-1234", "path": "D:/work/alpha", "last_used": 1,
        "mem_lines": 0, "dangling": False,
    }])
    store = SessionMetadataStore(tmp_path)
    row = store.create(title="Busy")
    coordinator = SessionCoordinator(lambda _session_id: None)
    coordinator._active_by_session[row["id"]] = type("Active", (), {
        "session_id": row["id"], "run_id": "run-1", "stream_id": "stream-1",
    })()
    monkeypatch.setattr(sessions, "_store", store)
    monkeypatch.setattr(sessions, "_coordinator", coordinator)

    app = FastAPI()
    app.include_router(sessions.router)
    with TestClient(app) as client:
        unknown_project = client.put(
            f"/api/sessions/{row['id']}/project",
            json={"name": "missing", "path": "D:/missing"},
        )
        assert unknown_project.status_code == 404

        busy = client.put(
            f"/api/sessions/{row['id']}/project",
            json={"name": "alpha-1234", "path": "D:/work/alpha"},
        )
        assert busy.status_code == 409
        assert busy.json()["detail"]["code"] == "session_active"


def test_project_delete_reports_mapping_removal_failure(tmp_path: Path, monkeypatch) -> None:
    from frontends import workspace_cmd

    monkeypatch.setattr(workspace_cmd, "registry_list", lambda: [{
        "name": "alpha-1234",
        "path": "D:/work/alpha",
        "dangling": False,
    }])
    monkeypatch.setattr(workspace_cmd, "remove", lambda name: {
        "ok": False,
        "name": name,
        "link_removed": False,
        "source_preserved": True,
        "error": "无法移除项目目录映射",
    })

    with _client(tmp_path, monkeypatch) as client:
        response = client.delete("/api/projects/alpha-1234")

    assert response.status_code == 500
    assert response.json()["detail"] == {
        "code": "project_remove_failed",
        "detail": "无法移除项目目录映射",
    }


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
