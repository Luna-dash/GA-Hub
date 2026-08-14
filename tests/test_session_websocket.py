"""Session-scoped WebSocket contract tests."""
from __future__ import annotations

import asyncio
import logging
import time

from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.services.event_bus import Event, EventBus
from server.services.session_coordinator import RuntimeState
from server.services.session_metadata import SessionMetadataStore


def test_coordinator_abort_timeout_publishes_identified_error_event(
    monkeypatch, caplog
):
    caplog.set_level(logging.INFO, logger="server.routes.sessions")
    from server.routes import sessions

    event_bus = EventBus()
    captured = {}

    class CapturingCoordinator:
        def __init__(self, runtime_factory, *, on_state_change, capacity):
            captured["callback"] = on_state_change
            captured["capacity"] = capacity

    monkeypatch.setattr(sessions, "bus", event_bus)
    monkeypatch.setattr(sessions, "_coordinator", None)
    monkeypatch.setattr(sessions, "SessionCoordinator", CapturingCoordinator)
    monkeypatch.setattr(sessions, "SessionRuntimeFactory", lambda store: object())

    sessions._get_coordinator()
    assert captured["capacity"] == 3
    captured["callback"](RuntimeState(
        "session-a", "error", "run-a", "stream-a", "abort_timeout"
    ))

    event = event_bus.history("chat:")[-1]
    assert event.topic == "chat:error"
    assert event.payload == {
        "session_id": "session-a",
        "run_id": "run-a",
        "stream_id": "stream-a",
        "code": "abort_timeout",
        "detail": "停止请求超时；底层任务尚未终止，如持续占用请重启服务。",
    }
    assert "session_runtime_error session_id=session-a" in caplog.text
    assert "run_id=run-a" in caplog.text
    assert "stream_id=stream-a" in caplog.text
    assert "runtime_before=aborting runtime_after=error" in caplog.text


def test_coordinator_completion_publishes_runtime_event(monkeypatch):
    from server.routes import sessions

    event_bus = EventBus()
    monkeypatch.setattr(sessions, "bus", event_bus)

    sessions._publish_runtime_state(RuntimeState(
        "session-a", completed_run_id="run-a"
    ))

    event = event_bus.history("session:")[-1]
    assert event.topic == "session:runtime"
    assert event.payload == {
        "session_id": "session-a",
        "status": "idle",
        "run_id": None,
        "stream_id": None,
        "completed_run_id": "run-a",
        "error": None,
    }


class FakeCoordinator:
    def runtime_state(self, session_id: str) -> RuntimeState:
        return RuntimeState(session_id, "running", "run-a", "stream-a")

    def session_snapshot(self, session_id: str):
        return self.runtime_state(session_id), None


def _app(tmp_path, monkeypatch) -> tuple[FastAPI, str]:
    from server.routes import sessions

    store = SessionMetadataStore(tmp_path / "sessions.json")
    sid = store.create(title="A")["id"]
    monkeypatch.setattr(sessions, "_store", store)
    monkeypatch.setattr(sessions, "_coordinator", FakeCoordinator())
    event_bus = EventBus()
    monkeypatch.setattr(sessions, "bus", event_bus)
    app = FastAPI()

    @app.on_event("startup")
    async def attach_event_loop() -> None:
        event_bus.attach_loop(asyncio.get_running_loop())

    app.state.test_bus = event_bus
    app.include_router(sessions.router)
    return app, sid


def test_session_event_frame_is_strictly_isolated():
    from server.routes import sessions

    matching = Event("chat:next", {
        "session_id": "A", "run_id": "r1", "stream_id": "s1", "content": "hello",
    }, event_id=7)
    assert sessions._session_event_frame("A", matching) == {
        "type": "next", "session_id": "A", "run_id": "r1",
        "stream_id": "s1", "content": "hello",
        "event_id": 7, "epoch": sessions.bus.epoch,
    }
    assert sessions._session_event_frame("B", matching) is None
    assert sessions._session_event_frame("A", Event("chat:heartbeat", {"stream_id": "s1"})) is None
    assert sessions._session_event_frame("A", Event("agent:done", {"session_id": "A"})) is None

    rewound = Event("chat:rewound", {
        "session_id": "A", "removed_sids": ["s1"],
        "kept": 1, "history_lines": 2,
    }, event_id=8)
    assert sessions._session_event_frame("A", rewound) == {
        "type": "rewound", "session_id": "A",
        "removed_sids": ["s1"], "kept": 1, "history_lines": 2,
        "event_id": 8, "epoch": sessions.bus.epoch,
    }
    assert sessions._session_event_frame("B", rewound) is None


def test_session_websocket_starts_with_runtime_snapshot_and_supports_ping(tmp_path, monkeypatch):
    app, sid = _app(tmp_path, monkeypatch)
    event_bus = app.state.test_bus
    with TestClient(app) as client:
        with client.websocket_connect(f"/ws/sessions/{sid}") as ws:
            snapshot = ws.receive_json()
            assert snapshot == {
                "type": "snapshot", "session_id": sid, "status": "running",
                "run_id": "run-a", "stream_id": "stream-a",
                "completed_run_id": None,
                "runtime": {
                    "status": "running", "run_id": "run-a",
                    "stream_id": "stream-a", "error": None,
                },
                "active_message": None,
                "epoch": event_bus.epoch,
            }
            assert ws.receive_json() == {
                "type": "replay_done", "session_id": sid,
                "event_id": 0, "epoch": event_bus.epoch,
            }
            # The subscription must already exist when the snapshot is visible;
            # otherwise an event published in the snapshot/subscribe gap is lost.
            assert len(event_bus._subs) == 1
            ws.send_json({"type": "ping"})
            assert ws.receive_json() == {"type": "pong", "session_id": sid}


def test_unknown_session_websocket_is_rejected(tmp_path, monkeypatch):
    app, _ = _app(tmp_path, monkeypatch)
    with TestClient(app) as client:
        try:
            with client.websocket_connect("/ws/sessions/missing"):
                raise AssertionError("unknown session websocket was accepted")
        except Exception as exc:
            # Starlette raises WebSocketDisconnect; avoid pinning its private repr.
            assert getattr(exc, "code", None) == 4404


def test_invalid_resume_cursor_emits_correlated_resync_log(
    tmp_path, monkeypatch, caplog
):
    caplog.set_level(logging.INFO, logger="server.routes.sessions")
    app, sid = _app(tmp_path, monkeypatch)

    with TestClient(app) as client:
        with client.websocket_connect(
            f"/ws/sessions/{sid}?after_event_id=not-an-integer"
        ) as ws:
            resync = ws.receive_json()
            assert resync["type"] == "resync_required"
            assert resync["reason"] == "invalid_cursor"
            assert ws.receive_json()["type"] == "snapshot"
            assert ws.receive_json()["type"] == "replay_done"

    resync_record = next(
        record for record in caplog.records
        if record.getMessage().startswith("session_ws_resync ")
    )
    connected_record = next(
        record for record in caplog.records
        if record.getMessage().startswith("session_ws_connected ")
    )
    assert resync_record.args[0] == sid
    assert resync_record.args[1] == connected_record.args[1]
    assert resync_record.args[3] == "invalid_cursor"


def test_session_websocket_forwards_only_owned_events_and_cleans_subscription(
    tmp_path, monkeypatch, caplog
):
    caplog.set_level(logging.INFO, logger="server.routes.sessions")
    app, sid = _app(tmp_path, monkeypatch)
    event_bus = app.state.test_bus

    with TestClient(app) as client:
        with client.websocket_connect(f"/ws/sessions/{sid}") as ws:
            assert ws.receive_json()["type"] == "snapshot"
            assert ws.receive_json() == {
                "type": "replay_done", "session_id": sid,
                "event_id": 0, "epoch": event_bus.epoch,
            }
            deadline = time.monotonic() + 1
            while not event_bus._subs and time.monotonic() < deadline:
                time.sleep(0.005)
            assert len(event_bus._subs) == 1

            event_bus.publish("chat:next", {
                "session_id": "other", "run_id": "run-b",
                "stream_id": "stream-b", "content": "wrong",
            })
            event_bus.publish("chat:next", {
                "session_id": sid, "run_id": "run-a",
                "stream_id": "stream-a", "content": "owned",
            })
            assert ws.receive_json() == {
                "type": "next", "session_id": sid, "run_id": "run-a",
                "stream_id": "stream-a", "content": "owned",
                "event_id": 2, "epoch": event_bus.epoch,
            }

        deadline = time.monotonic() + 1
        while event_bus._subs and time.monotonic() < deadline:
            time.sleep(0.005)
        assert event_bus._subs == []

    connected = next(
        record for record in caplog.records
        if record.getMessage().startswith("session_ws_connected ")
    )
    replay = next(
        record for record in caplog.records
        if record.getMessage().startswith("session_ws_replay ")
    )
    disconnected = next(
        record for record in caplog.records
        if record.getMessage().startswith("session_ws_disconnected ")
    )
    assert connected.args[0] == sid
    assert connected.args[1] == replay.args[1] == disconnected.args[1]
    assert connected.args[3] == replay.args[3] == 0
    assert replay.args[5] == "snapshot"
    log_text = caplog.text
    assert "owned" not in log_text
    assert "wrong" not in log_text
