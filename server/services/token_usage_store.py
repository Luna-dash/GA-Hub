"""Atomic persistence for durable token usage ledgers and history."""
from __future__ import annotations

from contextlib import contextmanager
import json
import logging
import os
from pathlib import Path
import threading
from typing import Any
from uuid import uuid4

from .. import _paths

log = logging.getLogger(__name__)

_lock_guard = threading.Lock()
_path_locks: dict[str, threading.RLock] = {}


def _shared_path_lock(path: Path) -> threading.RLock:
    key = os.path.normcase(str(path.resolve()))
    with _lock_guard:
        return _path_locks.setdefault(key, threading.RLock())


class TokenUsageStore:
    """Own all reads and writes for token usage/history sidecar files."""

    def __init__(
        self,
        *,
        usage_path: Path | None = None,
        history_path: Path | None = None,
    ) -> None:
        self.usage_path = usage_path or _paths.ADMIN_DATA / "token_usage.json"
        self.history_path = history_path or _paths.ADMIN_DATA / "token_history.json"
        self.lock_path = self.usage_path.with_suffix(".lock")
        self._thread_lock = _shared_path_lock(self.lock_path)

    @contextmanager
    def transaction(self):
        """Serialize usage/history read-modify-write cycles across processes."""
        self.lock_path.parent.mkdir(parents=True, exist_ok=True)
        with self._thread_lock, self.lock_path.open("a+b") as handle:
            if os.name == "nt":
                import msvcrt

                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
                try:
                    yield
                finally:
                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
                try:
                    yield
                finally:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    def read_usage(self) -> dict[str, Any] | None:
        try:
            data = json.loads(self.usage_path.read_text("utf-8"))
            return data if isinstance(data, dict) else None
        except (OSError, ValueError):
            return None

    def write_usage(self, data: dict[str, Any]) -> None:
        self._atomic_replace(self.usage_path, json.dumps(data, ensure_ascii=False))

    def read_history(self) -> list[dict[str, Any]]:
        try:
            data = json.loads(self.history_path.read_text("utf-8"))
            return data if isinstance(data, list) else []
        except (OSError, ValueError):
            return []

    def write_history(self, history: list[dict[str, Any]]) -> None:
        self._atomic_replace(
            self.history_path, json.dumps(history, ensure_ascii=False)
        )

    @staticmethod
    def _atomic_replace(path: Path, payload: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
        try:
            tmp.write_text(payload, "utf-8")
            os.replace(tmp, path)
        finally:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
