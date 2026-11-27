"""Persistent one-shot chat submissions for durable sessions."""
from __future__ import annotations

import json
import logging
import math
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Callable

from .._paths import ADMIN_DATA
from .attachment_refs import validate_attachments
from .session_metadata import SessionNotFoundError

log = logging.getLogger(__name__)
MAX_FINISHED_TASKS = 500


@dataclass
class ScheduledChat:
    id: str
    session_id: str
    text: str
    images: list[str]
    scheduled_for: float
    created_at: float
    attachments: list[dict] = field(default_factory=list)
    status: str = "pending"
    sent_at: float | None = None
    cancelled_at: float | None = None
    last_error: str | None = None
    retry_at: float | None = None


class ScheduledChatService:
    """Owns persisted scheduled-chat state and one bounded worker thread."""

    def __init__(
        self,
        submit: Callable[[ScheduledChat], None],
        *,
        path: Path | None = None,
        clock: Callable[[], float] = time.time,
        retry_seconds: float = 60.0,
        poll_seconds: float = 15.0,
    ) -> None:
        self._submit = submit
        self._path = path or (ADMIN_DATA / "scheduled_chats.json")
        self._clock = clock
        self._retry_seconds = retry_seconds
        self._poll_seconds = poll_seconds
        self._lock = threading.RLock()
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._tasks: dict[str, ScheduledChat] = {}
        self._load()

    def start(self) -> None:
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._stop.clear()
            self._thread = threading.Thread(target=self._run, name="scheduled-chat", daemon=True)
            self._thread.start()
            self._wake.set()

    def shutdown(self) -> None:
        self._stop.set()
        self._wake.set()
        thread = self._thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=5)
        # Keep the reference when the join timed out: blanking it would let
        # the next start() spawn a second worker alongside the live one.
        if thread is None or not thread.is_alive():
            self._thread = None

    def create(self, *, session_id: str, text: str, images: list[str], scheduled_for: float, attachments: list[dict] | None = None) -> dict:
        now = self._clock()
        if scheduled_for <= now:
            raise ValueError("scheduled time must be in the future")
        validate_attachments(attachments or [])
        task = ScheduledChat(
            id=uuid.uuid4().hex,
            session_id=session_id,
            text=text,
            images=list(images),
            scheduled_for=scheduled_for,
            created_at=now,
            attachments=[dict(a) for a in (attachments or [])],
        )
        with self._lock:
            self._tasks[task.id] = task
            self._save_locked()
        self._wake.set()
        return self._public(task)

    def list(self, session_id: str, *, include_finished: bool = False) -> list[dict]:
        with self._lock:
            rows = [
                self._public(task)
                for task in self._tasks.values()
                if task.session_id == session_id and (include_finished or task.status == "pending")
            ]
        return sorted(rows, key=lambda row: (row["scheduled_for"], row["created_at"]))

    def cancel(self, session_id: str, task_id: str) -> dict:
        with self._lock:
            task = self._tasks.get(task_id)
            if task is None or task.session_id != session_id:
                raise KeyError(task_id)
            if task.status != "pending":
                raise ValueError("only pending scheduled chats can be cancelled")
            task.status = "cancelled"
            task.cancelled_at = self._clock()
            task.retry_at = None
            self._save_locked()
            result = self._public(task)
        self._wake.set()
        return result

    def cancel_for_session(self, session_id: str, *, reason: str = "会话已删除") -> int:
        now = self._clock()
        cancelled = 0
        with self._lock:
            for task in self._tasks.values():
                if task.session_id == session_id and task.status == "pending":
                    task.status = "cancelled"
                    task.cancelled_at = now
                    task.retry_at = None
                    task.last_error = reason
                    cancelled += 1
            if cancelled:
                self._save_locked()
        if cancelled:
            self._wake.set()
        return cancelled

    def run_due_once(self) -> int:
        """Dispatch due work once. Public to keep scheduling behavior deterministic in tests."""
        now = self._clock()
        with self._lock:
            due_ids = [
                task.id for task in self._tasks.values()
                if task.status == "pending" and (task.retry_at or task.scheduled_for) <= now
            ]
        dispatched = 0
        for task_id in due_ids:
            with self._lock:
                task = self._tasks.get(task_id)
                if task is None or task.status != "pending":
                    continue
                task.status = "dispatching"
                self._save_locked()
            try:
                validate_attachments(task.attachments)
                self._submit(task)
            except SessionNotFoundError:
                log.info("scheduled chat cancelled because target session is gone task_id=%s session_id=%s", task_id, task.session_id)
                with self._lock:
                    current = self._tasks.get(task_id)
                    if current is not None and current.status == "dispatching":
                        current.status = "cancelled"
                        current.cancelled_at = self._clock()
                        current.retry_at = None
                        current.last_error = "目标会话已不存在"
                        self._save_locked()
                continue
            except Exception as exc:
                log.warning("scheduled chat dispatch deferred task_id=%s: %s", task_id, exc)
                with self._lock:
                    current = self._tasks.get(task_id)
                    if current is not None and current.status == "dispatching":
                        current.status = "pending"
                        current.last_error = str(exc)[:500]
                        current.retry_at = self._clock() + self._retry_seconds
                        self._save_locked()
                continue
            with self._lock:
                current = self._tasks.get(task_id)
                if current is not None and current.status == "dispatching":
                    current.status = "sent"
                    current.sent_at = self._clock()
                    current.retry_at = None
                    current.last_error = None
                    self._save_locked()
                    dispatched += 1
        return dispatched

    def _next_wait_seconds(self) -> float | None:
        with self._lock:
            due_times = [
                (t.retry_at if t.retry_at is not None else t.scheduled_for)
                for t in self._tasks.values()
                if t.status == "pending"
            ]
        if not due_times:
            return None
        earliest = min(due_times)
        remaining = earliest - self._clock()
        return min(self._poll_seconds, max(0.05, remaining))

    def _run(self) -> None:
        while not self._stop.is_set():
            # Clear BEFORE the sweep: a wake set during run_due_once must
            # survive, or a freshly created task waits a full poll period.
            self._wake.clear()
            try:
                self.run_due_once()
            except Exception:
                log.exception("scheduled chat worker iteration failed")
            wait_sec = self._next_wait_seconds()
            self._wake.wait(wait_sec)

    @staticmethod
    def _decode_task(row: dict) -> ScheduledChat:
        task = ScheduledChat(**row)
        if (
            not all(isinstance(value, str) for value in (task.id, task.session_id, task.text))
            or task.status not in ("pending", "dispatching", "sent", "cancelled")
            or not isinstance(task.images, list)
            or not all(isinstance(image, str) for image in task.images)
            or not isinstance(task.attachments, list)
            or not all(isinstance(attachment, dict) for attachment in task.attachments)
            or (task.last_error is not None and not isinstance(task.last_error, str))
        ):
            raise ValueError("invalid scheduled chat fields")
        for value in (task.scheduled_for, task.created_at, task.sent_at, task.cancelled_at, task.retry_at):
            if value is not None and (type(value) not in (int, float) or not math.isfinite(value)):
                raise ValueError("invalid scheduled chat timestamp")
        if task.scheduled_for is None or task.created_at is None:
            raise ValueError("missing scheduled chat timestamp")
        return task

    def _load(self) -> None:
        if not self._path.is_file():
            return
        corrupt_backup = self._path.with_name(f"{self._path.name}.corrupt.{time.time_ns()}.bak")
        try:
            original = self._path.read_bytes()
            raw = json.loads(original.decode("utf-8"))
            if not isinstance(raw, list):
                raise ValueError("scheduled chat state must be a list")
        except ValueError:
            try:
                self._path.replace(corrupt_backup)
                log.warning("scheduled chat state corrupted; quarantined to %s", corrupt_backup, exc_info=True)
            except OSError:
                log.exception("scheduled chat state unreadable; starting empty")
            return
        except OSError:
            log.exception("scheduled chat state unreadable; starting empty")
            return

        recovered = False
        invalid = 0
        for row in raw:
            try:
                task = self._decode_task(row)
            except (TypeError, ValueError, OverflowError):
                invalid += 1
                continue
            if task.status == "dispatching":
                task.status = "pending"
                task.retry_at = self._clock() + self._retry_seconds
                task.last_error = "服务重启后重新调度"
                recovered = True
            self._tasks[task.id] = task

        if invalid or recovered:
            try:
                if invalid:
                    # Copy rather than move: until the atomic save succeeds, the
                    # original pathname must still be loadable on the next boot.
                    corrupt_backup.write_bytes(original)
                self._save_locked()
                if invalid:
                    log.warning("skipped %d invalid scheduled chat rows; original saved to %s", invalid, corrupt_backup)
            except OSError:
                log.exception("scheduled chat repair could not be persisted; keeping loaded tasks in memory")

    def _prune_finished_locked(self) -> None:
        finished = [
            task for task in self._tasks.values()
            if task.status not in {"pending", "dispatching"}
        ]
        if len(finished) <= MAX_FINISHED_TASKS:
            return
        finished.sort(
            key=lambda task: (task.sent_at or task.cancelled_at or task.created_at),
            reverse=True,
        )
        for task in finished[MAX_FINISHED_TASKS:]:
            self._tasks.pop(task.id, None)

    def _save_locked(self) -> None:
        self._prune_finished_locked()
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(self._path.suffix + ".tmp")
        tmp.write_text(
            json.dumps([asdict(task) for task in self._tasks.values()], ensure_ascii=False, indent=2),
            "utf-8",
        )
        tmp.replace(self._path)

    @staticmethod
    def _public(task: ScheduledChat) -> dict:
        return {
            "id": task.id,
            "session_id": task.session_id,
            "text": task.text,
            "images": list(task.images),
            "attachments": [dict(a) for a in task.attachments],
            "scheduled_for": task.scheduled_for,
            "created_at": task.created_at,
            "status": task.status,
            "sent_at": task.sent_at,
            "cancelled_at": task.cancelled_at,
            "last_error": task.last_error,
            "retry_at": task.retry_at,
        }
