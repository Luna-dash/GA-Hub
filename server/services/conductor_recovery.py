"""Ordered journal recovery and guarded, durable Conductor commands."""
from __future__ import annotations

import logging
import threading
import time

from ..event_topics import (
    CONDUCTOR_CHAT_READ,
    CONDUCTOR_REQUEST_OUTCOME,
    CONDUCTOR_REQUEST_YIELD_REQUESTED,
)
from . import conductor_activity
from .conductor_client import _engine_spawn_env
from .conductor_protocol import validate_protocol
from .conductor_vocabulary import (
    REVIEW_ACCEPTED,
    REVIEW_NONE,
    REVIEW_PENDING,
    REVIEW_REJECTED,
)


log = logging.getLogger(__name__)
WORKER_EVENTS = frozenset({"spawned", "started", "running", "completed", "pending_review",
                          "accepted", "rejected", "reworked", "timeout_output", "timeout_total",
                          "cancelled", "failed", "killed"})
OBSERVATIONS = frozenset({"chat_read", "request_yield_requested", "request_started", "model_failed",
                          "model_fallback", "worker_failed", "worker_timeout", "worker_silent",
                          "subagent_milestone", "subagent_force_accept", "supervisor_followup",
                          "engine_stopped", "error", "output_truncated"})
# Registry constants for the observations that have one; the rest ride the
# dynamic "conductor:" family (their suffixes are engine event kinds).
_OBSERVATION_TOPICS = {"chat_read": CONDUCTOR_CHAT_READ,
                       "request_yield_requested": CONDUCTOR_REQUEST_YIELD_REQUESTED}
# How far back the one-shot activity backfill reads the journal. The store keeps
# at most ConductorStore.ACTIVITY_CAP rows per engine, so this is a generous
# multiple of what could ever be stored: it bounds startup work on an old,
# unrotated journal without ever truncating a reachable row.
ACTIVITY_BACKFILL_RECORDS = 20_000


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
        # The activity backfill is a one-shot upgrade step. Without this flag a
        # journal whose events never earn a timeline row (a chat-only install)
        # would be re-scanned in full on every sync, forever.
        self._activity_backfilled = False

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
        validate_protocol(response, expected_env=_engine_spawn_env())

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
                    # A fresh engine process forgot the hub-pushed model
                    # policy. The SSE-hello path used to re-assert it on every
                    # reconnect; on the journal track the boot change is the
                    # equivalent signal. Best-effort and idempotent.
                    self.service._push_models_to_engine()
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
            self._backfill_activity()
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
                        "review_status": REVIEW_NONE, "attempt": 1, "created_at": 0,
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
                            record_item["review_status"] = REVIEW_PENDING
                    elif kind == "subagent_accepted":
                        record_item["status"] = "stopped"
                        record_item["review_status"] = REVIEW_ACCEPTED
                        record_item["accepted_at"] = int(record.get("ts") or 0)
                    elif kind == "subagent_rejected":
                        record_item["status"] = "stopped"
                        record_item["review_status"] = REVIEW_REJECTED
                    elif kind in ("subagent_failed", "subagent_cancelled", "subagent_timeout_total"):
                        record_item["status"] = "stopped"
                        record_item["review_status"] = REVIEW_NONE
                    elif kind == "subagent_reworked":
                        record_item["status"] = "running"
                        record_item["review_status"] = REVIEW_NONE
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

    def _backfill_activity(self) -> None:
        """Fold the existing journal into the durable timeline, once per process.

        An install upgrading to durable history already has a journal full of
        events its cursor has consumed — the catch-up loop will never revisit
        them. Without this the 动态 tab stays empty for every task that ran
        before the upgrade, which is precisely the case the feature exists for.

        The guard is a process flag, not "is the table empty": catch-up runs
        first and writes the handful of records that arrived since the saved
        checkpoint, so a content-based guard would skip the very history this
        exists to restore (observed against a real install). Re-folding an
        already-persisted record is a no-op — rows are keyed by epoch+seq — so
        scanning again costs a read and cannot duplicate anything.
        """
        store = self.service.store
        if self._activity_backfilled:
            return
        try:
            head = self.service.client.journal(after_seq=0, limit=1)
            info = head.get("journal") or {}
            if info.get("disabled"):
                # A disabled journal yields nothing to fold and will not come
                # back within this process; stop rescanning it.
                self._activity_backfilled = True
                return
            # Bounded tail scan: the store keeps at most ACTIVITY_CAP rows per
            # engine, so folding more history than could ever be stored would
            # only cost startup time on an old, unrotated journal.
            after = max(0, int(info.get("last_seq") or 0) - ACTIVITY_BACKFILL_RECORDS)
        except Exception:
            log.exception("activity backfill probe failed")
            return
        try:
            rows: list[dict] = []
            while True:
                page = self.service.client.journal(after_seq=after, limit=5000)
                info = page.get("journal") or {}
                epoch = info.get("epoch")
                records = page.get("events") or []
                if not records:
                    break
                for record in records:
                    row = self._activity_for(record, epoch)
                    if row is not None:
                        rows.append(row)
                after = int(records[-1].get("seq") or after)
                if len(records) < 5000:
                    break
            rows.extend(self._terminal_rows(store, rows))
            tombstones = store.tombstones()
            items = [row for row in rows if row["request_id"] not in tombstones]
            if items:
                store.save_activity(items)
                log.info("activity backfilled %d rows from journal", len(items))
            self._activity_backfilled = True
        except Exception:
            log.exception("activity backfill failed")

    @staticmethod
    def _terminal_rows(store, rows: list[dict]) -> list[dict]:
        """Closing rows for workflows that already finished.

        Terminal transitions are tracker-derived rather than journal events, so
        `_apply_record` cannot record them after the fact. Their timestamps come
        from the workflow row; a closed workflow's own created_at/completed_at
        pair is degenerate (the row is rewritten on close), so the request's
        last known event clamps the row to sort last instead of first.
        """
        latest: dict[str, int] = {}
        for row in rows:
            latest[row["request_id"]] = max(latest.get(row["request_id"], 0), row["atMs"])
        out: list[dict] = []
        for workflow in store.recent_workflows(store.ACTIVITY_CAP):
            kind = workflow.get("terminal_event")
            request_id = workflow.get("request_id")
            if not kind or not request_id:
                continue
            ms = latest.get(request_id, 0)
            finished = workflow.get("completed_at")
            if isinstance(finished, (int, float)) and finished > 0:
                ms = max(ms, int(round(float(finished) * 1000)))
            row = conductor_activity.workflow_activity(
                kind, request_id, event_id=f"wf:{request_id}:{kind}", ts=ms / 1000 if ms else 0.0)
            if row is not None:
                out.append(row)
        return out

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
                    self._apply_record(record, epoch)
                    self.store.checkpoint(epoch, seq, cursor["boot_id"])
                cursor["seq"] = seq
                if time.monotonic() >= deadline and seq < target:
                    self.ready = False
                    self.wake.set()
                    return False
            if cursor["seq"] < target:
                response = self.service.client.journal(after_seq=cursor["seq"], limit=500)
        with self.store.transaction():
            self.store.checkpoint(epoch, target, cursor["boot_id"])
        return True

    @staticmethod
    def _journal_event_id(record: dict, epoch: str | None) -> str | None:
        """Stable identity for one journal record.

        The bus assigns a fresh event_id to every publish, so history cannot be
        keyed off it: a replayed event would then look like a new one and
        duplicate its own row. Epoch+seq is stable across replays and restarts.
        """
        seq = record.get("seq")
        if type(seq) is not int:
            return None
        return f"{epoch or 'journal'}:{seq}"

    @staticmethod
    def _journal_ts(record: dict) -> float:
        ts = record.get("ts")
        return float(ts) if isinstance(ts, (int, float)) and ts > 0 else 0.0

    def _activity_for(self, record: dict, epoch: str | None) -> dict | None:
        """Timeline row for one journal record, or None when it earns no row."""
        kind = record.get("type")
        event = record.get("payload")
        event_id = self._journal_event_id(record, epoch)
        if event_id is None or not isinstance(kind, str) or not isinstance(event, dict):
            return None
        return conductor_activity.journal_activity(
            kind, event, event_id=event_id, ts=self._journal_ts(record))

    @staticmethod
    def _with_activity(event: dict, activity: dict | None) -> dict:
        """The published payload carries its own timeline row.

        The live path and the hydrated path must hand the page the same id and
        the same copy, or the row shows up twice with different wording. Both
        are produced here, from one mapping.
        """
        return event if activity is None else {**event, "activity": activity}

    def _apply_record(self, record: dict, epoch: str | None = None) -> None:
        kind = record.get("type")
        if kind == "engine_started":
            self._journal_boot = record.get("boot_id")
            return
        event = record.get("payload")
        if not isinstance(event, dict) or event.get("event") != kind:
            raise ValueError(f"invalid journal payload at seq {record.get('seq')}")
        # Persist before publishing: the row is the durable truth, the SSE frame
        # only a live hint for it.
        activity = self._activity_for(record, epoch)
        if activity is not None:
            self.service.store.save_activity([activity])
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
            self.service._publish("conductor:" + kind, self._with_activity(event, activity))
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
            self.service._publish(CONDUCTOR_REQUEST_OUTCOME, self._with_activity(event, activity))
        elif kind in OBSERVATIONS:
            self.service._publish(_OBSERVATION_TOPICS.get(kind) or "conductor:" + kind,
                                  self._with_activity(event, activity))
        else:
            raise ValueError(f"unsupported journal event: {kind}")
