"""Non-blocking admission contract for the session runtime coordinator.

Architecture-review problem 6: ``submit_stream`` used to run runtime creation
(the GA archive restore) *and* ``runtime.submit`` inside its single global
RLock, so one session cold-starting froze every other session — state reads,
live-chat snapshots and even stopping an unrelated run queued behind it. These
tests pin the fix by construction rather than by timing luck:

the fake factory and the fake runtime block on an ``Event`` that only the test
can release, so a probe that returns *before* the release has provably not
waited for the slow work. Each slow operation self-releases after a few
seconds, so a regression fails the wall-clock assertion instead of hanging.
"""
from __future__ import annotations

import threading
import time

import pytest

from server.services.session_coordinator import (
    AgentBusyError,
    RunStartAbortedError,
    SessionControlBusyError,
    SessionCoordinator,
    STATUS_ABORTING,
    STATUS_IDLE,
)

GATE_TIMEOUT = 5.0
FAST = 0.5  # a probe that had to wait for a release would exceed this


class FakeHandle:
    def __init__(self, stream_id: str, run_finished=None) -> None:
        self.stream_id = stream_id
        self.finished = False
        self._run_finished = run_finished

    @property
    def run_finished(self) -> bool:
        if self._run_finished is not None:
            return self._run_finished()
        return self.finished


class FakeRuntime:
    def __init__(self, session_id: str, *, create_gate=None, submit_gate=None) -> None:
        self.session_id = session_id
        self.created = True
        self.submissions: list[dict] = []
        self.abort_calls = 0
        self.shutdown_calls = 0
        self.handle: FakeHandle | None = None
        self.submit_gate = submit_gate
        if create_gate is not None:
            self.created = False
            create_gate.wait(GATE_TIMEOUT)
            self.created = True

    def submit(self, text: str, **kwargs) -> FakeHandle:
        self.submissions.append({"text": text, **kwargs})
        # The handle exists before the gate so a test can finish the "run"
        # while the submit is still blocked inside the coordinator.
        self.handle = FakeHandle(f"stream-{self.session_id}-{len(self.submissions)}")
        if self.submit_gate is not None:
            self.submit_gate.wait(GATE_TIMEOUT)
        return self.handle

    def abort(self) -> None:
        self.abort_calls += 1

    def shutdown(self, timeout: float = 3.0) -> bool:
        self.shutdown_calls += 1
        return True

    def btw(self, question: str) -> str:
        return f"side:{self.session_id}:{question}"

    def rewind_turns(self, *, sid=None, n=None) -> dict:
        return {"removed_sids": [], "kept": 0, "history_lines": 0}

    def active_message_snapshot(self, stream_id, *, session_id, run_id):
        snapshot_gate = getattr(self, "snapshot_gate", None)
        if snapshot_gate is not None:
            snapshot_gate.wait(GATE_TIMEOUT)
        return {"stream_id": stream_id, "content": "partial", "done": False}


class Factory:
    """Creation blocks only for the sessions named in ``gated``."""

    def __init__(self, *, gated=(), submit_gate=None) -> None:
        self.gated = set(gated)
        self.submit_gate = submit_gate
        self.calls: list[str] = []
        self.runtimes: dict[str, FakeRuntime] = {}
        self.started = threading.Event()
        self.gates: dict[str, threading.Event] = {
            session_id: threading.Event() for session_id in self.gated
        }

    def __call__(self, session_id: str) -> FakeRuntime:
        self.calls.append(session_id)
        self.started.set()
        gate = self.gates.get(session_id)
        runtime = FakeRuntime(session_id, create_gate=gate, submit_gate=self.submit_gate)
        self.runtimes[session_id] = runtime
        return runtime


def _gated_factory(gated, *, submit_gate=None):
    return Factory(gated=gated, submit_gate=submit_gate)


def _wait_until(predicate, timeout: float = 5.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.005)
    return predicate()


def _in_thread(target):
    thread = threading.Thread(target=target, daemon=True)
    thread.start()
    return thread


# ── the freeze itself ────────────────────────────────────────────────────────

PROBES = {
    "runtime_state": lambda c: c.runtime_state("B"),
    "active_runs": lambda c: c.active_runs(),
    "session_snapshot": lambda c: c.session_snapshot("B"),
    "peek_runtime": lambda c: c.peek_runtime("B"),
    "abort_if_current": lambda c: c.abort_if_current(session_id="B"),
    "ensure_runtime_third_session": lambda c: c.ensure_runtime("C"),
}


@pytest.mark.parametrize("probe_name", sorted(PROBES))
def test_a_cold_start_does_not_block_other_sessions(probe_name: str) -> None:
    factory = _gated_factory({"A"})
    coordinator = SessionCoordinator(factory, capacity=2, poll_interval=0.01)
    coordinator.ensure_runtime("B")
    coordinator.submit_stream("hello from B", session_id="B")

    worker = _in_thread(
        lambda: _swallow(lambda: coordinator.submit_stream("hello from A", session_id="A"))
    )
    assert factory.started.wait(GATE_TIMEOUT), "factory was never entered"

    started = time.perf_counter()
    PROBES[probe_name](coordinator)
    elapsed = time.perf_counter() - started

    # The release happens only after the probe: if it had queued behind the
    # cold start, this would still be blocked and the assert below would fail.
    assert not factory.gates["A"].is_set(), "cold start finished before the probe"
    assert elapsed < FAST, f"{probe_name} waited {elapsed:.3f}s on an unrelated cold start"

    factory.gates["A"].set()
    worker.join(GATE_TIMEOUT)


def test_a_slow_submit_does_not_block_other_sessions() -> None:
    submit_gate = threading.Event()
    factory = _gated_factory(set(), submit_gate=submit_gate)
    coordinator = SessionCoordinator(factory, capacity=2, poll_interval=0.01)
    coordinator.ensure_runtime("B")
    coordinator.submit_stream("hello from B", session_id="B")
    coordinator.ensure_runtime("A")  # warm: no restore cost at all

    worker = _in_thread(
        lambda: _swallow(lambda: coordinator.submit_stream("hello from A", session_id="A"))
    )
    assert _wait_until(lambda: factory.runtimes["A"].submissions)

    started = time.perf_counter()
    coordinator.abort_if_current(session_id="B")
    elapsed = time.perf_counter() - started
    assert not submit_gate.is_set(), "slow submit returned before the probe"
    assert elapsed < FAST, f"probe waited {elapsed:.3f}s on another session's submit"

    submit_gate.set()
    worker.join(GATE_TIMEOUT)


def test_a_slow_snapshot_does_not_block_other_sessions() -> None:
    factory = _gated_factory(set())
    coordinator = SessionCoordinator(factory, capacity=2, poll_interval=0.01)
    coordinator.ensure_runtime("B")
    coordinator.submit_stream("hello from B", session_id="B")
    coordinator.submit_stream("hello from A", session_id="A")
    snapshot_gate = threading.Event()
    factory.runtimes["A"].snapshot_gate = snapshot_gate

    worker = _in_thread(
        lambda: _swallow(lambda: coordinator.session_snapshot("A"))
    )
    time.sleep(0.05)  # let the snapshot call reach its gate

    started = time.perf_counter()
    coordinator.runtime_state("B")
    elapsed = time.perf_counter() - started
    assert not snapshot_gate.is_set()
    assert elapsed < FAST, f"probe waited {elapsed:.3f}s on another session's snapshot"

    snapshot_gate.set()
    worker.join(GATE_TIMEOUT)


def test_a_slow_configure_callback_does_not_block_other_sessions() -> None:
    factory = _gated_factory(set())
    coordinator = SessionCoordinator(factory, capacity=2, poll_interval=0.01)
    coordinator.ensure_runtime("B")
    coordinator.ensure_runtime("A")
    release = threading.Event()
    entered = threading.Event()

    def slow_configure(_runtime):
        entered.set()
        release.wait(GATE_TIMEOUT)
        return "configured"

    worker = _in_thread(
        lambda: _swallow(lambda: coordinator.configure_if_idle("A", slow_configure))
    )
    assert entered.wait(GATE_TIMEOUT)

    started = time.perf_counter()
    coordinator.runtime_state("B")
    elapsed = time.perf_counter() - started
    assert not release.is_set()
    assert elapsed < FAST, f"probe waited {elapsed:.3f}s on a configure callback"

    # Exclusivity is now carried by the session's control reservation, so a
    # concurrent admission for THAT session is refused rather than interleaved.
    with pytest.raises(SessionControlBusyError):
        coordinator.submit_stream("must not interleave", session_id="A")

    release.set()
    worker.join(GATE_TIMEOUT)


# ── what the moved lock was silently enforcing ───────────────────────────────

def test_concurrent_admissions_for_one_session_build_one_runtime() -> None:
    factory = _gated_factory({"A"})
    coordinator = SessionCoordinator(factory, capacity=2, poll_interval=0.01)
    errors: list[BaseException] = []

    first = _in_thread(
        lambda: _swallow(
            lambda: coordinator.submit_stream("first", session_id="A"), errors
        )
    )
    assert factory.started.wait(GATE_TIMEOUT)
    with pytest.raises(AgentBusyError) as busy:
        coordinator.submit_stream("second", session_id="A")
    assert busy.value.reason == AgentBusyError.REASON_SESSION_ACTIVE

    factory.gates["A"].set()
    first.join(GATE_TIMEOUT)
    assert factory.calls == ["A"], "the session's runtime was built twice"
    assert errors == [None], "the admitted submit did not succeed"


def test_a_side_question_racing_a_submit_shares_one_runtime() -> None:
    """BTW does not take the run reservation, so only the creation gate can
    stop it and a cold-starting submit from building two runtimes."""
    factory = _gated_factory({"A"})
    coordinator = SessionCoordinator(factory, capacity=2, poll_interval=0.01)

    submitter = _in_thread(
        lambda: _swallow(lambda: coordinator.submit_stream("hello", session_id="A"))
    )
    assert factory.started.wait(GATE_TIMEOUT)
    btw = _in_thread(
        lambda: _swallow(lambda: coordinator.side_question("A", "why?"))
    )
    time.sleep(0.05)  # both callers are now past the map lookup

    factory.gates["A"].set()
    submitter.join(GATE_TIMEOUT)
    btw.join(GATE_TIMEOUT)

    assert factory.calls == ["A"], "a raced creation built a second runtime"
    assert coordinator.peek_runtime("A") is factory.runtimes["A"]


def test_a_released_session_never_installs_an_orphan_runtime() -> None:
    factory = _gated_factory({"A"})
    coordinator = SessionCoordinator(factory, capacity=2, poll_interval=0.01)

    worker = _in_thread(
        lambda: _swallow(lambda: coordinator.ensure_runtime("A"))
    )
    assert factory.started.wait(GATE_TIMEOUT)

    assert coordinator.release_runtime("A") is False  # nothing installed yet
    factory.gates["A"].set()
    worker.join(GATE_TIMEOUT)

    assert coordinator.peek_runtime("A") is None, "a deleted session got a runtime"
    assert factory.runtimes["A"].shutdown_calls == 1, "the orphan runtime leaked"


# ── stopping a run that has not started yet ──────────────────────────────────

def test_stop_during_a_cold_start_never_submits_and_settles_idle() -> None:
    factory = _gated_factory({"A"})
    coordinator = SessionCoordinator(factory, capacity=2, poll_interval=0.01)
    outcomes: list[BaseException] = []

    worker = _in_thread(
        lambda: _swallow(
            lambda: coordinator.submit_stream("hello", session_id="A"), outcomes
        )
    )
    assert factory.started.wait(GATE_TIMEOUT)

    started = time.perf_counter()
    state = coordinator.abort_if_current(session_id="A")
    elapsed = time.perf_counter() - started
    # The stop must be immediate even though the runtime does not exist yet.
    assert elapsed < FAST
    assert state.status == STATUS_ABORTING

    factory.gates["A"].set()
    worker.join(GATE_TIMEOUT)

    assert len(outcomes) == 1 and isinstance(outcomes[0], RunStartAbortedError)
    assert factory.runtimes["A"].submissions == [], "an aborted start still submitted"
    assert _wait_until(lambda: coordinator.runtime_state("A").status == STATUS_IDLE)
    assert coordinator.active_run() is None
    assert coordinator.runtime_state("A").completed_run_id == state.run_id


def test_stop_that_lands_during_a_slow_submit_is_finished_by_the_watcher() -> None:
    submit_gate = threading.Event()
    factory = _gated_factory(set(), submit_gate=submit_gate)
    coordinator = SessionCoordinator(factory, capacity=1, poll_interval=0.01)
    coordinator.ensure_runtime("A")

    worker = _in_thread(
        lambda: _swallow(lambda: coordinator.submit_stream("hello", session_id="A"))
    )
    assert _wait_until(lambda: factory.runtimes["A"].submissions)

    state = coordinator.abort_if_current(session_id="A")
    assert state.status == STATUS_ABORTING
    assert factory.runtimes["A"].abort_calls == 1

    # The run exists, so the ordinary watcher owns the completion.
    factory.runtimes["A"].handle.finished = True
    submit_gate.set()
    worker.join(GATE_TIMEOUT)
    assert _wait_until(lambda: coordinator.runtime_state("A").status == STATUS_IDLE)
    assert coordinator.active_run() is None


def test_shutdown_during_creation_discards_the_runtime_and_frees_the_slot() -> None:
    """The reservation must not survive a creation that was thrown away."""
    factory = _gated_factory({"A"})
    coordinator = SessionCoordinator(factory, capacity=1, poll_interval=0.01)
    outcomes: list = []

    worker = _in_thread(
        lambda: _swallow(
            lambda: coordinator.submit_stream("hello", session_id="A"), outcomes
        )
    )
    assert factory.started.wait(GATE_TIMEOUT)

    # Bounded shutdown while the restore is in flight: it raises the gate and
    # gives up waiting, which is exactly the window the creator must notice.
    coordinator.shutdown(timeout=0.05)
    factory.gates["A"].set()
    worker.join(GATE_TIMEOUT)

    assert len(outcomes) == 1
    assert outcomes[0].__class__.__name__ == "SessionCoordinatorStoppedError"
    assert factory.runtimes["A"].shutdown_calls == 1, "the discarded runtime leaked"
    assert coordinator.peek_runtime("A") is None
    assert coordinator.active_run() is None, "the admission slot was never released"


def test_a_failing_creation_releases_the_admission_slot() -> None:
    def factory(session_id: str) -> FakeRuntime:
        if session_id == "A":
            raise RuntimeError("restore failed")
        return FakeRuntime(session_id)

    coordinator = SessionCoordinator(factory, capacity=1, poll_interval=0.01)
    with pytest.raises(RuntimeError, match="restore failed"):
        coordinator.submit_stream("hello", session_id="A")

    assert coordinator.active_run() is None
    assert coordinator.runtime_state("A").status == STATUS_IDLE
    # Capacity is usable again: the failed admission kept nothing.
    coordinator.submit_stream("hello", session_id="B")
    assert coordinator.active_run() is not None


def _swallow(action, outcomes: list | None = None) -> None:
    """Run ``action`` in a worker thread, keeping any exception for asserts."""
    try:
        action()
    except BaseException as exc:  # noqa: BLE001 - handed to the test
        if outcomes is not None:
            outcomes.append(exc)
        return
    if outcomes is not None:
        outcomes.append(None)  # type: ignore[arg-type]
