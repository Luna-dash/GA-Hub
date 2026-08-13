from __future__ import annotations

import contextvars
import time
import uuid
from dataclasses import dataclass, asdict
from threading import Lock
from typing import Any

_CURRENT: contextvars.ContextVar[str | None] = contextvars.ContextVar("hub_request_id", default=None)

@dataclass
class RequestUsage:
    request_id: str
    started_at: float
    completed_at: float | None = None
    requests: int = 0
    input: int = 0
    output: int = 0
    cache_create: int = 0
    cache_read: int = 0
    attribution: str = "PENDING"

    def public(self) -> dict[str, Any]:
        row = asdict(self)
        row["duration_ms"] = (max(0.0, (self.completed_at or time.monotonic()) - self.started_at) * 1000)
        row["total"] = self.input + self.output + self.cache_create + self.cache_read
        return row

class RequestUsageStore:
    def __init__(self, clock=time.monotonic):
        self._clock = clock
        self._rows: dict[str, RequestUsage] = {}
        self._lock = Lock()

    def begin(self, request_id: str | None = None) -> str:
        rid = request_id or uuid.uuid4().hex
        with self._lock:
            self._rows[rid] = RequestUsage(rid, self._clock())
        return rid

    def activate(self, request_id: str):
        return _CURRENT.set(request_id)

    def deactivate(self, token) -> None:
        _CURRENT.reset(token)

    def record(self, usage: dict[str, Any] | None, api_mode: str) -> None:
        rid = _CURRENT.get()
        if not rid or not usage:
            return
        with self._lock:
            row = self._rows.get(rid)
            if not row:
                return
            row.requests += 1
            if api_mode == "messages":
                row.input += int(usage.get("input_tokens", 0) or 0)
                row.cache_create += int(usage.get("cache_creation_input_tokens", 0) or 0)
                row.cache_read += int(usage.get("cache_read_input_tokens", 0) or 0)
                out = int(usage.get("output_tokens", 0) or 0)
                if out > 1: row.output += out
            elif api_mode == "chat_completions":
                cached = int((usage.get("prompt_tokens_details") or {}).get("cached_tokens", 0) or 0)
                row.input += int(usage.get("prompt_tokens", 0) or 0) - cached
                row.cache_read += cached
            elif api_mode == "responses":
                cached = int((usage.get("input_tokens_details") or {}).get("cached_tokens", 0) or 0)
                row.input += int(usage.get("input_tokens", 0) or 0) - cached
                row.cache_read += cached

    def complete(self, request_id: str, attribution: str = "OK") -> None:
        with self._lock:
            if request_id in self._rows:
                self._rows[request_id].completed_at = self._clock()
                self._rows[request_id].attribution = attribution

    def list(self, limit: int = 100) -> list[dict[str, Any]]:
        with self._lock:
            rows = sorted(self._rows.values(), key=lambda x: x.started_at, reverse=True)[:limit]
            return [row.public() for row in rows]
