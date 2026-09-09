"""Durable recovery faults, using an in-memory engine transport and temporary SQLite."""
from __future__ import annotations

import copy
import sqlite3
import threading
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.routes import conductor as conductor_routes
from server.services.conductor_client import GahubProcessError
from server.services.conductor_service import ConductorService
from server.services.conductor_store import OperationConflict


class Engine:
    def __init__(self):
        self.boot = "boot-a"
        self.epoch = "journal-a"
        self.events = []
        self.items = []
        self.receipts = {}
        self.posts = []
        self.fail_response = False
        self.revision = 1

    def event(self, kind, **payload):
        self.events.append({"seq": len(self.events) + 1, "type": kind,
                            "payload": {"event": kind, "boot_id": self.boot, **payload}})

    def recovery(self):
        return {"protocol_version": 2, "boot_id": self.boot,
                "capabilities": ["snapshot_revision", "path_policy", "request_recovery",
                                 "guarded_actions", "operation_receipts"],
                "path_policy": {"mode": "explicit_absolute"}, "requests": []}

    def get_subagents(self):
        return {"boot_id": self.boot, "snapshot_revision": self.revision, "items": self.items}

    def get_subagent(self, sid):
        return {"id": sid, "boot_id": self.boot, "active_generation": 1,
                "command_revision": 3, "review_status": "pending"}

    def journal(self, after_seq=0, limit=500):
        return {"journal": {"epoch": self.epoch, "last_seq": len(self.events)},
                "events": copy.deepcopy(self.events[after_seq:after_seq + limit])}

    def status(self):
        return {"started": True}

    def push_models(self, **kwargs):
        return {}

    def subagent_action(self, **kwargs):
        return self._post(kwargs, {"id": kwargs["sid"], "status": "stopped",
                                  "active_generation": 1})

    def start_subagent(self, **kwargs):
        return self._post(kwargs, {"id": "worker", "active_generation": 1})

    def post_chat(self, msg, role, request_id, **kwargs):
        return self._post({**kwargs, "msg": msg, "role": role, "request_id": request_id},
                          {"id": "chat-1", "msg": msg, "role": role, "request_id": request_id, "ts": 1000})

    def _post(self, kwargs, result):
        operation = kwargs["operation_id"]
        if operation not in self.receipts:
            self.posts.append(copy.deepcopy(kwargs))
            self.receipts[operation] = copy.deepcopy(result)
        if self.fail_response:
            self.fail_response = False
            raise GahubProcessError("lost response")
        return copy.deepcopy(self.receipts[operation])

    def operation(self, operation_id, scope):
        return {"boot_id": self.boot, "known": operation_id in self.receipts,
                "status_code": 200, "result": copy.deepcopy(self.receipts.get(operation_id))}


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

    def apply(record):
        original(record)
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
                             "ts": 1000}, from_hello=True)

    monkeypatch.setattr(conductor_routes, "svc", lambda: service)
    app = FastAPI()
    app.include_router(conductor_routes.router)
    with TestClient(app) as client:
        result = client.get("/api/conductor/chat", params={"last": 20})

    assert result.status_code == 200
    assert [item["id"] for item in result.json()["items"]] == ["chat-1"]
