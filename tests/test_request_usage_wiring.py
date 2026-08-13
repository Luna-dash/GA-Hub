"""Request-level usage wiring tests for the Conductor service."""
from __future__ import annotations

from unittest.mock import Mock, patch

from server.services.conductor_service import ConductorService
from server.services.request_usage import RequestUsageStore


def test_user_chat_message_starts_usage_request_and_returns_request_id():
    service = object.__new__(ConductorService)
    service.chat_messages = []
    service._started = True
    service.start = Mock()
    service.notify = Mock()
    service.usage_store = RequestUsageStore(clock=lambda: 10.0)

    with patch("server.services.conductor_service.bus.publish"):
        item = service.add_chat_message("hello", role="user")

    request_id = item["request_id"]
    assert request_id
    assert request_id != item["id"]
    row = service.usage_store.list()[0]
    assert row["request_id"] == request_id
    assert row["attribution"] == "PENDING"
    service.start.assert_called_once_with(None)
    service.notify.assert_called_once_with(
        {"type": "user_message", "msg": "hello", "request_id": request_id}
    )
