"""Request-level usage wiring tests for the Conductor service."""
from __future__ import annotations

import pytest
from unittest.mock import Mock, patch

from server.services.conductor_service import ConductorService
from server.services.request_usage import RequestUsageStore


def test_user_chat_message_starts_usage_request_and_returns_request_id():
    service = object.__new__(ConductorService)
    service.chat_messages = []
    service._started = True
    service.configure_models = Mock()
    service.ensure_started = Mock()
    service.notify = Mock(return_value=True)
    service.usage_store = RequestUsageStore(clock=lambda: 10.0)

    with patch("server.services.conductor_service.bus.publish"):
        item = service.add_chat_message("hello", role="user")

    request_id = item["request_id"]
    assert request_id
    assert request_id != item["id"]
    row = service.usage_store.list()[0]
    assert row["request_id"] == request_id
    assert row["attribution"] == "PENDING"
    service.configure_models.assert_called_once_with(
        llm_index=None,
        subagent_llm_index=None,
        subagent_model_policy=None,
    )
    service.ensure_started.assert_called_once_with()
    service.notify.assert_called_once_with(
        {"type": "user_message", "msg": "hello", "request_id": request_id}
    )


def _service_for_admission_test():
    service = object.__new__(ConductorService)
    service.chat_messages = []
    service._started = False
    service.configure_models = Mock()
    service.ensure_started = Mock()
    service.notify = Mock(return_value=True)
    service.usage_store = RequestUsageStore(clock=lambda: 10.0)
    return service


def test_user_admission_starts_conductor_before_notify():
    service = _service_for_admission_test()
    order = []
    service.configure_models.side_effect = lambda **_kwargs: order.append("configure")
    service.ensure_started.side_effect = lambda: order.append("start")
    service.notify.side_effect = lambda _event: order.append("notify") or True

    with patch("server.services.conductor_service.bus.publish"):
        service.add_chat_message("hello", role="user")

    assert order == ["configure", "start", "notify"]


def test_add_chat_failure_completes_request_as_failed_admission():
    service = _service_for_admission_test()

    with patch(
        "server.services.conductor_service.add_chat",
        side_effect=RuntimeError("chat failed"),
    ), pytest.raises(RuntimeError, match="chat failed"):
        service.add_chat_message("hello", role="user")

    row = service.usage_store.list()[0]
    assert row["attribution"] == "FAILED_ADMISSION"
    assert row["completed_at"] == 10.0


def test_start_failure_completes_request_as_failed_start():
    service = _service_for_admission_test()
    service.ensure_started.side_effect = RuntimeError("start failed")

    with patch("server.services.conductor_service.bus.publish"), pytest.raises(
        RuntimeError, match="start failed"
    ):
        service.add_chat_message("hello", role="user")

    row = service.usage_store.list()[0]
    assert row["attribution"] == "FAILED_START"
    assert row["completed_at"] == 10.0
    service.notify.assert_not_called()


def test_notify_failure_completes_request_as_failed_admission():
    service = _service_for_admission_test()
    service.notify.side_effect = RuntimeError("notify failed")

    with patch("server.services.conductor_service.bus.publish"), pytest.raises(
        RuntimeError, match="notify failed"
    ):
        service.add_chat_message("hello", role="user")

    row = service.usage_store.list()[0]
    assert row["attribution"] == "FAILED_ADMISSION"
    assert row["completed_at"] == 10.0
    service.ensure_started.assert_called_once_with()


def test_notify_false_completes_request_as_failed_admission():
    service = _service_for_admission_test()
    service.notify.return_value = False

    with patch("server.services.conductor_service.bus.publish"), pytest.raises(
        RuntimeError, match="stopped before event admission"
    ):
        service.add_chat_message("hello", role="user")

    row = service.usage_store.list()[0]
    assert row["attribution"] == "FAILED_ADMISSION"
    assert row["completed_at"] == 10.0
