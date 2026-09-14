"""Durable recovery faults, using an in-memory engine transport and temporary SQLite."""
from __future__ import annotations

import copy
import sqlite3
import threading
import time
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from conductor_engine import Engine
from server.routes import conductor as conductor_routes
from server.services.conductor_client import GahubProcessError
from server.services.conductor_service import ConductorService
from server.services.conductor_store import OperationConflict


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setenv("GAHUB_PATH_POLICY", "explicit_absolute")
    engine = Engine()
    services = []

    def create():
        service = ConductorService.for_tests(store_path=tmp_path / "state.sqlite3")
        service.client = engine
        service.pool.client = engine
        service._process_manager = None
        service._ensure_relay = lambda: None
        service.ensure_started = lambda **kwargs: True
        services.append(service)
        return service

    yield engine, create
    for service in services:
        service.store.close()


def test_replay_commit_failure_rolls_back_workflow_cursor_and_notifications(setup, monkeypatch):
    engine, create = setup
    service = create()
    notices = []
    monkeypatch.setattr("server.services.conductor_service.bus.publish", lambda *args: notices.append(args))
    engine.event("request_admitted", request_id="request")
    service.store.db.execute("""CREATE TRIGGER reject_workflow BEFORE INSERT ON workflows
                                BEGIN SELECT RAISE(ABORT, 'disk fault'); END""")
    with pytest.raises(sqlite3.IntegrityError, match="disk fault"):
        service.recovery.sync()
    assert service.store.cursor()["seq"] == 0
    assert not service.workflow_tracker.has_request("request")
    assert notices == []
    service.store.db.execute("DROP TRIGGER reject_workflow")
    assert service.recovery.sync()
    assert service.store.cursor()["seq"] == 1
    assert service.workflow_tracker.has_request("request")


def test_final_business_failure_is_retried_before_chat_dedupe(setup, monkeypatch):
    engine, create = setup
    service = create()
    engine.event("request_admitted", request_id="request")
    engine.event("chat", item={"id": "final", "request_id": "request", "role": "conductor",
                               "msg": "done", "final": True})
    record_final = service.workflow_tracker.record_final
    monkeypatch.setattr(service.workflow_tracker, "record_final", lambda *args: (_ for _ in ()).throw(RuntimeError("projection")))
    with pytest.raises(RuntimeError, match="projection"):
        service.recovery.sync()
    assert service.store.cursor()["seq"] == 1
    assert "final" not in service._relayed_chat_ids
    monkeypatch.setattr(service.workflow_tracker, "record_final", record_final)
    assert service.recovery.sync()
    assert service.store.cursor()["seq"] == 2
    assert service.workflow_tracker.snapshot("request")["status"] == "completed"
    assert [item["id"] for item in service.chat_messages] == ["final"]


def test_lost_response_recovers_same_request_and_receipt_after_hub_restart(setup):
    engine, create = setup
    service = create()
    engine.fail_response = True
    with pytest.raises(GahubProcessError):
        service.add_chat_message("task", role="user", operation_id="submit")
    command = service.store.command("submit")
    assert command["state"] == "unknown"
    request_id = command["payload"]["request_id"]
    restarted = create()
    result = restarted.add_chat_message("task", role="user", operation_id="submit")
    assert result["request_id"] == request_id
    assert len(engine.posts) == 1
    assert restarted.store.command("submit")["state"] == "succeeded"
    with pytest.raises(OperationConflict):
        restarted.add_chat_message("different", role="user", operation_id="submit")


def test_action_retries_original_arguments_without_repreparing(setup):
    engine, create = setup
    service = create()
    engine.fail_response = True
    with pytest.raises(GahubProcessError):
        service.apply_subagent_action("worker", "keyinfo", "hint", operation_id="hint")
    engine.get_subagent = lambda sid: (_ for _ in ()).throw(AssertionError("must use prepared command"))
    result = service.apply_subagent_action("worker", "keyinfo", "hint", operation_id="hint")
    assert result["id"] == "worker"
    assert len(engine.posts) == 1
    assert engine.posts[0]["expected_command_revision"] == 3
    assert engine.posts[0]["expected_boot_id"] == "boot-a"


def test_old_boot_replay_never_auto_accepts_and_snapshot_failure_preserves_boot(setup):
    engine, create = setup
    service = create()
    engine.event("request_admitted", request_id="request")
    engine.event("subagent_spawned", id="worker", request_id="request", generation=1)
    assert service.recovery.sync()
    engine.event("subagent_pending_review", id="worker", request_id="request", generation=1)
    engine.boot = "boot-b"
    snapshot = engine.get_subagents
    engine.get_subagents = lambda: (_ for _ in ()).throw(RuntimeError("snapshot unavailable"))
    with pytest.raises(RuntimeError):
        service.recovery.sync()
    assert service.store.cursor()["boot_id"] == "boot-a"
    assert service.store.pending_commands() == []
    engine.get_subagents = snapshot
    restarted = create()
    assert restarted.recovery.sync()
    assert restarted.workflow_tracker.snapshot("request")["phase"] == "engine_restarted"
    assert restarted.store.cursor()["boot_id"] == "boot-b"


def test_pending_review_and_auto_accept_intent_commit_together(setup):
    engine, create = setup
    service = create()
    engine.event("subagent_pending_review", id="worker", request_id="request", generation=1)
    assert service.recovery.sync()
    pending = service.store.pending_commands()
    assert len(pending) == 1
    restarted = create()
    assert restarted.recovery.sync()
    restarted.commands.drain_commands()
    assert len(engine.posts) == 1
    assert engine.posts[0]["force"] is False
    assert engine.posts[0]["operation_id"] == pending[0]["operation_id"]
    assert restarted.workflow_tracker.snapshot("request")["subagents"]["worker"]["state"] == "accepted"


@pytest.mark.parametrize("fault", ["gap", "epoch", "unknown_type", "truncation"])
def test_invalid_journal_never_skips_checkpoint(setup, fault):
    engine, create = setup
    service = create()
    engine.event("request_admitted", request_id="request")
    assert service.recovery.sync()
    if fault == "gap":
        engine.event("request_started", request_id="request")
        engine.events[-1]["seq"] = 3
    elif fault == "epoch":
        engine.epoch = "new-epoch"
    elif fault == "truncation":
        engine.events = []
    else:
        engine.event("unrecognized_execution_fact")
    with pytest.raises((RuntimeError, ValueError)):
        service.recovery.sync()
    assert service.store.cursor()["seq"] == 1
    assert not service.recovery.ready


def test_mirror_rejects_old_snapshot_and_old_boot_http_response(setup):
    engine, create = setup
    service = create()
    assert service.recovery.sync()
    service.recovery.on_event({"event": "subagents", "boot_id": "boot-a", "snapshot_revision": 3,
                               "items": [{"id": "worker", "status": "stopped"}]})
    service.recovery.on_event({"event": "subagents", "boot_id": "boot-a", "snapshot_revision": 2, "items": []})
    assert service.pool.get("worker") is not None
    engine.boot = "boot-b"
    assert service.recovery.sync()
    service.recovery.on_event({"event": "subagents", "boot_id": "boot-a", "snapshot_revision": 100,
                               "items": [{"id": "worker"}]})
    assert service.pool.get("worker") is None


def test_periodic_sync_recovers_final_even_without_sse_hint(setup):
    engine, create = setup
    service = create()
    assert service.recovery.sync()
    engine.event("request_admitted", request_id="request")
    engine.event("chat", item={"id": "final", "role": "conductor", "request_id": "request", "final": True})
    assert service.recovery.sync()
    assert service.workflow_tracker.snapshot("request")["status"] == "completed"


def test_manual_stop_suspends_uncertain_command_instead_of_reexecuting(setup):
    engine, create = setup
    service = create()
    engine.fail_response = True
    with pytest.raises(GahubProcessError):
        service.apply_subagent_action("worker", "keyinfo", "hint", operation_id="hint")
    service.commands.suspend_commands()
    service.commands.drain_commands()
    with pytest.raises(GahubProcessError, match="suspended"):
        service.apply_subagent_action("worker", "keyinfo", "hint", operation_id="hint")
    assert len(engine.posts) == 1


def test_chat_history_survives_restart_without_engine_history(setup):
    engine, create = setup
    service = create()
    engine.event("request_admitted", request_id="request")
    engine.event("chat", item={"id": "user", "role": "user", "request_id": "request", "msg": "task", "ts": 1})
    engine.event("chat", item={"id": "final", "role": "conductor", "request_id": "request", "msg": "done", "ts": 2, "final": True})
    assert service.recovery.sync()
    restored = create()
    assert [item["id"] for item in restored.chat_messages] == ["user", "final"]
    assert restored.workflow_tracker.snapshot("request")["item"]["msg"] == "done"
    assert restored.workflow_tracker.snapshot("request")["title"] == "task"
    restored._on_remote_chat(restored.chat_messages[-1])
    assert len(restored.chat_messages) == 2


def test_terminal_history_leaves_memory_but_remains_queryable_and_closed(setup):
    _, create = setup
    service = create()
    tracker = service.workflow_tracker
    tracker._max_workflows = 3
    tracker.admit("active")
    for i in range(12):
        rid = f"done-{i}"
        tracker.admit(rid)
        tracker.bind_subagent(rid, f"worker-{i}", 1)
        tracker.record_subagent_event(f"worker-{i}", "accepted", generation=1)
        tracker.record_final(rid, {"id": rid, "msg": "done"})
    assert len(tracker._workflows) == 3
    assert tracker.is_open("active")
    assert tracker.has_request("done-0") and not tracker.is_open("done-0")
    assert tracker.request_for_subagent("worker-0") == "done-0"
    tracker.admit("done-0")
    assert tracker.snapshot("done-0")["status"] == "completed"
    assert len(tracker.snapshots(limit=20)) == 13


def test_v1_upgrade_backs_up_and_restores_committed_chat(setup):
    _, create = setup
    service = create()
    service.add_chat_message("migrated task", role="user", operation_id="migration")
    service.store.db.execute("DELETE FROM chat")
    service.store.db.execute("PRAGMA user_version=1")
    restarted = create()
    assert restarted.store.db.execute("PRAGMA user_version").fetchone()[0] >= 2
    assert restarted.chat_messages[0]["msg"] == "migrated task"


def test_transaction_copies_only_touched_workflows_and_restores_ownership(setup, monkeypatch):
    _, create = setup
    service = create()
    tracker = service.workflow_tracker
    tracker.admit("original")
    tracker.bind_subagent("original", "worker", 1)
    monkeypatch.setattr(tracker, "export_state", lambda: (_ for _ in ()).throw(AssertionError("full history copy")))
    service.store.db.execute("""CREATE TRIGGER reject_update BEFORE UPDATE ON workflows
                                BEGIN SELECT RAISE(ABORT, 'disk fault'); END""")
    with pytest.raises(sqlite3.IntegrityError):
        with service.store.transaction():
            tracker.record_subagent_event("worker", "accepted", generation=1)
            service.store.checkpoint("journal", 1, "boot")
    assert tracker.snapshot("original")["subagents"]["worker"]["state"] == "running"
    assert tracker.request_for_subagent("worker") == "original"
    assert service.store.cursor()["seq"] == 0


def test_post_commit_effect_failure_requests_resync(setup):
    _, create = setup
    service = create()
    with service.store.transaction():
        service.workflow_tracker.admit("request")
        service.store.defer(lambda: (_ for _ in ()).throw(RuntimeError("notification failed")))
    assert service.workflow_tracker.has_request("request")
    assert service._notifications_dirty


def test_prepare_string_error_is_a_durable_rejection(setup):
    engine, create = setup
    service = create()
    engine.get_subagent = lambda sid: (_ for _ in ()).throw(GahubProcessError("gone", status_code=404, detail="missing worker"))
    with pytest.raises(GahubProcessError) as failure:
        service.apply_subagent_action("gone", "accept", operation_id="missing")
    assert failure.value.detail["operation_id"] == "missing"
    assert service.store.command("missing")["state"] == "rejected"
    service.commands.drain_commands()


def test_shutdown_keeps_store_open_until_recovery_helpers_exit(setup):
    _, create = setup
    service = create()
    service.client.stop = lambda **kwargs: {"stopped": True}
    service._process_manager = SimpleNamespace(stop=lambda **kwargs: True)
    release = threading.Event()
    helper = threading.Thread(target=release.wait)
    service.recovery.threads.append(helper)
    helper.start()
    try:
        assert not service.shutdown(timeout=0.01)
        assert not service.store.closed
        release.set()
        helper.join(1)
        assert service.shutdown(timeout=1)
        assert service.store.closed
    finally:
        release.set()
        helper.join(1)


def test_large_journal_yields_without_skipping_uncommitted_events(setup, monkeypatch):
    engine, create = setup
    service = create()
    for i in range(1100):
        engine.event("request_started", request_id=str(i))
    elapsed = [0.0]
    original = service.recovery._apply_record

    def apply(record, epoch=None):
        original(record, epoch)
        elapsed[0] += 0.001

    monkeypatch.setattr(service.recovery, "_apply_record", apply)
    monkeypatch.setattr("server.services.conductor_recovery.time.monotonic", lambda: elapsed[0])
    assert not service.recovery.sync()
    assert 0 < service.store.cursor()["seq"] < 1100
    for _ in range(10):
        if service.recovery.sync():
            break
    assert service.recovery.ready
    assert service.store.cursor()["seq"] == 1100


@pytest.mark.parametrize("fault", ["disabled", "legacy", "path_mode", "roots"])
def test_incompatible_engine_pauses_writes(setup, monkeypatch, fault):
    engine, create = setup
    service = create()
    response = engine.recovery()
    if fault == "disabled":
        engine.journal = lambda **kwargs: {"journal": {"disabled": True}}
    elif fault == "legacy":
        response["capabilities"] = []
    elif fault == "path_mode":
        response["path_policy"]["mode"] = "allowed_roots"
    else:
        monkeypatch.setenv("GAHUB_PATH_POLICY", "allowed_roots")
        monkeypatch.setenv("GAHUB_DELIVERABLE_ROOTS", "D:/approved,C:/approved")
        response["path_policy"] = {"mode": "allowed_roots", "allowed_roots": ["D:/different"]}
    engine.recovery = lambda: response
    with pytest.raises(RuntimeError):
        service.recovery.sync()
    assert not service.recovery.ready
    assert service.store.cursor()["seq"] == 0
    assert engine.posts == []


def test_invalid_model_policy_is_a_durable_rejection_never_delivered_later(setup, monkeypatch):
    """A deterministic submit failure must not stay pending: a later drain
    would otherwise deliver a message the caller was told was refused."""
    engine, create = setup
    service = create()
    monkeypatch.setattr("server.services.conductor_service.bus.publish", lambda *args: None)
    with pytest.raises(GahubProcessError) as caught:
        service.commands.submit(None, {"kind": "chat", "role": "user", "msg": "hello",
                                       "subagent_model_policy": "bogus"})
    assert caught.value.status_code == 422
    operation_id = caught.value.detail["operation_id"]
    assert service.store.command(operation_id)["state"] == "rejected"
    assert service.recovery.sync()
    service.commands.drain_commands()
    assert engine.posts == []


def test_chat_route_serves_store_history_when_engine_memory_is_gone(setup, monkeypatch):
    """GET /chat is the page-hydration authority in store mode; a restarted
    engine must not blank the conversation (reliability plan §4.3)."""
    engine, create = setup
    service = create()
    monkeypatch.setattr("server.services.conductor_service.bus.publish", lambda *args: None)

    def no_engine_chat(last=20):
        raise AssertionError("store mode must not consult engine chat memory")

    engine.get_chat = no_engine_chat
    service._on_remote_chat({"id": "chat-1", "role": "conductor", "msg": "stable",
                             "ts": 1000})

    monkeypatch.setattr(conductor_routes, "svc", lambda: service)
    app = FastAPI()
    app.include_router(conductor_routes.router)
    with TestClient(app) as client:
        result = client.get("/api/conductor/chat", params={"last": 20})

    assert result.status_code == 200
    assert [item["id"] for item in result.json()["items"]] == ["chat-1"]


def test_journal_events_become_a_durable_timeline_and_ship_the_same_row(setup, monkeypatch):
    """The 动态 tab must survive a reload.

    Two things are asserted together because the feature only works if both
    hold: the row is persisted (so a task reopened from history can read it) and
    the live SSE frame carries *that* row (so the page cannot end up with two
    versions of the same event — one live, one hydrated).
    """
    engine, create = setup
    service = create()
    published = []
    monkeypatch.setattr("server.services.conductor_service.bus.publish",
                        lambda topic, payload: published.append((topic, payload)))

    engine.event("request_admitted", request_id="request")
    engine.event("subagent_spawned", request_id="request", id="worker", prompt="盘点仓库")
    engine.event("subagent_milestone", request_id="request", id="worker",
                 desc="扫描目录", status="reached")
    engine.event("subagent_killed", request_id="request", id="worker", reason="idle_timeout")
    assert service.recovery.sync()

    rows = service.store.activity_for_request("request", 20)
    # request_admitted earns no row; the three worker events do, in journal
    # order, and the tracker-derived close follows them.
    assert [item["id"] for item in rows] == [
        "journal-a:2", "journal-a:3", "journal-a:4", "wf:request:workflow_failed",
    ]
    assert [item["kind"] for item in rows] == [
        "worker_spawned", "worker_milestone", "worker_killed", "workflow_failed",
    ]

    frames = {topic: payload for topic, payload in published if topic.startswith("conductor:subagent_")}
    assert frames["conductor:subagent_milestone"]["activity"]["id"] == "journal-a:3"
    # Byte-for-byte the persisted row: one id, one wording, whichever path the
    # page reads it through.
    assert frames["conductor:subagent_milestone"]["activity"] == rows[1]


def test_a_replayed_journal_record_does_not_duplicate_its_row(setup, monkeypatch):
    """Replay is normal (cursor resets, restarts); duplication is not.

    The bus assigns a fresh event id to every publish, so keying history off it
    would make a replay look like a brand-new event.
    """
    engine, create = setup
    service = create()
    monkeypatch.setattr("server.services.conductor_service.bus.publish", lambda *args: None)
    engine.event("subagent_spawned", request_id="request", id="worker")
    assert service.recovery.sync()
    record = engine.events[0]

    for _ in range(3):
        service.recovery._apply_record(copy.deepcopy(record), "journal-a")

    rows = service.store.activity_for_request("request", 20)
    assert [item["id"] for item in rows] == ["journal-a:1"]


def test_upgrade_backfills_history_even_after_catch_up_wrote_a_row(setup, monkeypatch):
    """The backfill must not be keyed off "the activity table is empty".

    On a real install upgrading to durable history the saved cursor already
    sits at the end of the journal, so `sync()` runs catch-up first and — the
    moment any worker event arrives — writes a row. A content-based guard then
    reads "history exists" and skips the fold, leaving every earlier task with a
    four-row timeline. This walks that exact sequence.
    """
    engine, create = setup
    service = create()
    monkeypatch.setattr("server.services.conductor_service.bus.publish", lambda *args: None)

    engine.event("subagent_spawned", request_id="request", id="w1")
    engine.events[-1]["ts"] = 1000
    engine.event("subagent_milestone", request_id="request", id="w1",
                 desc="早先的里程碑", status="reached")
    engine.events[-1]["ts"] = 1001
    assert service.recovery.sync()

    # Now pretend the store predates the feature: no activity rows, cursor still
    # at the end of what it has already consumed, and a fresh process.
    service.store.db.execute("DELETE FROM activity")
    service.recovery._activity_backfilled = False

    engine.event("subagent_killed", request_id="request", id="w1", reason="idle_timeout")
    engine.events[-1]["ts"] = 1002
    assert service.recovery.sync()

    rows = service.store.activity_for_request("request", 20)
    assert [item["id"] for item in rows] == [
        "journal-a:1", "journal-a:2", "journal-a:3", "wf:request:workflow_failed",
    ]
    # journal-a:2 was consumed by an older build and is invisible to catch-up;
    # only the history fold can bring it back, and it must carry its own copy
    # rather than a placeholder.
    assert rows[1]["text"] == "里程碑 · 早先的里程碑"


def test_activity_route_serves_the_durable_timeline_with_paging(setup, monkeypatch):
    engine, create = setup
    service = create()
    monkeypatch.setattr("server.services.conductor_service.bus.publish", lambda *args: None)
    for index in range(3):
        engine.event("subagent_milestone", request_id="request", id="worker",
                     desc=f"步骤 {index}", status="reached")
        # Journal records carry a real timestamp; the in-memory transport does
        # not, and paging by atMs is meaningless without one.
        engine.events[-1]["ts"] = 1000 + index
    assert service.recovery.sync()

    monkeypatch.setattr(conductor_routes, "svc", lambda: service)
    app = FastAPI()
    app.include_router(conductor_routes.router)
    with TestClient(app) as client:
        page = client.get("/api/conductor/activity",
                          params={"request_id": "request", "limit": 2})
        # The page pages back with the oldest held atMs + 1, so the boundary
        # millisecond is re-read rather than skipped. `ts` is in seconds, so the
        # pivot is the second row's 1_001_000 ms.
        older = client.get("/api/conductor/activity",
                           params={"request_id": "request", "limit": 2, "before_ms": 1_001_001})

    assert page.status_code == 200
    body = page.json()
    assert body["durable"] is True
    assert body["has_more"] is True
    assert [item["text"] for item in body["items"]] == ["里程碑 · 步骤 1", "里程碑 · 步骤 2"]

    assert older.status_code == 200
    assert older.json()["has_more"] is False
    assert [item["text"] for item in older.json()["items"]] == [
        "里程碑 · 步骤 0", "里程碑 · 步骤 1",
    ]



def test_accept_owner_parity_and_instruction_stamping(setup):
    """Owner resolution (P0-B) and the conductor instruction line are
    command-track post-processing: accept forwards the tracker owner even
    when the caller omitted the request; input responses carry the
    dispatched instruction and the resolved model context."""
    engine, create = setup
    service = create()
    service.workflow_tracker.admit("rid-owner")
    service.workflow_tracker.bind_subagent("rid-owner", "w1", 1)

    accepted = service.apply_subagent_action("w1", "accept", "verified")
    assert engine.posts[-1]["request_id"] == "rid-owner"
    assert accepted["request_id"] == "rid-owner"

    resumed = service.input_subagent("w1", "continue", llm_index=3)
    assert resumed["instruction"]
    assert resumed["llm_index"] == 3


def test_unbound_worker_keeps_none_owner(setup):
    engine, create = setup
    service = create()

    service.apply_subagent_action("w1", "keyinfo", "ctx")

    assert engine.posts[-1]["request_id"] is None


def test_auto_accept_drain_respects_staleness_guard(setup):
    """A deliverable that predates the attempt must never be machine-accepted:
    the drain rejects the auto command instead of delivering it."""
    engine, create = setup
    service = create()
    service.recovery.sync()
    state = engine.get_subagent("w1")
    state["deliverables_stale"] = ["D:/old/pelican.svg"]
    engine.get_subagent = lambda sid: state
    service.commands.enqueue_auto_accept("w1", "rid-1", 1)

    service.commands.drain_commands()

    assert engine.posts == []
    rejected = [c for c in service.store.pending_commands()]
    assert rejected == []

    # A clean worker goes through.
    engine.get_subagent = lambda sid: {"id": sid, "boot_id": engine.boot,
                                       "active_generation": 1, "command_revision": 3,
                                       "review_status": "pending"}
    service.commands.enqueue_auto_accept("w2", "rid-2", 1)
    service.workflow_tracker.admit("rid-2")
    service.commands.drain_commands()
    assert len(engine.posts) == 1
    assert engine.posts[0]["force"] is False


def test_auto_accept_off_leaves_the_worker_for_a_human(setup):
    """The automation policy has two gates and both must honour it.

    Off, a clean pending_review neither persists an auto command (the journal
    consumer) nor gets an already-persisted one delivered (the drain loop).
    Dropping either gate silently machine-accepts a delivery the user asked
    to review by hand.
    """
    engine, create = setup
    service = create()
    service.auto_accept = False
    engine.event("subagent_pending_review", id="worker", request_id="request", generation=1)

    assert service.recovery.sync()

    # Gate 1 — the journal consumer enqueues nothing while the policy is off.
    assert service.store.pending_commands() == []
    snapshot = service.workflow_tracker.snapshot("request")
    assert snapshot["subagents"]["worker"]["state"] == "pending"

    # Gate 2 — a command persisted while the policy was on is not delivered
    # after it is switched off: the flip takes effect mid-flight.
    service.commands.enqueue_auto_accept("worker", "request", 1)
    service.commands.drain_commands()

    assert engine.posts == []
    assert len(service.store.pending_commands()) == 1  # parked, not dropped


def test_pending_review_without_a_request_owner_is_not_auto_accepted(setup):
    """A worker no admitted request owns has nothing to accept it against, so
    the automation must not invent one (the engine reports workers it never
    bound to a request)."""
    engine, create = setup
    service = create()
    engine.event("subagent_pending_review", id="orphan", generation=1)

    assert service.recovery.sync()

    assert service.store.pending_commands() == []
    assert engine.posts == []


def test_auto_accept_failure_does_not_abort_the_drain_loop(setup):
    """A lost response on an auto accept must not stop the loop.

    The failed command is parked as uncertain for reconciliation and the next
    one still goes out; a raised exception would leave the rest of the queue
    undelivered until the next wake.
    """
    engine, create = setup
    service = create()
    service.recovery.sync()
    service.workflow_tracker.admit("rid-1")
    service.commands.enqueue_auto_accept("w1", "rid-1", 1)
    time.sleep(0.01)  # pending_commands orders on updated_at
    service.workflow_tracker.admit("rid-2")
    service.commands.enqueue_auto_accept("w2", "rid-2", 1)
    engine.fail_response = True  # the FIRST delivery loses its response

    service.commands.drain_commands()  # must not raise

    assert [post["sid"] for post in engine.posts] == ["w1", "w2"]
    # The uncertain one is parked for reconciliation (never silently dropped,
    # never re-sent as if the engine had not seen it).
    parked = service.store.pending_commands()
    assert [c["payload"]["intent"]["sid"] for c in parked] == ["w1"]
    assert parked[0]["state"] == "unknown"


def test_final_command_replays_recorded_result(setup):
    """A retried final gets the recorded item back instead of re-delivering
    or failing assert_ready_for_final a second time."""
    engine, create = setup
    service = create()
    service.workflow_tracker.admit("request-1")
    service.workflow_tracker.bind_subagent("request-1", "worker-1", 1)
    service.workflow_tracker.record_subagent_event("worker-1", "accepted", generation=1)

    first = service.add_chat_message("done", role="conductor",
                                     request_id="request-1", kind="final",
                                     operation_id="op-final")
    second = service.add_chat_message("done", role="conductor",
                                      request_id="request-1", kind="final",
                                      operation_id="op-final")

    assert first == second
    assert len(engine.posts) == 1
    assert service.workflow_tracker.snapshot("request-1")["status"] == "completed"


def test_duplicate_operation_in_flight_is_refused(setup):
    engine, create = setup
    service = create()
    service.commands._inflight.add("op-x")

    with pytest.raises(GahubProcessError, match="operation is in progress"):
        service.commands.execute_command("op-x")


def test_conductor_start_failure_keeps_the_chat_pending(setup):
    """ensure_started failures are transient: the command stays pending for
    the drain loop instead of being rejected or silently dropped."""
    engine, create = setup
    service = create()
    failures = [RuntimeError("cold start raced")]

    def flaky_start(**kwargs):
        if failures:
            raise failures.pop()
        return True

    service.ensure_started = flaky_start
    with pytest.raises(RuntimeError, match="cold start raced"):
        service.add_chat_message("task", role="user", operation_id="op-1")
    assert engine.posts == []
    assert service.store.command("op-1")["state"] == "pending"

    assert service.recovery.sync()
    service.commands.drain_commands()
    assert len(engine.posts) == 1
    assert service.store.command("op-1")["state"] == "succeeded"


def test_boot_change_repushes_the_hub_model_policy(setup):
    """A fresh engine process forgot the hub-pushed policy; the boot change
    detected by sync is the re-assert signal (legacy SSE-hello behavior)."""
    engine, create = setup
    service = create()
    pushed = []
    engine.push_models = lambda **kwargs: pushed.append(kwargs) or {}

    assert service.recovery.sync()          # first boot: baseline push
    assert len(pushed) == 1
    service.recovery.sync()                 # same boot: no repush
    assert len(pushed) == 1

    engine.boot = "boot-b"
    assert service.recovery.sync()
    assert len(pushed) == 2
