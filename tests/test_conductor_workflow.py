from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest

from server.services.conductor_service import ConductorService, HubConductorCallbacks
from server.services.conductor_workflow import WorkflowTracker


def test_final_report_without_a_dispatched_worker_completes_the_workflow():
    """Workerless finals close housekeeping/acknowledgement requests.

    The old contract refused any final before a dispatch, stranding requests
    that legitimately need no execution in "admitted" forever (live E2E
    2026-08-30).  The engine boundary only admits such a final for a request
    it actually saw, so the tracker completes it on the supervisor's word.
    """
    tracker = WorkflowTracker(clock=lambda: 10.0)
    tracker.admit("request-1")

    result = tracker.record_final("request-1", {"id": "final"})
    assert result is not None
    assert result[0] == "conductor:workflow_completed"
    snapshot = tracker.snapshot("request-1")
    assert snapshot["status"] == "completed"
    assert snapshot["terminal_event"] == "workflow_completed"

    # A final for a request the tracker never admitted is still an error.
    with pytest.raises(ValueError, match="unknown conductor request_id"):
        tracker.record_final("no-such-request", {"id": "final"})


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


def test_tracker_is_open_distinguishes_active_recoverable_and_terminal():
    """Recoverable worker failures stay open: a user follow-up must still be
    able to wake the supervisor for a rework or a fresh dispatch."""
    tracker = WorkflowTracker(clock=lambda: 10.0)
    tracker.admit("request-open")
    tracker.admit("request-recovering")
    tracker.admit("request-closed")

    tracker.fail_supervisor("request-closed", phase="dispatch", error="boom")
    # Worker failure without a terminal event = recoverable, not closed.
    tracker.bind_subagent("request-recovering", "worker-1", 1)
    tracker.record_subagent_event("worker-1", "failed", generation=1)

    assert tracker.is_open("request-open") is True
    assert tracker.is_open("request-recovering") is True
    assert tracker.is_open("request-closed") is False
    assert tracker.is_open("never-admitted") is False


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
    service = ConductorService.for_tests()
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
    service = ConductorService.for_tests()
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
    service = ConductorService.for_tests()
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
    service = ConductorService.for_tests()
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
    service = ConductorService.for_tests()
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


def test_five_concurrent_workers_finalize_single_workflow():
    """Five workers fanned out on one request all close before the final.

    Live round 4 (mini-convert, 2026-08-31): exactly 5 concurrent single-file
    workers; the workflow must only complete after the fifth acceptance and
    one final, with every worker visible in the terminal snapshot.
    """
    tracker = WorkflowTracker(clock=lambda: 10.0)
    tracker.admit("request-1")
    workers = [f"w{i}" for i in range(5)]
    for worker in workers:
        tracker.bind_subagent("request-1", worker, 1)
        tracker.record_subagent_event(worker, "pending_review", generation=1)

    assert tracker.snapshot("request-1")["status"] == "awaiting_review"

    for worker in workers[:-1]:
        owner, transition = tracker.record_subagent_event(
            worker, "accepted", generation=1)
        assert owner == "request-1"
        assert transition is None  # nothing to complete until the last accept

    owner, transition = tracker.record_subagent_event(
        workers[-1], "accepted", generation=1)
    assert owner == "request-1"
    assert transition is None  # accepted alone does not complete: final due

    result = tracker.record_final("request-1", {"id": "final"})
    assert result is not None
    assert result[0] == "conductor:workflow_completed"
    snapshot = tracker.snapshot("request-1")
    assert snapshot["status"] == "completed"
    assert set(snapshot["subagents"]) == set(workers)
    assert all(state["state"] == "accepted"
               for state in snapshot["subagents"].values())


# ── stranded admitted recovery (resume semantics) ────────────────────────────

def test_stranded_admitted_lists_only_workerless_nonterminal():
    tracker = WorkflowTracker(clock=lambda: 10.0)
    tracker.admit("rid-strand")
    # supervising: has a worker → not stranded
    tracker.admit("rid-busy")
    tracker.bind_subagent("rid-busy", "worker-1", 1)
    # terminal → not stranded
    tracker.admit("rid-closed")
    tracker.fail_supervisor("rid-closed", phase="drain", error="stopped")

    stranded = tracker.stranded_admitted()
    assert [wf["request_id"] for wf in stranded] == ["rid-strand"]
    assert stranded[0]["status"] == "admitted"
    assert stranded[0]["subagents"] == {}


def test_stranded_admitted_keeps_newest_within_limit():
    tracker = WorkflowTracker(clock=lambda: 10.0)
    for i in range(7):
        tracker.admit(f"rid-{i}")
        tracker._workflows[f"rid-{i}"].created_at = float(i)

    stranded = tracker.stranded_admitted(limit=3)
    assert [wf["request_id"] for wf in stranded] == ["rid-4", "rid-5", "rid-6"]


def test_redispatch_re_relays_stranded_admitted_only():
    service = ConductorService.for_tests()
    tracker = WorkflowTracker(clock=lambda: 10.0)
    tracker.admit("rid-strand")
    tracker.admit("rid-busy")
    tracker.bind_subagent("rid-busy", "worker-1", 1)
    service.workflow_tracker = tracker
    service.chat_messages = [
        {"id": "c1", "role": "user", "msg": "做鹈鹕任务", "request_id": "rid-strand"},
        {"id": "c2", "role": "user", "msg": "另一个", "request_id": "rid-busy"},
    ]
    service.client = Mock()
    service.client.get_chat.return_value = []
    service.client.post_chat.return_value = {"id": "engine-1"}

    service._redispatch_stranded_workflows()

    # P0 idempotency: the redispatch mints a fresh operation id for the
    # re-delivery (the original admission died with the cold engine).
    service.client.post_chat.assert_called_once()
    args, kwargs = service.client.post_chat.call_args
    assert args == ("做鹈鹕任务", "user", "rid-strand")
    assert kwargs.get("operation_id")


def test_redispatch_ignores_terminal_and_untraceable_requests():
    service = ConductorService.for_tests()
    tracker = WorkflowTracker(clock=lambda: 10.0)
    tracker.admit("rid-strand")
    tracker.admit("rid-lost")  # no chat message anywhere
    tracker.fail_supervisor("rid-closed", phase="drain", error="stopped")
    service.workflow_tracker = tracker
    service.chat_messages = [
        {"id": "c1", "role": "user", "msg": "任务", "request_id": "rid-strand"},
    ]
    service.client = Mock()
    service.client.get_chat.return_value = []
    service.client.post_chat.return_value = {"id": "engine-1"}

    service._redispatch_stranded_workflows()

    service.client.post_chat.assert_called_once()
    args, kwargs = service.client.post_chat.call_args
    assert args == ("任务", "user", "rid-strand")
    assert kwargs.get("operation_id")


def test_redispatch_failure_does_not_raise():
    service = ConductorService.for_tests()
    tracker = WorkflowTracker(clock=lambda: 10.0)
    tracker.admit("rid-strand")
    service.workflow_tracker = tracker
    service.chat_messages = [
        {"id": "c1", "role": "user", "msg": "任务", "request_id": "rid-strand"},
    ]
    service.client = Mock()
    service.client.get_chat.return_value = []
    service.client.post_chat.side_effect = RuntimeError("engine down")

    service._redispatch_stranded_workflows()  # must not raise


def test_redispatch_excludes_the_just_admitted_request():
    """The just-admitted request looks stranded (no workers yet) but the
    caller is about to notify the engine for it — re-relaying here duplicated
    the user message (live 2026-09-01 regression)."""
    service = ConductorService.for_tests()
    tracker = WorkflowTracker(clock=lambda: 10.0)
    tracker.admit("rid-new")
    tracker.admit("rid-old")
    service.workflow_tracker = tracker
    service.chat_messages = [
        {"id": "c1", "role": "user", "msg": "新消息", "request_id": "rid-new"},
        {"id": "c2", "role": "user", "msg": "旧消息", "request_id": "rid-old"},
    ]
    service.client = Mock()
    service.client.get_chat.return_value = []
    service.client.post_chat.return_value = {"id": "engine-1"}

    service._redispatch_stranded_workflows(exclude_request_id="rid-new")

    service.client.post_chat.assert_called_once()
    args, kwargs = service.client.post_chat.call_args
    assert args == ("旧消息", "user", "rid-old")
    assert kwargs.get("operation_id")


def test_redispatch_empty_history_falls_back_to_engine_chat():
    service = ConductorService.for_tests()
    tracker = WorkflowTracker(clock=lambda: 10.0)
    tracker.admit("rid-strand")
    service.workflow_tracker = tracker
    service.chat_messages = []
    service.client = Mock()
    service.client.get_chat.return_value = [
        {"id": "e9", "role": "user", "msg": "引擎侧原文", "request_id": "rid-strand"},
    ]
    service.client.post_chat.return_value = {"id": "engine-1"}

    service._redispatch_stranded_workflows()

    service.client.post_chat.assert_called_once()
    args, kwargs = service.client.post_chat.call_args
    assert args == ("引擎侧原文", "user", "rid-strand")
    assert kwargs.get("operation_id")


# ===== resume_workflow: per-task relay, the explicit 恢复此任务 =====


def _resume_service(service=None):
    """Shared harness: two stranded workflows plus one with a worker, so a
    per-task resume can prove it relays exactly one original message and
    leaves the other open workflows untouched."""
    service = service or ConductorService.for_tests()
    tracker = WorkflowTracker(clock=lambda: 10.0)
    tracker.admit("rid-a")
    tracker.admit("rid-b")
    tracker.admit("rid-busy")
    tracker.bind_subagent("rid-busy", "worker-1", 1)
    service.workflow_tracker = tracker
    service.chat_messages = [
        {"id": "c1", "role": "user", "msg": "任务A", "request_id": "rid-a"},
        {"id": "c2", "role": "user", "msg": "任务B", "request_id": "rid-b"},
    ]
    service.client = Mock()
    service.client.get_chat.return_value = []
    service.client.post_chat.return_value = {"id": "engine-1"}
    service.ensure_started = Mock(return_value=True)
    return service


def test_resume_workflow_relays_only_the_named_request():
    service = _resume_service()

    assert service.resume_workflow("rid-a") is True

    service.ensure_started.assert_called_once_with(redispatch_stranded=False)
    service.client.post_chat.assert_called_once()
    args, kwargs = service.client.post_chat.call_args
    assert args == ("任务A", "user", "rid-a")
    assert kwargs.get("operation_id")


def test_resume_workflow_relay_failure_surfaces_to_the_caller():
    service = _resume_service()
    service.client.post_chat.side_effect = RuntimeError("engine down")

    with pytest.raises(RuntimeError, match="engine down"):
        service.resume_workflow("rid-a")


def test_resume_workflow_refused_relay_raises_runtime_error():
    service = _resume_service()
    service.client.post_chat.return_value = None

    with pytest.raises(RuntimeError):
        service.resume_workflow("rid-a")


def test_resume_workflow_unknown_request_raises_value_error():
    service = _resume_service()

    with pytest.raises(ValueError, match="unknown"):
        service.resume_workflow("rid-missing")


def test_resume_workflow_terminal_request_raises_value_error():
    service = _resume_service()
    service.workflow_tracker.fail_supervisor("rid-a", phase="drain", error="stopped")

    with pytest.raises(ValueError):
        service.resume_workflow("rid-a")


def test_resume_workflow_missing_original_message_raises_value_error():
    service = _resume_service()
    service.chat_messages = []

    with pytest.raises(ValueError, match="原始指令"):
        service.resume_workflow("rid-a")


# ===== delete: terminal workflows tombstone instead of resurrect =====

def test_forget_workflow_requires_a_terminal_workflow():
    tracker = WorkflowTracker(clock=lambda: 10.0)
    tracker.admit("request-open")
    with pytest.raises(ValueError, match="active"):
        tracker.forget_workflow("request-open")
    tracker.admit("request-1")
    tracker.record_final("request-1", {"id": "final"})
    tracker.forget_workflow("request-1")
    assert tracker.snapshot("request-1") is None
    assert "request-1" in tracker.tombstones


def test_forget_workflow_allows_active_workflow_when_conductor_paused():
    # Paused session (conductor stopped): nothing is executing, so a paused
    # workflow may be deleted directly; the tombstone stops the next start
    # from re-admitting it.
    tracker = WorkflowTracker(clock=lambda: 10.0)
    tracker.admit("request-paused")
    tracker.forget_workflow("request-paused", allow_active=True)
    assert tracker.snapshot("request-paused") is None
    assert "request-paused" in tracker.tombstones
    tracker.admit("request-paused")
    assert tracker.snapshot("request-paused") is None


def test_deleted_workflow_cannot_resurrect_from_readmission():
    tracker = WorkflowTracker(clock=lambda: 10.0)
    tracker.admit("request-1")
    tracker.record_final("request-1", {"id": "final"})
    tracker.forget_workflow("request-1")
    # The engine still tracks the request in memory: supervisor retries and
    # late journal events re-report it, and admit must refuse to resurrect.
    tracker.admit("request-1")
    tracker.confirm_admission("request-1", boot_id="boot-1")
    assert tracker.snapshot("request-1") is None
    assert tracker.snapshots(limit=20) == []


def test_store_persists_tombstones_across_reopen(tmp_path):
    from server.services.conductor_store import ConductorStore

    tracker1 = WorkflowTracker(clock=lambda: 10.0)
    store1 = ConductorStore(tmp_path / "wf.db", "engine-a", tracker1)
    tracker1.admit("request-1")
    tracker1.record_final("request-1", {"id": "final"})
    tracker1.forget_workflow("request-1")
    store1.close()

    tracker2 = WorkflowTracker(clock=lambda: 10.0)
    store2 = ConductorStore(tmp_path / "wf.db", "engine-a", tracker2)
    assert tracker2.snapshot("request-1") is None
    # Even a fresh readmission after a full process restart stays suppressed.
    tracker2.admit("request-1")
    assert store2.recent_workflows(20) == []
    assert tracker2.snapshot("request-1") is None
    store2.close()
