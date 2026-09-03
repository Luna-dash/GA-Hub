"""Scheduler job-registration contract: the misfire policy must survive.

A desktop box sleeps through ticks; the 6h grace + coalesce registration is
what turns "missed while asleep" into one same-day catch-up run instead of a
silent discard (APScheduler's default misfire_grace_time is ~1s).  These
tests lock the registration parameters for BOTH schedulers — the grace was
previously added to task_scheduler only, and nothing would have caught the
asymmetry (2026-09 review).
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest import mock

import pytest
from apscheduler.schedulers.background import BackgroundScheduler

from server.services.autonomous_scheduler import (
    MISFIRE_GRACE_SECONDS,
    AutonomousScheduler,
    Schedule,
)
from server.services.task_scheduler import (
    MISFIRE_GRACE_SECONDS as TASK_MISFIRE_GRACE_SECONDS,
    TaskSchedule,
    TaskScheduler,
)


class _Handle:
    def __init__(self) -> None:
        self.stream_id = "stream-1"
        self.finished = True
        self.final_text = ""
        self.last_chunk = ""


class _Channel:
    def __init__(self) -> None:
        self.agent = SimpleNamespace(last_reply_time=0, is_running=False)

    def submit(self, _prompt: str, *, source: str):
        return _Handle()


def _task_service() -> TaskScheduler:
    # A real but never-started scheduler: add_job/get_job work, no thread runs.
    with mock.patch.object(TaskScheduler, "_load", lambda self: None):
        return TaskScheduler(_Channel(), scheduler_runtime=BackgroundScheduler())


def _autonomous_service() -> AutonomousScheduler:
    with mock.patch.object(AutonomousScheduler, "_load", lambda self: None):
        return AutonomousScheduler(_Channel(), scheduler_runtime=BackgroundScheduler())


@pytest.mark.parametrize("cron", ["0 9 * * *", "*/5 * * * *"])
def test_task_cron_and_interval_jobs_carry_the_misfire_policy(cron: str) -> None:
    service = _task_service()
    service.schedules["task-1"] = TaskSchedule(id="task-1", prompt="run", cron=cron)
    service._install_job(service.schedules["task-1"])
    job = service._sched.get_job("task_task-1")
    assert job is not None
    assert job.misfire_grace_time == TASK_MISFIRE_GRACE_SECONDS == 6 * 3600
    assert job.coalesce is True


@pytest.mark.parametrize("cron", ["0 9 * * *", "*/5 * * * *"])
def test_autonomous_cron_and_interval_jobs_carry_the_misfire_policy(cron: str) -> None:
    service = _autonomous_service()
    service.schedules["auto-1"] = Schedule(id="auto-1", type="cron", cron=cron)
    service._install_job(service.schedules["auto-1"])
    job = service._sched.get_job("auto_auto-1")
    assert job is not None
    assert job.misfire_grace_time == MISFIRE_GRACE_SECONDS == 6 * 3600
    assert job.coalesce is True


def test_task_interval_job_carry_the_misfire_policy() -> None:
    service = _task_service()
    service.schedules["task-1"] = TaskSchedule(id="task-1", prompt="run", type="interval", interval_minutes=30)
    service._install_job(service.schedules["task-1"])
    job = service._sched.get_job("task_task-1")
    assert job is not None
    assert job.misfire_grace_time == 6 * 3600
    assert job.coalesce is True


def test_autonomous_interval_job_carry_the_misfire_policy() -> None:
    service = _autonomous_service()
    service.schedules["auto-1"] = Schedule(id="auto-1", type="interval", interval_minutes=30)
    service._install_job(service.schedules["auto-1"])
    job = service._sched.get_job("auto_auto-1")
    assert job is not None
    assert job.misfire_grace_time == 6 * 3600
    assert job.coalesce is True
