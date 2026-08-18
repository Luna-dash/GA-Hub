"""Scheduler watcher threads remain owned by their service lifecycle."""
from __future__ import annotations

import threading
import time
from types import SimpleNamespace
from unittest import mock

import pytest

from server.services.autonomous_scheduler import AutonomousScheduler, Schedule
from server.services.task_scheduler import TaskSchedule, TaskScheduler
from server.services.watcher_registry import WatcherRegistry


class _Handle:
    def __init__(self, *, finished: bool = False) -> None:
        self.stream_id = "stream-1"
        self.finished = finished
        self.final_text = "final result" if finished else ""
        self.last_chunk = "partial result"


class _AgentService:
    def __init__(self, handle: _Handle) -> None:
        self.handle = handle
        self.agent = SimpleNamespace(last_reply_time=0, is_running=False)

    def submit(self, _prompt: str, *, source: str) -> _Handle:
        assert source in {"autonomous", "scheduled_task"}
        return self.handle


def _autonomous_scheduler(handle: _Handle) -> AutonomousScheduler:
    runtime = SimpleNamespace(running=True)
    with mock.patch.object(AutonomousScheduler, "_load"):
        service = AutonomousScheduler(_AgentService(handle), scheduler_runtime=runtime)
    service.schedules["auto-1"] = Schedule(id="auto-1", type="interval")
    return service


def _task_scheduler(handle: _Handle) -> TaskScheduler:
    runtime = SimpleNamespace(running=True)
    with mock.patch.object(TaskScheduler, "_load"):
        service = TaskScheduler(_AgentService(handle), scheduler_runtime=runtime)
    service.schedules["task-1"] = TaskSchedule(id="task-1", prompt="run")
    return service


def test_registry_shutdown_reports_a_watcher_that_misses_the_deadline() -> None:
    registry = WatcherRegistry()
    entered = threading.Event()
    release = threading.Event()

    def blocked(_stop_event: threading.Event) -> None:
        entered.set()
        release.wait()

    assert registry.start(blocked, name="blocked-watch")
    assert entered.wait(1)
    assert registry.shutdown(timeout=0) is False
    assert registry.active_count == 1

    release.set()
    assert registry.shutdown(timeout=1) is True
    assert registry.active_count == 0


def test_registry_zero_timeout_does_not_block_on_a_final_callback() -> None:
    registry = WatcherRegistry()
    entered = threading.Event()
    release = threading.Event()

    def blocking_callback() -> None:
        entered.set()
        release.wait()

    def watcher(_stop_event: threading.Event) -> None:
        registry.run_if_active(blocking_callback)

    assert registry.start(watcher, name="blocking-final-callback")
    assert entered.wait(1)

    started_at = time.monotonic()
    assert registry.shutdown(timeout=0) is False
    assert time.monotonic() - started_at < 0.25

    release.set()
    assert registry.shutdown(timeout=1) is True


def test_registry_can_restart_only_after_shutdown_completed() -> None:
    registry = WatcherRegistry()

    assert registry.shutdown(timeout=0) is True
    assert registry.shutdown(timeout=0) is True
    registry.reset()

    finished = threading.Event()
    assert registry.start(lambda _stop_event: finished.set(), name="restarted-watch")
    assert finished.wait(1)
    assert registry.shutdown(timeout=1) is True


def test_autonomous_shutdown_cancels_pending_watcher_without_side_effects() -> None:
    service = _autonomous_scheduler(_Handle())

    with (
        mock.patch.object(service, "_persist"),
        mock.patch.object(service, "_snapshot_reports", return_value=set()),
        mock.patch.object(service, "_record_run") as record_run,
        mock.patch("server.services.autonomous_scheduler.bus.publish") as publish,
    ):
        result = service.trigger_now("auto-1")
        assert result["stream_id"] == "stream-1"
        assert service._watchers.active_count == 1
        assert service.shutdown(timeout=1) is True

    record_run.assert_not_called()
    assert [call.args[0] for call in publish.call_args_list] == ["autonomous:fired"]
    assert service._watchers.active_count == 0


def test_task_shutdown_cancels_pending_watcher_without_side_effects() -> None:
    service = _task_scheduler(_Handle())

    with (
        mock.patch.object(service, "_persist"),
        mock.patch.object(service, "_record_run") as record_run,
        mock.patch("server.services.task_scheduler.bus.publish") as publish,
    ):
        result = service.trigger_now("task-1")
        assert result["stream_id"] == "stream-1"
        assert service._watchers.active_count == 1
        assert service.shutdown(timeout=1) is True

    record_run.assert_not_called()
    assert [call.args[0] for call in publish.call_args_list] == ["task:fired"]
    assert service._watchers.active_count == 0


@pytest.mark.parametrize(
    ("scheduler_type", "service_factory", "instance_attr"),
    [
        ("task", _task_scheduler, TaskScheduler),
        ("autonomous", _autonomous_scheduler, AutonomousScheduler),
    ],
)
def test_shutdown_timeout_barriers_fire_before_releasing_singleton(
    scheduler_type: str,
    service_factory,
    instance_attr,
) -> None:
    service = service_factory(_Handle())
    entered = threading.Event()
    release = threading.Event()
    submitted = mock.Mock(wraps=service.agent_service.submit)

    def blocked_persist() -> None:
        entered.set()
        release.wait(1)

    service.agent_service.submit = submitted
    instance_attr._instance = service
    result: dict[str, object] = {}
    try:
        with mock.patch.object(service, "_persist", side_effect=blocked_persist), \
             mock.patch(f"server.services.{'task_scheduler' if scheduler_type == 'task' else 'autonomous_scheduler'}.bus.publish"):
            thread = threading.Thread(
                target=lambda: result.update(service.trigger_now("task-1" if scheduler_type == "task" else "auto-1")),
                daemon=True,
            )
            thread.start()
            assert entered.wait(1)
            assert service.shutdown(timeout=0) is False
            assert instance_attr._instance is service
            release.set()
            thread.join(1)
        assert result == {"error": "shutting_down"}
        submitted.assert_not_called()
        assert service.shutdown(timeout=1) is True
        assert instance_attr._instance is None
    finally:
        release.set()
        instance_attr._instance = None


def test_task_instance_does_not_reuse_a_scheduler_still_shutting_down() -> None:
    service = _task_scheduler(_Handle())
    entered = threading.Event()
    release = threading.Event()

    def blocked(_stop_event: threading.Event) -> None:
        entered.set()
        release.wait(1)

    assert service._watchers.start(blocked, name="stale-task-watch")
    assert entered.wait(1)
    service._stop_event.set()
    TaskScheduler._instance = service
    try:
        with pytest.raises(RuntimeError, match="still shutting down"):
            TaskScheduler.instance(SimpleNamespace(), scheduler_runtime=SimpleNamespace())
        assert TaskScheduler._instance is service
    finally:
        release.set()
        assert service.shutdown(timeout=1) is True
        TaskScheduler._instance = None


def test_completed_task_watcher_records_and_reaps_itself() -> None:
    service = _task_scheduler(_Handle(finished=True))
    recorded = threading.Event()

    with (
        mock.patch.object(service, "_persist"),
        mock.patch.object(service, "_record_run", side_effect=lambda _run: recorded.set()),
        mock.patch("server.services.task_scheduler.bus.publish") as publish,
    ):
        service.trigger_now("task-1")
        assert recorded.wait(1)
        assert service.shutdown(timeout=1) is True

    assert [call.args[0] for call in publish.call_args_list] == ["task:fired", "task:done"]
    assert service._watchers.active_count == 0
