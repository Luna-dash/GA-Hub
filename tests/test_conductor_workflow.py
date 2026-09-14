from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest

from server.services.conductor_client import GahubProcessError
from server.services.conductor_service import ConductorService
from server.services.conductor_workflow import WorkflowTracker

from conductor_engine import Engine


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

    publish.assert_called_once()
    topic, published = publish.call_args.args
    assert topic == "conductor:workflow_completed"
    # The timeline row rides the frame so the live page keys it identically to
    # the hydrated one; everything else is the transition payload untouched.
    activity = published["activity"]
    assert {key: value for key, value in published.items() if key != "activity"} == payload
    assert activity["id"] == "wf:request-1:workflow_completed"
    assert activity["kind"] == "workflow_completed"
    assert activity["text"] == "任务完成"
    assert activity["request_id"] == "request-1"


def test_service_rejects_a_final_report_before_acceptance_without_persisting_it(
        tmp_path, monkeypatch):
    from conductor_engine import Engine
    from server.services.conductor_client import GahubProcessError

    monkeypatch.setenv("GAHUB_PATH_POLICY", "explicit_absolute")
    engine = Engine()
    service = ConductorService.for_tests(store_path=tmp_path / "state.sqlite3")
    service.client = engine
    service.pool.client = engine
    service._process_manager = None
    service._ensure_relay = lambda: None
    try:
        service.workflow_tracker.admit("request-1", boot_id="boot-a")
        service.workflow_tracker.bind_subagent("request-1", "worker", 1)

        with pytest.raises(GahubProcessError) as raised:
            service.add_chat_message(
                "premature delivery", role="conductor",
                request_id="request-1", kind="final")

        # Deterministic rejection: surfaced immediately, recorded on the
        # command, and nothing reaches the engine or the hub chat log.
        assert raised.value.status_code == 422
        assert "before every subagent is accepted" in str(raised.value)
        assert engine.posts == []
        assert service.get_chat_messages() == []
    finally:
        service.store.close()


def test_service_final_report_publishes_the_single_workflow_completion(
        tmp_path, monkeypatch):
    from conductor_engine import Engine

    monkeypatch.setenv("GAHUB_PATH_POLICY", "explicit_absolute")
    engine = Engine()
    service = ConductorService.for_tests(store_path=tmp_path / "state.sqlite3")
    service.client = engine
    service.pool.client = engine
    service._process_manager = None
    service._ensure_relay = lambda: None
    try:
        service.workflow_tracker.admit("request-1", boot_id="boot-a")
        service.workflow_tracker.bind_subagent("request-1", "worker", 1)
        service.workflow_tracker.record_subagent_event(
            "worker", "accepted", generation=1)

        with patch("server.services.conductor_service.bus.publish") as publish:
            item = service.add_chat_message(
                "verified delivery", role="conductor",
                request_id="request-1", kind="final")

        # The engine receipt is echoed back; the hub log carries the final
        # marker the UI keys on.
        assert service.get_chat_messages()[-1]["kind"] == "final"
        topics = [call.args[0] for call in publish.call_args_list]
        assert topics.count("conductor:chat") == 1
        assert topics.count("conductor:workflow_completed") == 1
        snapshot = service.workflow_tracker.snapshot("request-1")
        assert snapshot["status"] == "completed"
    finally:
        service.store.close()


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


# ===== resume_workflow: per-task relay, the explicit 恢复此任务 =====


@pytest.fixture
def resume_engine(tmp_path, monkeypatch):
    """Two stranded workflows plus one with a worker, wired to the shared
    in-memory engine. A per-task resume must relay exactly one original
    message through the guarded chat command and leave the other open
    workflows untouched."""
    monkeypatch.setenv("GAHUB_PATH_POLICY", "explicit_absolute")
    engine = Engine()
    service = ConductorService.for_tests(store_path=tmp_path / "state.sqlite3")
    service.client = engine
    service.pool.client = engine
    service._process_manager = None
    service._ensure_relay = lambda: None
    starts = []

    def ensure_started(**kwargs):
        starts.append(kwargs)
        engine.started = True
        return True

    service.ensure_started = ensure_started
    service.ensure_started_calls = starts
    tracker = service.workflow_tracker
    for rid in ("rid-a", "rid-b", "rid-busy"):
        tracker.admit(rid, boot_id="boot-a")
    tracker.bind_subagent("rid-busy", "worker-1", 1)
    service.chat_messages = [
        {"id": "c1", "role": "user", "msg": "任务A", "request_id": "rid-a"},
        {"id": "c2", "role": "user", "msg": "任务B", "request_id": "rid-b"},
    ]
    yield engine, service
    service.store.close()


def test_resume_workflow_relays_only_the_named_request(resume_engine):
    engine, service = resume_engine

    assert service.resume_workflow("rid-a") is True

    # The cold start is the per-task one: the recovery wake stays disarmed.
    # (The command track's own ensure_started() then finds a live engine, so
    # it never reaches the wake branch either.)
    assert service.ensure_started_calls[0] == {"wake_recovery": False}
    # Exactly one message reached the engine, and it is rid-a's original.
    assert len(engine.posts) == 1
    assert engine.posts[0]["msg"] == "任务A"
    assert engine.posts[0]["request_id"] == "rid-a"
    # It rode the guarded command track: persisted, boot-bound, receipt-stored.
    command = service.store.command(engine.posts[0]["operation_id"])
    assert command["state"] == "succeeded"
    assert command["payload"]["boot_id"] == "boot-a"
    # Being a chat turn, the relay is mirrored like any other: the engine
    # appends it to the request's thread, and that echoed turn is the user
    # visible feedback that the re-send went out.
    assert [m["msg"] for m in service.chat_messages][-1] == "任务A"


def test_resume_workflow_double_click_replays_instead_of_relaying_twice(
        resume_engine):
    """P0: the relay is idempotent within one engine boot.

    The old direct post minted a fresh operation id per click, so a double
    click (or a transport retry) appended the original instruction twice —
    the engine has no request_id-level dedupe. The boot-scoped operation id
    now makes the second call replay the stored outcome.
    """
    engine, service = resume_engine

    assert service.resume_workflow("rid-a") is True
    assert service.resume_workflow("rid-a") is True

    assert len(engine.posts) == 1
    # ...and the replay leaves the chat log alone: one echoed turn, not two.
    assert [m["id"] for m in service.chat_messages] == ["c1", "c2", "chat-1"]


def test_resume_workflow_relay_failure_surfaces_to_the_caller(resume_engine):
    engine, service = resume_engine
    engine.fail_response = True

    with pytest.raises(GahubProcessError, match="lost response"):
        service.resume_workflow("rid-a")


def test_resume_workflow_refuses_when_the_supervisor_cannot_start(
        resume_engine):
    engine, service = resume_engine
    # ensure_started claims success but the engine never came up, so the
    # supervisor is still down when the command is prepared.
    service.ensure_started = Mock(return_value=True)
    engine.started = False

    with pytest.raises(GahubProcessError) as excinfo:
        service.resume_workflow("rid-a")

    # 409 + the ConductorNotRunning wording, not a silent no-op or a blind 500.
    assert excinfo.value.status_code == 409
    assert "not running" in str(excinfo.value)


def test_resume_workflow_unknown_request_raises_value_error(resume_engine):
    _, service = resume_engine

    with pytest.raises(ValueError, match="unknown"):
        service.resume_workflow("rid-missing")


def test_resume_workflow_terminal_request_raises_value_error(resume_engine):
    engine, service = resume_engine
    service.workflow_tracker.fail_supervisor("rid-a", phase="drain", error="stopped")

    with pytest.raises(ValueError):
        service.resume_workflow("rid-a")
    assert engine.posts == []


def test_resume_workflow_missing_original_message_raises_value_error(resume_engine):
    engine, service = resume_engine
    service.chat_messages = []

    with pytest.raises(ValueError, match="原始指令"):
        service.resume_workflow("rid-a")
    assert engine.posts == []


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
