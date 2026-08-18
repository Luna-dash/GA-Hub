from __future__ import annotations

import queue
import threading
import time

import pytest

from server.services import goalhive_service
from server.services.goalhive_service import GoalHiveService


def _wait_until(predicate, timeout: float = 1.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.005)
    return bool(predicate())


class _QueueAgent:
    def __init__(self, *, blocked: bool = False, exit_after_task: bool = False) -> None:
        self.inc_out = True
        self.is_running = False
        self.history: list[str] = []
        self.task_queue: queue.Queue[object] = queue.Queue()
        self.allow_finish = threading.Event()
        if not blocked:
            self.allow_finish.set()
        self.exit_after_task = exit_after_task
        self.run_calls = 0
        self.abort_calls = 0
        self.tasks_seen = 0
        self.task_started = threading.Event()
        self.prompts: list[str] = []
        self.sources: list[str] = []

    def put_task(self, query: str, *, source: str) -> queue.Queue[dict[str, str]]:
        output: queue.Queue[dict[str, str]] = queue.Queue()
        self.task_queue.put({"query": query, "source": source, "output": output})
        return output

    def run(self) -> None:
        self.run_calls += 1
        while True:
            task = self.task_queue.get()
            try:
                if isinstance(task, str):
                    return
                self.is_running = True
                self.tasks_seen += 1
                self.prompts.append(task["query"])
                self.sources.append(task["source"])
                self.task_started.set()
                self.allow_finish.wait()
                task["output"].put({"next": "working"})
                task["output"].put({"done": f"done-{self.tasks_seen}"})
                if self.exit_after_task:
                    return
            finally:
                self.is_running = False
                self.task_queue.task_done()

    def abort(self) -> None:
        self.abort_calls += 1
        self.allow_finish.set()


class _StubbornAgent(_QueueAgent):
    def __init__(self) -> None:
        super().__init__(blocked=True)

    def abort(self) -> None:
        self.abort_calls += 1


class _FailingPutAgent(_QueueAgent):
    def put_task(self, query: str, *, source: str) -> queue.Queue[dict[str, str]]:
        raise RuntimeError("queue unavailable")


class _CrashingAgent(_QueueAgent):
    def run(self) -> None:
        self.run_calls += 1
        task = self.task_queue.get()
        try:
            assert not isinstance(task, str)
            self.is_running = True
            self.task_started.set()
            raise RuntimeError("runner crashed")
        finally:
            self.is_running = False
            self.task_queue.task_done()


class _QueuedBeforeRunAgent(_QueueAgent):
    def __init__(self) -> None:
        super().__init__()
        self.runner_ready = threading.Event()
        self.allow_dequeue = threading.Event()

    def run(self) -> None:
        self.run_calls += 1
        self.runner_ready.set()
        self.allow_dequeue.wait()
        task = self.task_queue.get()
        try:
            if isinstance(task, str):
                return
            self.is_running = True
            self.tasks_seen += 1
            self.task_started.set()
            task["output"].put({"done": "unexpected task execution"})
        finally:
            self.is_running = False
            self.task_queue.task_done()

    def abort(self) -> None:
        self.abort_calls += 1
        self.allow_dequeue.set()


def test_submit_starts_owned_runner_and_consumes_agent_queue() -> None:
    agent = _QueueAgent()
    service = GoalHiveService(agent_factory=lambda: agent, drain_poll_seconds=0.01)

    stream_id = service.submit("finish the migration")

    assert stream_id
    assert agent.task_started.wait(1.0)
    assert _wait_until(lambda: not service.is_running())
    messages = service.get_messages()
    assert messages[-1]["content"] == "done-1"
    assert messages[-1]["streaming"] is False
    assert agent.sources == ["goalhive"]
    assert "finish the migration" in agent.prompts[0]
    runner = service._runner_thread
    assert runner is not None and runner.is_alive()
    assert agent.run_calls == 1

    assert service.shutdown(timeout=1.0) is True
    assert not runner.is_alive()
    assert service._drain_threads == set()


def test_submit_rolls_back_ui_reservation_when_queue_admission_fails() -> None:
    agent = _FailingPutAgent()
    service = GoalHiveService(agent_factory=lambda: agent, drain_poll_seconds=0.01)

    with pytest.raises(RuntimeError, match="queue unavailable"):
        service.submit("cannot enqueue")

    assert service.get_messages() == []
    assert service.is_running() is False
    assert service._stream_queues == {}
    assert service.shutdown(timeout=1.0) is True


def test_runner_crash_wakes_drain_and_terminates_active_message() -> None:
    agent = _CrashingAgent()
    service = GoalHiveService(agent_factory=lambda: agent, drain_poll_seconds=0.01)

    service.submit("crash the runner")

    assert agent.task_started.wait(1.0)
    assert _wait_until(
        lambda: not service.is_running()
        and service._runner_thread is None
        and not service._drain_threads
    )
    assistant = service.get_messages()[-1]
    assert assistant["streaming"] is False
    assert "runner stopped unexpectedly" in assistant["content"]
    assert service.shutdown(timeout=0.1) is True


def test_abort_stops_active_projection_without_closing_runner() -> None:
    agent = _QueueAgent(blocked=True)
    service = GoalHiveService(agent_factory=lambda: agent, drain_poll_seconds=0.01)
    service.submit("abortable task")
    assert agent.task_started.wait(1.0)

    service.abort()

    assert agent.abort_calls == 1
    assert service.is_running() is False
    assert all(message["streaming"] is False for message in service.get_messages())
    assert _wait_until(lambda: not service._drain_threads)
    runner = service._runner_thread
    assert runner is not None and runner.is_alive()
    assert service.shutdown(timeout=1.0) is True
    assert not runner.is_alive()


def test_shutdown_discards_queued_work_before_runner_marks_it_running() -> None:
    agent = _QueuedBeforeRunAgent()
    service = GoalHiveService(agent_factory=lambda: agent, drain_poll_seconds=0.01)

    service.submit("queued but not started")
    assert agent.runner_ready.wait(1.0)
    runner = service._runner_thread
    assert runner is not None and runner.is_alive()

    assert service.shutdown(timeout=1.0) is True
    assert agent.abort_calls >= 1
    assert agent.tasks_seen == 0
    assert not runner.is_alive()


def test_shutdown_aborts_active_work_and_is_idempotent() -> None:
    agent = _QueueAgent(blocked=True)
    service = GoalHiveService(agent_factory=lambda: agent, drain_poll_seconds=0.01)
    service.submit("long task")
    assert agent.task_started.wait(1.0)
    runner = service._runner_thread
    drains = tuple(service._drain_threads)

    assert service.shutdown(timeout=1.0) is True
    assert agent.abort_calls == 1
    assert runner is not None and not runner.is_alive()
    assert drains and all(not thread.is_alive() for thread in drains)
    assert all(message["streaming"] is False for message in service.get_messages())

    assert service.shutdown(timeout=0.1) is True
    assert agent.abort_calls == 1
    with pytest.raises(RuntimeError, match="closed"):
        service.submit("must not resurrect")


def test_shutdown_timeout_is_bounded_and_later_call_reaps_same_runner() -> None:
    agent = _StubbornAgent()
    service = GoalHiveService(agent_factory=lambda: agent, drain_poll_seconds=0.01)
    service.submit("stubborn task")
    assert agent.task_started.wait(1.0)
    runner = service._runner_thread

    started = time.monotonic()
    assert service.shutdown(timeout=0.02) is False
    assert time.monotonic() - started < 0.25
    assert runner is not None and runner.is_alive()
    with pytest.raises(RuntimeError, match="closed"):
        service.submit("second agent must not be created")

    agent.allow_finish.set()
    assert service.shutdown(timeout=1.0) is True
    assert not runner.is_alive()
    assert agent.run_calls == 1


def test_singleton_shutdown_keeps_timed_out_owner_until_threads_are_reaped(
    monkeypatch,
) -> None:
    agent = _StubbornAgent()
    service = GoalHiveService(agent_factory=lambda: agent, drain_poll_seconds=0.01)
    service.submit("singleton task")
    assert agent.task_started.wait(1.0)
    monkeypatch.setattr(goalhive_service, "_service", service)

    assert goalhive_service.shutdown_goalhive_service(timeout=0.01) is False
    assert goalhive_service._service is service

    agent.allow_finish.set()
    assert goalhive_service.shutdown_goalhive_service(timeout=1.0) is True
    assert goalhive_service._service is None


def test_next_submit_restarts_an_unexpectedly_exited_runner() -> None:
    agent = _QueueAgent(exit_after_task=True)
    service = GoalHiveService(agent_factory=lambda: agent, drain_poll_seconds=0.01)

    service.submit("first")
    assert _wait_until(
        lambda: not service.is_running() and service._runner_thread is None
    )
    service.submit("second")
    assert _wait_until(
        lambda: len(service.get_messages()) == 4
        and not service.is_running()
        and service._runner_thread is None
    )

    assert agent.run_calls == 2
    assert [row["content"] for row in service.get_messages() if row["role"] == "assistant"] == [
        "done-1",
        "done-2",
    ]
    assert service.shutdown(timeout=0.1) is True
