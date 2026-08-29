from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest

from server.services.conductor_service import ConductorService, HubConductorCallbacks
from server.services.conductor_workflow import WorkflowTracker


def test_final_report_without_a_dispatched_worker_does_not_complete():
    tracker = WorkflowTracker(clock=lambda: 10.0)
    tracker.admit("request-1")

    with pytest.raises(ValueError, match="before dispatching"):
        tracker.record_final("request-1", {"id": "final"})
    assert tracker.snapshot("request-1")["status"] == "admitted"


def test_workflow_completes_once_after_final_report_and_every_worker_acceptance():
    tracker = WorkflowTracker(clock=lambda: 10.0)
    tracker.admit("request-1")
    tracker.bind_subagent("request-1", "worker-1", 1)
    tracker.bind_subagent("request-1", "worker-2", 1)
    tracker.record_subagent_event("worker-1", "pending_review", generation=1)
    tracker.record_subagent_event("worker-2", "pending_review", generation=1)

    assert tracker.record_subagent_event(
        "worker-1", "accepted", generation=1
    )[1] is None

    owner, transition = tracker.record_subagent_event(
        "worker-2", "accepted", generation=1
    )
    assert owner == "request-1"
    assert transition is None

    transition = tracker.record_final("request-1", {"id": "final"})
    assert transition[0] == "conductor:workflow_completed"
    assert transition[1]["item"] == {"id": "final"}
    assert transition[1]["subagents"] == {
        "worker-1": {"generation": 1, "state": "accepted"},
        "worker-2": {"generation": 1, "state": "accepted"},
    }

    assert tracker.record_subagent_event(
        "worker-2", "accepted", generation=1
    )[1] is None


def test_stale_worker_generation_cannot_change_the_current_review_state():
    tracker = WorkflowTracker(clock=lambda: 10.0)
    tracker.admit("request-1")
    tracker.bind_subagent("request-1", "worker-1", 2)

    tracker.record_subagent_event("worker-1", "pending_review", generation=2)
    tracker.record_subagent_event("worker-1", "accepted", generation=1)

    worker = tracker.snapshot("request-1")["subagents"]["worker-1"]
    assert worker == {"generation": 2, "state": "pending"}


def test_same_generation_bind_does_not_reset_a_fast_completion():
    tracker = WorkflowTracker(clock=lambda: 10.0)
    tracker.admit("request-1")
    tracker.bind_subagent("request-1", "worker-1", 1)
    tracker.record_subagent_event("worker-1", "pending_review", generation=1)

    tracker.bind_subagent("request-1", "worker-1", 1)

    worker = tracker.snapshot("request-1")["subagents"]["worker-1"]
    assert worker == {"generation": 1, "state": "pending"}


def test_subagent_cannot_be_rebound_to_a_different_live_request_by_an_event():
    tracker = WorkflowTracker(clock=lambda: 10.0)
    tracker.admit("request-1")
    tracker.admit("request-2")
    tracker.bind_subagent("request-1", "worker-1", 1)

    with pytest.raises(ValueError, match="belongs to request request-1"):
        tracker.record_subagent_event(
            "worker-1",
            "accepted",
            generation=1,
            request_id="request-2",
        )


def test_accepted_worker_can_be_reused_after_its_previous_workflow_is_terminal():
    tracker = WorkflowTracker(clock=lambda: 10.0)
    tracker.admit("request-1")
    tracker.bind_subagent("request-1", "worker-1", 1)
    tracker.record_subagent_event("worker-1", "accepted", generation=1)
    tracker.record_final("request-1", {"id": "final-1"})
    tracker.admit("request-2")

    owner, transition = tracker.record_subagent_event(
        "worker-1",
        "started",
        generation=2,
        request_id="request-2",
    )

    assert owner == "request-2"
    assert transition is None
    assert tracker.request_for_subagent("worker-1") == "request-2"
    assert tracker.snapshot("request-2")["subagents"]["worker-1"] == {
        "generation": 2,
        "state": "running",
    }


def test_tracker_prunes_old_terminal_workflows_but_keeps_active_ones():
    now = iter([1.0, 2.0, 3.0, 4.0])
    tracker = WorkflowTracker(clock=lambda: next(now), max_workflows=2)
    tracker.admit("request-1")
    tracker.fail_supervisor("request-1", phase="dispatch", error="failed")
    tracker.admit("request-2")
    tracker.admit("request-3")

    assert tracker.snapshot("request-1") is None
    assert tracker.snapshot("request-2") is not None
    assert tracker.snapshot("request-3") is not None


def test_tracker_lists_recent_workflows_in_creation_order():
    now = iter([1.0, 2.0, 3.0])
    tracker = WorkflowTracker(clock=lambda: next(now))
    tracker.admit("request-1")
    tracker.admit("request-2")
    tracker.admit("request-3")

    assert [item["request_id"] for item in tracker.snapshots(limit=2)] == [
        "request-2",
        "request-3",
    ]


# ── recoverable worker failures (failure/timeout state consistency) ──────────

def test_failed_worker_keeps_the_workflow_recoverable():
    """The engine supports rework (a fresh attempt) after a dispatch
    failure; the tracker must not terminalize the workflow or the recovery
    is silently dropped."""
    tracker = WorkflowTracker(clock=lambda: 10.0)
    tracker.admit("request-1")
    tracker.bind_subagent("request-1", "worker-1", 1)

    owner, transition = tracker.record_subagent_event(
        "worker-1", "failed", generation=1, error="worker_start",
    )

    assert owner == "request-1"
    assert transition is not None and transition[0] == "conductor:worker_failed"
    snapshot = tracker.snapshot("request-1")
    assert snapshot["status"] == "failed"
    # Recoverable: no terminal marker yet, so clients can tell this apart
    # from a closed workflow.
    assert snapshot["terminal_event"] is None
    assert snapshot["subagents"]["worker-1"] == {
        "generation": 1, "state": "failed"}

    # Rework reopens the workflow and the final can still complete it.
    tracker.record_subagent_event("worker-1", "reworked", generation=2)
    tracker.record_subagent_event("worker-1", "pending_review", generation=2)
    tracker.record_subagent_event("worker-1", "accepted", generation=2)
    completed = tracker.record_final("request-1", {"id": "final"})
    assert completed[0] == "conductor:workflow_completed"


def test_failed_worker_lets_a_replacement_dispatch_bind():
    tracker = WorkflowTracker(clock=lambda: 10.0)
    tracker.admit("request-1")
    tracker.bind_subagent("request-1", "worker-1", 1)
    tracker.record_subagent_event("worker-1", "failed", generation=1)

    # bind_subagent would raise on a terminal workflow; a recoverable
    # failure must accept the replacement worker.
    transition = tracker.bind_subagent("request-1", "worker-2", 1)
    assert transition is None
    assert tracker.snapshot("request-1")["subagents"]["worker-2"] == {
        "generation": 1, "state": "running"}


def test_timeout_worker_keeps_the_workflow_awaiting_review():
    tracker = WorkflowTracker(clock=lambda: 10.0)
    tracker.admit("request-1")
    tracker.bind_subagent("request-1", "worker-1", 1)
    tracker.record_subagent_event("worker-1", "pending_review", generation=1)

    owner, transition = tracker.record_subagent_event(
        "worker-1", "timeout_total", generation=1)

    assert owner == "request-1"
    assert transition is None
    snapshot = tracker.snapshot("request-1")
    assert snapshot["status"] == "awaiting_review"
    assert snapshot["subagents"]["worker-1"] == {
        "generation": 1, "state": "timeout"}


def test_rejected_worker_closes_only_itself_and_final_needs_an_accepted_sibling():
    tracker = WorkflowTracker(clock=lambda: 10.0)
    tracker.admit("request-1")
    tracker.bind_subagent("request-1", "worker-1", 1)
    tracker.record_subagent_event("worker-1", "pending_review", generation=1)

    owner, transition = tracker.record_subagent_event(
        "worker-1", "rejected", generation=1)

    assert owner == "request-1" and transition is None
    assert tracker.snapshot("request-1")["subagents"]["worker-1"] == {
        "generation": 1, "state": "rejected"}

    # A rejected-only workflow cannot finalize: nothing was delivered.
    with pytest.raises(ValueError, match="at least one accepted subagent"):
        tracker.record_final("request-1", {"id": "final"})

    # A fresh accepted worker satisfies delivery; the rejected worker no
    # longer blocks the final.
    tracker.bind_subagent("request-1", "worker-2", 1)
    tracker.record_subagent_event("worker-2", "pending_review", generation=1)
    tracker.record_subagent_event("worker-2", "accepted", generation=1)
    completed = tracker.record_final("request-1", {"id": "final"})
    assert completed[0] == "conductor:workflow_completed"
    assert completed[1]["subagents"]["worker-1"] == {
        "generation": 1, "state": "rejected"}


def test_terminal_workflow_does_not_adopt_new_workers_through_events():
    tracker = WorkflowTracker(clock=lambda: 10.0)
    tracker.admit("request-1")
    tracker.fail_supervisor("request-1", phase="dispatch", error="boom")

    owner, transition = tracker.record_subagent_event(
        "worker-1", "started", generation=1, request_id="request-1")

    assert owner == "request-1" and transition is None
    assert tracker.request_for_subagent("worker-1") is None
    assert tracker.snapshot("request-1")["subagents"] == {}


def test_cancelled_and_killed_workers_still_terminalize_the_workflow():
    for event in ("cancelled", "killed"):
        tracker = WorkflowTracker(clock=lambda: 10.0)
        tracker.admit("request-1")
        tracker.bind_subagent("request-1", "worker-1", 1)

        owner, transition = tracker.record_subagent_event(
            "worker-1", event, generation=1)

        assert owner == "request-1"
        assert transition[0] == "conductor:workflow_failed"
        snapshot = tracker.snapshot("request-1")
        assert snapshot["status"] == event
        # The terminal marker is what lets clients distinguish a closed
        # workflow from a recoverable worker failure.
        assert snapshot["terminal_event"] == "workflow_failed"
        # Deliberate cancellation / reaping really is terminal: replacement
        # workers can no longer bind.
        with pytest.raises(ValueError, match="already terminal"):
            tracker.bind_subagent("request-1", "worker-2", 1)


def test_terminal_workflow_transition_publishes_completion():
    service = object.__new__(ConductorService)
    service.chat_messages = []

    payload = {
        "request_id": "request-1",
        "status": "completed",
        "item": {"id": "final", "msg": "done"},
    }
    with patch("server.services.conductor_service.bus.publish") as publish:
        service._publish_workflow_transition(
            ("conductor:workflow_completed", payload)
        )

    publish.assert_called_once_with("conductor:workflow_completed", payload)


def test_service_rejects_a_final_report_before_acceptance_without_persisting_it():
    service = object.__new__(ConductorService)
    service.chat_messages = []
    service.workflow_tracker = WorkflowTracker(clock=lambda: 10.0)
    service.workflow_tracker.admit("request-1")
    service.workflow_tracker.bind_subagent("request-1", "worker-1", 1)

    with pytest.raises(ValueError, match="before every subagent is accepted"):
        service.add_chat_message(
            "premature delivery",
            role="conductor",
            request_id="request-1",
            kind="final",
        )

    assert service.chat_messages == []


def test_service_final_report_publishes_the_single_workflow_completion():
    service = object.__new__(ConductorService)
    service.chat_messages = []
    service.workflow_tracker = WorkflowTracker(clock=lambda: 10.0)
    service.workflow_tracker.admit("request-1")
    service.workflow_tracker.bind_subagent("request-1", "worker-1", 1)
    service.workflow_tracker.record_subagent_event(
        "worker-1", "accepted", generation=1
    )

    with patch("server.services.conductor_service.bus.publish") as publish:
        item = service.add_chat_message(
            "verified delivery",
            role="conductor",
            request_id="request-1",
            kind="final",
        )

    assert item["kind"] == "final"
    topics = [call.args[0] for call in publish.call_args_list]
    assert topics == ["conductor:chat", "conductor:workflow_completed"]


def test_generic_conductor_error_is_persisted_once_as_chat():
    service = object.__new__(ConductorService)
    service.chat_messages = []
    service.pool = SimpleNamespace(snapshot=lambda: [])
    callbacks = HubConductorCallbacks(service)

    with patch("server.services.conductor_service.bus.publish") as publish:
        callbacks.on_conductor_event("error", {"error": "stream closed"})
        callbacks.on_conductor_event("error", {"error": "stream closed"})

    assert len(service.chat_messages) == 1
    item = service.chat_messages[0]
    assert item["role"] == "error"
    assert item["kind"] == "error"
    assert "stream closed" in item["msg"]
    assert [call.args[0] for call in publish.call_args_list].count(
        "conductor:chat"
    ) == 1
    assert [call.args[0] for call in publish.call_args_list].count(
        "conductor:error"
    ) == 2


def test_hub_snapshot_exposes_the_core_active_generation():
    # gahub_app enriches its SSE snapshots with generation/request_id; the
    # hub mirror passes them straight through.
    service = object.__new__(ConductorService)
    service.pool = SimpleNamespace(
        snapshot=lambda: [{"id": "worker-1", "status": "stopped",
                           "generation": 3, "request_id": "request-1"}],
    )

    assert service.get_subagent_snapshot() == [{
        "id": "worker-1",
        "status": "stopped",
        "generation": 3,
        "request_id": "request-1",
    }]
