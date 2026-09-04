"""Generic scheduled task runner backed by APScheduler.

The shared singleton/lifecycle/persistence/CRUD skeleton lives in
``scheduler_domain_base.SchedulerDomainBase``; this module only carries the
task-specific schedule/run models, email notification and the error-commit
watcher semantics.
"""
from __future__ import annotations

import logging
import threading
import time
import uuid
from dataclasses import asdict, dataclass
from typing import Any

from apscheduler.schedulers.background import BackgroundScheduler

from .. import _paths
from . import email_service
from .event_bus import bus
from .scheduler_domain_base import (  # noqa: F401 — MISFIRE_GRACE_SECONDS re-exported for test seams
    MISFIRE_GRACE_SECONDS,
    SchedulerDomainBase,
)
from .system_channels import SystemChannel
from ..event_topics import (
    TASK_DELETE,
    TASK_DONE,
    TASK_ERROR,
    TASK_FIRED,
    TASK_UPSERT,
)

log = logging.getLogger(__name__)


@dataclass
class TaskSchedule:
    id: str
    type: str = "cron"              # cron | interval
    enabled: bool = True
    prompt: str = ""
    cron: str = "0 8 * * *"
    interval_minutes: int = 60
    notify_email: bool = False
    email_to: str = ""
    email_subject: str = "GenericAgent 定时任务结果: {name}"
    last_fired_at: int = 0
    fire_count: int = 0
    name: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class TaskRun:
    id: str
    task_id: str
    task_name: str
    fired_at: int
    stream_id: str = ""
    finished_at: int = 0
    status: str = "running"         # running | done | error | timeout
    prompt_preview: str = ""
    result_preview: str = ""
    email_sent: bool = False
    email_error: str = ""
    note: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


class TaskScheduler(SchedulerDomainBase):
    _instance: "TaskScheduler | None" = None

    schedule_cls = TaskSchedule
    display_name = "task scheduler"
    source = "scheduled_task"
    job_prefix = "task_"
    id_prefix = "task_"
    watch_prefix = "task"
    topic_fired = TASK_FIRED
    topic_upsert = TASK_UPSERT
    topic_delete = TASK_DELETE

    # The scheduled-task system channel: admission goes through the same
    # SessionCoordinator gate as web sessions (merge of the two chat chains);
    # ``channel`` duck-types the AgentService submit surface.
    def __init__(
        self,
        channel: SystemChannel,
        *,
        scheduler_runtime: Any | None = None,
    ):
        super().__init__(channel, scheduler_runtime=scheduler_runtime)

    # ── persistence paths ────────────────────────────────────────
    def _sched_file(self) -> str:
        return str(_paths.tasks_schedules_file())

    def _runs_file(self) -> str:
        return str(_paths.tasks_runs_file())

    def _new_runtime(self) -> BackgroundScheduler:
        return BackgroundScheduler(timezone=self._tz) if self._tz else BackgroundScheduler()

    @classmethod
    def instance(
        cls,
        channel: SystemChannel | None = None,
        *,
        scheduler_runtime: Any | None = None,
    ) -> "TaskScheduler":
        if cls._instance is not None and cls._instance._stop_event.is_set():
            if not cls._instance.shutdown(timeout=0):
                raise RuntimeError("previous task scheduler is still shutting down")
        if cls._instance is None:
            assert channel is not None
            cls._instance = cls(channel, scheduler_runtime=scheduler_runtime)
        return cls._instance

    # ── fire hooks ───────────────────────────────────────────────
    def _build_run(self, s: TaskSchedule, now: int, handle: Any, prompt: str) -> TaskRun:
        return TaskRun(
            id=uuid.uuid4().hex,
            task_id=s.id,
            task_name=s.name,
            fired_at=now,
            stream_id=handle.stream_id,
            prompt_preview=prompt[:160],
        )

    def _fired_payload(self, s: TaskSchedule, run: TaskRun, handle: Any, now: int) -> dict:
        return {
            "task_id": s.id, "task_name": s.name, "run_id": run.id,
            "stream_id": handle.stream_id, "fired_at": now,
        }

    def _watch_deadline_reached(self, run: TaskRun) -> bool:
        # The one-hour watch deadline mirrors the autonomous domain.
        if time.time() > (run.fired_at + 60 * 60):
            run.status = "timeout"
            run.note = "watch_timeout"
            return True
        return False

    def _finalize_run(self, s: TaskSchedule, run: TaskRun, handle: Any, context: Any) -> None:
        if handle.finished:
            run.status = "done"
            run.finished_at = int(time.time())
            run.result_preview = (handle.final_text or handle.last_chunk or "")[:500]
        else:
            run.finished_at = int(time.time())
            run.result_preview = (handle.last_chunk or "")[:500]
        if s.notify_email:
            result = self._send_run_email(s, run, handle.final_text or handle.last_chunk or "")
            run.email_sent = bool(result.get("ok"))
            run.email_error = str(result.get("error") or "")[:400]

        def commit_done() -> None:
            self._record_run(run)
            bus.publish(TASK_DONE, run.to_dict())

        self._watchers.run_if_active(commit_done)

    def _on_watch_crash(
        self, s: TaskSchedule, run: TaskRun, stop_event: threading.Event, exc: Exception,
    ) -> None:
        if stop_event.is_set():
            return
        run.status = "error"
        run.finished_at = int(time.time())
        run.note = str(exc)[:400]

        def commit_error() -> None:
            self._record_run(run)
            bus.publish(TASK_ERROR, run.to_dict())

        self._watchers.run_if_active(commit_error)

    def _apply_upsert_defaults(self, base: dict) -> None:
        if not base.get("cron"):
            base["cron"] = "0 8 * * *"
        if not base.get("email_subject"):
            base["email_subject"] = "GenericAgent 定时任务结果: {name}"

    def _send_run_email(self, s: TaskSchedule, run: TaskRun, final_text: str) -> dict[str, Any]:
        subject = s.email_subject or "GenericAgent 定时任务结果: {name}"
        subject = subject.format(name=s.name or s.id, id=s.id, run_id=run.id)
        body = (
            f"任务: {s.name or s.id}\n"
            f"时间: {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(run.fired_at))}\n"
            f"状态: {run.status}\n"
            f"Stream: {run.stream_id}\n\n"
            f"Prompt:\n{s.prompt}\n\n"
            f"结果:\n{final_text or run.result_preview or '(无结果内容)'}\n"
        )
        return email_service.send_email(s.email_to, subject, body)