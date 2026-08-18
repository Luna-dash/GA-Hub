"""Lifecycle ownership for short-lived background watcher threads."""
from __future__ import annotations

import threading
import time
from collections.abc import Callable


class WatcherRegistry:
    """Start, cancel, and join a bounded set of cooperative watcher threads."""

    def __init__(self, stop_event: threading.Event | None = None) -> None:
        self.stop_event = stop_event or threading.Event()
        self._lock = threading.Lock()
        self._callback_lock = threading.Lock()
        self._threads: set[threading.Thread] = set()
        self._accepting = True

    @property
    def active_count(self) -> int:
        with self._lock:
            return len(self._threads)

    @property
    def stopping(self) -> bool:
        with self._lock:
            return not self._accepting

    def reset(self) -> None:
        """Allow a fully stopped owner to be started again."""
        with self._lock:
            if self._threads:
                raise RuntimeError("cannot restart while watcher threads are still alive")
            self.stop_event.clear()
            self._accepting = True

    def request_stop(self) -> None:
        """Atomically prevent new work and wake cooperative watchers."""
        with self._lock:
            self._accepting = False
            self.stop_event.set()

    def run_if_active(self, callback: Callable[[], None]) -> bool:
        """Run a final side effect only if owner shutdown has not begun."""
        # This gate closes the check/callback race without involving the
        # registry state lock. Shutdown signals cancellation immediately and
        # uses the watcher join deadline if a callback was already in flight.
        with self._callback_lock:
            if self.stop_event.is_set():
                return False
            callback()
            return True

    def start(
        self,
        target: Callable[[threading.Event], None],
        *,
        name: str,
    ) -> bool:
        """Start a watcher unless shutdown has already begun."""

        def run() -> None:
            try:
                target(self.stop_event)
            finally:
                with self._lock:
                    self._threads.discard(threading.current_thread())

        with self._lock:
            if not self._accepting:
                return False
            thread = threading.Thread(target=run, daemon=True, name=name)
            self._threads.add(thread)
            try:
                thread.start()
            except BaseException:
                self._threads.discard(thread)
                raise
        return True

    def shutdown(self, timeout: float = 5.0) -> bool:
        """Reject new watchers, request cancellation, and join to a deadline."""
        deadline = time.monotonic() + max(0.0, timeout)
        self.request_stop()
        with self._lock:
            threads = tuple(self._threads)

        current = threading.current_thread()
        for thread in threads:
            if thread is current:
                continue
            thread.join(timeout=max(0.0, deadline - time.monotonic()))

        with self._lock:
            self._threads = {thread for thread in self._threads if thread.is_alive()}
            return not self._threads
