from __future__ import annotations

import asyncio

from fastapi import WebSocketDisconnect

from server.routes import goalhive


class _DisconnectingWebSocket:
    def __init__(self, broadcaster_started: asyncio.Event) -> None:
        self.headers: dict[str, str] = {}
        self.accepted = False
        self.sent: list[dict[str, object]] = []
        self._broadcaster_started = broadcaster_started

    async def accept(self) -> None:
        self.accepted = True

    async def send_json(self, payload: dict[str, object]) -> None:
        self.sent.append(payload)

    async def receive_text(self) -> str:
        await self._broadcaster_started.wait()
        raise WebSocketDisconnect(code=1000)


class _GoalHiveService:
    def get_messages(self) -> list[dict[str, object]]:
        return []


def test_disconnect_cancels_and_awaits_broadcaster_cleanup(monkeypatch) -> None:
    async def exercise() -> None:
        started = asyncio.Event()
        cleanup_finished = False
        broadcaster_task: asyncio.Task[None] | None = None

        async def broadcaster(_ws, _service) -> None:
            nonlocal broadcaster_task, cleanup_finished
            broadcaster_task = asyncio.current_task()
            started.set()
            try:
                await asyncio.Future()
            finally:
                cleanup_finished = True

        websocket = _DisconnectingWebSocket(started)
        monkeypatch.setattr(goalhive, "get_goalhive_service", _GoalHiveService)
        monkeypatch.setattr(goalhive, "_broadcast_updates", broadcaster)

        await goalhive.ws_goalhive(websocket)  # type: ignore[arg-type]

        assert websocket.accepted
        assert websocket.sent == [{"type": "snapshot", "messages": []}]
        assert broadcaster_task is not None
        assert broadcaster_task.done()
        assert broadcaster_task.cancelled()
        assert cleanup_finished

    asyncio.run(exercise())
