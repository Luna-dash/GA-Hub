"""Persistent one-shot chat submissions for durable sessions."""
from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable

from .._paths import ADMIN_DATA

log = logging.getLogger(__name__)


@dataclass
class ScheduledChat:
    id: str
    session_id: str
    text: str
    images: list[str]
    scheduled_for: float
    created_at: float
    status: str = "pending"
    sent_at: float | None = None
    cancelled_at: float | None = None
    last_error: str | None = None
    retry_at: float | None = None


class ScheduledChatService:
    """Owns persisted scheduled-chat state and one bounded worker thread."""

    _instance: "ScheduledChatService | None" = None

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

    @classmethod
    def instance(cls, submit: Callable[[ScheduledChat], None] | None = None) -> "ScheduledChatService":
        if cls._instance is None:
            if submit is None:
                raise RuntimeError("scheduled chat submit callback is required")
            cls._instance = cls(submit)
        return cls._instance

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
        self._thread = None

    def create(self, *, session_id: str, text: str, images: list[str], scheduled_for: float) -> dict:
        now = self._clock()
        if scheduled_for <= now:
            raise ValueError("scheduled time must be in the future")
        task = ScheduledChat(
            id=uuid.uuid4().hex,
            session_id=session_id,
            text=text,
            images=list(images),
            scheduled_for=scheduled_for,
            created_at=now,
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
                self._submit(task)
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

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self.run_due_once()
            except Exception:
                log.exception("scheduled chat worker iteration failed")
            self._wake.wait(self._poll_seconds)
            self._wake.clear()

    def _load(self) -> None:
        if not self._path.is_file():
            return
        try:
            raw = json.loads(self._path.read_text("utf-8"))
            recovered = False
            for row in raw if isinstance(raw, list) else []:
                task = ScheduledChat(**row)
                if task.status == "dispatching":
                    task.status = "pending"
                    task.retry_at = self._clock() + self._retry_seconds
                    task.last_error = "服务重启后重新调度"
                    recovered = True
                self._tasks[task.id] = task
            if recovered:
                self._save_locked()
        except Exception:
            log.exception("scheduled chat state unreadable; starting empty")

    def _save_locked(self) -> None:
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
            "scheduled_for": task.scheduled_for,
            "created_at": task.created_at,
            "status": task.status,
            "sent_at": task.sent_at,
            "cancelled_at": task.cancelled_at,
            "last_error": task.last_error,
            "retry_at": task.retry_at,
        }
