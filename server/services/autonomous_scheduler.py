"""AutonomousScheduler — drives self-evolution on user-defined schedules.

Three trigger types:
  * ``idle``     — fire when ``time.time() - agent.last_reply_time >= idle_minutes*60``
  * ``cron``     — standard cron expression (5 fields, local timezone)
  * ``interval`` — every N minutes

Schedules persist to ``~/.genericagent-admin/autonomous_schedules.json``
(admin-managed, never written to the GA repo).
Trigger history persists to ``~/.genericagent-admin/autonomous_runs.jsonl``.
Reports themselves stay in GA's ``temp/autonomous_reports/`` (per the SOP convention).

When fired, the schedule's ``prompt`` is submitted to the agent with
``source="autonomous"``. The default prompt mirrors
``reflect/autonomous.py`` so the agent invokes the autonomous SOP.

The shared singleton/lifecycle/persistence/CRUD skeleton lives in
``scheduler_domain_base.SchedulerDomainBase``.
"""
from __future__ import annotations

import logging
import os
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from typing import Any

from apscheduler.schedulers.background import BackgroundScheduler

from .. import _paths
from .event_bus import bus
from .scheduler_domain_base import (  # noqa: F401 — MISFIRE_GRACE_SECONDS re-exported for test seams
    MISFIRE_GRACE_SECONDS,
    SchedulerDomainBase,
)
from .system_channels import SystemChannel
from ..event_topics import (
    AUTONOMOUS_DELETE,
    AUTONOMOUS_FIRED,
    AUTONOMOUS_REPORT_SAVED,
    AUTONOMOUS_UPSERT,
)

log = logging.getLogger(__name__)


DEFAULT_PROMPT = (
    "[AUTO]🤖 用户已经离开超过约定时间，作为自主智能体，请阅读自动化sop，执行自动任务。"
)


@dataclass
class Schedule:
    id: str
    type: str            # idle | cron | interval
    enabled: bool = True
    prompt: str = DEFAULT_PROMPT
    # type-specific
    idle_minutes: int = 30
    cron: str = ""        # 5-field
    interval_minutes: int = 60
    # bookkeeping
    last_fired_at: int = 0
    fire_count: int = 0
    name: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Run:
    id: str
    schedule_id: str
    fired_at: int
    prompt_preview: str
    report_paths: list[str] = field(default_factory=list)
    note: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


class AutonomousScheduler(SchedulerDomainBase):
    _instance: "AutonomousScheduler | None" = None

    schedule_cls = Schedule
    display_name = "autonomous scheduler"
    source = "autonomous"
    job_prefix = "auto_"
    id_prefix = "sched_"
    watch_prefix = "auto"
    topic_fired = AUTONOMOUS_FIRED
    topic_upsert = AUTONOMOUS_UPSERT
    topic_delete = AUTONOMOUS_DELETE

    def __init__(
        self,
        channel: SystemChannel,
        *,
        scheduler_runtime: Any | None = None,
    ):
        # The autonomous system channel: admission goes through the same
        # SessionCoordinator gate as web sessions (merge of the two chat
        # chains); ``channel`` duck-types the AgentService surface used here
        # (submit + agent introspection for idle checks).
        super().__init__(channel, scheduler_runtime=scheduler_runtime)
        self._idle_thread: threading.Thread | None = None

    # ── persistence paths ────────────────────────────────────────
    def _sched_file(self) -> str:
        return str(_paths.schedules_file())

    def _runs_file(self) -> str:
        return str(_paths.runs_file())

    def _reports_dir(self) -> str:
        return str(_paths.reports_dir())

    def _new_runtime(self) -> BackgroundScheduler:
        return BackgroundScheduler(timezone=self._tz) if self._tz else BackgroundScheduler()

    def _seed_defaults(self) -> None:
        sch = Schedule(
            id="default_idle_30m",
            type="idle",
            enabled=False,                  # opt-in; user enables in UI
            idle_minutes=30,
            name="离线30分钟自主探索",
        )
        self.schedules[sch.id] = sch
        self._persist()

    # ── autonomous idle ticker ───────────────────────────────────
    def _check_restart_allowed(self) -> None:
        if self._idle_thread is not None and self._idle_thread.is_alive():
            raise RuntimeError("cannot restart while autonomous idle thread is stopping")

    def _start_idle(self) -> None:
        if not self._idle_thread or not self._idle_thread.is_alive():
            self._idle_thread = threading.Thread(target=self._idle_loop, daemon=True, name="auto-idle")
            self._idle_thread.start()

    def _idle_loop(self) -> None:
        while not self._stop_event.wait(30):
            now = int(time.time())
            for s in list(self.schedules.values()):
                if s.type != "idle" or not s.enabled:
                    continue
                # Same introspection surface the global singleton used to
                # provide: the channel's own agent (created on first touch).
                try:
                    agent = self.channel.agent
                except Exception:
                    log.debug("autonomous idle check: runtime unavailable", exc_info=True)
                    continue
                lr = int(getattr(agent, "last_reply_time", 0)) or now
                idle = now - lr
                if idle < s.idle_minutes * 60:
                    continue
                # don't double-fire: respect last_fired_at vs idle window
                if (now - (s.last_fired_at or 0)) < s.idle_minutes * 60:
                    continue
                # don't fire while agent is busy
                if getattr(agent, "is_running", False):
                    continue
                try:
                    self._fire(s.id)
                except Exception:
                    # The loop outlives individual schedules: a refused or
                    # crashing fire (admission busy, runtime gone mid-check)
                    # must skip this schedule now, not kill idle firing for
                    # every remaining schedule until restart.
                    log.exception("autonomous idle fire failed for %s", s.id)

    # ── fire hooks ───────────────────────────────────────────────
    def _before_submit(self) -> set[str]:
        # Reports are diffed after the run finishes; snapshot the directory
        # before submitting so only newly produced files count.
        return self._snapshot_reports()

    def _fire_prompt(self, s: Schedule) -> str:
        return s.prompt or DEFAULT_PROMPT

    def _build_run(self, s: Schedule, now: int, handle: Any, prompt: str) -> Run:
        return Run(
            id=uuid.uuid4().hex,
            schedule_id=s.id,
            fired_at=now,
            prompt_preview=prompt[:120],
        )

    def _fired_payload(self, s: Schedule, run: Run, handle: Any, now: int) -> dict:
        return {
            "schedule_id": s.id, "schedule_name": s.name, "run_id": run.id,
            "stream_id": handle.stream_id, "fired_at": now,
        }

    def _watch_deadline_reached(self, run: Run) -> bool:
        if (time.time() - run.fired_at) > 60 * 60:
            run.note = "watch_timeout"
            return True
        return False

    def _finalize_run(self, s: Schedule, run: Run, handle: Any, context: Any) -> None:
        produced = self._diff_reports(context if context is not None else set())
        run.report_paths = produced

        def commit() -> None:
            self._record_run(run)
            bus.publish(AUTONOMOUS_REPORT_SAVED, run.to_dict())

        self._watchers.run_if_active(commit)

    # ── reports diff ─────────────────────────────────────────────
    def _snapshot_reports(self) -> set[str]:
        try:
            return set(os.listdir(self._reports_dir()))
        except FileNotFoundError:
            return set()

    def _diff_reports(self, before: set[str]) -> list[str]:
        rdir = self._reports_dir()
        try:
            now = set(os.listdir(rdir))
        except FileNotFoundError:
            return []
        new = sorted(now - before)
        return [os.path.join(rdir, n) for n in new if n.endswith(".md")]

    # ── reports/runs browse ─────────────────────────────────────
    def list_reports(self) -> list[dict]:
        out: list[dict] = []
        rdir = self._reports_dir()
        if not os.path.isdir(rdir):
            return out
        for name in sorted(os.listdir(rdir), reverse=True):
            if not name.endswith(".md"):
                continue
            p = os.path.join(rdir, name)
            try:
                stat = os.stat(p)
                out.append({
                    "name": name,
                    "size": stat.st_size,
                    "mtime": int(stat.st_mtime),
                })
            except FileNotFoundError:
                pass
        return out

    def read_report(self, name: str) -> str:
        # Prevent path traversal
        if "/" in name or ".." in name:
            raise ValueError("invalid name")
        p = os.path.join(self._reports_dir(), name)
        if not os.path.isfile(p):
            raise FileNotFoundError(name)
        with open(p, encoding="utf-8") as fh:
            return fh.read()
