"""Async event bus with topic-style fan-out.

Bridges blocking producer threads (agent run loop, WeChat polling) and
asyncio consumers (WebSocket subscribers). Producers call ``publish``
from any thread; consumers ``subscribe`` from the asyncio event loop.

Topics use ``namespace:event`` convention. A subscriber may filter by
prefix (e.g. ``"wechat:"``) or subscribe to all (``""``).
"""
from __future__ import annotations

import asyncio
import dataclasses
import logging
import time
from collections import deque
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator, Callable

log = logging.getLogger(__name__)


def _json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    if isinstance(value, Mapping):
        return {str(k): _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_safe(v) for v in value]
    if dataclasses.is_dataclass(value):
        return _json_safe(dataclasses.asdict(value))
    if hasattr(value, "model_dump") and callable(value.model_dump):
        try:
            return _json_safe(value.model_dump())
        except Exception:
            pass
    if hasattr(value, "dict") and callable(value.dict):
        try:
            return _json_safe(value.dict())
        except Exception:
            pass
    if hasattr(value, "isoformat") and callable(value.isoformat):
        try:
            return value.isoformat()
        except Exception:
            pass
    if hasattr(value, "__dict__"):
        try:
            state = vars(value)
            if state:
                return _json_safe(state)
        except Exception:
            pass
    return repr(value)


@dataclass
class Event:
    topic: str
    payload: dict
    ts: float = field(default_factory=time.time)


class EventBus:
    """Thread-safe → asyncio fan-out.

    Producer side is sync (thread-safe). Consumer side is asyncio.

    Each subscriber gets its own bounded queue; if it falls behind we drop
    oldest events for that subscriber rather than blocking the producer.
    """

    def __init__(self, history: int = 200, queue_size: int = 256):
        self._loop: asyncio.AbstractEventLoop | None = None
        self._subs: list[tuple[str, asyncio.Queue]] = []
        self._history: deque[Event] = deque(maxlen=history)
        self._queue_size = queue_size
        self._lock = asyncio.Lock()

    def attach_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """Bind to the asyncio loop running FastAPI. Must be called once at startup."""
        self._loop = loop

    # ── producers ────────────────────────────────────────────────
    def publish(self, topic: str, payload: dict | None = None) -> None:
        """Thread-safe publish. Safe to call from any thread."""
        safe_payload = _json_safe(payload or {})
        evt = Event(
            topic=topic,
            payload=safe_payload if isinstance(safe_payload, dict) else {"value": safe_payload},
        )
        self._history.append(evt)
        if self._loop is None:
            return
        self._loop.call_soon_threadsafe(self._dispatch_async, evt)

    def _dispatch_async(self, evt: Event) -> None:
        for prefix, q in list(self._subs):
            if prefix and not evt.topic.startswith(prefix):
                continue
            try:
                q.put_nowait(evt)
            except asyncio.QueueFull:
                # drop oldest, push newest (best-effort, keep liveness)
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                try:
                    q.put_nowait(evt)
                except asyncio.QueueFull:
                    log.warning("event bus subscriber stalled; dropping %s", evt.topic)

    # ── consumers ────────────────────────────────────────────────
    async def subscribe(
        self, prefix: str = "", *, replay: int = 0
    ) -> AsyncIterator[Event]:
        """Async generator yielding events matching ``prefix``.

        ``replay``: if >0, replay up to N most recent matching events from history.
        """
        q: asyncio.Queue[Event] = asyncio.Queue(maxsize=self._queue_size)
        async with self._lock:
            self._subs.append((prefix, q))
        try:
            if replay:
                for evt in list(self._history)[-replay:]:
                    if not prefix or evt.topic.startswith(prefix):
                        yield evt
            while True:
                evt = await q.get()
                yield evt
        finally:
            async with self._lock:
                self._subs[:] = [(p, qq) for p, qq in self._subs if qq is not q]

    def history(self, prefix: str = "", limit: int = 100) -> list[Event]:
        out = [e for e in self._history if not prefix or e.topic.startswith(prefix)]
        return out[-limit:]


# Process-global singleton
bus = EventBus(history=1000)
