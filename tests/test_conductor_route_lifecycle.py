from __future__ import annotations

import asyncio
from types import SimpleNamespace

from server.routes import conductor as conductor_routes
from server.services.conductor_service import ConductorService


RUNNING = {
    "started": True,
    "stopping": False,
    "admission_open": True,
    "loop_alive": True,
    "agent_alive": True,
}
STOPPED = {
    "started": False,
    "stopping": False,
    "admission_open": False,
    "loop_alive": False,
    "agent_alive": False,
}


class FakeService:
    def __init__(self, lifecycle):
        self._started = not lifecycle["started"]
        self._lifecycle = dict(lifecycle)
        self.pool = SimpleNamespace(counts=lambda: (2, 3))
        self.chat_messages = [{"role": "user"}]
        self.start_calls = []
        self.stop_calls = 0

    def lifecycle_status(self):
        self._started = self._lifecycle["started"]
        return dict(self._lifecycle)

    def start(self, llm_index=None):
        self.start_calls.append(llm_index)
        already_started = self._lifecycle["started"]
        self._lifecycle = dict(RUNNING)
        return not already_started

    def stop(self):
        self.stop_calls += 1
        self._lifecycle = dict(STOPPED)
        return True


def test_status_route_uses_live_lifecycle_instead_of_cached_started(monkeypatch):
    service = FakeService(STOPPED)
    assert service._started is True
    monkeypatch.setattr(conductor_routes, "svc", lambda: service)

    result = asyncio.run(conductor_routes.get_status())

    assert result == {
        **STOPPED,
        "subagents": {"running": 2, "stopped": 3},
        "chat_count": 1,
    }
    assert service._started is False


def test_start_route_returns_live_lifecycle_and_remains_idempotent(monkeypatch):
    service = FakeService(RUNNING)
    monkeypatch.setattr(conductor_routes, "svc", lambda: service)

    result = asyncio.run(conductor_routes.start_conductor())

    assert result == {"ok": True, **RUNNING}
    assert service.start_calls == [None]


def test_stop_route_delegates_and_returns_live_lifecycle(monkeypatch):
    service = FakeService(RUNNING)
    monkeypatch.setattr(conductor_routes, "svc", lambda: service)

    result = asyncio.run(conductor_routes.stop_conductor())

    assert result == {"ok": True, **STOPPED}
    assert service.stop_calls == 1


def test_service_lifecycle_status_refreshes_compatibility_cache():
    service = ConductorService.__new__(ConductorService)
    service._started = True
    service.conductor = SimpleNamespace(
        lifecycle_snapshot=lambda: dict(STOPPED)
    )

    assert service.lifecycle_status() == STOPPED
    assert service._started is False
