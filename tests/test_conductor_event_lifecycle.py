"""Conductor event-surface lifecycle tests (single command track).

The legacy in-memory SSE track is gone: request outcomes, subagent events
and auto-accept are journal-recovery concerns (see
test_conductor_recovery.py). What remains here is the observer surface the
live process still owns — log frames, snapshot publishing, the false-success
guard and engine cold-start locking.
"""
from __future__ import annotations

import threading
from types import SimpleNamespace
from unittest.mock import Mock, patch

from conductor_engine import Engine
from server.services.conductor_service import (
    ConductorService,
    HubConductorCallbacks,
)


def test_conductor_log_frame_publishes_valid_item_only():
    service = ConductorService.for_tests()
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
    service = ConductorService.for_tests()
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


def envelope(items, revision):
    return {"items": items, "boot_id": "boot-a", "snapshot_revision": revision}


def test_subagent_snapshot_publishes_once_per_change():
    """Unchanged snapshots are deduped; a changed revision publishes again."""
    service = ConductorService.for_tests()
    snapshots = [envelope([{"id": "sid", "status": "running"}], 1)]
    service.pool = SimpleNamespace(envelope=lambda: snapshots[-1])
    callbacks = HubConductorCallbacks(service)

    with patch("server.services.conductor_service.bus.publish") as publish:
        callbacks.publish_subagent_snapshot()
        callbacks.publish_subagent_snapshot()
        snapshots.append(envelope([{"id": "sid", "status": "stopped"}], 2))
        callbacks.publish_subagent_snapshot()

    assert publish.call_count == 2


def test_subagent_snapshot_publish_failure_is_observer_only():
    """A snapshot publish failure must not propagate into the caller's
    already-committed pool action; _publish absorbs it and flags the
    notification channel dirty for the resync flow."""
    service = ConductorService.for_tests()
    service.pool = SimpleNamespace(
        envelope=lambda: envelope([{"id": "sid", "status": "running"}], 1))
    callbacks = HubConductorCallbacks(service)

    with patch(
        "server.services.conductor_service.bus.publish",
        side_effect=RuntimeError("temporary"),
    ):
        callbacks.publish_subagent_snapshot()

    assert service._notifications_dirty


def test_relayed_user_chat_is_not_duplicated_by_the_journal_replay(
        tmp_path, monkeypatch):
    """The delivered user turn is mirrored from the engine receipt, and the
    journal replay of that same engine record must not append it twice."""
    monkeypatch.setenv("GAHUB_PATH_POLICY", "explicit_absolute")
    engine = Engine()
    service = ConductorService.for_tests(store_path=tmp_path / "state.sqlite3")
    service.client = engine
    service.pool.client = engine
    service._process_manager = None
    service._ensure_relay = lambda: None
    service.ensure_started = lambda **kwargs: True
    try:
        item = service.add_chat_message("hello", role="user", operation_id="op-1")

        # D4: the hub mirrors the engine id verbatim (hydration dedupes on it)
        # and remembers it as our own relay.
        assert item["id"] in service._relayed_chat_ids
        assert [m["id"] for m in service.chat_messages] == [item["id"]]

        with patch("server.services.conductor_service.bus.publish"):
            service._on_remote_chat({"id": item["id"], "role": "user",
                                     "msg": "hello", "final": False})
        assert [m["id"] for m in service.chat_messages] == [item["id"]]

        with patch("server.services.conductor_service.bus.publish"):
            service._on_remote_chat({"id": "ga-new-1", "role": "conductor",
                                     "msg": "plan", "final": False})
        assert [m["msg"] for m in service.chat_messages] == ["hello", "plan"]
    finally:
        service.store.close()


# ── false-success / policy-resilience regression coverage ────────────────────

def _service_with_tracker():
    from server.services.conductor_workflow import WorkflowTracker
    service = ConductorService.for_tests()
    service.chat_messages = []
    service.workflow_tracker = WorkflowTracker(clock=lambda: 10.0)
    return service


def test_ok_outcome_for_an_untouched_request_fails_the_stranded_workflow():
    """A coalesced batch that ends naturally without dispatching (or
    answering) one request must not read as success for that request: the
    workflow is visibly failed instead of stranding in ``admitted``."""
    service = _service_with_tracker()
    service.workflow_tracker.admit("rid-stranded")
    callbacks = HubConductorCallbacks(service)

    with patch("server.services.conductor_service.bus.publish"):
        callbacks._fail_unhandled_request("rid-stranded")

    snapshot = service.workflow_tracker.snapshot("rid-stranded")
    assert snapshot["status"] == "failed"
    assert any(
        item.get("kind") == "error"
        and "without dispatching a worker" in item.get("msg", "")
        for item in service.chat_messages
    )


def test_ok_outcome_for_a_dispatched_or_answered_request_stays_success():
    service = _service_with_tracker()
    service.workflow_tracker.admit("rid-worker")
    service.workflow_tracker.bind_subagent("rid-worker", "worker-1", 1)
    callbacks = HubConductorCallbacks(service)

    with patch("server.services.conductor_service.bus.publish") as publish:
        callbacks._fail_unhandled_request("rid-worker")

    assert service.workflow_tracker.snapshot("rid-worker")["status"] in {
        "supervising", "awaiting_review", "completed"}
    failure_events = [
        call for call in publish.call_args_list
        if call.args[0] == "conductor:workflow_failed"
    ]
    assert failure_events == []

    # A conductor chat answer for the request also counts as handled.
    service2 = _service_with_tracker()
    service2.workflow_tracker.admit("rid-answered")
    service2.chat_messages.append({
        "id": "plan", "role": "conductor",
        "request_id": "rid-answered", "msg": "clarifying question",
    })
    callbacks2 = HubConductorCallbacks(service2)
    with patch("server.services.conductor_service.bus.publish") as publish2:
        callbacks2._fail_unhandled_request("rid-answered")
    assert service2.workflow_tracker.snapshot("rid-answered")["status"] == "admitted"
    assert not [
        call for call in publish2.call_args_list
        if call.args[0] == "conductor:workflow_failed"
    ]


def test_cold_start_repushes_the_hub_model_policy():
    """/start only restores the conductor model — the subagent
    policy snapshot must be re-pushed or it silently resets in the engine."""
    service = _service()
    service._started = False
    service._relay_thread = None
    service._relay_stop = threading.Event()
    service._process_manager = Mock()
    service._lifecycle_cache = {}
    service.client.status.return_value = {"started": False}
    service.client.start.return_value = {"started": True}
    service._push_models_to_engine = Mock()

    service.ensure_started()

    service.client.start.assert_called_once_with(
        llm_index=1)
    service._push_models_to_engine.assert_called_once()


def _service() -> ConductorService:
    service = ConductorService.for_tests()
    service._conductor_llm_index = 1
    service._subagent_llm_index = None
    service._subagent_model_policy = "follow_main"
    service._model_lock = threading.RLock()
    service.pool = SimpleNamespace(snapshot=lambda: [], get=lambda _sid: None)
    service.client = Mock()
    service.client.status.return_value = {"started": True}
    service.client.start.return_value = {"started": True}
    service.callbacks = HubConductorCallbacks(service)
    return service


# ── engine cold-start locking (resume semantics) ─────────────────────────────

def _ensure_started_service(status_started: bool):
    service = ConductorService.for_tests()
    service.client = Mock()
    service.client.status.return_value = {"started": status_started}
    service._conductor_llm_index = None
    service._relay_thread = None
    service._relay_stop = threading.Event()
    service._process_manager = None
    service._push_models_to_engine = Mock()
    service._ensure_relay = Mock()
    return service, service.client


def test_ensure_started_never_restarts_when_already_running():
    """An already-running conductor may be mid-turn on an admitted workflow;
    re-running the cold-start sequence there would disturb it."""
    service, client = _ensure_started_service(True)
    service.ensure_started()

    client.start.assert_not_called()


def test_ensure_started_explicit_start_is_pure_bring_up():
    """The header 启动 button is a pure bring-up (2026-09 user ruling: a
    stopped task is not implicitly a task to restart). Pressing it must not
    replay a single stranded workflow — resuming is per-task (恢复此任务);
    the journal catch-up wake is reserved for chat admission."""
    service, client = _ensure_started_service(False)
    service.ensure_started(wake_recovery=False)

    client.start.assert_called_once()
    assert not service.recovery.wake.is_set()


def test_ensure_started_second_admission_rechecks_under_cold_start_lock():
    """Two admissions racing a cold start both observe "not started" before
    either starts the engine — the lock's inner re-check is the only thing
    keeping the engine from being started twice."""
    service, client = _ensure_started_service(False)
    client.status.side_effect = [
        {"started": False},  # caller A: outer check
        {"started": False},  # caller B: outer check (A has not started yet)
        {"started": False},  # caller A: re-check inside the lock -> starts
        {"started": True},   # caller B: re-check inside the lock -> skips
        {"started": True},   # lifecycle_status
        {"started": True},   # lifecycle_status
    ]
    service.ensure_started()
    service.ensure_started()

    client.start.assert_called_once()


def test_ensure_started_cold_start_lock_is_thread_safe():
    """Real interleaving: N concurrent admissions produce exactly one
    engine start."""
    service, client = _ensure_started_service(False)
    started_after_engine_start = threading.Event()

    def status():
        # Start is the point of no return: before it the engine is cold,
        # after it every caller (outer or re-check) must see "started".
        if started_after_engine_start.is_set():
            return {"started": True}
        return {"started": False}

    client.status.side_effect = lambda: status()
    start_calls: list[dict] = []

    def fake_start(**kwargs):
        start_calls.append(kwargs)
        started_after_engine_start.set()

    client.start.side_effect = fake_start
    errors: list[Exception] = []
    gate = threading.Barrier(4, timeout=10)

    def run():
        gate.wait()
        try:
            service.ensure_started()
        except Exception as exc:  # pragma: no cover - failure reporting
            errors.append(exc)

    threads = [threading.Thread(target=run) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(10)

    assert errors == []
    assert len(start_calls) == 1
