from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable

import pytest

from server.routes import agent, events, goalhive, sessions


class _RejectedWebSocket:
    def __init__(self, origin: str) -> None:
        self.headers = {"origin": origin}
        self.accepted = False
        self.close_args: dict[str, object] | None = None

    async def accept(self) -> None:
        self.accepted = True

    async def close(self, **kwargs: object) -> None:
        self.close_args = kwargs


def _session_handler(ws: _RejectedWebSocket) -> Awaitable[None]:
    return sessions.session_events(ws, "private-session")  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "handler",
    [
        events.ws_events,
        agent.ws_chat,
        goalhive.ws_goalhive,
        _session_handler,
    ],
    ids=["events", "chat", "goalhive", "sessions"],
)
def test_websocket_routes_reject_external_origin_before_accept(
    handler: Callable[[_RejectedWebSocket], Awaitable[None]],
) -> None:
    ws = _RejectedWebSocket("https://evil.example")

    asyncio.run(handler(ws))

    assert not ws.accepted
    assert ws.close_args == {"code": 1008, "reason": "Forbidden origin"}
