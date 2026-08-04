"""Per-session runtime ownership with one process-wide run slot.

This module deliberately knows nothing about conversation persistence.  Each
runtime owns its GA agent/history; the coordinator only tracks runtime and run
identity so callers cannot abort or merge the wrong session.
"""
from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, replace
from typing import Any, Callable, Protocol


class RuntimeHandle(Protocol):
    stream_id: str
    finished: bool


class SessionRuntime(Protocol):
    def submit(self, text: str, **kwargs: Any) -> RuntimeHandle: ...
    def abort(self) -> None: ...
    def active_message_snapshot(
        self, stream_id: str, *, session_id: str, run_id: str
    ) -> dict[str, Any] | None: ...


class AgentBusyError(RuntimeError):
    def __init__(self, active_session_id: str, active_run_id: str) -> None:
        self.active_session_id = active_session_id
        self.active_run_id = active_run_id
        super().__init__(f"session {active_session_id!r} is already running")


class SessionNotActiveError(RuntimeError):
    pass


class RunMismatchError(RuntimeError):
    pass


@dataclass(frozen=True)
class RuntimeState:
    session_id: str
    status: str = "idle"
    run_id: str | None = None
    stream_id: str | None = None
    error: str | None = None


class SessionCoordinator:
    """Own lazily-created runtimes and serialize their execution globally."""

    def __init__(
        self,
        runtime_factory: Callable[[str], SessionRuntime],
        *,
        poll_interval: float = 0.05,
        abort_timeout: float = 10.0,
    ) -> None:
        self._runtime_factory = runtime_factory
        self._poll_interval = poll_interval
        self._abort_timeout = abort_timeout
        self._lock = threading.RLock()
        self._runtimes: dict[str, SessionRuntime] = {}
        self._states: dict[str, RuntimeState] = {}
        self._active: RuntimeState | None = None
        self._abort_started: dict[str, float] = {}

    def runtime_state(self, session_id: str) -> RuntimeState:
        with self._lock:
            return replace(self._states.get(session_id, RuntimeState(session_id)))

    def active_run(self) -> RuntimeState | None:
        with self._lock:
            return replace(self._active) if self._active is not None else None

    def session_snapshot(self, session_id: str) -> tuple[RuntimeState, dict[str, Any] | None]:
        """Return runtime identity and its matching active content together.

        The coordinator lock prevents the active run from being replaced while
        its session runtime is queried.  The runtime is responsible for taking
        its own content lock and rejecting mismatched identity.
        """
        with self._lock:
            state = replace(self._states.get(session_id, RuntimeState(session_id)))
            active_message = None
            if state.run_id and state.stream_id:
                runtime = self._runtimes.get(session_id)
                reader = getattr(runtime, "active_message_snapshot", None)
                if reader is not None:
                    active_message = reader(
                        state.stream_id,
                        session_id=session_id,
                        run_id=state.run_id,
                    )
            return state, active_message

    def submit(
        self,
        text: str,
        *,
        session_id: str,
        source: str = "webui",
        images: list[str] | None = None,
        llm_index: int | None = None,
    ) -> RuntimeState:
        run_id = uuid.uuid4().hex
        with self._lock:
            if self._active is not None:
                raise AgentBusyError(self._active.session_id, self._active.run_id or "")

            # Reserve before runtime construction: concurrent submits cannot
            # both pass the busy check, and a rejected session is not created.
            reserved = RuntimeState(session_id, "starting", run_id)
            self._active = reserved
            self._states[session_id] = reserved
            try:
                runtime = self._runtimes.get(session_id)
                if runtime is None:
                    runtime = self._runtime_factory(session_id)
                    self._runtimes[session_id] = runtime
                handle = runtime.submit(
                    text,
                    source=source,
                    images=images,
                    llm_index=llm_index,
                    session_id=session_id,
                    run_id=run_id,
                )
            except Exception:
                self._active = None
                self._states[session_id] = RuntimeState(session_id)
                raise

            running = RuntimeState(session_id, "running", run_id, handle.stream_id)
            self._active = running
            self._states[session_id] = running

        threading.Thread(
            target=self._watch_completion,
            args=(runtime, handle, session_id, run_id),
            daemon=True,
            name=f"session-run-{session_id[:12]}",
        ).start()
        return replace(running)

    def abort(self, *, session_id: str, run_id: str) -> RuntimeState:
        with self._lock:
            active = self._active
            if active is None or active.session_id != session_id:
                raise SessionNotActiveError(session_id)
            if active.run_id != run_id:
                raise RunMismatchError(run_id)
            if active.status in {"aborting", "error"}:
                return replace(active)

            runtime = self._runtimes[session_id]
            runtime.abort()
            aborting = replace(active, status="aborting")
            self._abort_started[run_id] = time.monotonic()
            self._active = aborting
            self._states[session_id] = aborting
            return replace(aborting)

    def _watch_completion(
        self,
        runtime: SessionRuntime,
        handle: RuntimeHandle,
        session_id: str,
        run_id: str,
    ) -> None:
        while not handle.finished:
            with self._lock:
                active = self._active
                abort_started = self._abort_started.get(run_id)
                if (
                    active is not None
                    and active.run_id == run_id
                    and active.status == "aborting"
                    and abort_started is not None
                    and time.monotonic() - abort_started >= self._abort_timeout
                ):
                    failed = replace(active, status="error", error="abort_timeout")
                    self._active = failed
                    self._states[session_id] = failed
            time.sleep(self._poll_interval)
        with self._lock:
            # A stale watcher must never clear a newer run.
            if self._active is None or self._active.run_id != run_id:
                return
            self._abort_started.pop(run_id, None)
            self._active = None
            self._states[session_id] = RuntimeState(session_id)
