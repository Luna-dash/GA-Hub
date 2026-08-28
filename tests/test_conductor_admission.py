"""Request admission wiring tests for the Conductor service."""
from __future__ import annotations

import pytest
from unittest.mock import Mock, patch

from server.services.conductor_service import ConductorService


def test_user_chat_message_is_admitted_with_a_request_id():
    service = object.__new__(ConductorService)
    service.chat_messages = []
    service._started = True
    service.configure_models = Mock()
    service.ensure_started = Mock()
    service.notify = Mock(return_value=True)

    with patch("server.services.conductor_service.bus.publish"):
        item = service.add_chat_message("hello", role="user")

    request_id = item["request_id"]
    assert request_id
    assert request_id != item["id"]
    service.configure_models.assert_called_once_with(
        llm_index=None,
        subagent_llm_index=None,
        subagent_model_policy=None,
    )
    service.ensure_started.assert_called_once_with()
    service.notify.assert_called_once_with(
        {"type": "user_message", "msg": "hello", "request_id": request_id}
    )


def test_conductor_plan_and_report_do_not_recursively_admit_user_tasks():
    service = object.__new__(ConductorService)
    service.chat_messages = []
    service._started = True
    service.configure_models = Mock()
    service.ensure_started = Mock()
    service.notify = Mock(return_value=True)

    with patch("server.services.conductor_service.bus.publish"):
        user_item = service.add_chat_message("calculate", role="user")
        plan_item = service.add_chat_message("dispatching", role="conductor")
        report_item = service.add_chat_message("result: 323", role="conductor")

    assert user_item["request_id"]
    assert "request_id" not in plan_item
    assert "request_id" not in report_item
    service.configure_models.assert_called_once()
    service.ensure_started.assert_called_once_with()
    service.notify.assert_called_once()
    assert service.notify.call_args.args[0]["type"] == "user_message"


def _service_for_admission_test():
    service = object.__new__(ConductorService)
    service.chat_messages = []
    service._started = False
    service.configure_models = Mock()
    service.ensure_started = Mock()
    service.notify = Mock(return_value={"id": "engine-1", "role": "user"})
    return service


def test_user_admission_starts_conductor_before_notify():
    service = _service_for_admission_test()
    order = []
    service.configure_models.side_effect = lambda **_kwargs: order.append("configure")
    service.ensure_started.side_effect = lambda: order.append("start")
    service.notify.side_effect = (
        lambda _event: order.append("notify") or {"id": "engine-1"}
    )

    with patch("server.services.conductor_service.bus.publish"):
        service.add_chat_message("hello", role="user")

    assert order == ["configure", "start", "notify"]


def test_add_chat_failure_is_propagated_without_starting_conductor():
    service = _service_for_admission_test()

    with patch(
        "server.services.conductor_service.add_chat",
        side_effect=RuntimeError("chat failed"),
    ), pytest.raises(RuntimeError, match="chat failed"):
        service.add_chat_message("hello", role="user")



def test_start_failure_is_propagated_before_notify():
    service = _service_for_admission_test()
    service.ensure_started.side_effect = RuntimeError("start failed")

    with patch("server.services.conductor_service.bus.publish"), pytest.raises(
        RuntimeError, match="start failed"
    ):
        service.add_chat_message("hello", role="user")

    service.notify.assert_not_called()


def test_notify_failure_is_propagated_after_start():
    service = _service_for_admission_test()
    service.notify.side_effect = RuntimeError("notify failed")

    with patch("server.services.conductor_service.bus.publish"), pytest.raises(
        RuntimeError, match="notify failed"
    ):
        service.add_chat_message("hello", role="user")

    service.ensure_started.assert_called_once_with()


def test_notify_false_raises_stopped_before_admission():
    service = _service_for_admission_test()
    service.notify.return_value = None

    with patch("server.services.conductor_service.bus.publish"), pytest.raises(
        RuntimeError, match="stopped before event admission"
    ):
        service.add_chat_message("hello", role="user")


def test_user_chat_adopts_engine_id_and_publishes_once():
    """D4: the engine id is the authoritative chat identity — the POST
    response and the live event must both carry it, exactly once."""
    service = _service_for_admission_test()
    service.notify = Mock(return_value={
        "id": "engine-9", "role": "user", "msg": "hello", "final": False,
    })
    published = []

    with patch("server.services.conductor_service.bus.publish",
               side_effect=lambda topic, payload: published.append((topic, payload))):
        item = service.add_chat_message("hello", role="user")

    assert item["id"] == "engine-9"
    chat_events = [payload for topic, payload in published
                   if topic == "conductor:chat"]
    assert chat_events == [{"item": item}]
    assert service.chat_messages[-1]["id"] == "engine-9"
