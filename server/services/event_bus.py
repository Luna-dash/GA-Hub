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
        with self.bus._state_lock:
            self.bus._subs[:] = [
                (prefixes, q)
                for prefixes, q in self.bus._subs
                if q is not self.queue
            ]
            self.bus._resumable_subs.pop(self.queue, None)
            self.bus._subscriber_loops.pop(self.queue, None)


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
        # ``_subs`` is intentionally kept as the legacy two-tuple shape for
        # callers/tests.  Keep the owning loop beside it so a new lifespan
        # never dispatches into a queue created by an older loop.
        self._subscriber_loops: dict[
            asyncio.Queue[Event], asyncio.AbstractEventLoop
        ] = {}
        self._history: deque[Event] = deque(maxlen=history)
        # Unrelated high-volume topics must not invalidate a filtered cursor.
        self._evicted_topic_ids: dict[str, int] = {}
        self._queue_size = queue_size
        self._lock = asyncio.Lock()
        self._state_lock = threading.Lock()
        self.epoch = uuid.uuid4().hex
        self._next_event_id = 1
        # Producers can publish from several worker threads.  Keep one
        # scheduled callback per burst instead of one callback per event;
        # this prevents high-volume streams from flooding the loop's ready
        # queue while retaining the event-id order in ``_pending_dispatch``.
        self._pending_dispatch: deque[Event] = deque()
        self._dispatch_scheduled = False
        self._dispatch_generation = 0
        self._dispatch_batch_size = 512

    def attach_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """Bind producers to the asyncio loop currently owning the app lifespan."""
        schedule = False
        generation = 0
        retired: list[tuple[asyncio.Queue[Event], asyncio.AbstractEventLoop | None]] = []
        with self._state_lock:
            if self._loop is loop:
                return
            old_loop = self._loop
            if old_loop is not None:
                # A new lifespan may replace an owner whose finalizer did not
                # run. Its queued live delivery belongs to the old subscriber
                # set; history remains available for cursor replay.
                self._pending_dispatch.clear()
                self._dispatch_scheduled = False
                retired = self._retire_subscriptions_locked(old_loop, "server_restarted")
            self._loop = loop
            self._dispatch_generation += 1
            generation = self._dispatch_generation
            if self._pending_dispatch and not self._dispatch_scheduled:
                self._dispatch_scheduled = True
                schedule = True
        self._wake_retired(retired)
        if schedule:
            self._schedule_dispatch(loop, generation)

    def detach_loop(self, loop: asyncio.AbstractEventLoop) -> bool:
        """Release ``loop`` without detaching a newer lifespan owner."""
        retired: list[tuple[asyncio.Queue[Event], asyncio.AbstractEventLoop | None]] = []
        with self._state_lock:
            if self._loop is not loop:
                return False
            self._loop = None
            self._dispatch_generation += 1
            self._dispatch_scheduled = False
            # Pending events remain in history and can be replayed by a new
            # subscriber. They must not cross an application lifespan into a
            # different loop or stale subscriber set.
            self._pending_dispatch.clear()
            retired = self._retire_subscriptions_locked(loop, "server_restarted")
        self._wake_retired(retired)
        return True

    def _retire_subscriptions_locked(
        self,
        owner: asyncio.AbstractEventLoop,
        reason: str,
    ) -> list[tuple[asyncio.Queue[Event], asyncio.AbstractEventLoop | None]]:
        """Remove subscriptions owned by ``owner`` while holding state lock."""
        retired: list[tuple[asyncio.Queue[Event], asyncio.AbstractEventLoop | None]] = []
        kept: list[tuple[tuple[str, ...], asyncio.Queue[Event]]] = []
        for prefixes, queue in self._subs:
            queue_owner = self._subscriber_loops.get(queue)
            # Entries restored by legacy callers may not have an owner map;
            # treat them as stale when replacing/detaching an owner.
            if queue_owner is not owner and queue_owner is not None:
                kept.append((prefixes, queue))
                continue
            subscription = self._resumable_subs.pop(queue, None)
            if subscription is not None:
                subscription.live_resync_reason = reason
            self._subscriber_loops.pop(queue, None)
            retired.append((queue, queue_owner))
        self._subs[:] = kept
        return retired

    @staticmethod
    def _wake_queue(queue: asyncio.Queue[Event]) -> None:
        """Wake a retired consumer without crossing its loop thread."""
        while True:
            try:
                queue.get_nowait()
            except asyncio.QueueEmpty:
                break
        try:
            queue.put_nowait(None)  # type: ignore[arg-type]
        except asyncio.QueueFull:
            # A queue can only refill between the drain and put for a custom
            # queue implementation; the subscription is already retired.
            pass

    def _wake_retired(
        self,
        retired: list[tuple[asyncio.Queue[Event], asyncio.AbstractEventLoop | None]],
    ) -> None:
        for queue, owner in retired:
            if owner is None or owner.is_closed():
                continue
            try:
                owner.call_soon_threadsafe(self._wake_queue, queue)
            except RuntimeError:
                # The old loop can close between the check and scheduling.
                continue

    def _schedule_dispatch(
        self, loop: asyncio.AbstractEventLoop, generation: int
    ) -> None:
        try:
            loop.call_soon_threadsafe(self._drain_dispatch, loop, generation)
        except RuntimeError:
            # A loop may close between acquiring the state lock and posting
            # the callback. Keep history, but make the bus available for a
            # later lifespan or a clean detach.
            with self._state_lock:
                if self._loop is loop and self._dispatch_generation == generation:
                    self._loop = None
                    self._dispatch_scheduled = False
                    self._pending_dispatch.clear()

    def _drain_dispatch(
        self, loop: asyncio.AbstractEventLoop, generation: int
    ) -> None:
        """Dispatch one bounded batch and schedule the next batch if needed."""
        with self._state_lock:
            if self._loop is not loop or self._dispatch_generation != generation:
                return
            batch: list[Event] = []
            while self._pending_dispatch and len(batch) < self._dispatch_batch_size:
                batch.append(self._pending_dispatch.popleft())
            has_more = bool(self._pending_dispatch)
            if not has_more:
                self._dispatch_scheduled = False

        try:
            for evt in batch:
                try:
                    self._dispatch_async(evt)
                except Exception:
                    # One malformed/stale subscriber must not abort the rest
                    # of a bounded batch or strand the next scheduled batch.
                    log.exception("event bus subscriber dispatch failed")
        finally:
            if has_more:
                try:
                    loop.call_soon(self._drain_dispatch, loop, generation)
                except RuntimeError:
                    with self._state_lock:
                        if self._loop is loop and self._dispatch_generation == generation:
                            self._loop = None
                            self._dispatch_scheduled = False
                            self._pending_dispatch.clear()

    # ── producers ────────────────────────────────────────────────
    def publish(self, topic: str, payload: dict | None = None) -> None:
        """Thread-safe publish. Safe to call from any thread."""
        safe_payload = _json_safe(payload or {})
        schedule = False
        loop: asyncio.AbstractEventLoop | None = None
        generation = 0
        with self._state_lock:
            event_id = self._next_event_id
            self._next_event_id += 1
            evt = Event(
                topic=topic,
                payload=safe_payload if isinstance(safe_payload, dict) else {"value": safe_payload},
                event_id=event_id,
            )
            if self._history.maxlen == 0:
                self._evicted_topic_ids[evt.topic] = evt.event_id
            elif (
                self._history.maxlen is not None
                and len(self._history) == self._history.maxlen
            ):
                evicted = self._history[0]
                self._evicted_topic_ids[evicted.topic] = evicted.event_id
            self._history.append(evt)
            loop = self._loop
            if loop is None:
                return
            self._pending_dispatch.append(evt)
            if not self._dispatch_scheduled:
                self._dispatch_scheduled = True
                generation = self._dispatch_generation
                schedule = True
        if schedule and loop is not None:
            self._schedule_dispatch(loop, generation)

    def _dispatch_async(self, evt: Event) -> None:
        with self._state_lock:
            subscriptions = list(self._subs)
            subscriber_loops = dict(self._subscriber_loops)
        current_loop = asyncio.get_running_loop()
        for prefixes, q in subscriptions:
            owner = subscriber_loops.get(q)
            if owner is not None and owner is not current_loop:
                continue
            if not _matches_topic(evt.topic, prefixes):
                continue
            try:
                q.put_nowait(evt)
            except asyncio.QueueFull:
                with self._state_lock:
                    resumable = self._resumable_subs.get(q)
                if resumable is not None:
                    # A resumable subscriber must never silently skip an event.
                    # Discard queued data, then wake live() with a sentinel;
                    # the client will reconnect without a cursor.
                    with self._state_lock:
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
        owner_loop = asyncio.get_running_loop()
        async with self._lock:
            with self._state_lock:
                self._subs.append((prefixes, q))
                self._subscriber_loops[q] = owner_loop
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
                if evt is None:
                    return
                yield evt
        finally:
            with self._state_lock:
                self._subs[:] = [
                    (sub_prefixes, qq)
                    for sub_prefixes, qq in self._subs
                    if qq is not q
                ]
                self._subscriber_loops.pop(q, None)

    async def subscribe_after(
        self, prefix: EventPrefixFilter = "", *, after_event_id: int | None = None,
        epoch: str | None = None, replay: int = 0,
    ) -> EventSubscription:
        """Atomically subscribe and capture events through a fixed boundary."""
        prefixes = _normalize_prefixes(prefix)
        q: asyncio.Queue[Event] = asyncio.Queue(maxsize=self._queue_size)
        owner_loop = asyncio.get_running_loop()
        async with self._lock:
            with self._state_lock:
                history = list(self._history)
                boundary_id = self._next_event_id - 1
                resync_reason: str | None = None
                if after_event_id is not None:
                    if epoch != self.epoch:
                        resync_reason = "server_restarted"
                    elif after_event_id > boundary_id:
                        resync_reason = "cursor_ahead"
                    elif any(
                        event_id > after_event_id
                        and _matches_topic(topic, prefixes)
                        for topic, event_id in self._evicted_topic_ids.items()
                    ):
                        resync_reason = "history_window_exceeded"
                if resync_reason is not None:
                    replay_events: list[Event] = []
                elif after_event_id is not None:
                    replay_events = [
                        e for e in history
                        if e.event_id > after_event_id
                        and e.event_id <= boundary_id
                        and _matches_topic(e.topic, prefixes)
                    ]
                else:
                    replay_count = max(0, replay)
                    matching_history = [
                        e for e in history
                        if _matches_topic(e.topic, prefixes)
                    ]
                    replay_events = matching_history[-replay_count:] if replay_count else []
                subscription = EventSubscription(
                    bus=self, prefixes=prefixes, queue=q, boundary_id=boundary_id,
                    replay=replay_events, resync_reason=resync_reason,
                )
                self._subs.append((prefixes, q))
                self._resumable_subs[q] = subscription
                self._subscriber_loops[q] = owner_loop
        return subscription

    def history(self, prefix: EventPrefixFilter = "", limit: int = 100) -> list[Event]:
        prefixes = _normalize_prefixes(prefix)
        with self._state_lock:
            out = [e for e in self._history if _matches_topic(e.topic, prefixes)]
        return out[-limit:]


# Process-global singleton
bus = EventBus(history=1000)
