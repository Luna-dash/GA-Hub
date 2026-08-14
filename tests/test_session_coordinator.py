"""Concurrency contract for the message-free session runtime coordinator."""
from __future__ import annotations

import threading
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
        self.btw_questions: list[str] = []
        self.rewinds: list[dict] = []

    def submit(self, text: str, **kwargs) -> FakeHandle:
        self.submissions.append({"text": text, **kwargs})
        self.handle = FakeHandle(f"stream-{self.session_id}-{len(self.submissions)}")
        return self.handle

    def abort(self) -> None:
        self.abort_calls += 1

    def btw(self, question: str) -> str:
        self.btw_questions.append(question)
        return f"side:{self.session_id}:{question}"

    def rewind_turns(self, *, sid: str | None = None, n: int | None = None) -> dict:
        request = {"sid": sid, "n": n}
        self.rewinds.append(request)
        return {"removed_sids": [], "kept": 0, "history_lines": 0}


def test_session_configuration_is_atomic_and_rejected_while_running() -> None:
    from server.services.session_coordinator import AgentBusyError, SessionCoordinator

    runtimes: dict[str, FakeRuntime] = {}

    def factory(session_id: str) -> FakeRuntime:
        runtime = FakeRuntime(session_id)
        runtimes[session_id] = runtime
        return runtime

    coordinator = SessionCoordinator(factory, poll_interval=0.005)
    seen: list[FakeRuntime | None] = []
    assert coordinator.configure_if_idle("A", lambda runtime: seen.append(runtime) or "saved") == "saved"
    assert seen == [None]

    coordinator.submit("alpha", session_id="A")
    with pytest.raises(AgentBusyError):
        coordinator.configure_if_idle("A", lambda runtime: None)

    assert runtimes["A"].handle is not None
    runtimes["A"].handle.finished = True
    _wait_until(lambda: coordinator.active_run() is None)
    coordinator.configure_if_idle("A", lambda runtime: seen.append(runtime))
    assert seen[-1] is runtimes["A"]


def test_btw_reuses_session_runtime_and_can_overlap_normal_run() -> None:
    from server.services.session_coordinator import (
        AgentBusyError,
        SessionCoordinator,
    )

    runtimes: dict[str, FakeRuntime] = {}
    coordinator = SessionCoordinator(
        lambda session_id: runtimes.setdefault(session_id, FakeRuntime(session_id)),
        poll_interval=0.005,
    )
    coordinator.submit("main", session_id="A")

    assert coordinator.side_question("A", "why") == "side:A:why"
    assert runtimes["A"].btw_questions == ["why"]
    with pytest.raises(AgentBusyError) as error:
        coordinator.rewind("A", n=1)
    assert error.value.reason == AgentBusyError.REASON_SESSION_ACTIVE

    assert runtimes["A"].handle is not None
    runtimes["A"].handle.finished = True
    _wait_until(lambda: coordinator.active_run() is None)


def test_rewind_is_exclusive_only_within_its_session() -> None:
    from server.services.session_coordinator import (
        SessionControlBusyError,
        SessionCoordinator,
    )

    started = threading.Event()
    release = threading.Event()
    errors: list[BaseException] = []

    class BlockingRuntime(FakeRuntime):
        def rewind_turns(self, *, sid: str | None = None, n: int | None = None) -> dict:
            started.set()
            if not release.wait(1):
                raise TimeoutError("rewind test gate timed out")
            return super().rewind_turns(sid=sid, n=n)

    runtimes: dict[str, FakeRuntime] = {}

    def factory(session_id: str) -> FakeRuntime:
        runtime = BlockingRuntime(session_id) if session_id == "A" else FakeRuntime(session_id)
        runtimes[session_id] = runtime
        return runtime

    coordinator = SessionCoordinator(factory, capacity=1, poll_interval=0.005)

    def rewind() -> None:
        try:
            coordinator.rewind("A", n=1)
        except BaseException as exc:  # pragma: no cover - asserted below
            errors.append(exc)

    thread = threading.Thread(target=rewind)
    thread.start()
    assert started.wait(1)

    with pytest.raises(SessionControlBusyError):
        coordinator.side_question("A", "blocked")
    with pytest.raises(SessionControlBusyError):
        coordinator.configure_if_idle("A", lambda runtime: runtime)
    with pytest.raises(SessionControlBusyError):
        coordinator.submit("blocked", session_id="A")

    assert coordinator.side_question("B", "allowed") == "side:B:allowed"
    run_b = coordinator.submit("allowed", session_id="B")
    assert run_b.session_id == "B"

    release.set()
    thread.join(timeout=1)
    assert not thread.is_alive()
    assert errors == []

    assert runtimes["B"].handle is not None
    runtimes["B"].handle.finished = True
    _wait_until(lambda: coordinator.active_run() is None)


def test_inflight_btw_blocks_mutating_controls_but_not_submit() -> None:
    from server.services.session_coordinator import (
        SessionControlBusyError,
        SessionCoordinator,
    )

    started = threading.Event()
    release = threading.Event()

    class BlockingBtwRuntime(FakeRuntime):
        def btw(self, question: str) -> str:
            started.set()
            if not release.wait(1):
                raise TimeoutError("BTW test gate timed out")
            return super().btw(question)

    runtime = BlockingBtwRuntime("A")
    coordinator = SessionCoordinator(lambda _session_id: runtime, poll_interval=0.005)
    thread = threading.Thread(target=lambda: coordinator.side_question("A", "side"))
    thread.start()
    assert started.wait(1)

    with pytest.raises(SessionControlBusyError) as error:
        coordinator.rewind("A", n=1)
    assert error.value.operation == "btw"
    with pytest.raises(SessionControlBusyError):
        coordinator.configure_if_idle("A", lambda current: current)

    run = coordinator.submit("main", session_id="A")
    assert run.status == "running"

    release.set()
    thread.join(timeout=1)
    assert not thread.is_alive()
    assert runtime.handle is not None
    runtime.handle.finished = True
    _wait_until(lambda: coordinator.active_run() is None)


def test_release_runtime_is_exclusive_and_shuts_down_cached_runtime() -> None:
    from server.services.session_coordinator import (
        AgentBusyError,
        SessionControlBusyError,
        SessionCoordinator,
    )

    runtime = FakeRuntime("A")
    coordinator = SessionCoordinator(lambda _session_id: runtime, poll_interval=0.005)
    coordinator._runtimes["A"] = runtime
    shutdowns: list[FakeRuntime] = []

    assert coordinator.release_runtime("A", shutdown=shutdowns.append) is True
    assert shutdowns == [runtime]
    assert coordinator._runtimes == {}
    assert coordinator.release_runtime("A", shutdown=shutdowns.append) is False
    assert shutdowns == [runtime]

    coordinator._runtimes["A"] = runtime
    run = coordinator.submit("main", session_id="A")
    with pytest.raises(AgentBusyError):
        coordinator.release_runtime("A", shutdown=shutdowns.append)
    assert coordinator._runtimes["A"] is runtime

    runtime.handle.finished = True
    _wait_until(lambda: coordinator.active_run() is None)

    started = threading.Event()
    release = threading.Event()

    def blocking_release() -> None:
        started.set()
        if not release.wait(1):
            raise TimeoutError("release test gate timed out")

    import threading as _threading
    thread = _threading.Thread(
        target=lambda: coordinator.exclusive("A", "archive_delete", blocking_release)
    )
    thread.start()
    assert started.wait(1)
    with pytest.raises(SessionControlBusyError):
        coordinator.release_runtime("A", shutdown=shutdowns.append)
    release.set()
    thread.join(timeout=1)
    assert not thread.is_alive()


def test_runtime_release_and_disposal_share_one_reservation() -> None:
    from server.services.session_coordinator import (
        SessionControlBusyError,
        SessionCoordinator,
    )

    old_runtime = FakeRuntime("A")
    new_runtime = FakeRuntime("A")
    made: list[FakeRuntime] = []

    def factory(_session_id: str) -> FakeRuntime:
        runtime = made.pop(0) if made else new_runtime
        return runtime

    coordinator = SessionCoordinator(factory, poll_interval=0.005)
    coordinator._runtimes["A"] = old_runtime
    events: list[str] = []
    disposal_started = threading.Event()
    disposal_resume = threading.Event()

    def dispose() -> None:
        events.append("dispose")
        disposal_started.set()
        if not disposal_resume.wait(1):
            raise TimeoutError("disposal test gate timed out")

    thread = threading.Thread(
        target=lambda: coordinator.release_runtime(
            "A",
            shutdown=lambda _runtime: events.append("shutdown"),
            operation="archive_delete",
            after_release=dispose,
        )
    )
    thread.start()
    assert disposal_started.wait(1)

    with pytest.raises(SessionControlBusyError) as error:
        coordinator.submit("main", session_id="A")
    assert error.value.operation == "archive_delete"
    assert new_runtime.submissions == []

    disposal_resume.set()
    thread.join(timeout=1)
    assert not thread.is_alive()
    assert events == ["shutdown", "dispose"]


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


def test_completion_snapshot_survives_short_run_and_notifies_observer() -> None:
    from server.services.session_coordinator import RuntimeState, SessionCoordinator

    made: list[FakeRuntime] = []
    notifications: list[RuntimeState] = []

    def factory(session_id: str) -> FakeRuntime:
        runtime = FakeRuntime(session_id)
        made.append(runtime)
        return runtime

    coordinator = SessionCoordinator(
        factory,
        poll_interval=0.005,
        on_state_change=notifications.append,
    )
    run = coordinator.submit("quick", session_id="A")
    assert made[0].handle is not None
    made[0].handle.finished = True

    _wait_until(lambda: coordinator.runtime_state("A").status == "idle")
    completed = coordinator.runtime_state("A")
    assert completed.run_id is None
    assert completed.stream_id is None
    assert completed.completed_run_id == run.run_id
    assert notifications[-1] == completed


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
