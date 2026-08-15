"""Focused tests for Hub-only Conductor output and timeout policy (Phase C.2)."""
from __future__ import annotations

from dataclasses import dataclass
import queue
from threading import RLock

from server.services import conductor_service
from server.services.conductor_ext_timeout import OutputBudget, TimeoutMonitor


def test_output_budget_truncates_once_with_injected_counter():
    events: list[tuple[str, dict]] = []
    budget = OutputBudget(
        "agent-1",
        max_tokens=5,
        max_lines=10,
        token_counter=len,
        publish=lambda topic, payload: events.append((topic, payload)),
    )

    assert budget.append("abc") == "abc"
    output = budget.append("def")

    assert output.startswith("abcde")
    assert "output truncated" in output
    assert budget.truncated is True
    assert budget.append("ignored") == output
    assert len(events) == 1
    assert events[0][0] == "conductor:subagent_timeout_output"
    assert events[0][1]["id"] == "agent-1"
    assert events[0][1]["estimated_tokens"] == 5


def test_output_budget_enforces_line_limit_and_reconciles_full_done():
    budget = OutputBudget("agent-2", max_tokens=100, max_lines=2)

    assert budget.append("one\n") == "one\n"
    output = budget.finish("one\ntwo\nthree")

    assert output.startswith("one\ntwo")
    assert "output truncated" in output
    assert output.count("\n") <= 2

    replacement = OutputBudget("agent-3", max_tokens=100, max_lines=10)
    replacement.append("streamed")
    assert replacement.finish("authoritative done") == "authoritative done"


@dataclass
class FakeState:
    id: str
    status: str
    created_at: float
    updated_at: float
    active_generation: int = 0


class FakeCore:
    def __init__(self, *states: FakeState):
        self.lock = RLock()
        self.subagents = {state.id: state for state in states}


def test_timeout_monitor_warns_once_per_kind_without_mutating_state():
    state = FakeState("late", "running", created_at=0.0, updated_at=80.0)
    stopped = FakeState("stopped", "stopped", created_at=0.0, updated_at=0.0)
    core = FakeCore(state, stopped)
    events: list[tuple[str, dict]] = []
    monitor = TimeoutMonitor(
        core,
        silence_timeout=10.0,
        total_timeout=50.0,
        check_interval=1.0,
        publish=lambda topic, payload: events.append((topic, payload)),
        clock=lambda: 100.0,
    )

    assert monitor.check_once() == [("late", "silence"), ("late", "total")]
    assert monitor.check_once() == []
    assert state.status == "running"
    assert stopped.status == "stopped"
    assert [topic for topic, _ in events] == [
        "conductor:subagent_timeout_silence",
        "conductor:subagent_timeout_total",
    ]
    assert all(payload["action"] == "warning_only" for _, payload in events)


def test_timeout_monitor_warns_again_for_a_new_generation():
    state = FakeState(
        "retrying",
        "running",
        created_at=0.0,
        updated_at=80.0,
        active_generation=1,
    )
    monitor = TimeoutMonitor(
        FakeCore(state),
        silence_timeout=10.0,
        total_timeout=50.0,
        check_interval=1.0,
        clock=lambda: 100.0,
    )

    assert monitor.check_once() == [("retrying", "silence"), ("retrying", "total")]
    assert {key[:2] for key in monitor._emitted} == {("retrying", 1)}

    state.active_generation = 2
    assert monitor.check_once() == [("retrying", "silence"), ("retrying", "total")]
    assert {key[:2] for key in monitor._emitted} == {("retrying", 2)}
    assert monitor.check_once() == []


def test_timeout_monitor_discards_emissions_for_finished_or_removed_agents():
    state = FakeState("finished", "running", created_at=0.0, updated_at=0.0)
    core = FakeCore(state)
    monitor = TimeoutMonitor(
        core,
        silence_timeout=10.0,
        total_timeout=50.0,
        check_interval=1.0,
        clock=lambda: 100.0,
    )

    assert monitor.check_once() == [("finished", "silence"), ("finished", "total")]
    assert monitor._emitted

    state.status = "done"
    assert monitor.check_once() == []
    assert monitor._emitted == set()

    with core.lock:
        del core.subagents[state.id]
    assert monitor.check_once() == []
    assert monitor._emitted == set()


def test_timeout_monitor_validates_positive_configuration():
    try:
        TimeoutMonitor(object(), silence_timeout=0)
    except ValueError as exc:
        assert "positive" in str(exc)
    else:
        raise AssertionError("zero timeout must be rejected")


class _FakePool:
    def __init__(self):
        self.displays: list[tuple[str, str, bool]] = []

    def on_display(self, agent_id: str, output: str, done: bool) -> None:
        self.displays.append((agent_id, output, done))

    def snapshot(self) -> list:
        return []


def test_display_bridge_reconciles_stream_chunks_with_full_done(monkeypatch):
    dq = queue.Queue()
    dq.put({"next": "hel"})
    dq.put({"next": "lo"})
    dq.put({"done": "hello"})
    pool = _FakePool()
    monkeypatch.setattr(conductor_service, "push_subagent_cards", lambda _cards: None)

    conductor_service.monitor_display_queue("agent-3", dq, pool, trigger_when_done=False)

    assert pool.displays == [
        ("agent-3", "hel", False),
        ("agent-3", "hello", False),
        ("agent-3", "hello", True),
    ]


def test_display_bridge_keeps_bounded_output_when_done_is_full(monkeypatch):
    dq = queue.Queue()
    dq.put({"next": "abc"})
    dq.put({"next": "def"})
    dq.put({"done": "abcdef"})
    pool = _FakePool()
    monkeypatch.setattr(conductor_service, "push_subagent_cards", lambda _cards: None)
    monkeypatch.setattr(
        conductor_service,
        "OutputBudget",
        lambda agent_id, publish=None: OutputBudget(
            agent_id,
            max_tokens=5,
            max_lines=10,
            token_counter=len,
            publish=publish,
        ),
    )

    conductor_service.monitor_display_queue("agent-4", dq, pool, trigger_when_done=False)

    bounded = pool.displays[-1][1]
    assert pool.displays[-1] == ("agent-4", bounded, True)
    assert bounded.startswith("abcde")
    assert "output truncated" in bounded
    assert "abcdef" not in bounded


def test_conductor_service_shutdown_stops_timeout_monitor_twice_safely():
    monitor = TimeoutMonitor(FakeCore(), check_interval=1.0)
    service = object.__new__(conductor_service.ConductorService)
    service.timeout_monitor = monitor

    service.shutdown()
    service.shutdown()

    assert monitor._stop.is_set()
