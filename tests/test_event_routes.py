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
    headers: dict[str, str] = {}

    def __init__(self, query: str) -> None:
        self.query_params = QueryParams(query)
        self.accepted = False

    async def accept(self) -> None:
        self.accepted = True

    async def close(self, **_kwargs) -> None:
        pass

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
