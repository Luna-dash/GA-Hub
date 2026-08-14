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


@dataclass(frozen=True)
class UsageDelta:
    input: int = 0
    output: int = 0
    cache_create: int = 0
    cache_read: int = 0


def _nonnegative_int(value) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _cached_tokens(usage: dict[str, Any], details_key: str, total_input: int) -> int:
    details = usage.get(details_key)
    if not isinstance(details, dict):
        return 0
    return min(total_input, _nonnegative_int(details.get("cached_tokens")))


def _normalize_usage(
    usage: dict[str, Any] | None, api_mode: str
) -> UsageDelta | None:
    if not usage:
        return None
    if api_mode == "messages":
        return UsageDelta(
            input=_nonnegative_int(usage.get("input_tokens")),
            output=_nonnegative_int(usage.get("output_tokens")),
            cache_create=_nonnegative_int(
                usage.get("cache_creation_input_tokens")
            ),
            cache_read=_nonnegative_int(usage.get("cache_read_input_tokens")),
        )
    if api_mode == "chat_completions":
        total_input = _nonnegative_int(usage.get("prompt_tokens"))
        cached = _cached_tokens(usage, "prompt_tokens_details", total_input)
        return UsageDelta(
            input=total_input - cached,
            output=_nonnegative_int(usage.get("completion_tokens")),
            cache_read=cached,
        )
    if api_mode == "responses":
        total_input = _nonnegative_int(usage.get("input_tokens"))
        cached = _cached_tokens(usage, "input_tokens_details", total_input)
        return UsageDelta(
            input=total_input - cached,
            output=_nonnegative_int(usage.get("output_tokens")),
            cache_read=cached,
        )
    return None

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

    def record(self, usage: dict[str, Any] | None, api_mode: str, request_id: str | None = None) -> None:
        rid = request_id or _CURRENT.get()
        delta = _normalize_usage(usage, api_mode)
        if not rid or delta is None:
            return
        with self._lock:
            row = self._rows.get(rid)
            if not row:
                return
            row.requests += 1
            row.input += delta.input
            row.output += delta.output
            row.cache_create += delta.cache_create
            row.cache_read += delta.cache_read

    def complete(self, request_id: str, attribution: str = "OK") -> None:
        with self._lock:
            if request_id in self._rows:
                self._rows[request_id].completed_at = self._clock()
                self._rows[request_id].attribution = attribution

    def list(self, limit: int = 100) -> list[dict[str, Any]]:
        with self._lock:
            rows = sorted(self._rows.values(), key=lambda x: x.started_at, reverse=True)[:limit]
            return [row.public() for row in rows]
