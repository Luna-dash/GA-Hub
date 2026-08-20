from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest

from server.services.conductor_service import ConductorService, HubConductorCallbacks
from server.services.conductor_workflow import WorkflowTracker
from server.services.request_usage import RequestUsageStore


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


def test_terminal_workflow_transition_completes_usage_before_publication():
    service = object.__new__(ConductorService)
    service.chat_messages = []
    service.usage_store = RequestUsageStore(clock=lambda: 10.0)
    service.usage_store.begin("request-1")

    payload = {
        "request_id": "request-1",
        "status": "completed",
        "item": {"id": "final", "msg": "done"},
    }
    with patch("server.services.conductor_service.bus.publish") as publish:
        service._publish_workflow_transition(
            ("conductor:workflow_completed", payload)
        )

    row = service.usage_store.list()[0]
    assert row["attribution"] == "OK"
    assert row["completed_at"] == 10.0
    publish.assert_called_once_with("conductor:workflow_completed", payload)


def test_service_rejects_a_final_report_before_acceptance_without_persisting_it():
    service = object.__new__(ConductorService)
    service.chat_messages = []
    service.usage_store = RequestUsageStore(clock=lambda: 10.0)
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
    service.usage_store = RequestUsageStore(clock=lambda: 10.0)
    service.usage_store.begin("request-1")
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
    row = service.usage_store.list()[0]
    assert row["attribution"] == "OK"


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


def test_monitor_completion_wake_inherits_the_bound_request(monkeypatch):
    service = SimpleNamespace(
        workflow_tracker=SimpleNamespace(
            request_for_subagent=Mock(return_value="request-1")
        ),
        notify=Mock(return_value=True),
    )
    monkeypatch.setattr(
        ConductorService,
        "instance",
        classmethod(lambda _cls: service),
    )

    # The detailed queue bridge is covered elsewhere; this assertion protects
    # the workflow attribution field that the GA core does not add itself.
    from server.services.conductor_service import monitor_display_queue
    import queue

    display_queue = queue.Queue()
    display_queue.put({"done": "finished"})
    pool = SimpleNamespace(on_display=Mock(return_value=True))
    with patch("server.services.conductor_service.OutputBudget") as budget_cls:
        budget_cls.return_value.finish.return_value = "finished"
        monitor_display_queue(
            "worker-1",
            display_queue,
            pool,
            True,
            generation=3,
        )

    service.notify.assert_called_once_with({
        "type": "subagent_done",
        "id": "worker-1",
        "reply": "finished",
        "generation": 3,
        "request_id": "request-1",
    })


def test_hub_snapshot_exposes_the_core_active_generation():
    service = object.__new__(ConductorService)
    service.workflow_tracker = WorkflowTracker()
    service.workflow_tracker.admit("request-1")
    service.workflow_tracker.bind_subagent("request-1", "worker-1", 3)
    service.pool = SimpleNamespace(
        snapshot=lambda: [{"id": "worker-1", "status": "stopped"}],
        get=lambda _sid: SimpleNamespace(active_generation=3),
    )

    assert service.get_subagent_snapshot() == [{
        "id": "worker-1",
        "status": "stopped",
        "generation": 3,
        "request_id": "request-1",
    }]
