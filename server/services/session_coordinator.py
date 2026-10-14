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

from .session_runtime_status import (
    STATUS_ABORTING,
    STATUS_ERROR,
    STATUS_IDLE,
    STATUS_RUNNING,
    STATUS_STARTING,
)


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


class RunStartAbortedError(RuntimeError):
    """Raised when a run is stopped while its runtime is still being created.

    Admission reserves the run before its runtime exists (creation happens
    outside the coordinator lock — see ``_runtime_for_session``), so a stop
    request can land inside that window. The pending run never reaches the
    runtime: nothing is submitted, the reservation is completed as if the run
    had been aborted, and the caller is told its start was cancelled. Cleaning
    the user's draft is the caller's business — the message was never run.
    """

    def __init__(self, session_id: str, run_id: str) -> None:
        self.session_id = session_id
        self.run_id = run_id
        super().__init__(
            f"run {run_id!r} for session {session_id!r} was stopped before it started"
        )


@dataclass(frozen=True)
class RuntimeState:
    session_id: str
    status: str = STATUS_IDLE
    run_id: str | None = None
    stream_id: str | None = None
    error: str | None = None
    completed_run_id: str | None = None
    outcome: str | None = None


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
        if not 1 <= capacity <= 10:
            raise ValueError("session run capacity must be between 1 and 10")
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
        # One creation gate per session. Runtime creation (GA archive restore
        # plus AgentService construction) is unboundedly slow and therefore
        # runs OUTSIDE ``self._lock``; the gate is what keeps two concurrent
        # admissions for the same session from building two runtimes, while
        # different sessions never wait for each other.
        self._creation_gates: dict[str, threading.Lock] = {}
        # Bumped whenever a session's runtime is replaced or released. A
        # creation that outlived its session (deleted while the restore was in
        # flight) compares its captured epoch and discards the fresh runtime
        # instead of installing an orphan. Entries are never removed: dropping
        # one would make an in-flight creation's captured epoch look current.
        self._runtime_epoch: dict[str, int] = {}

    @property
    def capacity(self) -> int:
        return self._capacity

    def runtime_state(self, session_id: str) -> RuntimeState:
        with self._lock:
            return replace(self._states.get(session_id, RuntimeState(session_id)))

    def runtime_states(self) -> tuple[RuntimeState, ...]:
        """Observe all known states without creating runtimes or admitting work."""
        with self._lock:
            return tuple(replace(state) for state in self._states.values())

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
        """Atomically configure a session without creating an idle runtime.

        The callback runs outside the coordinator lock: it activates a project
        on the GA agent and writes the sidecar row, and holding the lock across
        that would stall every other session. Exclusivity comes from reserving
        this session's control slot for the callback's duration instead — a
        concurrent submit for the same session is refused with the usual 409
        rather than being allowed to interleave with a project switch.
        """
        with self._lock:
            self._raise_if_shutdown()
            active = self._active_by_session.get(session_id)
            if active is not None:
                raise self._busy(active, reason=AgentBusyError.REASON_SESSION_ACTIVE)
            self._raise_if_control_busy(session_id, include_side_questions=True)
            self._exclusive_controls[session_id] = "configure"
            runtime = self._runtimes.get(session_id)
        try:
            return configure(runtime)
        finally:
            with self._lock:
                if self._exclusive_controls.get(session_id) == "configure":
                    self._exclusive_controls.pop(session_id, None)

    def side_question(self, session_id: str, question: str) -> str:
        """Run BTW against this session runtime without consuming run capacity.

        The BTW reservation is taken atomically, but both runtime creation and
        the potentially slow model call run outside the coordinator lock.
        Normal submissions remain allowed, preserving GA's snapshot-based BTW
        concurrency semantics.
        """
        with self._lock:
            self._raise_if_shutdown()
            self._raise_if_control_busy(session_id)
            self._side_questions[session_id] = self._side_questions.get(session_id, 0) + 1
        try:
            return self._runtime_for_session(session_id).btw(question)
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
            # The control reservation above is what makes this exclusive; the
            # runtime lookup (which may cold-start) must not hold the lock.
            runtime = self._runtime_for_session(session_id)
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
            # The terminal state goes with the runtime: without this,
            # completed/failed states accumulate for every session ever run
            # in the process (session_snapshot re-defaults on the miss).
            with self._lock:
                self._states.pop(session_id, None)
                # Invalidate any creation still in flight for this session: a
                # restore that started before the deletion must not resurrect
                # the session by installing its runtime afterwards.
                self._runtime_epoch[session_id] = (
                    self._runtime_epoch.get(session_id, 0) + 1
                )
            if runtime is not None and shutdown is not None:
                shutdown(runtime)
            if after_release is not None:
                after_release()
            return runtime is not None

        return self.exclusive(session_id, operation, _release)

    def session_snapshot(self, session_id: str) -> tuple[RuntimeState, dict[str, Any] | None]:
        """Return runtime identity and its matching active content together.

        The runtime call runs outside the coordinator lock: this is the live
        chat's snapshot/resync path and the runtime takes its own lock, so
        holding the coordinator lock here would stall unrelated sessions and
        nest two locks on every poll. Identity is re-checked afterwards so a
        snapshot is never paired with a different run's state.
        """
        with self._lock:
            state = replace(self._states.get(session_id, RuntimeState(session_id)))
            if state.status == STATUS_IDLE or not state.run_id or not state.stream_id:
                return state, None
            runtime = self._runtimes.get(session_id)
            if runtime is None:
                return state, None
            run_snapshotter = getattr(runtime, "run_message_snapshot", None)
            snapshotter = getattr(runtime, "active_message_snapshot", None)
        if callable(run_snapshotter):
            active_message = run_snapshotter(session_id=session_id, run_id=state.run_id)
        elif callable(snapshotter):
            # Compatibility with older adapters; production returns the full run.
            active_message = snapshotter(
                state.stream_id, session_id=session_id, run_id=state.run_id,
            )
        else:
            return state, None
        with self._lock:
            current = self._active_by_session.get(session_id)
            if current is None or current.run_id != state.run_id:
                # The run finished or was replaced while we copied it: report
                # the current state and no content rather than a stale pair.
                return replace(self._states.get(session_id, RuntimeState(session_id))), None
            return replace(current), active_message

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
        """Admit one run; the stream handle stays coordinator-internal."""
        return self.submit_stream(
            text,
            session_id=session_id,
            source=source,
            images=images,
            llm_index=llm_index,
            llm_key=llm_key,
        )[0]

    def submit_stream(
        self,
        text: str,
        *,
        session_id: str,
        source: str = "webui",
        images: list[str] | None = None,
        llm_index: int | None = None,
        llm_key: str | None = None,
    ) -> tuple[RuntimeState, RuntimeHandle]:
        """Admit one run and also return its stream handle.

        Background channels (system sessions) consume the handle directly
        (wechat relays display_queue items back into the chat; the schedulers
        watch ``finished``/``final_text``), so admission must hand it back
        without a second lookup racing the watcher.
        """
        # Admission — capacity check plus per-session identity reservation — is
        # one critical section, and it is the reservation (not the lock) that
        # makes overbooking impossible: the slot is taken before the lock is
        # dropped. Runtime creation and the submit itself are deliberately NOT
        # in that section, because both can block unboundedly (GA archive
        # restore, then the agent's input queue); holding the lock across them
        # froze every other session (architecture-review problem 6).
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
            starting = RuntimeState(session_id, STATUS_STARTING, run_id)
            self._active_by_session[session_id] = starting
            self._states[session_id] = starting

        try:
            runtime = self._runtime_for_session(session_id)
            # A stop may have landed while the runtime was being created — the
            # exact window this refactor opened, and one the live chat's stop
            # button can hit (it is offered while the status is "starting").
            # Honour it: never submit, and settle the reservation as a
            # completed abort so no watcher is needed to finish it.
            pending = self._reservation_status(session_id, run_id)
            if pending != STATUS_STARTING:
                self._finish_aborted_start(session_id, run_id)
                if pending == STATUS_ABORTING:
                    raise RunStartAbortedError(session_id, run_id)
                raise SessionControlBusyError(session_id, "release")
            from . import theme_task_runs
            theme_task_runs.begin(session_id, run_id, llm_key)
            handle = runtime.submit(
                text,
                source=source,
                images=images,
                llm_index=llm_index,
                llm_key=llm_key,
                session_id=session_id,
                run_id=run_id,
            )
        except RunStartAbortedError:
            # Already settled as a completed abort by _finish_aborted_start.
            raise
        except BaseException:
            # No run was admitted (creation or the submit itself failed), so
            # this admission's slot must go back — including when creation was
            # discarded because the session was released or we are shutting down.
            from . import theme_task_runs
            theme_task_runs.finish(session_id, run_id, "failed")
            self._release_reservation(session_id, run_id)
            raise

        with self._lock:
            active = self._active_by_session.get(session_id)
            if active is not None and active.run_id == run_id and (
                active.status == STATUS_STARTING
            ):
                running = RuntimeState(
                    session_id, STATUS_RUNNING, run_id, handle.stream_id
                )
                self._active_by_session[session_id] = running
                self._states[session_id] = running
            elif active is not None and active.run_id == run_id:
                # Aborted between install and submit: the run exists, so the
                # ordinary watcher completes the ABORTING transition.
                running = active
            else:
                # The reservation vanished (session released while we were in
                # the agent): nothing will watch this run, so retire it here.
                self._abort_orphaned_run(runtime, session_id, run_id)
                raise SessionControlBusyError(session_id, "release")

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
            try:
                watcher.start()
            except BaseException:
                # Thread exhaustion: without rollback the admitted run would
                # occupy its capacity slot forever (nobody watches completion).
                self._watchers.pop(run_id, None)
                active = self._active_by_session.get(session_id)
                if active is not None and active.run_id == run_id:
                    self._active_by_session.pop(session_id, None)
                    self._states[session_id] = RuntimeState(session_id)
                try:
                    runtime.abort()
                except Exception:
                    log.exception(
                        "watcher start rollback: abort failed for %s", session_id)
                raise
        return replace(running), handle

    def ensure_runtime(self, session_id: str) -> SessionRuntime:
        """Create (or return) the session runtime WITHOUT admitting a run.

        The runtime occupies no capacity slot — only an active run does. It
        exists so introspection surfaces (LLM listing, idle checks) can touch
        the session's agent before its first submit, exactly like the global
        singleton the background channels used before the merge.
        """
        with self._lock:
            self._raise_if_shutdown()
        # Creation is slow and must not run under the lock. If this session is
        # released while the restore is in flight, the epoch check discards the
        # fresh runtime instead of resurrecting a deleted session.
        return self._runtime_for_session(session_id)

    def replace_runtime(
        self,
        session_id: str,
        runtime: SessionRuntime,
        *,
        shutdown: Callable[[SessionRuntime], Any] | None = None,
        operation: str = "replace",
    ) -> SessionRuntime | None:
        """Atomically install a prepared runtime for one session.

        The replacement is admitted only while the session is idle and no
        other mutating control or BTW snapshot is in flight.  Construction of
        ``runtime`` therefore happens before this method; if construction
        fails, the currently installed runtime remains untouched.  The old
        runtime is detached before its potentially blocking shutdown runs.
        """
        def _replace() -> SessionRuntime | None:
            with self._lock:
                previous = self._runtimes.get(session_id)
                self._runtimes[session_id] = runtime
                self._states.pop(session_id, None)
                # Invalidate any creation still in flight for this session: it
                # must not install its runtime over this deliberate replacement.
                self._runtime_epoch[session_id] = (
                    self._runtime_epoch.get(session_id, 0) + 1
                )
            if previous is not None:
                disposer = shutdown or getattr(previous, "shutdown", None)
                if disposer is not None:
                    disposer(previous) if shutdown is not None else disposer()
            return previous

        return self.exclusive(session_id, operation, _replace)

    def peek_runtime(self, session_id: str) -> SessionRuntime | None:
        """Return the session's runtime if one exists, never creating one."""
        with self._lock:
            return self._runtimes.get(session_id)

    def _runtime_for_session(self, session_id: str) -> SessionRuntime:
        """Return this session's runtime, creating it OUTSIDE the coordinator lock.

        Creation is unboundedly slow: the factory builds an AgentService and
        replays the session's GA archive (lock acquisition, full parse, working
        memory restore). Holding ``self._lock`` across that froze every other
        session — reading state, polling a snapshot or stopping an unrelated
        run all queued behind one session's cold start (architecture-review
        problem 6). The lock now guards the maps only.

        Concurrency guarantees are preserved by three things:

        * the per-session creation gate, so two admissions for the SAME session
          cannot build two runtimes (and the loser reuses the winner's);
        * ``self._runtime_epoch``, so a creation that outlived its session
          (released or replaced while the restore was in flight) discards its
          fresh runtime instead of installing an orphan for a deleted session;
        * the caller's own reservation, which is taken before the lock is
          dropped and is what actually prevents overbooking.
        """
        with self._lock:
            runtime = self._runtimes.get(session_id)
            if runtime is not None:
                return runtime
            epoch = self._runtime_epoch.get(session_id, 0)
            gate = self._creation_gates.get(session_id)
            if gate is None:
                gate = threading.Lock()
                self._creation_gates[session_id] = gate

        with gate:
            with self._lock:
                runtime = self._runtimes.get(session_id)
                if runtime is not None:
                    return runtime

            runtime = self._runtime_factory(session_id)

            with self._lock:
                if self._runtime_epoch.get(session_id, 0) == epoch and (
                    not self._shutdown_is_requested()
                ):
                    self._runtimes[session_id] = runtime
                    return runtime
                stopping = self._shutdown_is_requested()

            # This session was released or replaced while we were building, or
            # the coordinator is shutting down: never install the runtime, and
            # never leak the GA agent it holds.
            self._discard_created_runtime(runtime)
            if stopping:
                raise SessionCoordinatorStoppedError(
                    "session coordinator is shutting down"
                )
            raise SessionControlBusyError(session_id, "release")

    def _discard_created_runtime(self, runtime: SessionRuntime) -> None:
        """Dispose a runtime that must not become any session's runtime."""
        shutdown = getattr(runtime, "shutdown", None)
        if shutdown is None:
            return
        try:
            shutdown()
        except Exception:
            log.exception("failed to discard an uninstalled session runtime")

    def _reservation_status(self, session_id: str, run_id: str) -> str | None:
        """Status of this admission's reservation, or None if it is gone."""
        with self._lock:
            active = self._active_by_session.get(session_id)
            if active is None or active.run_id != run_id:
                return None
            return active.status

    def _release_reservation(self, session_id: str, run_id: str) -> None:
        """Drop one admission's reservation without touching anyone else's."""
        with self._lock:
            active = self._active_by_session.get(session_id)
            if active is not None and active.run_id == run_id:
                self._active_by_session.pop(session_id, None)
                self._states[session_id] = RuntimeState(session_id)
            self._abort_started.pop(run_id, None)

    def _finish_aborted_start(self, session_id: str, run_id: str) -> None:
        """Settle a stop that arrived before the run reached its runtime.

        The run was never submitted, so no watcher exists to finish it. This
        mirrors the completion half of ``_watch_completion`` so the state
        machine lands exactly where a normal abort would.
        """
        completed: RuntimeState | None = None
        with self._lock:
            active = self._active_by_session.get(session_id)
            if active is None or active.run_id != run_id:
                return
            self._abort_started.pop(run_id, None)
            self._active_by_session.pop(session_id, None)
            settled = RuntimeState(session_id, completed_run_id=run_id)
            self._states[session_id] = settled
            completed = replace(settled)
        if completed is not None:
            self._emit_state_change(completed)

    def _abort_orphaned_run(
        self, runtime: SessionRuntime, session_id: str, run_id: str
    ) -> None:
        """Retire a run whose session lost its reservation while submitting."""
        try:
            runtime.abort()
        except Exception:
            log.exception("orphaned run rollback: abort failed for %s", session_id)
        with self._lock:
            self._abort_started.pop(run_id, None)
            self._watchers.pop(run_id, None)

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
            if current.status in {STATUS_ABORTING, STATUS_ERROR}:
                # A previous shutdown abort worker may have failed. Returning
                # the identity lets the retry path replace that failed worker;
                # a still-running or successful worker remains single-flight.
                return (current.run_id, runtime), True
            aborting = replace(current, status=STATUS_ABORTING)
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
                # No admitted run, but an error retry may still be backing
                # off on this session's runtime: fanout resubmits bypass the
                # coordinator, so route the abort to the runtime directly.
                # runtime.abort() is a no-op for a truly idle agent, and it
                # also cancels any pending error retry on that service.
                runtime = self._runtimes.get(session_id)
                if runtime is not None:
                    runtime.abort()
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
        if active.status in {STATUS_ABORTING, STATUS_ERROR}:
            return replace(active)
        # The runtime may not exist yet: admission reserves the run before its
        # runtime is created (creation happens outside the lock), so a stop
        # legitimately arrives while the restore is still running. Marking the
        # reservation ABORTING is enough — the admitting thread sees it, never
        # submits, and settles the run (``_finish_aborted_start``).
        runtime = self._runtimes.get(active.session_id)
        if runtime is not None:
            runtime.abort()
        aborting = replace(active, status=STATUS_ABORTING)
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
            # Recovery-capable handles expose completion of the whole run;
            # legacy runtimes have only a single physical stream.
            while not getattr(handle, "run_finished", handle.finished):
                notification: RuntimeState | None = None
                with self._lock:
                    active = self._active_by_session.get(session_id)
                    abort_started = self._abort_started.get(run_id)
                    if (
                        active is not None
                        and active.run_id == run_id
                        and active.status == STATUS_ABORTING
                        and abort_started is not None
                        and time.monotonic() - abort_started >= self._abort_timeout
                    ):
                        failed = replace(active, status=STATUS_ERROR, error="abort_timeout")
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
                outcome = getattr(handle, "run_outcome", None)
                if active.status == STATUS_ABORTING:
                    outcome = "cancelled"
                try:
                    from .archive_messages import read_archive_messages
                    from .archive_identity import finish_run
                    archive_path = runtime.agent.log_path
                    finish_run(archive_path, run_id,
                               ordinal=read_archive_messages(archive_path)["total"],
                               outcome=outcome or "completed")
                except Exception:
                    log.warning("identity_finish_failed session=%s run=%s", session_id, run_id, exc_info=True)
                completed = RuntimeState(
                    session_id, completed_run_id=run_id,
                    outcome=outcome or "completed",
                )
                self._states[session_id] = completed
                notification = replace(completed)
            # Notify immediately: optional metrics I/O must not delay runtime state.
            self._emit_state_change(notification)
            from . import theme_task_runs
            last = handle
            while getattr(last, "_continuation", None) is not None:
                last = last._continuation
            theme_task_runs.finish(session_id, run_id, notification.outcome or "failed", getattr(last, "final_text", ""))
        finally:
            with self._lock:
                if self._watchers.get(run_id) is threading.current_thread():
                    self._watchers.pop(run_id, None)
