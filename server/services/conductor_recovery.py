"""Ordered journal recovery and guarded, durable Conductor commands."""
from __future__ import annotations

import logging
import os
import threading
import time

from ..constants import ENV_GAHUB_DELIVERABLE_ROOTS, ENV_GAHUB_PATH_POLICY
from .conductor_client import GahubProcessError, _engine_spawn_env


log = logging.getLogger(__name__)
WORKER_EVENTS = frozenset({"spawned", "started", "running", "completed", "pending_review",
                          "accepted", "rejected", "reworked", "timeout_output", "timeout_total",
                          "cancelled", "failed", "killed"})
OBSERVATIONS = frozenset({"chat_read", "request_yield_requested", "request_started", "model_failed",
                          "model_fallback", "worker_failed", "worker_timeout", "worker_silent",
                          "subagent_milestone", "subagent_force_accept", "supervisor_followup",
                          "engine_stopped", "error", "output_truncated"})


class ConductorRecovery:
    def __init__(self, service, store):
        self.service = service
        self.store = store
        self.lock = threading.RLock()
        self.wake = threading.Event()
        self.command_wake = threading.Event()
        self.stop_event = threading.Event()
        self.threads: list[threading.Thread] = []
        self.boot_id: str | None = None
        self.ready = False
        self.error: str | None = None
        self.last_reconcile = 0.0
        self._connection_lock = threading.RLock()
        self._connection_generation = 0
        self._start_lock = threading.Lock()
        self._journal_boot: str | None = None

    def start(self) -> None:
        with self._start_lock:
            if self.threads or self.stop_event.is_set():
                return
            for target, name in ((self._consume_loop, "conductor-journal"),
                                 (self._command_loop, "conductor-commands")):
                thread = threading.Thread(target=target, name=name, daemon=True)
                self.threads.append(thread)
                thread.start()
            self.wake.set()

    def reconnect(self) -> None:
        with self._connection_lock:
            self._connection_generation += 1
            self.ready = False
        self.wake.set()

    def status(self) -> dict:
        return {"ready": self.ready, "error": self.error, "boot_id": self.boot_id,
                "applied_seq": self.store.cursor()["seq"], "last_reconcile_at": self.last_reconcile}

    def _consume_loop(self) -> None:
        while not self.stop_event.is_set():
            self.wake.wait(5)
            self.wake.clear()
            if self.stop_event.is_set():
                break
            try:
                if self.sync():
                    self.service._ensure_relay()
            except Exception as exc:
                self.ready = False
                if self.error != str(exc):
                    log.warning("Conductor recovery pending: %s", exc)
                self.error = str(exc)

    def _command_loop(self) -> None:
        while not self.stop_event.is_set():
            self.command_wake.wait(5)
            self.command_wake.clear()
            try:
                if self.ready and not self.stop_event.is_set():
                    self.service.commands.drain_commands()
            except Exception:
                self.ready = False
                log.exception("Conductor command store unavailable")

    def on_event(self, event: dict) -> bool:
        kind = event.get("event")
        if kind == "resync_required":
            self.reconnect()
        elif kind == "subagents":
            with self._connection_lock:
                if event.get("boot_id") == self.boot_id:
                    if self.service.pool.update(event.get("items") or [],
                            boot_id=self.boot_id, revision=event.get("snapshot_revision")):
                        self.service.callbacks.publish_subagent_snapshot()
                else:
                    self.wake.set()
        elif kind == "log":
            if event.get("boot_id") == self.boot_id:
                self.service.callbacks.on_conductor_log_frame(event.get("item"))
        else:
            self.wake.set()
        return True

    @staticmethod
    def _validate_protocol(response: dict) -> None:
        required = {"snapshot_revision", "path_policy", "request_recovery", "guarded_actions", "operation_receipts"}
        if response.get("protocol_version") != 2 or not required <= set(response.get("capabilities") or []):
            raise RuntimeError("engine protocol lacks required Conductor recovery capabilities; restart the updated engine")
        if not response.get("boot_id"):
            raise RuntimeError("engine recovery response has no boot identity")
        policy = response.get("path_policy") or {}
        expected = _engine_spawn_env()
        if policy.get("mode") != expected[ENV_GAHUB_PATH_POLICY]:
            raise RuntimeError("engine path policy differs from Hub configuration; restart the engine")
        roots = expected.get(ENV_GAHUB_DELIVERABLE_ROOTS, "")
        if roots.strip() and policy.get("mode") == "allowed_roots":
            normalize = lambda p: os.path.normcase(os.path.realpath(p))
            wanted = {normalize(p.strip()) for p in roots.split(",") if p.strip()}
            if wanted != {normalize(p) for p in policy.get("allowed_roots") or []}:
                raise RuntimeError("engine allowed roots differ from Hub configuration; restart the engine")

    def sync(self) -> bool:
        with self.lock:
            self.ready = False
            with self._connection_lock:
                connection = self._connection_generation
            response = self.service.client.recovery()
            self._validate_protocol(response)
            with self._connection_lock:
                if connection != self._connection_generation:
                    return False
                if self.boot_id != response["boot_id"]:
                    self.ready = False
                    self.boot_id = response["boot_id"]
                    self.service.pool.select_boot(self.boot_id)
            self.service._lifecycle_cache.update(response)
            if not self._catch_up():
                return False
            snapshot = self.service.client.get_subagents()
            with self._connection_lock:
                if connection != self._connection_generation or snapshot.get("boot_id") != self.boot_id:
                    self.reconnect()
                    return False
                if type(snapshot.get("snapshot_revision")) is not int:
                    raise RuntimeError("engine snapshot has no revision")
                self.service.pool.update(snapshot.get("items") or [], boot_id=self.boot_id,
                                         revision=snapshot["snapshot_revision"])
                # Change the saved boot only after reconciliation commits.
                with self.store.transaction():
                    tracker = self.service.workflow_tracker
                    for record in response.get("requests") or []:
                        if record.get("request_id"):
                            tracker.confirm_admission(record["request_id"], self.boot_id)
                    for workflow in tracker.export_state():
                        old_boot = workflow.get("boot_id") or self.store.cursor().get("boot_id")
                        if (workflow.get("terminal_event") is None and old_boot and old_boot != self.boot_id
                                and workflow.get("admission_state") == "admitted"):
                            transition = tracker.fail_supervisor(workflow["request_id"], phase="engine_restarted",
                                error="engine restarted; previous execution was interrupted")
                            if transition:
                                self.service._publish_workflow_transition(transition)
                    cursor = self.store.cursor()
                    self.store.checkpoint(cursor["epoch"], cursor["seq"], self.boot_id)
                self.last_reconcile = time.time()
                self.ready = True
                self.error = None
            if self.service._notifications_dirty:
                self.service._notifications_dirty = False
                self.service._publish("conductor:resync_required", {"reason": "notification_failed"})
            self._backfill_subagent_archive()
            self.service.callbacks.publish_subagent_snapshot()
            self.command_wake.set()
            return True

    def _backfill_subagent_archive(self) -> None:
        """Rebuild archived worker records from the engine journal once.

        Journal replays and the subagent archive share a store transaction
        ordering, so an empty archive after a catch-up means the boot either
        predates archiving or its workers were never journaled. Full-scan the
        journal (bounded pages), fold worker lifecycle events into per-worker
        records, and seed the archive so completed workflows keep per-worker
        detail even though the engine cleared its pool.
        """
        store = self.service.store
        if store is None:
            return
        try:
            existing = store.archived_subagent_snapshots()
        except Exception:
            log.exception("subagent archive probe failed; skip backfill")
            return
        if existing:
            return
        try:
            merged: dict[str, dict] = {}
            after = 0
            while True:
                page = self.service.client.journal(after_seq=after, limit=5000)
                records = page.get("events") or []
                if not records:
                    break
                for record in records:
                    kind = record.get("type")
                    event = record.get("payload") if isinstance(record.get("payload"), dict) else {}
                    if not (isinstance(kind, str) and kind.startswith("subagent_")):
                        continue
                    sid = str(event.get("id") or "")
                    if not sid:
                        continue
                    record_item = merged.setdefault(sid, {
                        "id": sid, "prompt": "", "reply": "", "status": "stopped",
                        "review_status": "none", "attempt": 1, "created_at": 0,
                        "updated_at": 0, "plan_milestones": [],
                    })
                    record_item["updated_at"] = int(record.get("ts") or record_item["updated_at"] or 0)
                    # Delivery-gate evidence rides on completion-class events.
                    for gate_key in ("deliverables_missing", "deliverables_stale",
                                     "quality_checks", "done_marker", "manifest"):
                        if gate_key in event:
                            record_item[gate_key] = event[gate_key]
                    if kind == "subagent_spawned":
                        record_item["prompt"] = str(event.get("prompt") or "")
                        record_item["created_at"] = int(record.get("ts") or 0)
                        record_item["status"] = "running"
                    elif kind in ("subagent_started", "subagent_running"):
                        record_item["status"] = "running"
                    elif kind in ("subagent_completed", "subagent_pending_review"):
                        record_item["status"] = "stopped"
                        record_item["completed_at"] = int(record.get("ts") or 0)
                        if kind == "subagent_pending_review":
                            record_item["review_status"] = "pending"
                    elif kind == "subagent_accepted":
                        record_item["status"] = "stopped"
                        record_item["review_status"] = "accepted"
                        record_item["accepted_at"] = int(record.get("ts") or 0)
                    elif kind == "subagent_rejected":
                        record_item["status"] = "stopped"
                        record_item["review_status"] = "rejected"
                    elif kind in ("subagent_failed", "subagent_cancelled", "subagent_timeout_total"):
                        record_item["status"] = "stopped"
                        record_item["review_status"] = "none"
                    elif kind == "subagent_reworked":
                        record_item["status"] = "running"
                        record_item["review_status"] = "none"
                        record_item["attempt"] = int(record_item.get("attempt") or 1) + 1
                    elif kind == "subagent_milestone":
                        milestones = record_item.setdefault("plan_milestones", [])
                        if not any(ms.get("id") == event.get("milestone_id") for ms in milestones):
                            milestones.append({"id": event.get("milestone_id"), "desc": event.get("desc"),
                                "status": event.get("status"),
                                "reached_at": int(record.get("ts") or 0) if event.get("status") == "reached" else None,
                                "missed_at": int(record.get("ts") or 0) if event.get("status") == "missed" else None})
                    if event.get("request_id"):
                        record_item["request_id"] = event["request_id"]
                    if event.get("generation"):
                        record_item["generation"] = int(event["generation"])
                after = int(records[-1].get("seq") or after)
                if len(records) < 5000:
                    break
            if not merged:
                return
            # Attach the tombstone filter: deleted workflows keep nothing.
            tombstones = store.tombstones()
            items = [item for item in merged.values()
                     if not (item.get("request_id") and item["request_id"] in tombstones)]
            if items:
                store.save_subagent_snapshots(items)
                log.info("subagent archive backfilled %d workers from journal", len(items))
        except Exception:
            log.exception("subagent archive backfill failed")

    def _catch_up(self) -> bool:
        cursor = self.store.cursor()
        response = self.service.client.journal(after_seq=cursor["seq"], limit=500)
        info = response.get("journal") or {}
        epoch = info.get("epoch")
        if info.get("disabled") or not epoch:
            raise RuntimeError("engine journal unavailable; durable recovery is paused")
        if cursor["epoch"] and cursor["epoch"] != epoch:
            raise RuntimeError("journal identity changed; explicit recovery is required")
        target = int(info.get("last_seq") or 0)
        if target < cursor["seq"]:
            raise RuntimeError("journal was truncated below the saved checkpoint")
        deadline = time.monotonic() + 0.25
        while cursor["seq"] < target:
            info = response.get("journal") or {}
            if info.get("epoch") != epoch or info.get("disabled"):
                raise RuntimeError("journal identity or availability changed during replay")
            records = response.get("events") or []
            if not records:
                raise RuntimeError(f"journal gap after seq {cursor['seq']}")
            for record in records:
                seq = record.get("seq")
                if type(seq) is not int or seq != cursor["seq"] + 1:
                    raise RuntimeError(f"journal gap after seq {cursor['seq']}")
                if seq > target:
                    break
                with self.store.transaction():
                    self._apply_record(record)
                    self.store.checkpoint(epoch, seq, cursor["boot_id"])
                cursor["seq"] = seq
                self.service._journal_cursor = {"seq": seq, "epoch": epoch}
                if time.monotonic() >= deadline and seq < target:
                    self.ready = False
                    self.wake.set()
                    return False
            if cursor["seq"] < target:
                response = self.service.client.journal(after_seq=cursor["seq"], limit=500)
        with self.store.transaction():
            self.store.checkpoint(epoch, target, cursor["boot_id"])
        return True

    def _apply_record(self, record: dict) -> None:
        kind = record.get("type")
        if kind == "engine_started":
            self._journal_boot = record.get("boot_id")
            return
        event = record.get("payload")
        if not isinstance(event, dict) or event.get("event") != kind:
            raise ValueError(f"invalid journal payload at seq {record.get('seq')}")
        tracker = self.service.workflow_tracker
        rid = event.get("request_id")
        boot = event.get("boot_id") or self._journal_boot
        if kind == "request_admitted":
            if not rid:
                raise ValueError("request_admitted is missing request_id")
            tracker.confirm_admission(rid, boot)
        elif kind == "chat":
            item = event.get("item") or {}
            if (item.get("final") or item.get("role") == "user") and item.get("request_id") and not tracker.has_request(item["request_id"]):
                tracker.admit(item["request_id"], admission_state="recovered_incomplete", boot_id=boot)
            self.service._on_remote_chat(item)
        elif isinstance(kind, str) and kind.startswith("subagent_") and kind[9:] in WORKER_EVENTS:
            if rid:
                tracker.confirm_admission(rid, boot)
            owner, transition = tracker.record_subagent_event(event.get("id", ""), kind[9:],
                request_id=rid, generation=event.get("generation"))
            self.service._publish("conductor:" + kind, event)
            if transition:
                self.service._publish_workflow_transition(transition)
            if kind == "subagent_pending_review" and owner and self.service.auto_accept and boot == self.boot_id:
                self.service.commands.enqueue_auto_accept(event["id"], owner, int(event.get("generation") or 0))
        elif kind == "request_outcome":
            if rid and event.get("status") == "ok":
                self.service.callbacks._fail_unhandled_request(rid)
            if rid and tracker.has_request(rid) and event.get("status") not in ("ok", "yielded"):
                transition = tracker.fail_supervisor(rid, phase=event.get("phase") or "finish",
                                                   error=event.get("error") or "supervisor failed")
                if transition:
                    self.service._publish_workflow_transition(transition)
            self.service._publish("conductor:request_outcome", event)
        elif kind in OBSERVATIONS:
            self.service._publish("conductor:" + kind, event)
        else:
            raise ValueError(f"unsupported journal event: {kind}")
