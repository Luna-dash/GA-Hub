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
