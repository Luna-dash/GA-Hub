"""Conductor request-event lifecycle tests."""
from __future__ import annotations

import queue
from types import SimpleNamespace
from unittest.mock import call, patch

import pytest

from server.services.conductor_service import (
    ConductorService,
    HubConductorCallbacks,
)


def RequestOutcome(**kw):
    return SimpleNamespace(
        status=kw.get("status"), phase=kw.get("phase"), error=kw.get("error", "")
    )


def test_cooperative_yield_publishes_a_nonterminal_turn_outcome():
    service = object.__new__(ConductorService)
    service.chat_messages = []
    request_id = "rid-yield"
    callbacks = HubConductorCallbacks(service)

    with patch("server.services.conductor_service.bus.publish") as publish:
        callbacks.on_conductor_request_yielded(
            request_id,
            RequestOutcome(status="yielded", phase="yield"),
        )

    publish.assert_called_once_with(
        "conductor:request_outcome",
        {
            "request_id": request_id,
            "status": "yielded",
            "phase": "yield",
        },
    )


def test_conductor_success_outcome_publishes_turn_event_without_completion_item():
    service = object.__new__(ConductorService)
    service.chat_messages = [
        {"id": "plan", "role": "conductor", "msg": "dispatching"},
        {"id": "user", "role": "user", "msg": "question"},
        {"id": "result", "role": "conductor", "msg": "finished result"},
    ]
    request_id = "rid-complete"
    callbacks = HubConductorCallbacks(service)

    with patch("server.services.conductor_service.bus.publish") as publish:
        callbacks.on_conductor_request_outcome(
            request_id,
            RequestOutcome(status="ok", phase="finish"),
        )

    publish.assert_called_once_with(
        "conductor:request_outcome",
        {
            "request_id": request_id,
            "status": "ok",
            "phase": "finish",
        },
    )


def test_subagent_stream_publishes_one_snapshot_without_per_chunk_metadata():
    service = object.__new__(ConductorService)
    service.pool = SimpleNamespace(snapshot=lambda: [])
    callbacks = HubConductorCallbacks(service)

    with patch("server.services.conductor_service.push_subagent_cards") as snapshot:
        with patch("server.services.conductor_service.bus.publish") as publish:
            callbacks.on_subagent_output("sid", "partial", False)
            callbacks.on_subagent_event(
                "sid", "running", {"output_len": 7}
            )

    snapshot.assert_called_once()
    publish.assert_not_called()


@pytest.mark.parametrize(
    "event",
    [
        "spawned",
        "completed",
        "reworked",
        "accepted",
        "cancelled",
        "failed",
        "killed",
    ],
)
def test_subagent_state_transitions_publish_authoritative_snapshot(event):
    items = [{"id": "sid", "status": "stopped"}]
    service = object.__new__(ConductorService)
    service.pool = SimpleNamespace(snapshot=lambda: items)
    callbacks = HubConductorCallbacks(service)

    with patch("server.services.conductor_service.push_subagent_cards") as snapshot:
        with patch("server.services.conductor_service.bus.publish") as publish:
            callbacks.on_subagent_event("sid", event, {"generation": 1})

    publish.assert_called_once_with(
        f"conductor:subagent_{event}",
        {"id": "sid", "generation": 1},
    )
    snapshot.assert_called_once_with(items)


@pytest.mark.parametrize(
    ("first", "second"),
    [
        ("spawned", "started"),
        ("completed", "pending_review"),
    ],
)
def test_identical_subagent_transitions_keep_typed_events_without_second_snapshot(
    first, second
):
    service = object.__new__(ConductorService)
    service.pool = SimpleNamespace(snapshot=lambda: [])
    callbacks = HubConductorCallbacks(service)

    with patch("server.services.conductor_service.push_subagent_cards") as snapshot:
        with patch("server.services.conductor_service.bus.publish") as publish:
            callbacks.on_subagent_event("sid", first, {})
            callbacks.on_subagent_event("sid", second, {})

    assert publish.call_args_list == [
        call(f"conductor:subagent_{first}", {"id": "sid"}),
        call(f"conductor:subagent_{second}", {"id": "sid"}),
    ]
    snapshot.assert_called_once_with([])


def test_completed_output_defers_to_single_completed_snapshot():
    items = [{"id": "sid", "status": "stopped", "review_status": "pending"}]
    service = object.__new__(ConductorService)
    service.pool = SimpleNamespace(snapshot=lambda: items)
    callbacks = HubConductorCallbacks(service)

    with patch("server.services.conductor_service.push_subagent_cards") as snapshot:
        with patch("server.services.conductor_service.bus.publish"):
            callbacks.on_subagent_output("sid", "done", True)
            callbacks.on_subagent_event("sid", "completed", {})
            callbacks.on_subagent_event("sid", "pending_review", {})

    snapshot.assert_called_once_with(items)


def test_conductor_log_frame_publishes_valid_item_only():
    service = object.__new__(ConductorService)
    callbacks = HubConductorCallbacks(service)
    item = {
        "id": "log-1",
        "ts": 123,
        "event": "user_msg",
        "turn": 2,
        "text": "Unicode 日志",
    }

    with patch("server.services.conductor_service.bus.publish") as publish:
        callbacks.on_conductor_log_frame({"type": "log", "item": item})
        callbacks.on_conductor_log_frame({"type": "other", "item": item})
        callbacks.on_conductor_log_frame({"type": "log", "item": {"id": 1}})

    publish.assert_called_once_with("conductor:log", {"item": item})


def test_conductor_log_publish_failure_is_observer_only():
    service = object.__new__(ConductorService)
    callbacks = HubConductorCallbacks(service)
    frame = {
        "type": "log",
        "item": {
            "id": "log-1",
            "ts": 123,
            "event": "wake",
            "turn": None,
            "text": "done",
        },
    }

    with patch(
        "server.services.conductor_service.bus.publish",
        side_effect=RuntimeError("closed loop"),
    ):
        callbacks.on_conductor_log_frame(frame)


def test_subagent_snapshot_publish_failure_is_retried():
    items = [{"id": "sid", "status": "running"}]
    service = object.__new__(ConductorService)
    service.pool = SimpleNamespace(snapshot=lambda: items)
    callbacks = HubConductorCallbacks(service)

    with patch(
        "server.services.conductor_service.push_subagent_cards",
        side_effect=[RuntimeError("temporary"), None],
    ) as publish:
        callbacks.publish_subagent_snapshot()
        callbacks.publish_subagent_snapshot()

    assert publish.call_count == 2


def test_subagent_lifecycle_publish_failure_still_attempts_snapshot():
    items = [{"id": "sid", "status": "stopped"}]
    service = object.__new__(ConductorService)
    service.pool = SimpleNamespace(snapshot=lambda: items)
    callbacks = HubConductorCallbacks(service)

    with patch(
        "server.services.conductor_service.bus.publish",
        side_effect=RuntimeError("temporary"),
    ):
        with patch(
            "server.services.conductor_service.push_subagent_cards"
        ) as snapshot:
            callbacks.on_subagent_event("sid", "cancelled", {})

    snapshot.assert_called_once_with(items)










@pytest.mark.parametrize("phase", ["prompt", "dispatch", "drain"])
def test_failed_request_outcome_publishes_failure_event(phase):
    service = object.__new__(ConductorService)
    request_id = f"rid-{phase}"
    callbacks = HubConductorCallbacks(service)

    with patch("server.services.conductor_service.bus.publish") as publish:
        callbacks.on_conductor_request_outcome(
            request_id,
            RequestOutcome(status="failed", phase=phase, error=f"{phase} failed"),
        )

    publish.assert_called_once_with(
        "conductor:request_outcome",
        {
            "request_id": request_id,
            "status": "failed",
            "phase": phase,
            "error": f"{phase} failed",
        },
    )





def test_relayed_user_chat_is_not_duplicated_by_the_sse_echo():
    from unittest.mock import Mock
    from server.services.conductor_service import HubConductorCallbacks

    service = object.__new__(ConductorService)
    service.chat_messages = []
    service.client = Mock()
    service.client.post_chat.return_value = {"id": "ga-echo-1", "role": "user",
                                             "msg": "hello", "final": False}

    assert service.notify({"type": "user_message", "msg": "hello",
                           "request_id": "r1"}) is True
    assert len(service.chat_messages) == 0          # notify itself stores nothing
    assert "ga-echo-1" in service._relayed_chat_ids

    callbacks = HubConductorCallbacks(service)
    with patch("server.services.conductor_service.bus.publish"):
        service._on_remote_chat({"id": "ga-echo-1", "role": "user",
                                 "msg": "hello", "final": False})
    assert service.chat_messages == []              # SSE echo recognized and skipped

    with patch("server.services.conductor_service.bus.publish"):
        service._on_remote_chat({"id": "ga-new-1", "role": "conductor",
                                 "msg": "plan", "final": False})
    assert [m["msg"] for m in service.chat_messages] == ["plan"]  # remote passes through


def test_live_user_echo_is_skipped_even_before_the_id_is_recorded():
    # The engine broadcasts the SSE echo before post_chat returns; a user
    # echo arriving ahead of the id bookkeeping must still not duplicate.
    service = object.__new__(ConductorService)
    service.chat_messages = []
    service._relayed_chat_ids = set()
    with patch("server.services.conductor_service.bus.publish"):
        service._on_remote_chat({"id": "ga-racy-1", "role": "user",
                                 "msg": "racy", "final": False})
    assert service.chat_messages == []
    # hello (restart history restore) still admits user entries
    with patch("server.services.conductor_service.bus.publish"):
        service._on_remote_chat({"id": "ga-old-1", "role": "user",
                                 "msg": "history", "final": False},
                                from_hello=True)
    assert [m["msg"] for m in service.chat_messages] == ["history"]
