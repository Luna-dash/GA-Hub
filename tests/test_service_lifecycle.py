"""Lifecycle regression tests for long-lived backend services."""
from __future__ import annotations

import queue
import threading
import time
from types import SimpleNamespace
from unittest import mock

import pytest

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


def test_delayed_feishu_autostart_uses_the_lifespan_owned_service() -> None:
    import asyncio
    from server.main import _delayed_feishu_autostart

    service = mock.Mock()
    service.start.return_value = {"started": True}

    asyncio.run(_delayed_feishu_autostart(service, delay_seconds=0))

    service.start.assert_called_once_with()


def test_app_status_and_shutdown_reuse_only_startup_owned_services() -> None:
    from fastapi.testclient import TestClient
    from server import _paths, main
    from server.routes import sessions as session_routes
    from server.routes import tokens as token_routes
    from server.services import core_contract

    if _paths.GA_ROOT is None:
        pytest.skip("normal-mode app lifecycle needs an importable GA core")

    agent = mock.Mock()
    agent.status.return_value = SimpleNamespace(
        is_running=False,
        llm_no=0,
        llm_name="test",
        llm_model="test-model",
        last_reply_time=0,
        queued_tasks=0,
        history_lines=0,
        current_title="",
    )
    feishu = mock.Mock()
    feishu.status.return_value = {
        "running": False,
        "pid": None,
        "returncode": None,
        "external": False,
        "fsapp_path": "D:/study/GA/frontends/fsapp.py",
        "fsapp_exists": True,
        "python": "python",
        "log_file": "feishu.log",
        "log_exists": False,
        "last_check": None,
        "last_check_ts": 0.0,
    }
    scheduler_status = {
        "runtime": {"running": True},
        "scheduled_chats": {"state": "running", "schedule_count": 0, "error": None},
        "autonomous": {"state": "running", "schedule_count": 2, "error": None},
        "tasks": {"state": "running", "schedule_count": 3, "error": None},
    }
    scheduler_host = mock.Mock()
    scheduler_host.status.return_value = scheduler_status
    agent_factory = mock.Mock(return_value=agent)
    feishu_factory = mock.Mock(return_value=feishu)

    with (
        mock.patch.object(_paths, "GA_ROOT", _paths.GA_ROOT),
        mock.patch("server.services.agent_service.AgentService.instance", agent_factory),
        mock.patch("server.services.feishu_service.FeishuService.instance", feishu_factory),
        mock.patch("server.services.scheduler_host.SchedulerHost", return_value=scheduler_host),
        mock.patch("server.services.autonomous_scheduler.AutonomousScheduler.instance", side_effect=AssertionError("status constructed autonomous")) as autonomous_factory,
        mock.patch("server.services.task_scheduler.TaskScheduler.instance", side_effect=AssertionError("status constructed tasks")) as task_factory,
        mock.patch.object(core_contract, "probe_core_contract", return_value=SimpleNamespace(ok=True, core_commit="test", errors=[])),
        mock.patch.object(token_routes, "start_persistence"),
        mock.patch.object(token_routes, "stop_persistence"),
        mock.patch.object(session_routes, "stop_session_runtimes"),
        mock.patch("server.services.conductor_service.shutdown_conductor_service", return_value=True),
        mock.patch("server.services.goalhive_service.shutdown_goalhive_service", return_value=True),
    ):
        app = main.create_app()
        with TestClient(app, base_url="http://127.0.0.1") as client:
            response = client.get("/api/status")

    assert response.status_code == 200
    assert response.json()["autonomous"] == {"schedule_count": 2}
    assert response.json()["tasks"] == {"schedule_count": 3}
    agent_factory.assert_called_once_with()
    feishu_factory.assert_called_once_with()
    autonomous_factory.assert_not_called()
    task_factory.assert_not_called()
    scheduler_host.shutdown_all.assert_called_once_with()
    feishu.shutdown.assert_called_once_with()
    agent._archive_snapshots_to_chat_history.assert_called_once_with()
    agent.shutdown.assert_called_once_with()
    assert session_routes._coordinator_stopping is False


def test_agent_shutdown_still_runs_when_snapshot_archival_fails() -> None:
    from fastapi.testclient import TestClient
    from server import _paths, main
    from server.routes import sessions as session_routes
    from server.routes import tokens as token_routes
    from server.services import core_contract

    if _paths.GA_ROOT is None:
        pytest.skip("normal-mode app lifecycle needs an importable GA core")

    agent = mock.Mock()
    agent._archive_snapshots_to_chat_history.side_effect = RuntimeError("archive boom")
    scheduler_host = mock.Mock()
    feishu = mock.Mock()

    with (
        mock.patch("server.services.agent_service.AgentService.instance", return_value=agent),
        mock.patch("server.services.feishu_service.FeishuService.instance", return_value=feishu),
        mock.patch("server.services.scheduler_host.SchedulerHost", return_value=scheduler_host),
        mock.patch.object(core_contract, "probe_core_contract", return_value=SimpleNamespace(ok=True, core_commit="test", errors=[])),
        mock.patch.object(token_routes, "start_persistence"),
        mock.patch.object(token_routes, "stop_persistence"),
        mock.patch.object(session_routes, "stop_session_runtimes"),
        mock.patch("server.services.conductor_service.shutdown_conductor_service", return_value=True),
        mock.patch("server.services.goalhive_service.shutdown_goalhive_service", return_value=True),
    ):
        app = main.create_app()
        with TestClient(app, base_url="http://127.0.0.1"):
            pass

    agent._archive_snapshots_to_chat_history.assert_called_once_with()
    agent.shutdown.assert_called_once_with()


def test_reentered_lifespan_never_reaps_previous_round_services_twice() -> None:
    from fastapi.testclient import TestClient
    from server import _paths, main
    from server.routes import sessions as session_routes
    from server.routes import tokens as token_routes
    from server.services import core_contract

    if _paths.GA_ROOT is None:
        pytest.skip("normal-mode app lifecycle needs an importable GA core")

    agent = mock.Mock()
    feishu = mock.Mock()
    scheduler_host = mock.Mock()
    agent_factory = mock.Mock(side_effect=[agent, RuntimeError("second startup boom")])

    with (
        mock.patch("server.services.agent_service.AgentService.instance", agent_factory),
        mock.patch("server.services.feishu_service.FeishuService.instance", return_value=feishu),
        mock.patch("server.services.scheduler_host.SchedulerHost", return_value=scheduler_host),
        mock.patch.object(core_contract, "probe_core_contract", return_value=SimpleNamespace(ok=True, core_commit="test", errors=[])),
        mock.patch.object(token_routes, "start_persistence"),
        mock.patch.object(token_routes, "stop_persistence"),
        mock.patch.object(session_routes, "stop_session_runtimes"),
        mock.patch("server.services.conductor_service.shutdown_conductor_service", return_value=True),
        mock.patch("server.services.goalhive_service.shutdown_goalhive_service", return_value=True),
    ):
        app = main.create_app()
        with TestClient(app, base_url="http://127.0.0.1"):
            pass
        with pytest.raises(RuntimeError, match="second startup boom"):
            with TestClient(app, base_url="http://127.0.0.1"):
                pass

    assert agent_factory.call_count == 2
    scheduler_host.shutdown_all.assert_called_once_with()
    feishu.shutdown.assert_called_once_with()
    agent._archive_snapshots_to_chat_history.assert_called_once_with()
    agent.shutdown.assert_called_once_with()


def test_partial_startup_failure_reaps_already_owned_services() -> None:
    from fastapi.testclient import TestClient
    from server import _paths, main
    from server.routes import sessions as session_routes
    from server.routes import tokens as token_routes
    from server.services import core_contract

    if _paths.GA_ROOT is None:
        pytest.skip("normal-mode app lifecycle needs an importable GA core")

    agent = mock.Mock()
    scheduler_host = mock.Mock()
    scheduler_host.start_all.side_effect = RuntimeError("scheduler boom")
    feishu_factory = mock.Mock(side_effect=AssertionError("startup must stop before Feishu"))

    with (
        mock.patch("server.services.agent_service.AgentService.instance", return_value=agent),
        mock.patch("server.services.feishu_service.FeishuService.instance", feishu_factory),
        mock.patch("server.services.scheduler_host.SchedulerHost", return_value=scheduler_host),
        mock.patch.object(core_contract, "probe_core_contract", return_value=SimpleNamespace(ok=True, core_commit="test", errors=[])),
        mock.patch.object(token_routes, "start_persistence"),
        mock.patch.object(token_routes, "stop_persistence"),
        mock.patch.object(session_routes, "stop_session_runtimes"),
        mock.patch("server.services.conductor_service.shutdown_conductor_service", return_value=True),
        mock.patch("server.services.goalhive_service.shutdown_goalhive_service", return_value=True),
    ):
        app = main.create_app()
        with pytest.raises(RuntimeError, match="scheduler boom"):
            with TestClient(app, base_url="http://127.0.0.1"):
                pass

    scheduler_host.shutdown_all.assert_called_once_with()
    agent._archive_snapshots_to_chat_history.assert_called_once_with()
    agent.shutdown.assert_called_once_with()
    feishu_factory.assert_not_called()
