"""P2 session runtime HTTP contract tests (no real GA runtime)."""
from __future__ import annotations

from dataclasses import asdict
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.services.session_coordinator import AgentBusyError, RuntimeState
from server.services.session_runtime_factory import RuntimeRestoreError
from server.services.session_metadata import SessionMetadataStore


class FakeCoordinator:
    def __init__(self) -> None:
        self.states: dict[str, RuntimeState] = {}
        self.active: RuntimeState | None = None
        self.submissions: list[dict] = []
        self.aborts: list[tuple[str, str]] = []
        self.restore_error = False

    def runtime_state(self, session_id: str) -> RuntimeState:
        return self.states.get(session_id, RuntimeState(session_id))

    def submit(self, text: str, **kwargs):
        if self.restore_error:
            raise RuntimeRestoreError("internal restore path")
        if self.active is not None:
            raise AgentBusyError(self.active.session_id, self.active.run_id or "")
        state = RuntimeState(kwargs["session_id"], "running", "run-1", "stream-1")
        self.states[state.session_id] = state
        self.active = state
        self.submissions.append({"text": text, **kwargs})
        return state

    def abort_if_current(self, *, session_id: str) -> RuntimeState:
        current = self.runtime_state(session_id)
        if current.status not in {"starting", "running"} or not current.run_id:
            return current
        self.aborts.append((session_id, current.run_id))
        state = RuntimeState(session_id, "aborting", current.run_id, current.stream_id)
        self.states[session_id] = state
        self.active = state
        return state


def _client(tmp_path: Path, monkeypatch):
    from server.routes import sessions

    store = SessionMetadataStore(tmp_path)
    coordinator = FakeCoordinator()
    monkeypatch.setattr(sessions, "_store", store)
    monkeypatch.setattr(sessions, "_coordinator", coordinator)
    app = FastAPI()
    app.include_router(sessions.router)
    return TestClient(app), store, coordinator


def test_restore_failure_is_stable_error(tmp_path: Path, monkeypatch) -> None:
    client, store, coordinator = _client(tmp_path, monkeypatch)
    sid = store.create(title="Restore", llm_index=0)["id"]
    coordinator.restore_error = True

    with client:
        response = client.post(f"/api/sessions/{sid}/runs", json={"text": "x"})

    assert response.status_code == 409
    assert response.json()["detail"] == {
        "code": "restore_failed",
        "detail": "会话运行环境恢复失败，请稍后重试。",
    }


    client, store, coordinator = _client(tmp_path, monkeypatch)
    sid = store.create(title="A", llm_index=4)["id"]

    with client:
        response = client.post(
            f"/api/sessions/{sid}/runs",
            json={"text": "hello", "images": ["a.png"], "source": "webui"},
        )
        assert response.status_code == 202
        assert response.json() == {
            "session_id": sid,
            "status": "running",
            "run_id": "run-1",
            "stream_id": "stream-1",
        }
        assert coordinator.submissions == [{
            "text": "hello",
            "session_id": sid,
            "source": "webui",
            "images": ["a.png"],
            "llm_index": 4,
        }]
        assert client.get(f"/api/sessions/{sid}/runtime").json() == response.json()


def test_global_busy_and_unknown_session_are_explicit(tmp_path: Path, monkeypatch) -> None:
    client, store, coordinator = _client(tmp_path, monkeypatch)
    sid_a = store.create(title="A")["id"]
    sid_b = store.create(title="B")["id"]
    coordinator.active = RuntimeState(sid_a, "running", "run-a", "stream-a")

    with client:
        busy = client.post(f"/api/sessions/{sid_b}/runs", json={"text": "B"})
        assert busy.status_code == 409
        assert busy.json()["detail"] == {
            "code": "agent_busy",
            "detail": "另一个会话正在运行，请等待当前任务结束后重试。",
            "active_session_id": sid_a,
            "active_run_id": "run-a",
            "capacity": 1,
            "active_count": 1,
        }
        assert client.post("/api/sessions/missing/runs", json={"text": "x"}).status_code == 404
        assert client.get("/api/sessions/missing/runtime").status_code == 404
        assert client.post("/api/sessions/missing/abort").status_code == 404


def test_abort_is_idempotent_and_targets_only_current_session_run(tmp_path: Path, monkeypatch) -> None:
    client, store, coordinator = _client(tmp_path, monkeypatch)
    sid = store.create(title="A")["id"]

    with client:
        idle = client.post(f"/api/sessions/{sid}/abort")
        assert idle.status_code == 200
        assert idle.json() == {
            "ok": True,
            "session_id": sid,
            "status": "idle",
            "run_id": None,
            "stream_id": None,
        }

        coordinator.states[sid] = RuntimeState(sid, "running", "run-a", "stream-a")
        stopped = client.post(f"/api/sessions/{sid}/abort")
        assert stopped.status_code == 200
        assert stopped.json()["status"] == "aborting"
        assert coordinator.aborts == [(sid, "run-a")]

        repeated = client.post(f"/api/sessions/{sid}/abort")
        assert repeated.status_code == 200
        assert repeated.json()["status"] == "aborting"
        assert coordinator.aborts == [(sid, "run-a")]


def test_active_session_cannot_be_deleted(tmp_path: Path, monkeypatch) -> None:
    client, store, coordinator = _client(tmp_path, monkeypatch)
    sid = store.create(title="A")["id"]
    coordinator.states[sid] = RuntimeState(sid, "running", "run-a", "stream-a")

    with client:
        response = client.delete(f"/api/sessions/{sid}")
        assert response.status_code == 409
        assert response.json()["detail"] == {
            "code": "session_active",
            "run_id": "run-a",
            "status": "running",
        }
        assert store.get(sid)["id"] == sid


def test_session_run_capacity_defaults_to_three_and_allows_one_to_three(monkeypatch) -> None:
    from server.routes import sessions

    monkeypatch.delenv("GAHUB_SESSION_RUN_CAPACITY", raising=False)
    assert sessions._session_run_capacity() == 3

    for capacity in ("1", "2", "3"):
        monkeypatch.setenv("GAHUB_SESSION_RUN_CAPACITY", capacity)
        assert sessions._session_run_capacity() == int(capacity)

    for invalid in ("0", "4", "many", ""):
        monkeypatch.setenv("GAHUB_SESSION_RUN_CAPACITY", invalid)
        assert sessions._session_run_capacity() == 3
