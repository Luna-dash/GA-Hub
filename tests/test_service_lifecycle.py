"""Lifecycle regression tests for long-lived backend services."""
from __future__ import annotations

import queue
import threading
import time
from types import SimpleNamespace
from unittest import mock

from server.services.agent_service import AgentService
from server.services.autonomous_scheduler import AutonomousScheduler
from server.services.feishu_service import FeishuService
from server.services.task_scheduler import TaskScheduler


def test_cancel_background_task_reaps_cancelled_coroutine() -> None:
    import asyncio
    from server.main import _cancel_background_task

    finalized = asyncio.Event()

    async def scenario() -> None:
        async def worker() -> None:
            try:
                await asyncio.Event().wait()
            finally:
                finalized.set()

        task = asyncio.create_task(worker())
        await asyncio.sleep(0)
        await _cancel_background_task(task)
        assert task.cancelled()
        assert finalized.is_set()

    asyncio.run(scenario())


class _FakeAgent:
    def __init__(self) -> None:
        self.inc_out = True
        self.verbose = True
        self.last_reply_time = int(time.time())
        self.is_running = False
        self.task_queue: queue.Queue[object] = queue.Queue()
        self._turn_end_hooks: dict[str, object] = {}
        self.exited = threading.Event()
        self.abort_calls = 0

    def run(self) -> None:
        while True:
            task = self.task_queue.get()
            self.task_queue.task_done()
            if not isinstance(task, dict):
                self.exited.set()
                return

    def abort(self) -> None:
        self.abort_calls += 1
        self.is_running = False


def test_agent_service_shutdown_aborts_signals_and_joins_run_thread() -> None:
    agent = _FakeAgent()
    service = AgentService(agent=agent, manage_global_preference=False)
    service.start_run_thread()

    service.shutdown(timeout=1.0)

    assert agent.exited.is_set()
    assert service._run_thread is None
    assert agent.abort_calls == 0
    service.shutdown(timeout=0.1)  # idempotent


def test_agent_service_shutdown_aborts_active_agent_before_sentinel() -> None:
    agent = _FakeAgent()
    agent.is_running = True
    service = AgentService(agent=agent, manage_global_preference=False)
    service.start_run_thread()

    service.shutdown(timeout=1.0)

    assert agent.abort_calls == 1
    assert agent.exited.is_set()


def test_agent_shutdown_releases_only_a_stopped_singleton() -> None:
    stopped = AgentService(agent=_FakeAgent(), manage_global_preference=False)
    AgentService._instance = stopped
    stopped.shutdown(timeout=0)
    assert AgentService._instance is None

    live = AgentService(agent=_FakeAgent(), manage_global_preference=False)
    live._run_thread = mock.Mock()
    live._run_thread.is_alive.return_value = True
    AgentService._instance = live
    try:
        live.shutdown(timeout=0)
        assert AgentService._instance is live
        live._run_thread.join.assert_called_once_with(timeout=0.0)
    finally:
        AgentService._instance = None


def test_task_scheduler_shutdown_releases_singleton_for_clean_restart() -> None:
    first_sched = mock.Mock()
    second_sched = mock.Mock()
    first_sched.running = False
    second_sched.running = False
    service = SimpleNamespace()

    with mock.patch.object(TaskScheduler, "_load"), mock.patch(
        "server.services.task_scheduler.BackgroundScheduler",
        side_effect=[first_sched, second_sched],
    ):
        TaskScheduler._instance = None
        try:
            first = TaskScheduler.instance(service)
            first.shutdown()
            second = TaskScheduler.instance(service)
        finally:
            TaskScheduler._instance = None

    assert second is not first
    first_sched.shutdown.assert_called_once_with(wait=False)


def test_autonomous_shutdown_wakes_idle_thread_and_releases_singleton() -> None:
    first_sched = mock.Mock()
    second_sched = mock.Mock()
    first_sched.running = False
    second_sched.running = False
    service = SimpleNamespace(agent=SimpleNamespace(last_reply_time=0, is_running=False))

    with mock.patch.object(AutonomousScheduler, "_load"), mock.patch(
        "server.services.autonomous_scheduler.BackgroundScheduler",
        side_effect=[first_sched, second_sched],
    ):
        AutonomousScheduler._instance = None
        try:
            first = AutonomousScheduler.instance(service)
            first.start()
            thread = first._idle_thread
            assert thread is not None and thread.is_alive()
            first.shutdown(timeout=1.0)
            second = AutonomousScheduler.instance(service)
        finally:
            AutonomousScheduler._instance = None

    assert not thread.is_alive()
    assert first._idle_thread is None
    assert second is not first
    first_sched.shutdown.assert_called_once_with(wait=False)


def test_autonomous_shutdown_timeout_keeps_live_singleton() -> None:
    service = object.__new__(AutonomousScheduler)
    service._stop_event = mock.Mock()
    service._idle_thread = mock.Mock()
    service._idle_thread.is_alive.return_value = True
    service._sched = mock.Mock()
    AutonomousScheduler._instance = service
    try:
        service.shutdown(timeout=0)
        assert AutonomousScheduler._instance is service
        service._idle_thread.join.assert_called_once_with(timeout=0.0)
    finally:
        AutonomousScheduler._instance = None


def test_feishu_log_watcher_restarts_on_same_singleton() -> None:
    service = FeishuService()
    with mock.patch.object(service, "_publish_chat_events_from_log"):
        assert service.start_log_watcher(interval=0.01)
        first_thread = service._poll_thread
        assert first_thread is not None and first_thread.is_alive()
        service.shutdown()
        assert not first_thread.is_alive()

        assert service.start_log_watcher(interval=0.01)
        second_thread = service._poll_thread
        assert second_thread is not None and second_thread is not first_thread
        service.shutdown()
        assert not second_thread.is_alive()
