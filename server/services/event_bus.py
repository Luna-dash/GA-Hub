"""Async event bus with topic-style fan-out.

Bridges blocking producer threads (agent run loop, WeChat polling) and
asyncio consumers (WebSocket subscribers). Producers call ``publish``
from any thread; consumers ``subscribe`` from the asyncio event loop.

Topics use ``namespace:event`` convention. A subscriber may filter by one
or more prefixes (e.g. ``"wechat:"``) or subscribe to all (``""``).
"""
from __future__ import annotations

import asyncio
import dataclasses
import logging
import threading
import time
import uuid
from collections import deque
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator, Callable

log = logging.getLogger(__name__)

EventPrefixFilter = str | Iterable[str]


def _normalize_prefixes(prefixes: EventPrefixFilter = "") -> tuple[str, ...]:
    """Return a stable prefix set; an empty tuple matches every topic."""
    if isinstance(prefixes, str):
        return (prefixes,) if prefixes else ()
    values = tuple(prefixes)
    if not values or "" in values:
        return ()
    return tuple(dict.fromkeys(values))


def _matches_topic(topic: str, prefixes: tuple[str, ...]) -> bool:
    return not prefixes or any(topic.startswith(prefix) for prefix in prefixes)


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
    event_id: int = 0


@dataclass
class EventSubscription:
    """Atomically captured replay window followed by live events."""

    bus: "EventBus"
    prefixes: tuple[str, ...]
    queue: asyncio.Queue
    boundary_id: int
    replay: list[Event]
    resync_reason: str | None = None
    live_resync_reason: str | None = None
    closed: bool = False

    async def live(self) -> AsyncIterator[Event]:
        while not self.closed:
            if self.live_resync_reason is not None:
                return
            event = await self.queue.get()
            if event is None or self.live_resync_reason is not None:
                return
            # Events already captured in replay may still have had a dispatch
            # callback queued when this subscription was registered.
            if event.event_id <= self.boundary_id:
                continue
            yield event

    async def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        async with self.bus._lock:
            self.bus._subs[:] = [
                (prefixes, q)
                for prefixes, q in self.bus._subs
                if q is not self.queue
            ]
            self.bus._resumable_subs.pop(self.queue, None)


class EventBus:
    """Thread-safe → asyncio fan-out.

    Producer side is sync (thread-safe). Consumer side is asyncio.

    Each subscriber gets its own bounded queue; if it falls behind we drop
    oldest events for that subscriber rather than blocking the producer.
    """

    def __init__(self, history: int = 200, queue_size: int = 256):
        self._loop: asyncio.AbstractEventLoop | None = None
        self._subs: list[tuple[tuple[str, ...], asyncio.Queue[Event]]] = []
        self._resumable_subs: dict[asyncio.Queue[Event], EventSubscription] = {}
        self._history: deque[Event] = deque(maxlen=history)
        self._queue_size = queue_size
        self._lock = asyncio.Lock()
        self._state_lock = threading.Lock()
        self.epoch = uuid.uuid4().hex
        self._next_event_id = 1

    def attach_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """Bind producers to the asyncio loop currently owning the app lifespan."""
        with self._state_lock:
            self._loop = loop

    def detach_loop(self, loop: asyncio.AbstractEventLoop) -> bool:
        """Release ``loop`` without detaching a newer lifespan owner."""
        with self._state_lock:
            if self._loop is not loop:
                return False
            self._loop = None
            return True

    # ── producers ────────────────────────────────────────────────
    def publish(self, topic: str, payload: dict | None = None) -> None:
        """Thread-safe publish. Safe to call from any thread."""
        safe_payload = _json_safe(payload or {})
        with self._state_lock:
            event_id = self._next_event_id
            self._next_event_id += 1
            evt = Event(
                topic=topic,
                payload=safe_payload if isinstance(safe_payload, dict) else {"value": safe_payload},
                event_id=event_id,
            )
            self._history.append(evt)
            loop = self._loop
            if loop is None:
                return
            try:
                loop.call_soon_threadsafe(self._dispatch_async, evt)
            except RuntimeError:
                # A loop may close unexpectedly between application teardown
                # and a late producer publish. Keep history, but do not let the
                # stale delivery target break that producer thread.
                if not loop.is_closed():
                    raise
                if self._loop is loop:
                    self._loop = None

    def _dispatch_async(self, evt: Event) -> None:
        for prefixes, q in list(self._subs):
            if not _matches_topic(evt.topic, prefixes):
                continue
            try:
                q.put_nowait(evt)
            except asyncio.QueueFull:
                resumable = self._resumable_subs.get(q)
                if resumable is not None:
                    # A resumable subscriber must never silently skip an event.
                    # Discard queued data, then wake live() with a sentinel;
                    # the client will reconnect without a cursor.
                    resumable.live_resync_reason = "subscriber_overflow"
                    while True:
                        try:
                            q.get_nowait()
                        except asyncio.QueueEmpty:
                            break
                    q.put_nowait(None)
                    continue
                # Legacy subscribers retain the historical best-effort policy.
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
        self, prefix: EventPrefixFilter = "", *, replay: int = 0
    ) -> AsyncIterator[Event]:
        """Async generator yielding events matching any requested prefix.

        ``replay``: if >0, replay up to N most recent matching events from history.
        """
        prefixes = _normalize_prefixes(prefix)
        q: asyncio.Queue[Event] = asyncio.Queue(maxsize=self._queue_size)
        async with self._lock:
            self._subs.append((prefixes, q))
        try:
            if replay:
                matching_history = [
                    evt
                    for evt in list(self._history)
                    if _matches_topic(evt.topic, prefixes)
                ]
                for evt in matching_history[-replay:]:
                    yield evt
            while True:
                evt = await q.get()
                yield evt
        finally:
            async with self._lock:
                self._subs[:] = [
                    (sub_prefixes, qq)
                    for sub_prefixes, qq in self._subs
                    if qq is not q
                ]

    async def subscribe_after(
        self, prefix: EventPrefixFilter = "", *, after_event_id: int | None = None,
        epoch: str | None = None,
    ) -> EventSubscription:
        """Atomically subscribe and capture events through a fixed boundary."""
        prefixes = _normalize_prefixes(prefix)
        q: asyncio.Queue[Event] = asyncio.Queue(maxsize=self._queue_size)
        async with self._lock:
            with self._state_lock:
                history = list(self._history)
                boundary_id = self._next_event_id - 1
                oldest_id = history[0].event_id if history else boundary_id + 1
                resync_reason: str | None = None
                if after_event_id is not None:
                    if epoch != self.epoch:
                        resync_reason = "server_restarted"
                    elif after_event_id > boundary_id:
                        resync_reason = "cursor_ahead"
                    elif after_event_id < oldest_id - 1:
                        resync_reason = "history_window_exceeded"
                replay = [] if after_event_id is None or resync_reason else [
                    e for e in history
                    if e.event_id > after_event_id
                    and e.event_id <= boundary_id
                    and _matches_topic(e.topic, prefixes)
                ]
                subscription = EventSubscription(
                    bus=self, prefixes=prefixes, queue=q, boundary_id=boundary_id,
                    replay=replay, resync_reason=resync_reason,
                )
                self._subs.append((prefixes, q))
                self._resumable_subs[q] = subscription
        return subscription

    def history(self, prefix: EventPrefixFilter = "", limit: int = 100) -> list[Event]:
        prefixes = _normalize_prefixes(prefix)
        with self._state_lock:
            out = [e for e in self._history if _matches_topic(e.topic, prefixes)]
        return out[-limit:]


# Process-global singleton
bus = EventBus(history=1000)
