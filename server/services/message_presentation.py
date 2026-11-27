"""Hub-owned message presentation (pure Python, zero Node.js subprocess).

Replaces the legacy persistent ``node.exe`` worker subprocess with the exact
canonical transcript parser in ``server.services.transcript_protocol``, locked
against the TypeScript implementation by shared golden contract tests.
"""
from __future__ import annotations

import logging
import time
from typing import Any

from .transcript_protocol import remote_message_page, remote_progress

log = logging.getLogger(__name__)

_SLOW_LOG_THRESHOLD_MS = 250.0


class MessagePresentation:
    """In-process pure-Python compact message presenter."""

    def __init__(self, *, timeout_seconds: float = 15.0):
        self._timeout_seconds = timeout_seconds
        self._requests = 0
        self._errors = 0
        self._last_exec_ms = 0.0
        self._max_exec_ms = 0.0
        self._last_error: str | None = None

    def metrics(self) -> dict[str, object]:
        """Metadata-only observability snapshot (never includes message bodies)."""
        return {
            "requests": self._requests,
            "spawns": 0,
            "restarts": 0,
            "timeouts": 0,
            "errors": self._errors,
            "cancellations": 0,
            "queued_cancellations": 0,
            "active_cancellations": 0,
            "last_lock_wait_ms": 0.0,
            "last_exec_ms": round(self._last_exec_ms, 2),
            "max_lock_wait_ms": 0.0,
            "max_exec_ms": round(self._max_exec_ms, 2),
            "last_error": self._last_error,
            "worker_alive": False,
            "mode": "python",
        }

    async def close(self) -> None:
        """No-op for API compatibility (no external worker process)."""
        return None

    async def page(self, data: dict[str, Any], *, kind: str = "history") -> dict[str, Any]:
        self._requests += 1
        started = time.monotonic()
        try:
            if kind == "progress":
                result = remote_progress(data)
            else:
                result = remote_message_page(data)
        except Exception as exc:
            exec_ms = (time.monotonic() - started) * 1000.0
            self._last_exec_ms = exec_ms
            self._max_exec_ms = max(self._max_exec_ms, exec_ms)
            self._errors += 1
            self._last_error = type(exc).__name__
            log.warning(
                "message_presentation failed kind=%s error=%s exec_ms=%.1f",
                kind,
                type(exc).__name__,
                exec_ms,
            )
            raise RuntimeError("Invalid message presentation response") from exc

        exec_ms = (time.monotonic() - started) * 1000.0
        self._last_exec_ms = exec_ms
        self._max_exec_ms = max(self._max_exec_ms, exec_ms)
        if exec_ms >= _SLOW_LOG_THRESHOLD_MS:
            log.info("message_presentation slow kind=%s exec_ms=%.1f", kind, exec_ms)
        else:
            log.debug("message_presentation ok kind=%s exec_ms=%.1f", kind, exec_ms)
        return result

    async def progress(self, frame: dict[str, Any], session_id: str) -> dict[str, Any]:
        """Project an authoritative snapshot using the desktop merge semantics."""
        if frame.get("session_id") != session_id:
            raise ValueError("Snapshot session mismatch")
        return await self.page(frame, kind="progress")


def presentation_of(app: Any) -> MessagePresentation:
    service = getattr(app.state, "message_presentation", None)
    if service is None:
        service = app.state.message_presentation = MessagePresentation()
    return service
