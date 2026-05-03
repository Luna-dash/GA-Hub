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
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from typing import Any

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from .. import _paths
from .agent_service import AgentService
from .event_bus import bus

log = logging.getLogger(__name__)


def _local_tz():
    """Resolve the local timezone in a way APScheduler accepts."""
    try:
        from datetime import datetime, timezone
        return datetime.now(timezone.utc).astimezone().tzinfo
    except Exception:
        return None


DEFAULT_PROMPT = (
    "[AUTO]🤖 用户已经离开超过约定时间，作为自主智能体，请阅读自动化sop，执行自动任务。"
)


def _sched_file() -> str:
    return str(_paths.schedules_file())


def _runs_file() -> str:
    return str(_paths.runs_file())


def _reports_dir() -> str:
    return str(_paths.reports_dir())


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


class AutonomousScheduler:
    _instance: "AutonomousScheduler | None" = None

    def __init__(self, agent_service: AgentService):
        self.agent_service = agent_service
        self.schedules: dict[str, Schedule] = {}
        self._tz = _local_tz()
        self._sched = BackgroundScheduler(timezone=self._tz) if self._tz else BackgroundScheduler()
        self._idle_thread: threading.Thread | None = None
        self._stop = False
        self._lock = threading.Lock()
        self._load()

    @classmethod
    def instance(cls, agent_service: AgentService | None = None) -> "AutonomousScheduler":
        if cls._instance is None:
            assert agent_service is not None
            cls._instance = cls(agent_service)
        return cls._instance

    # ── persistence ──────────────────────────────────────────────
    def _load(self) -> None:
        path = _sched_file()
        if not os.path.isfile(path):
            self._seed_defaults()
            return
        try:
            data = json.loads(open(path, encoding="utf-8").read())
            for s in data.get("schedules", []):
                # tolerate unknown keys
                allowed = {f.name for f in Schedule.__dataclass_fields__.values()}
                clean = {k: v for k, v in s.items() if k in allowed}
                sch = Schedule(**clean)
                self.schedules[sch.id] = sch
        except Exception as e:
            log.exception("failed to load schedules: %s", e)
            self._seed_defaults()

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

    def _persist(self) -> None:
        path = _sched_file()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"schedules": [s.to_dict() for s in self.schedules.values()]},
                      f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)

    def _record_run(self, run: Run) -> None:
        path = _runs_file()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(run.to_dict(), ensure_ascii=False) + "\n")

    # ── lifecycle ────────────────────────────────────────────────
    def start(self) -> None:
        if not self._sched.running:
            self._sched.start()
        # rebuild jobs from schedules
        for s in self.schedules.values():
            self._install_job(s)
        # idle ticker
        if not self._idle_thread or not self._idle_thread.is_alive():
            self._stop = False
            self._idle_thread = threading.Thread(target=self._idle_loop, daemon=True, name="auto-idle")
            self._idle_thread.start()

    def shutdown(self) -> None:
        self._stop = True
        try:
            self._sched.shutdown(wait=False)
        except Exception:
            pass

    # ── job management ───────────────────────────────────────────
    def _job_id(self, sch_id: str) -> str:
        return f"auto_{sch_id}"

    def _install_job(self, s: Schedule) -> None:
        jid = self._job_id(s.id)
        try:
            self._sched.remove_job(jid)
        except Exception:
            pass
        if not s.enabled:
            return
        if s.type == "cron":
            try:
                trig = CronTrigger.from_crontab(s.cron, timezone=self._tz) if self._tz else CronTrigger.from_crontab(s.cron)
            except Exception as e:
                log.warning("bad cron %r: %s", s.cron, e)
                return
            self._sched.add_job(self._fire, trig, id=jid, args=[s.id], replace_existing=True)
        elif s.type == "interval":
            self._sched.add_job(
                self._fire,
                IntervalTrigger(minutes=max(1, int(s.interval_minutes))),
                id=jid, args=[s.id], replace_existing=True,
            )
        # idle is handled by _idle_loop

    # ── triggers ─────────────────────────────────────────────────
    def _idle_loop(self) -> None:
        while not self._stop:
            time.sleep(30)
            now = int(time.time())
            for s in list(self.schedules.values()):
                if s.type != "idle" or not s.enabled:
                    continue
                lr = int(getattr(self.agent_service.agent, "last_reply_time", 0)) or now
                idle = now - lr
                if idle < s.idle_minutes * 60:
                    continue
                # don't double-fire: respect last_fired_at vs idle window
                if (now - (s.last_fired_at or 0)) < s.idle_minutes * 60:
                    continue
                # don't fire while agent is busy
                if self.agent_service.agent.is_running:
                    continue
                self._fire(s.id)

    def trigger_now(self, schedule_id: str) -> dict:
        if schedule_id not in self.schedules:
            raise KeyError(schedule_id)
        return self._fire(schedule_id)

    def _fire(self, schedule_id: str) -> dict:
        with self._lock:
            s = self.schedules.get(schedule_id)
            if s is None:
                return {"error": "not_found"}
            now = int(time.time())
            s.last_fired_at = now
            s.fire_count += 1
            self._persist()

            existing_reports = self._snapshot_reports()
            handle = self.agent_service.submit(s.prompt or DEFAULT_PROMPT, source="autonomous")
            run = Run(
                id=uuid.uuid4().hex,
                schedule_id=s.id,
                fired_at=now,
                prompt_preview=(s.prompt or DEFAULT_PROMPT)[:120],
            )

        bus.publish("autonomous:fired", {
            "schedule_id": s.id, "schedule_name": s.name, "run_id": run.id,
            "stream_id": handle.stream_id, "fired_at": now,
        })

        # background watcher: record produced reports once task is done
        def _watch():
            try:
                while not handle.finished:
                    time.sleep(2)
                    if (time.time() - run.fired_at) > 60 * 60:
                        run.note = "watch_timeout"
                        break
                # re-snapshot to detect new reports
                produced = self._diff_reports(existing_reports)
                run.report_paths = produced
                self._record_run(run)
                bus.publish("autonomous:report_saved", run.to_dict())
            except Exception as e:
                log.exception("autonomous watch crash: %s", e)

        threading.Thread(target=_watch, daemon=True, name="auto-watch").start()
        return {"run_id": run.id, "stream_id": handle.stream_id}

    @staticmethod
    def _snapshot_reports() -> set[str]:
        try:
            return set(os.listdir(_reports_dir()))
        except FileNotFoundError:
            return set()

    @classmethod
    def _diff_reports(cls, before: set[str]) -> list[str]:
        rdir = _reports_dir()
        try:
            now = set(os.listdir(rdir))
        except FileNotFoundError:
            return []
        new = sorted(now - before)
        return [os.path.join(rdir, n) for n in new if n.endswith(".md")]

    # ── CRUD ─────────────────────────────────────────────────────
    def list(self) -> list[dict]:
        return [s.to_dict() for s in sorted(self.schedules.values(), key=lambda s: s.id)]

    def upsert(self, payload: dict) -> Schedule:
        sid = payload.get("id") or f"sched_{uuid.uuid4().hex[:8]}"
        with self._lock:
            existing = self.schedules.get(sid)
            base = existing.to_dict() if existing else {}
            base.update({k: v for k, v in payload.items() if v is not None})
            base["id"] = sid
            allowed = {f.name for f in Schedule.__dataclass_fields__.values()}
            clean = {k: v for k, v in base.items() if k in allowed}
            sch = Schedule(**clean)
            self.schedules[sid] = sch
            self._persist()
            self._install_job(sch)
        bus.publish("autonomous:upsert", sch.to_dict())
        return sch

    def delete(self, sid: str) -> bool:
        with self._lock:
            if sid not in self.schedules:
                return False
            try:
                self._sched.remove_job(self._job_id(sid))
            except Exception:
                pass
            del self.schedules[sid]
            self._persist()
        bus.publish("autonomous:delete", {"id": sid})
        return True

    # ── reports/runs browse ─────────────────────────────────────
    def list_reports(self) -> list[dict]:
        out: list[dict] = []
        rdir = _reports_dir()
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
        p = os.path.join(_reports_dir(), name)
        if not os.path.isfile(p):
            raise FileNotFoundError(name)
        return open(p, encoding="utf-8").read()

    def list_runs(self, limit: int = 100) -> list[dict]:
        path = _runs_file()
        if not os.path.isfile(path):
            return []
        out: list[dict] = []
        try:
            with open(path, encoding="utf-8") as f:
                lines = f.readlines()[-limit:]
            for ln in reversed(lines):
                try:
                    out.append(json.loads(ln))
                except Exception:
                    continue
        except Exception as e:
            log.warning("failed to read runs: %s", e)
        return out
