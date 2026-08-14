"""In-memory chat stream projection used for reconnect replay."""
from __future__ import annotations

import threading
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any


@dataclass
class ChatSnapshot:
    stream_id: str
    source: str
    query: str
    started_at: float
    content: str = ""
    done: bool = False
    finished_at: float = 0.0
    aborted: bool = False
    logical_id: str = ""
    retry_attempt: int = 0
    retry_max: int = 0
    retry_of: str = ""
    retry_reason: str = ""
    session_id: str = ""
    run_id: str = ""


class ChatStreamProjection:
    """Own the bounded, insertion-ordered replay projection for one runtime."""

    def __init__(self, capacity: int = 20) -> None:
        if capacity < 1:
            raise ValueError("chat stream projection capacity must be positive")
        self.capacity = capacity
        self._lock = threading.Lock()
        self._snapshots: OrderedDict[str, ChatSnapshot] = OrderedDict()

    def add(self, snapshot: ChatSnapshot) -> ChatSnapshot:
        with self._lock:
            self._snapshots[snapshot.stream_id] = snapshot
            while len(self._snapshots) > self.capacity:
                self._snapshots.popitem(last=False)
            return snapshot

    def get(self, stream_id: str) -> ChatSnapshot | None:
        with self._lock:
            return self._snapshots.get(stream_id)

    def items(self) -> list[tuple[str, ChatSnapshot]]:
        with self._lock:
            return list(self._snapshots.items())

    def values(self) -> list[ChatSnapshot]:
        with self._lock:
            return list(self._snapshots.values())

    def update(self, stream_id: str, **changes: Any) -> None:
        with self._lock:
            snapshot = self._snapshots.get(stream_id)
            if snapshot is None:
                return
            for key, value in changes.items():
                setattr(snapshot, key, value)

    def pop(self, stream_id: str) -> ChatSnapshot | None:
        with self._lock:
            return self._snapshots.pop(stream_id, None)

    def clear(self) -> None:
        with self._lock:
            self._snapshots.clear()
