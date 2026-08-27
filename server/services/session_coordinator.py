"""Per-session runtime ownership with bounded process-wide run capacity.

This module deliberately knows nothing about conversation persistence. Each
runtime owns its GA agent/history; the coordinator atomically admits runs and
tracks their identity so callers cannot abort or clear the wrong session.
"""
from __future__ import annotations

import logging
import threading
import time
import uuid
from dataclasses import dataclass, replace
from typing import Any, Callable, Protocol


log = logging.getLogger(__name__)


class RuntimeHandle(Protocol):
    stream_id: str
    finished: bool


class SessionRuntime(Protocol):
    def submit(self, text: str, **kwargs: Any) -> RuntimeHandle: ...
    def btw(self, question: str) -> str: ...
    def rewind_turns(self, *, sid: str | None = None, n: int | None = None) -> dict: ...
    def abort(self) -> None: ...
    def shutdown(self, timeout: float = 5.0) -> bool: ...
    def active_message_snapshot(
        self, stream_id: str, *, session_id: str, run_id: str
    ) -> dict[str, Any] | None: ...


class AgentBusyError(RuntimeError):
    """Admission failed because this session or the global capacity is busy.

    ``reason`` disambiguates the two distinct causes so callers can map them to
    different machine codes / messages instead of pretending every conflict is a
    capacity overflow:

    * ``session_active`` – the *same* session already owns an admitted run
      (running or still aborting). This is a serial guard, not a capacity one.
    * ``capacity_full`` – the process-wide run capacity is exhausted by other
      sessions. This is the genuine "choose another running session" case.
    """

    REASON_SESSION_ACTIVE = "session_active"
    REASON_CAPACITY_FULL = "capacity_full"

    def __init__(
        self,
        active_session_id: str,
        active_run_id: str,
        *,
        capacity: int = 1,
        active_count: int = 1,
        reason: str = REASON_CAPACITY_FULL,
    ) -> None:
        self.active_session_id = active_session_id
        self.active_run_id = active_run_id
        self.capacity = capacity
        self.active_count = active_count
        self.reason = reason
        super().__init__(
            f"run capacity {active_count}/{capacity} is occupied; "
            f"session {active_session_id!r} is active"
        )


class SessionNotActiveError(RuntimeError):
    pass


class RunMismatchError(RuntimeError):
    pass


class SessionControlBusyError(RuntimeError):
    """A session-scoped control operation conflicts with another one."""

    def __init__(self, session_id: str, operation: str) -> None:
        self.session_id = session_id
        self.operation = operation
        super().__init__(
            f"session {session_id!r} is busy with control operation {operation!r}"
        )


class SessionCoordinatorStoppedError(RuntimeError):
    """Raised when a session run arrives after coordinator shutdown started."""


@dataclass(frozen=True)
class RuntimeState:
    session_id: str
    status: str = "idle"
    run_id: str | None = None
    stream_id: str | None = None
    error: str | None = None
    completed_run_id: str | None = None


class SessionCoordinator:
    """Own lazily-created runtimes and atomically enforce bounded capacity."""

    def __init__(
        self,
        runtime_factory: Callable[[str], SessionRuntime],
        *,
        capacity: int = 1,
        poll_interval: float = 0.05,
        abort_timeout: float = 10.0,
        on_state_change: Callable[[RuntimeState], None] | None = None,
    ) -> None:
        if capacity not in {1, 2, 3, 4, 5}:
            raise ValueError("session run capacity must be between 1 and 5")
        self._runtime_factory = runtime_factory
        self._capacity = capacity
        self._poll_interval = poll_interval
        self._abort_timeout = abort_timeout
        self._on_state_change = on_state_change
        self._lock = threading.RLock()
        self._lifecycle_state_lock = threading.Lock()
        self._shutdown_lock = threading.Lock()
        self._runtimes: dict[str, SessionRuntime] = {}
        self._states: dict[str, RuntimeState] = {}
        # One entry per admitted session. Entries remain until the underlying
        # handle really finishes, including while aborting or timed out.
        self._active_by_session: dict[str, RuntimeState] = {}
        self._abort_started: dict[str, float] = {}
        # Rewind mutates the runtime history/archive and must be exclusive for
        # one session. BTW is read-only against a history snapshot: multiple
        # BTW calls and a normal run may overlap, but rewind/configuration may
        # not cross an in-flight BTW snapshot.
        self._exclusive_controls: dict[str, str] = {}
        self._side_questions: dict[str, int] = {}
        self._shutdown_requested = False
        self._watchers: dict[str, threading.Thread] = {}
        self._shutdown_workers: dict[str, tuple[threading.Thread, dict[str, Any]]] = {}
        self._shutdown_abort_workers: dict[str, tuple[threading.Thread, dict[str, Any]]] = {}

    @property
    def capacity(self) -> int:
        return self._capacity

    def runtime_state(self, session_id: str) -> RuntimeState:
        with self._lock:
            return replace(self._states.get(session_id, RuntimeState(session_id)))

    def active_runs(self) -> tuple[RuntimeState, ...]:
        with self._lock:
            return tuple(replace(state) for state in self._active_by_session.values())

    def active_run(self) -> RuntimeState | None:
        """Backward-compatible first active run (capacity defaults to one)."""
        runs = self.active_runs()
        return runs[0] if runs else None

    def configure_if_idle(
        self,
        session_id: str,
        configure: Callable[[SessionRuntime | None], Any],
    ) -> Any:
        """Atomically configure a session without creating an idle runtime."""
        with self._lock:
            self._raise_if_shutdown()
            active = self._active_by_session.get(session_id)
            if active is not None:
                raise self._busy(active, reason=AgentBusyError.REASON_SESSION_ACTIVE)
            self._raise_if_control_busy(session_id, include_side_questions=True)
            return configure(self._runtimes.get(session_id))

    def side_question(self, session_id: str, question: str) -> str:
        """Run BTW against this session runtime without consuming run capacity.

        Runtime lookup/creation and the BTW reservation are atomic, but the
        potentially slow model call runs outside the coordinator lock. Normal
        submissions remain allowed, preserving GA's snapshot-based BTW
        concurrency semantics.
        """
        with self._lock:
            self._raise_if_shutdown()
            self._raise_if_control_busy(session_id)
            runtime = self._runtime_for_session_locked(session_id)
            self._side_questions[session_id] = self._side_questions.get(session_id, 0) + 1
        try:
            return runtime.btw(question)
        finally:
            with self._lock:
                remaining = self._side_questions.get(session_id, 0) - 1
                if remaining > 0:
                    self._side_questions[session_id] = remaining
                else:
                    self._side_questions.pop(session_id, None)

    def rewind(
        self,
        session_id: str,
        *,
        sid: str | None = None,
        n: int | None = None,
    ) -> dict:
        """Exclusively rewind one session while leaving others independent."""
        with self._lock:
            self._raise_if_shutdown()
            active = self._active_by_session.get(session_id)
            if active is not None:
                raise self._busy(active, reason=AgentBusyError.REASON_SESSION_ACTIVE)
            self._raise_if_control_busy(session_id, include_side_questions=True)
            self._exclusive_controls[session_id] = "rewind"
            try:
                runtime = self._runtime_for_session_locked(session_id)
            except BaseException:
                self._exclusive_controls.pop(session_id, None)
                raise
        try:
            return runtime.rewind_turns(sid=sid, n=n)
        finally:
            with self._lock:
                if self._exclusive_controls.get(session_id) == "rewind":
                    self._exclusive_controls.pop(session_id, None)

    def exclusive(
        self,
        session_id: str,
        operation: str,
        action: Callable[[], Any],
    ) -> Any:
        """Run a session-scoped mutating action under coordinator admission."""
        with self._lock:
            self._raise_if_shutdown()
            active = self._active_by_session.get(session_id)
            if active is not None:
                raise self._busy(active, reason=AgentBusyError.REASON_SESSION_ACTIVE)
            self._raise_if_control_busy(session_id, include_side_questions=True)
            self._exclusive_controls[session_id] = operation
        try:
            return action()
        finally:
            with self._lock:
                if self._exclusive_controls.get(session_id) == operation:
                    self._exclusive_controls.pop(session_id, None)

    def release_runtime(
        self,
        session_id: str,
        *,
        shutdown: Callable[[SessionRuntime], Any] | None = None,
        operation: str = "release",
        after_release: Callable[[], Any] | None = None,
    ) -> bool:
        """Detach, stop, and dispose identity in one exclusive reservation.

        ``after_release`` runs while the session control reservation is still
        held. It is used for metadata/archive deletion so a concurrent submit
        cannot recreate a runtime between shutdown and persistent deletion.
        """
        def _release() -> bool:
            runtime = self._runtimes.pop(session_id, None)
            if runtime is not None and shutdown is not None:
                shutdown(runtime)
            if after_release is not None:
                after_release()
            return runtime is not None

        return self.exclusive(session_id, operation, _release)

    def session_snapshot(self, session_id: str) -> tuple[RuntimeState, dict[str, Any] | None]:
        """Return runtime identity and its matching active content together."""
        with self._lock:
            state = replace(self._states.get(session_id, RuntimeState(session_id)))
            if state.status == "idle" or not state.run_id or not state.stream_id:
                return state, None
            runtime = self._runtimes.get(session_id)
            if runtime is None:
                return state, None
            snapshotter = getattr(runtime, "active_message_snapshot", None)
            if snapshotter is None:
                return state, None
            active_message = snapshotter(
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
        llm_key: str | None = None,
    ) -> RuntimeState:
        # Admission, per-session identity reservation, runtime creation and
        # submit are one critical section. No concurrent caller can overbook a
        # slot or start a second run for this session.
        with self._lock:
            self._raise_if_shutdown()
            self._raise_if_control_busy(session_id)
            same_session = self._active_by_session.get(session_id)
            if same_session is not None:
                raise self._busy(
                    same_session, reason=AgentBusyError.REASON_SESSION_ACTIVE
                )
            if len(self._active_by_session) >= self._capacity:
                raise self._busy(
                    next(iter(self._active_by_session.values())),
                    reason=AgentBusyError.REASON_CAPACITY_FULL,
                )

            run_id = uuid.uuid4().hex
            starting = RuntimeState(session_id, "starting", run_id)
            self._active_by_session[session_id] = starting
            self._states[session_id] = starting
            try:
                runtime = self._runtime_for_session_locked(session_id)
                handle = runtime.submit(
                    text,
                    source=source,
                    images=images,
                    llm_index=llm_index,
                    llm_key=llm_key,
                    session_id=session_id,
                    run_id=run_id,
                )
            except BaseException:
                if self._active_by_session.get(session_id) == starting:
                    self._active_by_session.pop(session_id, None)
                    self._states[session_id] = RuntimeState(session_id)
                raise

            running = RuntimeState(session_id, "running", run_id, handle.stream_id)
            self._active_by_session[session_id] = running
            self._states[session_id] = running

        watcher = threading.Thread(
            target=self._watch_completion,
            args=(runtime, handle, session_id, run_id),
            daemon=True,
            name=f"session-run-{session_id[:12]}",
        )
        with self._lock:
            self._watchers[run_id] = watcher
            # Register and start atomically with respect to shutdown.  Once a
            # watcher is visible to ``shutdown()``, joining it must be valid.
            watcher.start()
        return replace(running)

    def _runtime_for_session_locked(self, session_id: str) -> SessionRuntime:
        runtime = self._runtimes.get(session_id)
        if runtime is None:
            runtime = self._runtime_factory(session_id)
            self._runtimes[session_id] = runtime
        return runtime

    def _raise_if_control_busy(
        self, session_id: str, *, include_side_questions: bool = False
    ) -> None:
        operation = self._exclusive_controls.get(session_id)
        if operation is not None:
            raise SessionControlBusyError(session_id, operation)
        if include_side_questions and self._side_questions.get(session_id, 0) > 0:
            raise SessionControlBusyError(session_id, "btw")

    def _raise_if_shutdown(self) -> None:
        with self._lifecycle_state_lock:
            shutting_down = self._shutdown_requested
        if shutting_down:
            raise SessionCoordinatorStoppedError(
                "session coordinator is shutting down"
            )

    def _request_shutdown(self) -> None:
        with self._lifecycle_state_lock:
            self._shutdown_requested = True

    def _shutdown_is_requested(self) -> bool:
        with self._lifecycle_state_lock:
            return self._shutdown_requested

    def _controls_active(self, deadline: float) -> bool | None:
        remaining = self._remaining(deadline)
        if remaining <= 0.0 or not self._lock.acquire(timeout=remaining):
            return None
        try:
            return bool(self._exclusive_controls or self._side_questions)
        finally:
            self._lock.release()

    @staticmethod
    def _remaining(deadline: float) -> float:
        return max(0.0, deadline - time.monotonic())

    def _wait_for_controls(self, deadline: float) -> bool:
        while True:
            active = self._controls_active(deadline)
            if active is None:
                return False
            if not active:
                return True
            remaining = self._remaining(deadline)
            if remaining <= 0.0:
                return False
            time.sleep(min(self._poll_interval, remaining))

    def _start_shutdown_worker(
        self,
        registry: dict[str, tuple[threading.Thread, dict[str, Any]]],
        key: str,
        action: Callable[[], Any],
    ) -> tuple[threading.Thread, dict[str, Any]]:
        existing = registry.get(key)
        if existing is not None:
            if existing[0].is_alive():
                return existing
            outcome = existing[1]
            if outcome["error"] is None and outcome["result"] is not False:
                return existing
            # A completed failed attempt may be retried on the next bounded
            # shutdown pass; successful work stays single-flight too.
            registry.pop(key, None)
        outcome: dict[str, Any] = {"result": None, "error": None}

        def _run() -> None:
            try:
                outcome["result"] = action()
            except BaseException as exc:
                outcome["error"] = exc

        thread = threading.Thread(
            target=_run,
            daemon=True,
            name=f"session-shutdown-{str(key)[:12]}",
        )
        registry[key] = (thread, outcome)
        thread.start()
        return thread, outcome

    def _join_shutdown_workers(
        self,
        workers: tuple[tuple[threading.Thread, dict[str, Any]], ...],
        deadline: float,
    ) -> bool:
        stopped = True
        for thread, outcome in workers:
            thread.join(timeout=self._remaining(deadline))
            if thread.is_alive() or outcome["error"] is not None:
                stopped = False
            elif outcome["result"] is False:
                stopped = False
        return stopped

    def _mark_shutdown_aborting(
        self, active: RuntimeState, deadline: float
    ) -> tuple[tuple[str, SessionRuntime] | None, bool]:
        remaining = self._remaining(deadline)
        if remaining <= 0.0 or not self._lock.acquire(timeout=remaining):
            return None, False
        try:
            current = self._active_by_session.get(active.session_id)
            if current is None or current.run_id != active.run_id:
                return None, True
            runtime = self._runtimes.get(active.session_id)
            if runtime is None or not current.run_id:
                return None, True
            if current.status in {"aborting", "error"}:
                # A previous shutdown abort worker may have failed. Returning
                # the identity lets the retry path replace that failed worker;
                # a still-running or successful worker remains single-flight.
                return (current.run_id, runtime), True
            aborting = replace(current, status="aborting")
            self._abort_started[current.run_id] = time.monotonic()
            self._active_by_session[active.session_id] = aborting
            self._states[active.session_id] = aborting
            return (current.run_id, runtime), True
        finally:
            self._lock.release()

    def _shutdown_abort(self, run_id: str, runtime: SessionRuntime) -> None:
        self._start_shutdown_worker(
            self._shutdown_abort_workers,
            run_id,
            runtime.abort,
        )

    def shutdown(self, timeout: float = 3.0) -> bool:
        """Stop every cached runtime under one bounded lifecycle deadline.

        Runtime shutdown is intentionally outside the coordinator lock because
        it can join worker threads. The shutdown gate is set first so no new
        submit/control operation can recreate work while those workers drain.
        A timed-out coordinator keeps its runtime references and can be called
        again to finish cleanup.
        """
        deadline = time.monotonic() + max(0.0, timeout)
        # Only one caller may own runtime shutdown. A second caller can retry
        # after the first bounded attempt has released this lifecycle lock.
        if not self._shutdown_lock.acquire(timeout=self._remaining(deadline)):
            return False
        try:
            self._request_shutdown()
            if not self._wait_for_controls(deadline):
                return False

            remaining = self._remaining(deadline)
            if remaining <= 0.0 or not self._lock.acquire(timeout=remaining):
                return False
            try:
                active = tuple(self._active_by_session.values())
            finally:
                self._lock.release()

            # Mark identities under the coordinator lock, but execute the
            # potentially blocking runtime.abort calls in daemon workers.
            stopped = True
            for state in active:
                marked, acquired = self._mark_shutdown_aborting(state, deadline)
                if not acquired:
                    stopped = False
                    break
                if marked is not None:
                    run_id, runtime = marked
                    self._shutdown_abort(run_id, runtime)
            abort_workers = tuple(self._shutdown_abort_workers.values())
            aborts_stopped = self._join_shutdown_workers(abort_workers, deadline)
            # Completed failures must not poison every later shutdown attempt.
            # Keep successful/alive workers for single-flight reuse; retryable
            # failures are recreated when the still-active run is inspected.
            for run_id, (thread, outcome) in tuple(
                self._shutdown_abort_workers.items()
            ):
                if thread.is_alive():
                    continue
                if outcome["error"] is not None or outcome["result"] is False:
                    self._shutdown_abort_workers.pop(run_id, None)
            stopped = aborts_stopped and stopped

            remaining = self._remaining(deadline)
            if remaining <= 0.0:
                return False
            if not self._lock.acquire(timeout=remaining):
                return False
            try:
                runtimes = tuple(self._runtimes.items())
            finally:
                self._lock.release()

            for session_id, runtime in runtimes:
                shutdown = getattr(runtime, "shutdown", None)
                if not callable(shutdown):
                    stopped = False
                    log.warning(
                        "session runtime has no shutdown method session_id=%s",
                        session_id,
                    )
                    continue
                launch_timeout = self._remaining(deadline)
                if launch_timeout <= 0.0:
                    stopped = False
                    break
                self._start_shutdown_worker(
                    self._shutdown_workers,
                    session_id,
                    lambda runtime=runtime, launch_timeout=launch_timeout: runtime.shutdown(
                        timeout=launch_timeout
                    ),
                )
            stopped = self._join_shutdown_workers(
                tuple(self._shutdown_workers.values()), deadline
            ) and stopped

            # A runtime may report stopped before its coordinator watcher has
            # finished its final state projection. Join those threads too so a
            # later lifespan cannot receive stale session:runtime events.
            remaining = self._remaining(deadline)
            if remaining <= 0.0 or not self._lock.acquire(timeout=remaining):
                return False
            try:
                watchers = tuple(self._watchers.values())
            finally:
                self._lock.release()
            for watcher in watchers:
                watcher.join(timeout=self._remaining(deadline))
            remaining = self._remaining(deadline)
            if remaining <= 0.0 or not self._lock.acquire(timeout=remaining):
                return False
            try:
                if self._active_by_session or any(
                    watcher.is_alive() for watcher in self._watchers.values()
                ):
                    stopped = False
                if stopped:
                    self._runtimes.clear()
                    self._abort_started.clear()
                    self._shutdown_workers.clear()
                    self._shutdown_abort_workers.clear()
            finally:
                self._lock.release()
            return stopped
        finally:
            self._shutdown_lock.release()

    def _busy(self, representative: RuntimeState, *, reason: str = AgentBusyError.REASON_CAPACITY_FULL) -> AgentBusyError:
        return AgentBusyError(
            representative.session_id,
            representative.run_id or "",
            capacity=self._capacity,
            active_count=len(self._active_by_session),
            reason=reason,
        )

    def abort_if_current(self, *, session_id: str) -> RuntimeState:
        """Atomically identify and abort this session's current run.

        Returning idle/error/aborting is idempotent. In particular, a watcher
        cannot finish an old run and let this call accidentally abort a newer
        identity between separate state and abort operations.
        """
        with self._lock:
            active = self._active_by_session.get(session_id)
            if active is None:
                return replace(self._states.get(session_id, RuntimeState(session_id)))
            return self._abort_locked(active)

    def abort(self, *, session_id: str, run_id: str) -> RuntimeState:
        with self._lock:
            active = self._active_by_session.get(session_id)
            if active is None:
                raise SessionNotActiveError(session_id)
            if active.run_id != run_id:
                raise RunMismatchError(run_id)
            return self._abort_locked(active)

    def _abort_locked(self, active: RuntimeState) -> RuntimeState:
        if active.status in {"aborting", "error"}:
            return replace(active)
        runtime = self._runtimes[active.session_id]
        runtime.abort()
        aborting = replace(active, status="aborting")
        assert active.run_id is not None
        self._abort_started[active.run_id] = time.monotonic()
        self._active_by_session[active.session_id] = aborting
        self._states[active.session_id] = aborting
        return replace(aborting)

    def _emit_state_change(self, state: RuntimeState) -> None:
        callback = self._on_state_change
        if callback is None or self._shutdown_is_requested():
            return
        callback(state)

    def _watch_completion(
        self,
        runtime: SessionRuntime,
        handle: RuntimeHandle,
        session_id: str,
        run_id: str,
    ) -> None:
        try:
            while not handle.finished:
                notification: RuntimeState | None = None
                with self._lock:
                    active = self._active_by_session.get(session_id)
                    abort_started = self._abort_started.get(run_id)
                    if (
                        active is not None
                        and active.run_id == run_id
                        and active.status == "aborting"
                        and abort_started is not None
                        and time.monotonic() - abort_started >= self._abort_timeout
                    ):
                        failed = replace(active, status="error", error="abort_timeout")
                        self._active_by_session[session_id] = failed
                        self._states[session_id] = failed
                        notification = replace(failed)
                if notification is not None:
                    self._emit_state_change(notification)
                time.sleep(self._poll_interval)
            with self._lock:
                # A stale watcher must never clear a newer run in the same session.
                active = self._active_by_session.get(session_id)
                if active is None or active.run_id != run_id:
                    return
                self._abort_started.pop(run_id, None)
                self._active_by_session.pop(session_id, None)
                completed = RuntimeState(session_id, completed_run_id=run_id)
                self._states[session_id] = completed
                notification = replace(completed)
            self._emit_state_change(notification)
        finally:
            with self._lock:
                if self._watchers.get(run_id) is threading.current_thread():
                    self._watchers.pop(run_id, None)
