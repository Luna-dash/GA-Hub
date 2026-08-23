"""Request-level usage lifecycle tests for the Conductor service."""
from __future__ import annotations

import queue
from types import SimpleNamespace
from unittest.mock import call, patch

import pytest

from types import SimpleNamespace

from server.services.conductor_service import (
    ConductorService,
    HubConductorCallbacks,
)


def RequestOutcome(**kw):
    return SimpleNamespace(status=kw.get("status"), phase=kw.get("phase"),
                           error=kw.get("error", ""))

from server.services.request_usage import RequestUsageStore


def test_conductor_turn_lifecycle_activates_records_without_completing_workflow():
    service = object.__new__(ConductorService)
    service.usage_store = RequestUsageStore(clock=lambda: 10.0)
    request_id = service.usage_store.begin("rid-1")
    callbacks = HubConductorCallbacks(service)

    token = callbacks.on_conductor_request_started(request_id)
    service.usage_store.record({"input_tokens": 7, "output_tokens": 3}, "messages")
    with patch("server.services.conductor_service.bus.publish"):
        callbacks.on_conductor_request_finished(request_id, token)

    row = service.usage_store.list()[0]
    assert row["request_id"] == request_id
    assert row["requests"] == 1
    assert row["input"] == 7
    assert row["output"] == 3
    assert row["attribution"] == "PENDING"
    assert row["completed_at"] is None


def test_cooperative_yield_publishes_a_nonterminal_turn_outcome():
    service = object.__new__(ConductorService)
    service.chat_messages = []
    service.usage_store = RequestUsageStore(clock=lambda: 10.0)
    request_id = service.usage_store.begin("rid-yield")
    callbacks = HubConductorCallbacks(service)
    token = callbacks.on_conductor_request_started(request_id)

    with patch("server.services.conductor_service.bus.publish") as publish:
        callbacks.on_conductor_request_yielded(
            request_id,
            token,
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
    row = service.usage_store.list()[0]
    assert row["attribution"] == "PENDING"
    assert row["completed_at"] is None


def test_conductor_success_outcome_publishes_turn_event_without_completion_item():
    service = object.__new__(ConductorService)
    service.chat_messages = [
        {"id": "plan", "role": "conductor", "msg": "dispatching"},
        {"id": "user", "role": "user", "msg": "question"},
        {"id": "result", "role": "conductor", "msg": "finished result"},
    ]
    service.usage_store = RequestUsageStore(clock=lambda: 10.0)
    request_id = service.usage_store.begin("rid-complete")
    callbacks = HubConductorCallbacks(service)
    token = callbacks.on_conductor_request_started(request_id)

    with patch("server.services.conductor_service.bus.publish") as publish:
        callbacks.on_conductor_request_outcome(
            request_id,
            token,
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
    row = service.usage_store.list()[0]
    assert row["attribution"] == "PENDING"
    assert row["completed_at"] is None


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


@pytest.mark.parametrize(
    ("api_mode", "usage", "expected"),
    [
        (
            "messages",
            {"input_tokens": 9, "output_tokens": 1},
            {"input": 9, "output": 1, "cache_create": 0, "cache_read": 0},
        ),
        (
            "chat_completions",
            {
                "prompt_tokens": 20,
                "completion_tokens": 17,
                "prompt_tokens_details": {"cached_tokens": 6},
            },
            {"input": 14, "output": 17, "cache_create": 0, "cache_read": 6},
        ),
        (
            "responses",
            {
                "input_tokens": 30,
                "output_tokens": 23,
                "input_tokens_details": {"cached_tokens": 8},
            },
            {"input": 22, "output": 23, "cache_create": 0, "cache_read": 8},
        ),
        (
            "responses",
            {
                "input_tokens": 2,
                "output_tokens": 0,
                "input_tokens_details": {"cached_tokens": 9},
            },
            {"input": 0, "output": 0, "cache_create": 0, "cache_read": 2},
        ),
    ],
)
def test_usage_modes_are_normalized_and_zero_output_counts_request(
    api_mode, usage, expected
):
    store = RequestUsageStore(clock=lambda: 10.0)
    request_id = store.begin("rid-mode")

    store.record(usage, api_mode, request_id)

    row = store.list()[0]
    assert row["requests"] == 1
    for key, value in expected.items():
        assert row[key] == value


def test_unknown_usage_mode_does_not_increment_request_count():
    store = RequestUsageStore(clock=lambda: 10.0)
    request_id = store.begin("rid-unknown")

    store.record({"input_tokens": 10}, "unknown", request_id)

    assert store.list()[0]["requests"] == 0


def test_usage_normalization_tolerates_non_mapping_details():
    store = RequestUsageStore(clock=lambda: 10.0)
    request_id = store.begin("rid-details")

    store.record(
        {
            "prompt_tokens": 4,
            "completion_tokens": 2,
            "prompt_tokens_details": "invalid",
        },
        "chat_completions",
        request_id,
    )

    row = store.list()[0]
    assert row["requests"] == 1
    assert row["input"] == 4
    assert row["output"] == 2
    assert row["cache_read"] == 0


def test_request_finish_deactivates_context_without_completing_usage():
    class TrackingStore:
        def __init__(self):
            self.deactivated = []
            self.completed = []

        def complete(self, request_id, attribution="OK"):
            self.completed.append((request_id, attribution))

        def deactivate(self, token):
            self.deactivated.append(token)

    service = object.__new__(ConductorService)
    service.usage_store = TrackingStore()
    callbacks = HubConductorCallbacks(service)

    callbacks.on_conductor_request_finished("rid-1", "token-1")

    assert service.usage_store.deactivated == ["token-1"]
    assert service.usage_store.completed == []


@pytest.mark.parametrize("phase", ["prompt", "dispatch", "drain"])
def test_failed_request_outcome_is_not_attributed_as_ok(phase):
    service = object.__new__(ConductorService)
    service.usage_store = RequestUsageStore(clock=lambda: 10.0)
    request_id = service.usage_store.begin(f"rid-{phase}")
    callbacks = HubConductorCallbacks(service)
    token = callbacks.on_conductor_request_started(request_id)

    callbacks.on_conductor_request_outcome(
        request_id,
        token,
        RequestOutcome(status="failed", phase=phase, error=f"{phase} failed"),
    )

    row = service.usage_store.list()[0]
    assert row["attribution"] == f"FAILED_{phase.upper()}"
    assert row["completed_at"] == 10.0


def test_interleaved_request_contexts_do_not_cross_attribute_usage():
    service = object.__new__(ConductorService)
    service.usage_store = RequestUsageStore(clock=lambda: 10.0)
    callbacks = HubConductorCallbacks(service)
    rid1 = service.usage_store.begin("rid-1")
    rid2 = service.usage_store.begin("rid-2")

    token1 = callbacks.on_conductor_request_started(rid1)
    service.usage_store.record({"input_tokens": 3, "output_tokens": 1}, "messages")
    token2 = callbacks.on_conductor_request_started(rid2)
    service.usage_store.record({"input_tokens": 5, "output_tokens": 2}, "messages")
    callbacks.on_conductor_request_outcome(
        rid2, token2, RequestOutcome(status="ok", phase="finish")
    )
    service.usage_store.record({"input_tokens": 7, "output_tokens": 4}, "messages")
    callbacks.on_conductor_request_outcome(
        rid1, token1, RequestOutcome(status="ok", phase="finish")
    )

    rows = {row["request_id"]: row for row in service.usage_store.list()}
    assert rows[rid1]["requests"] == 2
    assert rows[rid1]["output"] == 5
    assert rows[rid2]["requests"] == 1
    assert rows[rid2]["output"] == 2



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
