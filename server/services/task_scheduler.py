"""Generic scheduled task runner backed by APScheduler."""
from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid
from dataclasses import asdict, dataclass
from typing import Any

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from .. import _paths
from . import email_service
from .agent_service import AgentService
from .event_bus import bus

log = logging.getLogger(__name__)


def _local_tz():
    try:
        from datetime import datetime, timezone
        return datetime.now(timezone.utc).astimezone().tzinfo
    except Exception:
        return None


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


class TaskScheduler:
    _instance: "TaskScheduler | None" = None

    def __init__(self, agent_service: AgentService):
        self.agent_service = agent_service
        self.schedules: dict[str, TaskSchedule] = {}
        self._tz = _local_tz()
        self._sched = BackgroundScheduler(timezone=self._tz) if self._tz else BackgroundScheduler()
        self._lock = threading.Lock()
        self._load()

    @classmethod
    def instance(cls, agent_service: AgentService | None = None) -> "TaskScheduler":
        if cls._instance is None:
            assert agent_service is not None
            cls._instance = cls(agent_service)
        return cls._instance

    def _sched_file(self) -> str:
        return str(_paths.tasks_schedules_file())

    def _runs_file(self) -> str:
        return str(_paths.tasks_runs_file())

    def _load(self) -> None:
        path = self._sched_file()
        if not os.path.isfile(path):
            return
        try:
            data = json.loads(open(path, encoding="utf-8").read())
            allowed = {f.name for f in TaskSchedule.__dataclass_fields__.values()}
            for raw in data.get("schedules", []):
                clean = {k: v for k, v in raw.items() if k in allowed}
                sch = TaskSchedule(**clean)
                self.schedules[sch.id] = sch
        except Exception as e:
            log.exception("failed to load task schedules: %s", e)

    def _persist(self) -> None:
        path = self._sched_file()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"schedules": [s.to_dict() for s in self.schedules.values()]},
                      f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)

    def _record_run(self, run: TaskRun) -> None:
        path = self._runs_file()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(run.to_dict(), ensure_ascii=False) + "\n")

    def start(self) -> None:
        if not self._sched.running:
            self._sched.start()
        for s in self.schedules.values():
            self._install_job(s)

    def shutdown(self) -> None:
        try:
            self._sched.shutdown(wait=False)
        except Exception:
            pass

    def _job_id(self, sch_id: str) -> str:
        return f"task_{sch_id}"

    def _install_job(self, s: TaskSchedule) -> None:
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
                log.warning("bad task cron %r: %s", s.cron, e)
                return
            self._sched.add_job(self._fire, trig, id=jid, args=[s.id], replace_existing=True)
        elif s.type == "interval":
            self._sched.add_job(
                self._fire,
                IntervalTrigger(minutes=max(1, int(s.interval_minutes))),
                id=jid, args=[s.id], replace_existing=True,
            )

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
            handle = self.agent_service.submit(s.prompt, source="scheduled_task")
            run = TaskRun(
                id=uuid.uuid4().hex,
                task_id=s.id,
                task_name=s.name,
                fired_at=now,
                stream_id=handle.stream_id,
                prompt_preview=(s.prompt or "")[:160],
            )

        bus.publish("task:fired", {
            "task_id": s.id, "task_name": s.name, "run_id": run.id,
            "stream_id": handle.stream_id, "fired_at": now,
        })

        def _watch():
            try:
                deadline = run.fired_at + 60 * 60
                while not handle.finished:
                    time.sleep(2)
                    if time.time() > deadline:
                        run.status = "timeout"
                        run.note = "watch_timeout"
                        break
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
                self._record_run(run)
                bus.publish("task:done", run.to_dict())
            except Exception as e:
                log.exception("task watch crash: %s", e)
                run.status = "error"
                run.finished_at = int(time.time())
                run.note = str(e)[:400]
                self._record_run(run)
                bus.publish("task:error", run.to_dict())

        threading.Thread(target=_watch, daemon=True, name="task-watch").start()
        return {"run_id": run.id, "stream_id": handle.stream_id}

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

    def list(self) -> list[dict]:
        return [s.to_dict() for s in sorted(self.schedules.values(), key=lambda s: s.id)]

    def upsert(self, payload: dict) -> TaskSchedule:
        sid = payload.get("id") or f"task_{uuid.uuid4().hex[:8]}"
        with self._lock:
            existing = self.schedules.get(sid)
            base = existing.to_dict() if existing else {}
            base.update({k: v for k, v in payload.items() if v is not None})
            base["id"] = sid
            if not base.get("cron"):
                base["cron"] = "0 8 * * *"
            if not base.get("email_subject"):
                base["email_subject"] = "GenericAgent 定时任务结果: {name}"
            allowed = {f.name for f in TaskSchedule.__dataclass_fields__.values()}
            clean = {k: v for k, v in base.items() if k in allowed}
            sch = TaskSchedule(**clean)
            self.schedules[sid] = sch
            self._persist()
            self._install_job(sch)
        bus.publish("task:upsert", sch.to_dict())
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
        bus.publish("task:delete", {"id": sid})
        return True

    def list_runs(self, limit: int = 100) -> list[dict]:
        path = self._runs_file()
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
            log.warning("failed to read task runs: %s", e)
        return out
