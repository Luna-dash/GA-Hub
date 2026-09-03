"""Gate-integration tests: background producers against a REAL coordinator.

test_system_channels.py wires producers to a FakeCoordinator, so it proves
routing shape but never exercises the admission gate.  These tests bind the
real SessionCoordinator (capacity=1) through real SystemChannels and assert
the failure modes from the 2026-09 review: a refused admission reaches the
producer as AgentBusyError, is NOT counted as a fired trigger, answers the
wechat user with a busy notice, and cannot kill the autonomous idle loop.
"""
from __future__ import annotations

import threading
from types import SimpleNamespace

import pytest

from server.services.session_coordinator import (
    AgentBusyError,
    SessionCoordinator,
)
from server.services.session_metadata import SessionMetadataStore
from server.services.system_channels import SystemChannels


class _GateRuntime:
    """Minimal runtime: real handle lifecycle plus agent introspection."""

    def __init__(self, session_id: str) -> None:
        self.session_id = session_id
        self.submissions = 0
        self.handle = None
        self.agent = SimpleNamespace(last_reply_time=0, is_running=False)

    def submit(self, text: str, **kwargs):
        self.submissions += 1
        handle = SimpleNamespace(
            stream_id=f"stream-{self.session_id}-{self.submissions}",
            finished=False,
            final_text="",
            last_chunk="",
            abort_calls=0,
        )
        self.handle = handle
        return handle

    def abort(self) -> None:
        if self.handle is not None:
            self.handle.finished = True

    def shutdown(self, timeout: float = 5.0) -> bool:
        if self.handle is not None:
            self.handle.finished = True
        return True


@pytest.fixture()
def gate():
    """capacity=1 coordinator + real system channels over a temp store."""
    runtimes: dict[str, _GateRuntime] = {}

    def factory(session_id: str) -> _GateRuntime:
        return runtimes.setdefault(session_id, _GateRuntime(session_id))

    coordinator = SessionCoordinator(factory, capacity=1, poll_interval=0.005)
    channels = SystemChannels(
        coordinator=lambda: coordinator,
        store=SessionMetadataStore(),
        llm_key_resolver=lambda _row: None,
    )
    yield SimpleNamespace(coordinator=coordinator, channels=channels,
                          runtimes=runtimes)
    coordinator.shutdown(timeout=1.0)


def _busy(exc_reason: str):
    """A submit that always hits the gate's refusal."""
    def submit(_text: str, **_kwargs):
        raise AgentBusyError("system-wechat", "run-1", capacity=1,
                             active_count=1, reason=exc_reason)
    return submit


def test_wechat_busy_reply_reaches_the_user(gate) -> None:
    """A capacity-refused wechat message answers with a busy notice instead of
    dying silently inside the handler thread."""
    from server.services.wechat_service import WeChatService

    channel = gate.channels.channel("wechat")
    service = object.__new__(WeChatService)
    service.channel = channel
    sent: list[tuple[str, str]] = []
    service._send_text = lambda uid, text, ctx="": sent.append((uid, text))

    # Occupy the single capacity slot through the SAME coordinator the
    # wechat channel submits into.
    gate.coordinator.submit("occupy", session_id="other-session")
    channel.submit = _busy(AgentBusyError.REASON_CAPACITY_FULL)

    service._run_agent_stream("wx-user", "hello", [], "")

    assert len(sent) == 1
    assert "稍后再试" in sent[0][1]

    gate.runtimes["other-session"].handle.finished = True


def test_wechat_session_active_reply_names_the_conflict(gate) -> None:
    from server.services.wechat_service import WeChatService

    channel = gate.channels.channel("wechat")
    service = object.__new__(WeChatService)
    service.channel = channel
    sent: list[tuple[str, str]] = []
    service._send_text = lambda uid, text, ctx="": sent.append((uid, text))

    channel.submit = _busy(AgentBusyError.REASON_SESSION_ACTIVE)
    service._run_agent_stream("wx-user", "hello", [], "")

    assert "已有任务在处理中" in sent[0][1]


def test_task_fire_refusal_does_not_consume_the_trigger(gate) -> None:
    """A gate-refused scheduled fire keeps last_fired_at/fire_count untouched
    so the next tick retries, instead of being counted and lost."""
    from server.services.task_scheduler import TaskScheduler

    channel = gate.channels.channel("scheduled_task")
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(TaskScheduler, "_load", lambda self: None)
        service = TaskScheduler(channel, scheduler_runtime=SimpleNamespace(running=True))
    service.schedules["task-1"] = SimpleNamespace(
        id="task-1", name="demo", prompt="run", enabled=True,
        last_fired_at=None, fire_count=0, notify_email=None,
    )
    gate.coordinator.submit("occupy", session_id="other-session")
    channel.submit = _busy(AgentBusyError.REASON_CAPACITY_FULL)
    persisted: list[int] = []
    service._persist = lambda: persisted.append(1)

    result = service._fire("task-1")

    assert result == {"error": AgentBusyError.REASON_CAPACITY_FULL}
    assert service.schedules["task-1"].fire_count == 0
    assert service.schedules["task-1"].last_fired_at is None
    assert persisted == []

    gate.runtimes["other-session"].handle.finished = True


def test_autonomous_idle_loop_survives_a_refused_fire(gate) -> None:
    """One refused fire must skip the schedule, not kill the idle loop."""
    from server.services.autonomous_scheduler import AutonomousScheduler, Schedule

    channel = gate.channels.channel("autonomous")
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(AutonomousScheduler, "_load", lambda self: None)
        service = AutonomousScheduler(channel, scheduler_runtime=SimpleNamespace(running=True))
    schedule = Schedule(id="auto-1", type="idle", idle_minutes=0)
    service.schedules["auto-1"] = schedule
    service._persist = lambda: None

    gate.coordinator.submit("occupy", session_id="other-session")
    channel.submit = _busy(AgentBusyError.REASON_SESSION_ACTIVE)

    # Drive one loop iteration: wait() returns False (tick), then True (stop).
    ticks = iter([False, True])
    service._stop_event = SimpleNamespace(
        wait=lambda _t: next(ticks), is_set=lambda: False, set=lambda: None,
    )

    service._idle_loop()  # must return normally, not raise

    assert schedule.fire_count == 0
    assert schedule.last_fired_at == 0

    gate.runtimes["other-session"].handle.finished = True


def test_fire_succeeds_and_counts_once_the_gate_frees(gate) -> None:
    """The happy path through the REAL gate: a refused-then-retried fire is
    admitted once the slot frees, and exactly that fire is counted."""
    from server.services.task_scheduler import TaskScheduler

    channel = gate.channels.channel("scheduled_task")
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(TaskScheduler, "_load", lambda self: None)
        service = TaskScheduler(channel, scheduler_runtime=SimpleNamespace(running=True))
    service.schedules["task-1"] = SimpleNamespace(
        id="task-1", name="demo", prompt="run", enabled=True,
        last_fired_at=None, fire_count=0, notify_email=None,
    )
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(type(service), "_persist", lambda self: None)
        gate.coordinator.submit("occupy", session_id="other-session")
        real_submit = channel.submit
        channel.submit = _busy(AgentBusyError.REASON_CAPACITY_FULL)
        refused = service._fire("task-1")
        assert refused["error"] == AgentBusyError.REASON_CAPACITY_FULL

        channel.submit = real_submit
        gate.runtimes["other-session"].handle.finished = True
        # The coordinator reaps the finished run on its poll thread; wait for
        # the slot to actually free before retrying.
        import time as _time
        for _ in range(100):
            if gate.coordinator.active_run() is None:
                break
            _time.sleep(0.02)
        with mock_noop_watchers(service):
            result = service._fire("task-1")
        assert result.get("stream_id", "").startswith("stream-system-scheduled_task"), result
        assert service.schedules["task-1"].fire_count == 1
        assert service.schedules["task-1"].last_fired_at is not None


def mock_noop_watchers(service):
    """Keep the run's follow-up watcher from racing the test teardown."""
    from unittest import mock
    return mock.patch.object(service._watchers, "start", lambda *_a, **_k: True)
