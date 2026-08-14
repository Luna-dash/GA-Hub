"""Unified lifecycle host for scheduler domain services.

The host owns the process scheduler runtime and startup/shutdown ordering.  It
deliberately does not merge the scheduled-chat, autonomous, and task domain
models or their persistence formats.
"""
from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from typing import Any, Callable

log = logging.getLogger(__name__)


@dataclass
class _Registration:
    name: str
    factory: Callable[[], Any]
    starter: Callable[[Any], None]
    stopper: Callable[[Any], None]
    service: Any | None = None
    started: bool = False
    error: str | None = None


class SchedulerHost:
    """Own one shared scheduler runtime and stop registered domains in reverse."""

    def __init__(self, runtime_factory: Callable[[], Any] | None = None) -> None:
        if runtime_factory is None:
            from apscheduler.schedulers.background import BackgroundScheduler

            runtime_factory = BackgroundScheduler
        self._runtime_factory = runtime_factory
        self._runtime: Any | None = None
        self._registrations: list[_Registration] = []
        self._lock = threading.RLock()

    @property
    def runtime(self) -> Any:
        """Return the shared runtime, creating it before the first domain start."""
        with self._lock:
            if self._runtime is None:
                self._runtime = self._runtime_factory()
            return self._runtime

    def register(
        self,
        name: str,
        factory: Callable[[], Any],
        *,
        starter: str = "start",
        stopper: str = "shutdown",
    ) -> None:
        with self._lock:
            if any(item.name == name for item in self._registrations):
                raise ValueError(f"scheduler {name!r} is already registered")
            self._registrations.append(_Registration(name, factory, starter, stopper))

    def start_all(self) -> None:
        """Start each domain independently so one failure cannot hide the others."""
        with self._lock:
            runtime = self.runtime
            try:
                if not runtime.running:
                    runtime.start()
            except Exception:
                log.exception("shared scheduler runtime failed to start")
                raise

            for item in self._registrations:
                try:
                    service = item.factory()
                    getattr(service, item.starter)()
                    item.service = service
                    item.started = True
                    item.error = None
                except Exception as exc:
                    item.service = None
                    item.started = False
                    item.error = str(exc)
                    log.exception("scheduler domain %s failed to start", item.name)

    def shutdown_all(self, *, timeout: float = 5.0) -> None:
        """Stop producers in reverse order, then stop the shared runtime last."""
        with self._lock:
            for item in reversed(self._registrations):
                if item.service is None:
                    continue
                try:
                    stopper = getattr(item.service, item.stopper)
                    try:
                        stopper(timeout=timeout)
                    except TypeError:
                        stopper()
                    item.started = False
                except Exception:
                    log.exception("scheduler domain %s failed to stop", item.name)

            runtime = self._runtime
            if runtime is not None:
                try:
                    runtime.shutdown(wait=False)
                except Exception:
                    log.exception("shared scheduler runtime failed to stop")

    def status(self) -> dict[str, dict[str, Any]]:
        with self._lock:
            runtime_running = bool(self._runtime is not None and self._runtime.running)
            result: dict[str, dict[str, Any]] = {
                "runtime": {"running": runtime_running},
            }
            for item in self._registrations:
                schedules = getattr(item.service, "schedules", None)
                result[item.name] = {
                    "state": "error" if item.error else ("running" if item.started else "stopped"),
                    "schedule_count": len(schedules) if schedules is not None else None,
                    "error": item.error,
                }
            return result
