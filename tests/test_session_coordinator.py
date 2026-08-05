"""Concurrency contract for the message-free session runtime coordinator."""
from __future__ import annotations

import time
from dataclasses import dataclass

import pytest


@dataclass
class FakeHandle:
    stream_id: str
    finished: bool = False


class FakeRuntime:
    def __init__(self, session_id: str) -> None:
        self.session_id = session_id
        self.submissions: list[dict] = []
        self.abort_calls = 0
        self.handle: FakeHandle | None = None

    def submit(self, text: str, **kwargs) -> FakeHandle:
        self.submissions.append({"text": text, **kwargs})
        self.handle = FakeHandle(f"stream-{self.session_id}-{len(self.submissions)}")
        return self.handle

    def abort(self) -> None:
        self.abort_calls += 1


def _wait_until(predicate, timeout: float = 1.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError("condition was not reached")


def test_lazy_runtime_is_reused_and_run_identity_is_propagated() -> None:
    from server.services.session_coordinator import SessionCoordinator

    made: list[FakeRuntime] = []

    def factory(session_id: str) -> FakeRuntime:
        runtime = FakeRuntime(session_id)
        made.append(runtime)
        return runtime

    coordinator = SessionCoordinator(factory, poll_interval=0.005)
    first = coordinator.submit("alpha", session_id="A", llm_index=2)

    assert len(made) == 1
    assert first.session_id == "A"
    assert first.stream_id == "stream-A-1"
    assert made[0].submissions == [{
        "text": "alpha",
        "source": "webui",
        "images": None,
        "llm_index": 2,
        "session_id": "A",
        "run_id": first.run_id,
    }]

    made[0].handle.finished = True
    _wait_until(lambda: coordinator.runtime_state("A").status == "idle")

    second = coordinator.submit("beta", session_id="A", llm_index=2)
    assert len(made) == 1
    assert second.run_id != first.run_id
    assert second.stream_id == "stream-A-2"


def test_global_run_slot_rejects_other_session_until_real_completion() -> None:
    from server.services.session_coordinator import AgentBusyError, SessionCoordinator

    runtimes: dict[str, FakeRuntime] = {}

    def factory(session_id: str) -> FakeRuntime:
        runtimes[session_id] = FakeRuntime(session_id)
        return runtimes[session_id]

    coordinator = SessionCoordinator(factory, poll_interval=0.005)
    active = coordinator.submit("alpha", session_id="A")

    with pytest.raises(AgentBusyError) as exc:
        coordinator.submit("beta", session_id="B")
    assert exc.value.active_session_id == "A"
    assert exc.value.active_run_id == active.run_id
    assert "B" not in runtimes

    runtimes["A"].handle.finished = True
    _wait_until(lambda: coordinator.active_run() is None)
    coordinator.submit("beta", session_id="B")
    assert set(runtimes) == {"A", "B"}


def test_abort_is_scoped_and_does_not_release_slot_early() -> None:
    from server.services.session_coordinator import (
        RunMismatchError,
        SessionCoordinator,
        SessionNotActiveError,
    )

    runtimes: dict[str, FakeRuntime] = {}

    def factory(session_id: str) -> FakeRuntime:
        runtimes[session_id] = FakeRuntime(session_id)
        return runtimes[session_id]

    coordinator = SessionCoordinator(factory, poll_interval=0.005)
    run = coordinator.submit("alpha", session_id="A")

    with pytest.raises(SessionNotActiveError):
        coordinator.abort(session_id="B", run_id=run.run_id)
    with pytest.raises(RunMismatchError):
        coordinator.abort(session_id="A", run_id="stale-run")
    assert runtimes["A"].abort_calls == 0

    state = coordinator.abort(session_id="A", run_id=run.run_id)
    assert state.status == "aborting"
    assert runtimes["A"].abort_calls == 1
    assert coordinator.active_run() is not None

    runtimes["A"].handle.finished = True
    _wait_until(lambda: coordinator.active_run() is None)


def test_abort_timeout_is_error_and_keeps_slot_until_core_really_finishes() -> None:
    from server.services.session_coordinator import AgentBusyError, SessionCoordinator

    runtimes: dict[str, FakeRuntime] = {}

    def factory(session_id: str) -> FakeRuntime:
        runtimes[session_id] = FakeRuntime(session_id)
        return runtimes[session_id]

    notifications: list[RuntimeState] = []
    coordinator = SessionCoordinator(
        factory,
        poll_interval=0.002,
        abort_timeout=0.02,
        on_state_change=notifications.append,
    )
    run = coordinator.submit("alpha", session_id="A")
    coordinator.abort(session_id="A", run_id=run.run_id)

    _wait_until(lambda: coordinator.runtime_state("A").status == "error")
    timed_out = coordinator.runtime_state("A")
    assert timed_out.error == "abort_timeout"
    assert coordinator.active_run() == timed_out
    assert notifications == [timed_out]

    with pytest.raises(AgentBusyError):
        coordinator.submit("beta", session_id="B")
    assert coordinator.abort(session_id="A", run_id=run.run_id) == timed_out
    assert runtimes["A"].abort_calls == 1

    runtimes["A"].handle.finished = True
    _wait_until(lambda: coordinator.active_run() is None)
    assert coordinator.runtime_state("A").status == "idle"


def test_capacity_two_tracks_each_session_identity_and_rejects_third() -> None:
    from server.services.session_coordinator import AgentBusyError, SessionCoordinator

    runtimes: dict[str, FakeRuntime] = {}

    def factory(session_id: str) -> FakeRuntime:
        runtime = FakeRuntime(session_id)
        runtimes[session_id] = runtime
        return runtime

    coordinator = SessionCoordinator(factory, capacity=2, poll_interval=0.001)
    run_a = coordinator.submit("a", session_id="A")
    run_b = coordinator.submit("b", session_id="B")

    assert coordinator.runtime_state("A").run_id == run_a.run_id
    assert coordinator.runtime_state("B").run_id == run_b.run_id
    assert {state.session_id for state in coordinator.active_runs()} == {"A", "B"}
    with pytest.raises(AgentBusyError) as error:
        coordinator.submit("c", session_id="C")
    assert error.value.capacity == 2
    assert error.value.active_count == 2

    runtimes["A"].handle.finished = True
    _wait_until(lambda: coordinator.runtime_state("A").status == "idle")
    run_c = coordinator.submit("c", session_id="C")
    assert run_c.session_id == "C"
    assert coordinator.runtime_state("B").run_id == run_b.run_id


def test_capacity_three_admits_three_sessions_and_rejects_fourth() -> None:
    from server.services.session_coordinator import AgentBusyError, SessionCoordinator

    coordinator = SessionCoordinator(
        lambda session_id: FakeRuntime(session_id),
        capacity=3,
        poll_interval=0.001,
    )
    for session_id in ("A", "B", "C"):
        coordinator.submit(session_id.lower(), session_id=session_id)

    assert {state.session_id for state in coordinator.active_runs()} == {"A", "B", "C"}
    with pytest.raises(AgentBusyError) as error:
        coordinator.submit("d", session_id="D")
    assert error.value.capacity == 3
    assert error.value.active_count == 3


@pytest.mark.parametrize("capacity", [0, 4])
def test_capacity_outside_supported_range_is_rejected(capacity: int) -> None:
    from server.services.session_coordinator import SessionCoordinator

    with pytest.raises(ValueError, match="between 1 and 3"):
        SessionCoordinator(lambda session_id: FakeRuntime(session_id), capacity=capacity)


def test_capacity_one_admission_is_atomic_under_concurrent_submit() -> None:
    import threading

    from server.services.session_coordinator import AgentBusyError, SessionCoordinator

    barrier = threading.Barrier(3)
    coordinator = SessionCoordinator(
        lambda session_id: FakeRuntime(session_id),
        capacity=1,
        poll_interval=0.001,
    )
    outcomes: list[tuple[str, str]] = []

    def submit(session_id: str) -> None:
        barrier.wait()
        try:
            coordinator.submit(session_id, session_id=session_id)
            outcomes.append((session_id, "admitted"))
        except AgentBusyError:
            outcomes.append((session_id, "busy"))

    threads = [threading.Thread(target=submit, args=(sid,)) for sid in ("A", "B")]
    for thread in threads:
        thread.start()
    barrier.wait()
    for thread in threads:
        thread.join(timeout=1)

    assert sorted(result for _, result in outcomes) == ["admitted", "busy"]
    assert len(coordinator.active_runs()) == 1


def test_abort_if_current_is_idempotent_and_never_targets_another_session() -> None:
    from server.services.session_coordinator import SessionCoordinator

    runtimes: dict[str, FakeRuntime] = {}

    def factory(session_id: str) -> FakeRuntime:
        runtime = FakeRuntime(session_id)
        runtimes[session_id] = runtime
        return runtime

    coordinator = SessionCoordinator(factory, capacity=2, poll_interval=0.001)
    run_a = coordinator.submit("a", session_id="A")
    run_b = coordinator.submit("b", session_id="B")

    first = coordinator.abort_if_current(session_id="A")
    second = coordinator.abort_if_current(session_id="A")
    assert first.run_id == run_a.run_id
    assert second.run_id == run_a.run_id
    assert runtimes["A"].abort_calls == 1
    assert runtimes["B"].abort_calls == 0
    assert coordinator.runtime_state("B").run_id == run_b.run_id


def test_stale_watcher_cannot_clear_newer_run_for_same_session() -> None:
    from server.services.session_coordinator import SessionCoordinator

    runtime = FakeRuntime("A")
    coordinator = SessionCoordinator(lambda _session_id: runtime, poll_interval=0.001)
    first = coordinator.submit("one", session_id="A")
    first_handle = runtime.handle
    first_handle.finished = True
    _wait_until(lambda: coordinator.runtime_state("A").status == "idle")

    second = coordinator.submit("two", session_id="A")
    assert second.run_id != first.run_id
    # Explicitly emulate a delayed stale completion callback.
    coordinator._watch_completion(runtime, first_handle, "A", first.run_id)
    assert coordinator.runtime_state("A").run_id == second.run_id
