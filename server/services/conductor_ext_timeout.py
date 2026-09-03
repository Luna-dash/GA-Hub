"""Hub-only Conductor output budgets and timeout warnings (Phase C.2)."""
from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable, Iterable
from typing import Any

from .conductor_vocabulary import SUBAGENT_RUNNING

log = logging.getLogger(__name__)

Publish = Callable[[str, dict], Any]


class TimeoutMonitor:
    """Emit one warning per running subagent and timeout kind; never kill it."""

    def __init__(
        self,
        core: Any,
        *,
        silence_timeout: float = 120.0,
        total_timeout: float = 600.0,
        check_interval: float = 10.0,
        publish: Publish | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        if min(silence_timeout, total_timeout, check_interval) <= 0:
            raise ValueError("timeouts and check interval must be positive")
        self.core = core
        self.silence_timeout = silence_timeout
        self.total_timeout = total_timeout
        self.check_interval = check_interval
        self.publish = publish
        self.clock = clock
        self._emitted: set[tuple[str, int, str]] = set()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def _states(self) -> Iterable[Any]:
        lock = getattr(self.core, "lock", None)
        if lock is None:
            return list(getattr(self.core, "subagents", {}).values())
        with lock:
            return list(getattr(self.core, "subagents", {}).values())

    def check_once(self) -> list[tuple[str, str]]:
        """Evaluate current state and return newly emitted ``(id, kind)`` pairs."""
        now = self.clock()
        emitted: list[tuple[str, str]] = []
        states = self._states()
        live_generations = {
            (str(state.id), int(getattr(state, "active_generation", 0)))
            for state in states
            if getattr(state, "status", None) == SUBAGENT_RUNNING
        }
        self._emitted = {
            key for key in self._emitted
            if key[:2] in live_generations
        }
        for state in states:
            if getattr(state, "status", None) != "running":
                continue
            agent_id = str(state.id)
            generation = int(getattr(state, "active_generation", 0))
            checks = (
                ("silence", now - float(state.updated_at), self.silence_timeout),
                ("total", now - float(state.created_at), self.total_timeout),
            )
            for kind, elapsed, limit in checks:
                key = (agent_id, generation, kind)
                if elapsed < limit or key in self._emitted:
                    continue
                self._emitted.add(key)
                emitted.append((agent_id, kind))
                if self.publish is not None:
                    self.publish(f"conductor:subagent_timeout_{kind}", {
                        "id": agent_id,
                        "generation": generation,
                        "elapsed_seconds": elapsed,
                        "limit_seconds": limit,
                        "action": "warning_only",
                    })
        return emitted

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run, name="conductor-timeout-monitor", daemon=True
        )
        self._thread.start()

    def stop(self, timeout: float = 1.0) -> bool:
        """Request the monitor to stop and reap it within ``timeout``.

        The monitor is deliberately never force-killed.  A timed-out thread
        remains referenced so a later shutdown attempt can finish reaping the
        same owner.  Returning the join result lets the service aggregate this
        helper with the core conductor under one shutdown deadline.
        """
        self._stop.set()
        thread = self._thread
        if thread is None:
            return True
        if thread is threading.current_thread():
            # Joining the current thread would raise and would make shutdown
            # non-idempotent when called from an unusual monitor callback.
            return False

        try:
            alive = thread.is_alive()
        except Exception:
            # Thread-like test doubles may not expose ``is_alive``.  Preserve
            # the old best-effort behavior and let join determine the result.
            alive = True
        if alive:
            thread.join(timeout=max(0.0, float(timeout)))

        try:
            alive = thread.is_alive()
        except Exception:
            alive = False
        if not alive:
            # Clear only after observing termination.  On timeout the live
            # reference is intentionally retained for the next retry.
            if self._thread is thread:
                self._thread = None
            return True
        return False

    def _run(self) -> None:
        while not self._stop.wait(self.check_interval):
            try:
                self.check_once()
            except Exception:
                # A single malformed snapshot (engine dict missing a field,
                # mid-mutation state) must never kill the monitor thread:
                # that would silence every timeout warning for the rest of
                # the supervisor's life with no error on any request path.
                log.exception("timeout monitor check failed")
