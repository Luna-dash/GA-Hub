"""AgentService.reset_live_snapshots — one home for the CHAT_RESET broadcast."""
from __future__ import annotations

import threading
from types import SimpleNamespace

from server.event_topics import CHAT_RESET
from server.services import event_bus
from server.services.agent_service import AgentService


def test_reset_live_snapshots_clears_and_broadcasts(monkeypatch):
    published: list[tuple[str, dict]] = []
    monkeypatch.setattr(
        event_bus.bus, "publish", lambda topic, payload: published.append((topic, payload))
    )
    service = SimpleNamespace(_lock=threading.Lock(), _snapshots={"stale": object()})

    AgentService.reset_live_snapshots(service, "session_restored")

    assert service._snapshots == {}
    assert published == [(CHAT_RESET, {"reason": "session_restored"})]
