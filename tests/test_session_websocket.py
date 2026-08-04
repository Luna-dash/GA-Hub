"""Session-scoped WebSocket contract tests."""
from __future__ import annotations

import asyncio
import time

from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.services.event_bus import Event, EventBus
from server.services.session_coordinator import RuntimeState
from server.services.session_metadata import SessionMetadataStore


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
    from server.routes.sessions import _session_event_frame

    matching = Event("chat:next", {
        "session_id": "A", "run_id": "r1", "stream_id": "s1", "content": "hello",
    })
    assert _session_event_frame("A", matching) == {
        "type": "next", "session_id": "A", "run_id": "r1",
        "stream_id": "s1", "content": "hello",
    }
    assert _session_event_frame("B", matching) is None
    assert _session_event_frame("A", Event("chat:heartbeat", {"stream_id": "s1"})) is None
    assert _session_event_frame("A", Event("agent:done", {"session_id": "A"})) is None


def test_session_websocket_starts_with_runtime_snapshot_and_supports_ping(tmp_path, monkeypatch):
    app, sid = _app(tmp_path, monkeypatch)
    event_bus = app.state.test_bus
    with TestClient(app) as client:
        with client.websocket_connect(f"/ws/sessions/{sid}") as ws:
            assert ws.receive_json() == {
                "type": "snapshot", "session_id": sid, "status": "running",
                "run_id": "run-a", "stream_id": "stream-a",
                "runtime": {
                    "status": "running", "run_id": "run-a",
                    "stream_id": "stream-a", "error": None,
                },
                "active_message": None,
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


def test_session_websocket_forwards_only_owned_events_and_cleans_subscription(
    tmp_path, monkeypatch
):
    app, sid = _app(tmp_path, monkeypatch)
    event_bus = app.state.test_bus

    with TestClient(app) as client:
        with client.websocket_connect(f"/ws/sessions/{sid}") as ws:
            assert ws.receive_json()["type"] == "snapshot"
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
            }

        deadline = time.monotonic() + 1
        while event_bus._subs and time.monotonic() < deadline:
            time.sleep(0.005)
        assert event_bus._subs == []
