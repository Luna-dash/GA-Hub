from __future__ import annotations

import asyncio
from unittest import mock

from starlette.datastructures import QueryParams

from server.routes import events


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
