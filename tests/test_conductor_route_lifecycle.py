from __future__ import annotations

import asyncio

from server.routes import conductor as conductor_routes


def test_stop_route_delegates_to_service_lifecycle(monkeypatch):
    class FakeService:
        _started = True

        def __init__(self):
            self.stop_calls = 0

        def stop(self):
            self.stop_calls += 1
            self._started = False
            return True

    service = FakeService()
    monkeypatch.setattr(conductor_routes, "svc", lambda: service)

    result = asyncio.run(conductor_routes.stop_conductor())

    assert result == {"ok": True, "started": False}
    assert service.stop_calls == 1
