"""Transactional Conductor projections, journal checkpoints and command intents."""
from __future__ import annotations

import copy
import hashlib
import json
import logging
import sqlite3
import threading
import time
from contextlib import contextmanager
from dataclasses import asdict
from pathlib import Path
from typing import Callable


log = logging.getLogger(__name__)


def command_fingerprint(payload: dict) -> str:
    encoded = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


class OperationConflict(ValueError):
    pass


class ConductorStore:
    def __init__(self, path: str | Path, engine_key: str, tracker):
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.engine_key = engine_key
        self.tracker = tracker
        self.lock = threading.RLock()
        self._local = threading.local()
        self.notification_failed: Callable[[], None] | None = None
        self.closed = False
        self.db = sqlite3.connect(str(path), timeout=5, isolation_level=None, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA busy_timeout=5000")
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        version = self.db.execute("PRAGMA user_version").fetchone()[0]
        if version not in (0, 1, 2):
            self.db.close()
            raise RuntimeError(f"unsupported Conductor database version: {version}")
        if version == 1 and str(path) != ":memory:":
            backup = sqlite3.connect(f"{path}.v1.{time.time_ns()}.bak")
            try:
                self.db.backup(backup)
                backup.commit()
            finally:
                backup.close()
        self.db.executescript("""
            BEGIN IMMEDIATE;
            CREATE TABLE IF NOT EXISTS workflows (
                engine_key TEXT NOT NULL, request_id TEXT NOT NULL,
                state_json TEXT NOT NULL, submission_json TEXT,
                PRIMARY KEY (engine_key, request_id));
            CREATE TABLE IF NOT EXISTS consumer_state (
                engine_key TEXT PRIMARY KEY, journal_epoch TEXT,
                applied_seq INTEGER NOT NULL DEFAULT 0, boot_id TEXT);
            CREATE INDEX IF NOT EXISTS workflows_recent ON workflows(engine_key, json_extract(state_json, '$.created_at'));
            CREATE INDEX IF NOT EXISTS workflows_terminal ON workflows(engine_key, json_extract(state_json, '$.terminal_event'));
            CREATE TABLE IF NOT EXISTS commands (
                engine_key TEXT NOT NULL, operation_id TEXT NOT NULL,
                fingerprint TEXT NOT NULL, payload_json TEXT NOT NULL,
                state TEXT NOT NULL, result_json TEXT, updated_at REAL NOT NULL,
                PRIMARY KEY (engine_key, operation_id));
            CREATE INDEX IF NOT EXISTS commands_pending ON commands(engine_key, state, updated_at);
            CREATE TABLE IF NOT EXISTS chat (
                engine_key TEXT NOT NULL, item_id TEXT NOT NULL,
                item_json TEXT NOT NULL, ts REAL NOT NULL,
                PRIMARY KEY (engine_key, item_id));
            CREATE INDEX IF NOT EXISTS chat_recent ON chat(engine_key, ts);
            CREATE TABLE IF NOT EXISTS workflow_tombstones (
                engine_key TEXT NOT NULL, request_id TEXT NOT NULL,
                created_at REAL NOT NULL,
                PRIMARY KEY (engine_key, request_id));
            PRAGMA user_version=2;
            COMMIT;
        """)
        active = self.db.execute("""SELECT state_json FROM workflows WHERE engine_key=?
            AND json_extract(state_json, '$.terminal_event') IS NULL""", (engine_key,))
        tracker.restore_state([json.loads(row[0]) for row in active] + self.recent_workflows(tracker._max_workflows))
        tracker.store = self
        tracker.tombstones.update(self.tombstones())
        tracker._prune_terminal(committed=True)
        if version == 1:
            with self.transaction():
                for row in self.db.execute("""SELECT json_extract(state_json, '$.final_item') FROM workflows
                    WHERE engine_key=? AND json_extract(state_json, '$.final_item') IS NOT NULL""", (engine_key,)):
                    self.save_chat(json.loads(row[0]))
                for row in self.db.execute("""SELECT result_json FROM commands WHERE engine_key=?
                    AND state='succeeded' AND json_extract(payload_json, '$.intent.kind')='chat'""", (engine_key,)):
                    if row[0]:
                        self.save_chat(json.loads(row[0]))

    @contextmanager
    def transaction(self):
        effects = []
        with self.tracker._lock, self.lock:
            if getattr(self._local, "active", False):
                yield
                return
            before = {}
            self.db.execute("BEGIN IMMEDIATE")
            self._local.active = True
            self._local.effects = effects
            self._local.before = before
            try:
                yield
                for request_id, previous in before.items():
                    workflow = self.tracker._workflows.get(request_id)
                    if workflow is not None and previous != workflow:
                        item = asdict(workflow)
                        self.db.execute("""INSERT INTO workflows(engine_key, request_id, state_json)
                            VALUES(?,?,?) ON CONFLICT(engine_key,request_id)
                            DO UPDATE SET state_json=excluded.state_json""",
                            (self.engine_key, item["request_id"], json.dumps(item, ensure_ascii=False)))
                self.db.commit()
                self.tracker._prune_terminal(committed=True)
            except BaseException:
                self.db.rollback()
                for request_id, previous in before.items():
                    if previous is None:
                        self.tracker._workflows.pop(request_id, None)
                    else:
                        self.tracker._workflows[request_id] = previous
                self.tracker._owners = {sid: workflow.request_id
                    for workflow in self.tracker._workflows.values() for sid in workflow.workers}
                raise
            finally:
                self._local.active = False
                self._local.effects = None
                self._local.before = None
        for effect in effects:
            try:
                effect()
            except Exception:
                log.exception("Conductor post-commit notification failed")
                if self.notification_failed is not None:
                    self.notification_failed()

    def track_workflow(self, request_id: str) -> None:
        if getattr(self._local, "active", False) and request_id not in self._local.before:
            self._local.before[request_id] = copy.deepcopy(self.tracker._workflows.get(request_id))

    def workflow(self, request_id: str) -> dict | None:
        with self.lock:
            row = self.db.execute("SELECT state_json FROM workflows WHERE engine_key=? AND request_id=?",
                                  (self.engine_key, request_id)).fetchone()
            return json.loads(row[0]) if row else None

    def recent_workflows(self, limit: int) -> list[dict]:
        with self.lock:
            return [json.loads(row[0]) for row in self.db.execute("""SELECT state_json FROM workflows
                WHERE engine_key=? AND NOT EXISTS (
                    SELECT 1 FROM workflow_tombstones t
                    WHERE t.engine_key=workflows.engine_key AND t.request_id=workflows.request_id)
                ORDER BY json_extract(state_json, '$.created_at') DESC LIMIT ?""",
                (self.engine_key, max(1, limit)))]

    def forget_workflow(self, request_id: str) -> None:
        """Remove one workflow row and leave a tombstone (caller's transaction).

        Must run inside the caller's tracker transaction so the in-memory drop
        and the row deletion commit or roll back together. The tombstone keeps
        a deleted request from resurrecting: the engine still tracks the
        request in memory and late journal events / a cursor reset would
        re-admit it otherwise.
        """
        self.db.execute("DELETE FROM workflows WHERE engine_key=? AND request_id=?",
                        (self.engine_key, request_id))
        self.db.execute("INSERT OR REPLACE INTO workflow_tombstones VALUES(?,?,?)",
                        (self.engine_key, request_id, time.time()))

    def tombstones(self) -> set[str]:
        with self.lock:
            return {row[0] for row in self.db.execute(
                "SELECT request_id FROM workflow_tombstones WHERE engine_key=?", (self.engine_key,))}

    def is_workflow_deleted(self, request_id: str) -> bool:
        with self.lock:
            return self.db.execute(
                "SELECT 1 FROM workflow_tombstones WHERE engine_key=? AND request_id=?",
                (self.engine_key, request_id)).fetchone() is not None

    def worker_owner(self, sid: str) -> str | None:
        with self.lock:
            row = self.db.execute("""SELECT w.request_id FROM workflows w, json_each(w.state_json, '$.workers') worker
                WHERE w.engine_key=? AND worker.key=? ORDER BY w.rowid DESC LIMIT 1""", (self.engine_key, sid)).fetchone()
            return row[0] if row else None

    def save_chat(self, item: dict) -> None:
        if not item.get("id"):
            return
        with self.transaction():
            self.db.execute("INSERT OR IGNORE INTO chat VALUES(?,?,?,?)",
                (self.engine_key, item["id"], json.dumps(item, ensure_ascii=False), item.get("ts") or time.time() * 1000))
            self.db.execute("""DELETE FROM chat WHERE engine_key=? AND item_id IN (
                SELECT item_id FROM chat WHERE engine_key=? ORDER BY ts DESC, rowid DESC LIMIT -1 OFFSET 200)""",
                (self.engine_key, self.engine_key))

    def chat_messages(self) -> list[dict]:
        with self.lock:
            return [json.loads(row[0]) for row in self.db.execute(
                "SELECT item_json FROM chat WHERE engine_key=? ORDER BY ts, rowid", (self.engine_key,))]

    def defer(self, effect: Callable[[], None]) -> None:
        if getattr(self._local, "active", False):
            self._local.effects.append(effect)
        else:
            effect()

    def cursor(self) -> dict:
        with self.lock:
            row = self.db.execute("SELECT * FROM consumer_state WHERE engine_key=?",
                                  (self.engine_key,)).fetchone()
            return ({"seq": row["applied_seq"], "epoch": row["journal_epoch"], "boot_id": row["boot_id"]}
                    if row else {"seq": 0, "epoch": None, "boot_id": None})

    def checkpoint(self, epoch: str | None, seq: int, boot_id: str | None) -> None:
        if not getattr(self._local, "active", False):
            raise RuntimeError("journal checkpoint requires a workflow transaction")
        current = self.cursor()
        if current["epoch"] and current["epoch"] != epoch:
            raise ValueError("journal epoch changed; recovery required")
        if seq < current["seq"]:
            raise ValueError("journal cursor cannot move backwards")
        self.db.execute("""INSERT INTO consumer_state VALUES(?,?,?,?)
            ON CONFLICT(engine_key) DO UPDATE SET journal_epoch=excluded.journal_epoch,
            applied_seq=excluded.applied_seq, boot_id=excluded.boot_id""",
            (self.engine_key, epoch, seq, boot_id))

    def put_command(self, operation_id: str, payload: dict) -> dict:
        fingerprint = command_fingerprint(payload)
        with self.transaction():
            existing = self.command(operation_id)
            if existing is not None:
                if existing["fingerprint"] != fingerprint:
                    raise OperationConflict("operation_id was used with different arguments")
                return existing
            self.db.execute("INSERT INTO commands VALUES(?,?,?,?,?,?,?)",
                            (self.engine_key, operation_id, fingerprint,
                             json.dumps(payload, ensure_ascii=False), "pending", None, time.time()))
            return self.command(operation_id)

    def command(self, operation_id: str) -> dict | None:
        with self.lock:
            row = self.db.execute("SELECT * FROM commands WHERE engine_key=? AND operation_id=?",
                                  (self.engine_key, operation_id)).fetchone()
            if row is None:
                return None
            return {"operation_id": operation_id, "fingerprint": row["fingerprint"],
                    "payload": json.loads(row["payload_json"]), "state": row["state"],
                    "result": json.loads(row["result_json"]) if row["result_json"] else None,
                    "updated_at": row["updated_at"]}

    def finish_command(self, operation_id: str, state: str, result: dict | None = None) -> None:
        if state not in {"pending", "sending", "succeeded", "rejected", "unknown"}:
            raise ValueError("invalid command state")
        with self.transaction():
            self.db.execute("""UPDATE commands SET state=?, result_json=?, updated_at=?
                WHERE engine_key=? AND operation_id=?""",
                (state, json.dumps(result, ensure_ascii=False) if result is not None else None,
                 time.time(), self.engine_key, operation_id))

    def prepare_command(self, operation_id: str, payload: dict) -> None:
        with self.transaction():
            self.db.execute("""UPDATE commands SET payload_json=?, fingerprint=?
                WHERE engine_key=? AND operation_id=?""",
                (json.dumps(payload, ensure_ascii=False), command_fingerprint(payload),
                 self.engine_key, operation_id))

    def pending_commands(self) -> list[dict]:
        with self.lock:
            ids = self.db.execute("""SELECT operation_id FROM commands WHERE engine_key=?
                AND state IN ('pending','sending','unknown') ORDER BY updated_at""",
                (self.engine_key,)).fetchall()
            return [self.command(row[0]) for row in ids]

    def close(self) -> None:
        with self.lock:
            if not self.closed:
                self.db.close()
                self.closed = True
