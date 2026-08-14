"""Lifecycle contract for the unified scheduler host."""
from __future__ import annotations

from types import SimpleNamespace
from unittest import mock

from server.services.scheduler_host import SchedulerHost


class Runtime:
    def __init__(self) -> None:
        self.running = False
        self.start_calls = 0
        self.shutdown_calls = 0

    def start(self) -> None:
        self.start_calls += 1
        self.running = True

    def shutdown(self, *, wait: bool) -> None:
        self.shutdown_calls += 1
        self.running = False


class Service:
    def __init__(self, name: str, schedules: dict[str, object] | None = None) -> None:
        self.name = name
        self.started = False
        self.stopped = False
        self.schedules = schedules if schedules is not None else {}

    def start(self) -> None:
        assert not self.stopped
        self.started = True

    def shutdown(self) -> None:
        self.stopped = True


def test_host_shares_runtime_and_stops_domains_in_reverse() -> None:
    runtime = Runtime()
    first = Service("scheduled", {"one": object()})
    second = Service("autonomous")
    third = Service("tasks")
    host = SchedulerHost(lambda: runtime)

    host.register("scheduled", lambda: first)
    host.register("autonomous", lambda: second)
    host.register("tasks", lambda: third)
    host.start_all()

    assert host.runtime is runtime
    assert runtime.start_calls == 1
    assert host.status() == {
        "runtime": {"running": True},
        "scheduled": {"state": "running", "schedule_count": 1, "error": None},
        "autonomous": {"state": "running", "schedule_count": 0, "error": None},
        "tasks": {"state": "running", "schedule_count": 0, "error": None},
    }

    host.shutdown_all(timeout=0)
    assert [service.stopped for service in (third, second, first)] == [True, True, True]
    assert runtime.shutdown_calls == 1
    assert host.status()["runtime"] == {"running": False}


def test_domain_startup_failure_is_recorded_without_blocking_other_domains() -> None:
    runtime = Runtime()
    good = Service("good")
    host = SchedulerHost(lambda: runtime)

    def failing_factory():
        raise RuntimeError("boom")

    host.register("bad", failing_factory)
    host.register("good", lambda: good)
    host.start_all()

    status = host.status()
    assert status["bad"]["state"] == "error"
    assert status["bad"]["error"] == "boom"
    assert status["good"]["state"] == "running"
    assert good.started
