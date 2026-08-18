"""Protocol tests for the global EventBus WebSocket route."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from unittest import mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.datastructures import QueryParams
from starlette.websockets import WebSocketDisconnect

from server.routes import events
from server.services.event_bus import EventBus


TRUSTED_ORIGIN = {"origin": "http://127.0.0.1:8765"}


class _FakeBus:
    def __init__(self) -> None:
        self.prefix = None
        self.replay = None

    async def subscribe(self, prefix="", *, replay=0):
        self.prefix = prefix
        self.replay = replay
        if False:
            yield None


class _FakeWebSocket:
    def __init__(self, query: str, origin: str | None = None) -> None:
        self.headers = {} if origin is None else {"origin": origin}
        self.query_params = QueryParams(query)
        self.accepted = False
        self.close_args = None

    async def accept(self) -> None:
        self.accepted = True

    async def close(self, **kwargs) -> None:
        self.close_args = kwargs

    async def send_json(self, _payload) -> None:
        raise AssertionError("fake bus does not yield events")


class _BackpressuredWebSocket(_FakeWebSocket):
    def __init__(self, query: str) -> None:
        super().__init__(query, origin=TRUSTED_ORIGIN["origin"])
        self.sent: list[dict] = []
        self.replay_done_sent = asyncio.Event()
        self.live_send_started = asyncio.Event()
        self.release_live_send = asyncio.Event()
        self.closed = asyncio.Event()

    async def send_json(self, payload) -> None:
        if "topic" in payload and not self.live_send_started.is_set():
            self.live_send_started.set()
            await self.release_live_send.wait()
        self.sent.append(payload)
        if payload.get("type") == "replay_done":
            self.replay_done_sent.set()

    async def receive_json(self):
        await self.closed.wait()
        raise WebSocketDisconnect()

    async def close(self, **kwargs) -> None:
        self.close_args = kwargs
        self.closed.set()


@pytest.fixture
def event_client(monkeypatch):
    test_bus = EventBus(history=10)
    monkeypatch.setattr(events, "bus", test_bus)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        loop = asyncio.get_running_loop()
        test_bus.attach_loop(loop)
        try:
            yield
        finally:
            test_bus.detach_loop(loop)

    app = FastAPI(lifespan=lifespan)
    app.include_router(events.router)
    with TestClient(app, base_url="http://127.0.0.1") as client:
        yield client, test_bus


def test_event_route_passes_all_repeated_prefixes_to_bus() -> None:
    fake_bus = _FakeBus()
    websocket = _FakeWebSocket("prefix=agent%3A&prefix=wechat%3A&replay=7")

    with mock.patch.object(events, "bus", fake_bus):
        asyncio.run(events.ws_events(websocket))

    assert websocket.accepted
    assert fake_bus.prefix == ("agent:", "wechat:")
    assert fake_bus.replay == 7


def test_event_route_accepts_tauri_app_origin() -> None:
    fake_bus = _FakeBus()
    websocket = _FakeWebSocket("", origin="http://tauri.localhost")

    with mock.patch.object(events, "bus", fake_bus):
        asyncio.run(events.ws_events(websocket))

    assert websocket.accepted
    assert websocket.close_args is None


def test_cursor_first_connection_sends_replay_done(event_client) -> None:
    client, test_bus = event_client

    with client.websocket_connect(
        "/ws/events?cursor=1&prefix=agent:",
        headers=TRUSTED_ORIGIN,
    ) as websocket:
        assert websocket.receive_json() == {
            "type": "replay_done",
            "event_id": 0,
            "epoch": test_bus.epoch,
        }
        test_bus.publish("agent:status", {"phase": "live"})
        live = websocket.receive_json()

    assert live == {
        "topic": "agent:status",
        "payload": {"phase": "live"},
        "ts": live["ts"],
        "event_id": 1,
        "epoch": test_bus.epoch,
    }


def test_cursor_subscriber_overflow_requires_resync_and_cleans_up() -> None:
    async def scenario() -> tuple[_BackpressuredWebSocket, EventBus]:
        test_bus = EventBus(history=10, queue_size=1)
        websocket = _BackpressuredWebSocket("cursor=1&prefix=agent:")
        loop = asyncio.get_running_loop()
        test_bus.attach_loop(loop)

        with mock.patch.object(events, "bus", test_bus):
            route_task = asyncio.create_task(events.ws_events(websocket))
            try:
                await asyncio.wait_for(websocket.replay_done_sent.wait(), timeout=1)
                test_bus.publish("agent:first", {"index": 1})
                await asyncio.wait_for(websocket.live_send_started.wait(), timeout=1)

                test_bus.publish("agent:second", {"index": 2})
                test_bus.publish("agent:third", {"index": 3})
                await asyncio.sleep(0)
                websocket.release_live_send.set()
                await asyncio.wait_for(route_task, timeout=1)
            finally:
                websocket.release_live_send.set()
                if not route_task.done():
                    route_task.cancel()
                    await asyncio.gather(route_task, return_exceptions=True)
                test_bus.detach_loop(loop)

        return websocket, test_bus

    websocket, test_bus = asyncio.run(scenario())

    assert websocket.sent[0] == {
        "type": "replay_done",
        "event_id": 0,
        "epoch": test_bus.epoch,
    }
    assert websocket.sent[-1] == {
        "type": "resync_required",
        "reason": "subscriber_overflow",
        "epoch": test_bus.epoch,
    }
    assert websocket.close_args == {"code": 1013, "reason": "resync required"}
    assert test_bus._subs == []
    assert test_bus._resumable_subs == {}


def test_valid_cursor_replays_only_matching_prefixes(event_client) -> None:
    client, test_bus = event_client
    test_bus.publish("agent:status", {"phase": "before"})
    cursor = test_bus.history()[-1].event_id
    test_bus.publish("chat:next", {"content": "excluded"})
    test_bus.publish("session:runtime", {"status": "running"})
    test_bus.publish("wechat:message_in", {"text": "included"})

    with client.websocket_connect(
        "/ws/events?cursor=1"
        f"&after_event_id={cursor}&epoch={test_bus.epoch}"
        "&prefix=session:&prefix=wechat:",
        headers=TRUSTED_ORIGIN,
    ) as websocket:
        session_event = websocket.receive_json()
        wechat_event = websocket.receive_json()
        replay_done = websocket.receive_json()

    assert session_event == {
        "topic": "session:runtime",
        "payload": {"status": "running"},
        "ts": session_event["ts"],
        "event_id": cursor + 2,
        "epoch": test_bus.epoch,
    }
    assert wechat_event == {
        "topic": "wechat:message_in",
        "payload": {"text": "included"},
        "ts": wechat_event["ts"],
        "event_id": cursor + 3,
        "epoch": test_bus.epoch,
    }
    assert replay_done == {
        "type": "replay_done",
        "event_id": cursor + 3,
        "epoch": test_bus.epoch,
    }


@pytest.mark.parametrize("raw_cursor", ["not-a-number", "-1"])
def test_invalid_cursor_requires_resync(event_client, raw_cursor: str) -> None:
    client, test_bus = event_client
    test_bus.publish("agent:status", {"phase": "ready"})

    with client.websocket_connect(
        f"/ws/events?cursor=1&after_event_id={raw_cursor}&epoch={test_bus.epoch}",
        headers=TRUSTED_ORIGIN,
    ) as websocket:
        resync = websocket.receive_json()
        replay_done = websocket.receive_json()

    assert resync == {
        "type": "resync_required",
        "reason": "invalid_cursor",
        "epoch": test_bus.epoch,
    }
    assert replay_done == {
        "type": "replay_done",
        "event_id": 1,
        "epoch": test_bus.epoch,
    }


def test_epoch_mismatch_requires_resync(event_client) -> None:
    client, test_bus = event_client
    test_bus.publish("agent:status", {"phase": "ready"})

    with client.websocket_connect(
        "/ws/events?cursor=1&after_event_id=0&epoch=stale-epoch",
        headers=TRUSTED_ORIGIN,
    ) as websocket:
        resync = websocket.receive_json()
        replay_done = websocket.receive_json()

    assert resync == {
        "type": "resync_required",
        "reason": "server_restarted",
        "epoch": test_bus.epoch,
    }
    assert replay_done == {
        "type": "replay_done",
        "event_id": 1,
        "epoch": test_bus.epoch,
    }


def test_legacy_replay_keeps_original_frames_without_controls(event_client) -> None:
    client, test_bus = event_client
    test_bus.publish("agent:status", {"phase": "replayed"})

    with client.websocket_connect(
        "/ws/events?prefix=agent:&replay=1",
        headers=TRUSTED_ORIGIN,
    ) as websocket:
        replayed = websocket.receive_json()
        test_bus.publish("agent:status", {"phase": "live"})
        live = websocket.receive_json()

    assert replayed["topic"] == "agent:status"
    assert replayed["payload"] == {"phase": "replayed"}
    assert live["topic"] == "agent:status"
    assert live["payload"] == {"phase": "live"}
    for frame in (replayed, live):
        assert set(frame) == {"topic", "payload", "ts"}
        assert "type" not in frame
