"""P2 session runtime HTTP contract tests (no real GA runtime)."""
from __future__ import annotations

from dataclasses import asdict
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.services.session_coordinator import (
    AgentBusyError,
    RuntimeState,
    SessionControlBusyError,
)
from server.services.session_runtime_factory import RuntimeRestoreError
from server.services.session_metadata import SessionMetadataStore


class FakeCoordinator:
    def __init__(self) -> None:
        self.states: dict[str, RuntimeState] = {}
        self.active: RuntimeState | None = None
        self.submissions: list[dict] = []
        self.aborts: list[tuple[str, str]] = []
        self.side_questions: list[tuple[str, str]] = []
        self.rewinds: list[dict] = []
        self.restore_error = False
        self.control_error: str | None = None
        self.released: list[str] = []
        self.exclusive_operations: list[tuple[str, str]] = []

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

    def side_question(self, session_id: str, question: str) -> str:
        if self.restore_error:
            raise RuntimeRestoreError("internal restore path")
        if self.control_error:
            raise SessionControlBusyError(session_id, self.control_error)
        self.side_questions.append((session_id, question))
        return f"answer:{question}"

    def rewind(self, session_id: str, *, sid: str | None = None, n: int | None = None):
        if self.restore_error:
            raise RuntimeRestoreError("internal restore path")
        if self.control_error:
            raise SessionControlBusyError(session_id, self.control_error)
        request = {"session_id": session_id, "sid": sid, "n": n}
        self.rewinds.append(request)
        return {"removed_sids": ["stream-2"], "kept": 1, "history_lines": 2}

    def release_runtime(
        self, session_id: str, *, shutdown, operation="release", after_release=None
    ) -> bool:
        state = self.runtime_state(session_id)
        if state.status != "idle":
            raise AgentBusyError(
                session_id,
                state.run_id or "",
                reason=AgentBusyError.REASON_SESSION_ACTIVE,
            )
        self.released.append(session_id)
        shutdown(type("Runtime", (), {"shutdown": lambda self: None})())
        if after_release is not None:
            after_release()
        return True

    def exclusive(self, session_id: str, operation: str, action):
        self.exclusive_operations.append((session_id, operation))
        return action()


def _client(tmp_path: Path, monkeypatch):
    from server.routes import sessions

    store = SessionMetadataStore(tmp_path)
    coordinator = FakeCoordinator()
    monkeypatch.setattr(sessions, "_store", store)
    monkeypatch.setattr(sessions, "_coordinator", coordinator)
    app = FastAPI()
    app.include_router(sessions.router)
    return TestClient(app), store, coordinator


def test_list_session_runtimes_returns_all_sessions_in_one_response(
    tmp_path: Path, monkeypatch
) -> None:
    client, store, coordinator = _client(tmp_path, monkeypatch)
    idle_id = store.create(title="Idle")["id"]
    running_id = store.create(title="Running")["id"]
    coordinator.states[running_id] = RuntimeState(
        running_id, "running", "run-a", "stream-a"
    )

    with client:
        response = client.get("/api/session-runtimes")

    assert response.status_code == 200
    assert response.json() == {
        idle_id: {
            "session_id": idle_id,
            "status": "idle",
            "run_id": None,
            "stream_id": None,
            "completed_run_id": None,
        },
        running_id: {
            "session_id": running_id,
            "status": "running",
            "run_id": "run-a",
            "stream_id": "stream-a",
            "completed_run_id": None,
        },
    }


def test_restore_failure_is_stable_error(tmp_path: Path, monkeypatch) -> None:
    client, store, coordinator = _client(tmp_path, monkeypatch)
    sid = store.create(title="Restore", llm_key="native_oai_config")["id"]
    coordinator.restore_error = True

    with client:
        response = client.post(f"/api/sessions/{sid}/runs", json={"text": "x"})

    assert response.status_code == 409
    assert response.json()["detail"] == {
        "code": "restore_failed",
        "detail": "会话运行环境恢复失败，请稍后重试。",
    }


def test_session_controls_use_selected_runtime_contract(tmp_path: Path, monkeypatch) -> None:
    client, store, coordinator = _client(tmp_path, monkeypatch)
    sid = store.create(title="A")["id"]

    with client:
        btw = client.post(f"/api/sessions/{sid}/btw", json={"text": "  why  "})
        rewind = client.post(f"/api/sessions/{sid}/rewind", json={"n": 2})

    assert btw.status_code == 200
    assert btw.json() == {"ok": True, "content": "answer:why", "error": ""}
    assert coordinator.side_questions == [(sid, "why")]
    assert rewind.status_code == 200
    assert rewind.json() == {
        "removed_sids": ["stream-2"],
        "kept": 1,
        "history_lines": 2,
    }
    assert coordinator.rewinds == [{"session_id": sid, "sid": None, "n": 2}]


def test_session_control_errors_are_explicit(tmp_path: Path, monkeypatch) -> None:
    client, store, coordinator = _client(tmp_path, monkeypatch)
    sid = store.create(title="A")["id"]

    with client:
        invalid_btw = client.post(f"/api/sessions/{sid}/btw", json={"text": "  "})
        invalid_rewind = client.post(f"/api/sessions/{sid}/rewind", json={})
        missing = client.post("/api/sessions/missing/btw", json={"text": "x"})
        coordinator.control_error = "rewind"
        busy = client.post(f"/api/sessions/{sid}/btw", json={"text": "x"})

    assert invalid_btw.status_code == 400
    assert invalid_btw.json()["detail"]["code"] == "invalid_btw"
    assert invalid_rewind.status_code == 400
    assert invalid_rewind.json()["detail"]["code"] == "invalid_rewind"
    assert missing.status_code == 404
    assert busy.status_code == 409
    assert busy.json()["detail"] == {
        "code": "session_control_active",
        "detail": "当前会话正在执行互斥控制操作，请稍后重试。",
        "operation": "rewind",
    }


def test_submit_run_uses_session_metadata_and_returns_runtime_state(
    tmp_path: Path, monkeypatch
) -> None:
    client, store, coordinator = _client(tmp_path, monkeypatch)
    sid = store.create(title="A", llm_key="native_oai_config")["id"]

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
            "completed_run_id": None,
        }
        assert coordinator.submissions == [{
            "text": "hello",
            "session_id": sid,
            "source": "webui",
            "images": ["a.png"],
            "llm_key": "native_oai_config",
        }]
        assert client.get(f"/api/sessions/{sid}/runtime").json() == response.json()


def test_submit_run_rejects_legacy_positional_llm_binding(
    tmp_path: Path, monkeypatch
) -> None:
    client, store, coordinator = _client(tmp_path, monkeypatch)
    sid = store.create(title="Legacy")["id"]
    store.update(sid, {"llm_key": None, "llm_index": 2})

    with client:
        response = client.post(f"/api/sessions/{sid}/runs", json={"text": "hello"})

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "llm_unconfirmed"
    assert coordinator.submissions == []


def test_unbound_session_run_inherits_preferred_llm_key(
    tmp_path: Path, monkeypatch
) -> None:
    from server.routes import sessions

    client, store, coordinator = _client(tmp_path, monkeypatch)
    sid = store.create(title="Follow global")["id"]
    monkeypatch.setattr(
        sessions,
        "LlmPreferenceStore",
        lambda: type("Preferences", (), {"get_key": lambda self: "native_oai_config"})(),
    )

    with client:
        response = client.post(f"/api/sessions/{sid}/runs", json={"text": "hello"})

    assert response.status_code == 202
    assert coordinator.submissions == [{
        "text": "hello",
        "session_id": sid,
        "source": "webui",
        "images": [],
        "llm_key": "native_oai_config",
    }]


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
            "detail": "会话正在运行，请等待当前任务结束后重试。",
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
            "completed_run_id": None,
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
            "detail": response.json()["detail"]["detail"],
            "active_session_id": sid,
            "active_run_id": "run-a",
            "capacity": 1,
            "active_count": 1,
        }
        assert store.get(sid)["id"] == sid


def test_deleting_idle_session_releases_cached_runtime_once(tmp_path: Path, monkeypatch) -> None:
    client, store, coordinator = _client(tmp_path, monkeypatch)
    sid = store.create(title="Idle")["id"]

    with client:
        response = client.delete(f"/api/sessions/{sid}")

    assert response.status_code == 204
    assert coordinator.released == [sid]
    assert coordinator.exclusive_operations == []
    assert store.list() == []


def test_session_run_capacity_defaults_to_five_and_allows_one_to_five(monkeypatch) -> None:
    from server.routes import sessions

    monkeypatch.delenv("GAHUB_SESSION_RUN_CAPACITY", raising=False)
    assert sessions._session_run_capacity() == 5

    for capacity in ("1", "2", "3", "4", "5"):
        monkeypatch.setenv("GAHUB_SESSION_RUN_CAPACITY", capacity)
        assert sessions._session_run_capacity() == int(capacity)

    for invalid in ("0", "6", "many", ""):
        monkeypatch.setenv("GAHUB_SESSION_RUN_CAPACITY", invalid)
        assert sessions._session_run_capacity() == 5
