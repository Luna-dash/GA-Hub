"""Direct unit tests for the AppServices ownership snapshot.

The lifespan relies on it for status and ordered teardown; these lock the
four behaviours the 2026-09 review called out: no service construction on
status reads, dependency-ordered shutdown, exception isolation between
services, and full reference release on clear().
"""
from __future__ import annotations

from types import SimpleNamespace

from server.services.app_services import AppServices


class _Agent:
    def __init__(self) -> None:
        self.shutdown_calls = 0

    def status(self) -> SimpleNamespace:
        return SimpleNamespace(running=True, pid=42)

    def shutdown(self) -> None:
        self.shutdown_calls += 1


class _Feishu:
    def __init__(self, *, explode: bool = False) -> None:
        self.shutdown_calls = 0
        self._explode = explode

    def status(self) -> dict:
        if self._explode:
            raise RuntimeError("feishu status exploded")
        return {"running": False}

    def shutdown(self) -> None:
        self.shutdown_calls += 1
        if self._explode:
            raise RuntimeError("feishu shutdown exploded")


class _SchedulerHost:
    def __init__(self) -> None:
        self.shutdown_calls = 0

    def status(self) -> dict:
        return {"autonomous": {"schedule_count": 2}, "tasks": {"schedule_count": 3}}

    def shutdown_all(self) -> bool:
        self.shutdown_calls += 1
        return True


def test_status_snapshot_reads_only_owned_services() -> None:
    services = AppServices()
    # Nothing owned: an empty snapshot, and no class-level getter runs that
    # could lazily construct a fresh service during partial startup.
    assert services.status_snapshot() == {}

    owned = AppServices(agent=_Agent(), feishu=_Feishu(), scheduler_host=_SchedulerHost())
    snap = owned.status_snapshot()
    assert snap["agent"] == {"running": True, "pid": 42}
    assert snap["feishu"] == {"running": False}
    assert snap["autonomous"] == {"schedule_count": 2}
    assert snap["tasks"] == {"schedule_count": 3}
    assert snap["schedulers"]["autonomous"]["schedule_count"] == 2


def test_status_snapshot_degrades_when_feishu_status_raises() -> None:
    services = AppServices(agent=_Agent(), feishu=_Feishu(explode=True))
    snap = services.status_snapshot()
    assert "feishu" not in snap
    assert snap["agent"]["running"] is True


def test_shutdown_all_follows_dependency_order() -> None:
    order: list[str] = []

    class _Tracked:
        def __init__(self, name: str) -> None:
            self._name = name
            self.status = lambda: {}  # unused here

        def shutdown(self) -> None:
            order.append(self._name)

    class _Host(_Tracked):
        def shutdown_all(self) -> bool:
            order.append("scheduler_host")
            return True

    services = AppServices(
        agent=_Tracked("agent"),
        feishu=_Tracked("feishu"),
        scheduler_host=_Host("unused-name"),
    )
    services.shutdown_all()
    assert order == ["scheduler_host", "feishu", "agent"]


def test_shutdown_all_isolates_one_service_failure() -> None:
    agent = _Agent()
    services = AppServices(agent=agent, feishu=_Feishu(explode=True),
                           scheduler_host=_SchedulerHost())
    services.shutdown_all()
    # feishu exploded, but the agent still got its shutdown.
    assert agent.shutdown_calls == 1


def test_clear_releases_every_owner() -> None:
    services = AppServices(agent=_Agent(), feishu=_Feishu(),
                           scheduler_host=_SchedulerHost())
    services.clear()
    assert services.agent is None
    assert services.feishu is None
    assert services.scheduler_host is None
    # A cleared snapshot observes nothing and shuts nothing down.
    assert services.status_snapshot() == {}
    services.shutdown_all()
