"""Shared skeleton for the APScheduler-backed schedule domains.

``AutonomousScheduler`` and ``TaskScheduler`` grew as clones: identical
singleton/lifecycle/persistence/CRUD machinery with only the naming, the
persistence paths and the fire/watch specifics differing.  This base owns the
skeleton as template methods; subclasses supply the ``schedule_cls``/naming
class attributes plus a handful of fire hooks.

Two namespace rules keep the existing test seams intact:

* the APScheduler runtime is built by ``_new_runtime()`` in each subclass
  module, so ``mock.patch("...task_scheduler.BackgroundScheduler")`` keeps
  intercepting construction;
* ``bus`` is the module-level singleton shared with the base, so a patch on
  either module's ``bus.publish`` intercepts publishes made from here.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid
from typing import Any, TypeVar

from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from .event_bus import bus
from .file_tail import read_jsonl_tail
from .session_coordinator import AgentBusyError
from .system_channels import SystemChannel
from .watcher_registry import WatcherRegistry

log = logging.getLogger(__name__)

# Desktop machines sleep/boot late: without an explicit grace window a missed
# cron tick is silently discarded (APScheduler default misfire_grace_time=1s).
# 6h mirrors the GenericAgent scheduler's max_delay_hours default so a late
# boot still fires the same day, and coalesce collapses any backlog to one run.
MISFIRE_GRACE_SECONDS = 6 * 3600


def _local_tz():
    """Resolve the local timezone in a way APScheduler accepts."""
    try:
        from datetime import datetime, timezone
        return datetime.now(timezone.utc).astimezone().tzinfo
    except Exception:
        return None


_SelfT = TypeVar("_SelfT", bound="SchedulerDomainBase")


class SchedulerDomainBase:
    """Template-method base for schedule stores that fire through a channel."""

    # Per-subclass singleton: ``instance()`` assigns ``cls._instance`` on the
    # concrete class, so both domains keep independent singletons.
    _instance: "SchedulerDomainBase | None" = None

    # ── subclass contract ────────────────────────────────────────
    schedule_cls: type          # dataclass of one schedule row
    display_name: str          # used in instance() shutdown-race errors
    source: str                # channel.submit source tag
    job_prefix: str            # APScheduler job id prefix (auto_/task_)
    id_prefix: str             # generated schedule id prefix (sched_/task_)
    watch_prefix: str          # watcher thread name prefix
    topic_fired: str
    topic_upsert: str
    topic_delete: str

    def __init__(
        self,
        channel: SystemChannel,
        *,
        scheduler_runtime: Any | None = None,
    ):
        # The domain system channel: admission goes through the same
        # SessionCoordinator gate as web sessions (merge of the two chat
        # chains); ``channel`` duck-types the submit/agent surface used here.
        self.channel = channel
        self.schedules: dict[str, Any] = {}
        self._tz = _local_tz()
        self._owns_sched = scheduler_runtime is None
        self._sched = (
            scheduler_runtime
            if scheduler_runtime is not None
            else self._new_runtime()
        )
        self._stop_event = threading.Event()
        self._watchers = WatcherRegistry(self._stop_event)
        self._admission_lock = threading.Lock()
        self._lock = threading.Lock()
        self._run_write_lock = threading.Lock()
        self._load()

    # ── subclass hooks ───────────────────────────────────────────
    def _new_runtime(self) -> Any:
        # Deliberately abstract: must resolve BackgroundScheduler through the
        # subclass module globals so per-module patches keep working.
        raise NotImplementedError

    def _sched_file(self) -> str:
        raise NotImplementedError

    def _runs_file(self) -> str:
        raise NotImplementedError

    def _seed_defaults(self) -> None:
        """Hook: rebuild factory defaults when the store is missing/corrupt."""

    def _check_restart_allowed(self) -> None:
        """Hook: subclass veto on restarting while a domain thread drains."""

    def _start_idle(self) -> None:
        """Hook: subclass-owned polling thread (autonomous idle ticker)."""

    def _before_submit(self) -> Any:
        """Hook: context captured before submit (reports snapshot)."""
        return None

    def _fire_prompt(self, s: Any) -> str:
        return s.prompt

    def _build_run(self, s: Any, now: int, handle: Any, prompt: str) -> Any:
        raise NotImplementedError

    def _fired_payload(self, s: Any, run: Any, handle: Any, now: int) -> dict:
        raise NotImplementedError

    def _watch_deadline_reached(self, run: Any) -> bool:
        raise NotImplementedError

    def _finalize_run(self, s: Any, run: Any, handle: Any, context: Any) -> None:
        raise NotImplementedError

    def _on_watch_crash(
        self, s: Any, run: Any, stop_event: threading.Event, exc: Exception,
    ) -> None:
        """Hook: post-crash bookkeeping (task commits an error run)."""

    def _apply_upsert_defaults(self, base: dict) -> None:
        """Hook: subclass backfills legacy defaults before materialization."""

    def _join_background_workers(self, deadline: float) -> bool:
        """Hook: join domain-owned background threads; True when drained."""
        return True

    @classmethod
    def instance(
        cls: type[_SelfT],
        channel: SystemChannel | None = None,
        *,
        scheduler_runtime: Any | None = None,
    ) -> _SelfT:
        if cls._instance is not None and cls._instance._stop_event.is_set():
            if not cls._instance.shutdown(timeout=0):
                raise RuntimeError(f"previous {cls.display_name} is still shutting down")
        if cls._instance is None:
            assert channel is not None
            cls._instance = cls(channel, scheduler_runtime=scheduler_runtime)
        return cls._instance

    # ── persistence ──────────────────────────────────────────────
    def _load(self) -> None:
        path = self._sched_file()
        if not os.path.isfile(path):
            self._seed_defaults()
            return
        try:
            with open(path, encoding="utf-8") as fh:
                data = json.loads(fh.read())
            allowed = {f.name for f in self.schedule_cls.__dataclass_fields__.values()}
            for raw in data.get("schedules", []):
                # tolerate unknown keys from older builds
                clean = {k: v for k, v in raw.items() if k in allowed}
                sch = self.schedule_cls(**clean)
                self.schedules[sch.id] = sch
        except Exception as e:
            log.exception("failed to load schedules: %s", e)
            self._seed_defaults()

    def _persist(self) -> None:
        path = self._sched_file()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"schedules": [s.to_dict() for s in self.schedules.values()]},
                      f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)

    def _record_run(self, run: Any) -> None:
        path = self._runs_file()
        with self._run_write_lock:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "a", encoding="utf-8") as f:
                f.write(json.dumps(run.to_dict(), ensure_ascii=False) + "\n")

    # ── lifecycle ────────────────────────────────────────────────
    def start(self) -> None:
        if self._watchers.stopping:
            self._check_restart_allowed()
            self._watchers.reset()
        if not self._sched.running:
            self._sched.start()
        # rebuild jobs from schedules
        for s in self.schedules.values():
            self._install_job(s)
        self._start_idle()

    def shutdown(self, timeout: float = 5.0) -> bool:
        deadline = time.monotonic() + max(0.0, timeout)
        stop_event = getattr(self, "_stop_event", None)
        if stop_event is not None:
            stop_event.set()
        admission_stopped = True
        admission_lock = getattr(self, "_admission_lock", None)
        if admission_lock is not None:
            admission_stopped = admission_lock.acquire(
                timeout=max(0.0, deadline - time.monotonic())
            )
            if admission_stopped:
                admission_lock.release()
        watchers = getattr(self, "_watchers", None)
        if watchers is not None and admission_stopped:
            watchers.request_stop()
        if getattr(self, "_owns_sched", True):
            try:
                scheduler = getattr(self, "_sched", None)
                if scheduler is not None:
                    scheduler.shutdown(wait=False)
            except Exception:
                pass
        idle_stopped = self._join_background_workers(deadline)
        if watchers is None:
            watchers_stopped = True
        elif admission_stopped:
            watchers_stopped = watchers.shutdown(
                timeout=max(0.0, deadline - time.monotonic())
            )
        else:
            # An in-flight fire still owns admission and must be allowed to
            # register its watcher after this timed-out shutdown returns.
            # stop_event already asks that watcher to exit promptly.
            watchers_stopped = False
        stopped = (
            admission_stopped
            and idle_stopped
            and watchers_stopped
        )
        if stopped and type(self)._instance is self:
            type(self)._instance = None
        return stopped

    # ── job management ───────────────────────────────────────────
    def _job_id(self, sch_id: str) -> str:
        return f"{self.job_prefix}{sch_id}"

    def _install_job(self, s: Any) -> None:
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
            self._sched.add_job(
                self._fire, trig, id=jid, args=[s.id], replace_existing=True,
                misfire_grace_time=MISFIRE_GRACE_SECONDS, coalesce=True,
            )
        elif s.type == "interval":
            self._sched.add_job(
                self._fire,
                IntervalTrigger(minutes=max(1, int(s.interval_minutes))),
                id=jid, args=[s.id], replace_existing=True,
                misfire_grace_time=MISFIRE_GRACE_SECONDS, coalesce=True,
            )
        # other trigger types (autonomous idle) never reach APScheduler

    # ── triggers ─────────────────────────────────────────────────
    def trigger_now(self, schedule_id: str) -> dict:
        if schedule_id not in self.schedules:
            raise KeyError(schedule_id)
        return self._fire(schedule_id)

    def _fire(self, schedule_id: str) -> dict:
        with self._admission_lock:
            with self._lock:
                if self._stop_event.is_set():
                    return {"error": "shutting_down"}
                s = self.schedules.get(schedule_id)
                if s is None:
                    return {"error": "not_found"}
                now = int(time.time())
                context = self._before_submit()
                if self._stop_event.is_set():
                    return {"error": "shutting_down"}
                prompt = self._fire_prompt(s)
                try:
                    handle = self.channel.submit(prompt, source=self.source)
                except AgentBusyError as exc:
                    # Admission refused: leave last_fired_at/fire_count alone so
                    # the next tick can retry instead of this trigger being
                    # silently consumed (2026-09 review P0).
                    log.warning("%s fire refused for %s: %s", self.source, s.id, exc)
                    return {"error": exc.reason}
                s.last_fired_at = now
                s.fire_count += 1
                self._persist()
                run = self._build_run(s, now, handle, prompt)

            bus.publish(self.topic_fired, self._fired_payload(s, run, handle, now))

            # Register before releasing admission so shutdown cannot miss it.
            def _watch(stop_event: threading.Event) -> None:
                try:
                    while not handle.finished:
                        if stop_event.wait(2):
                            return
                        if self._watch_deadline_reached(run):
                            break
                    if stop_event.is_set():
                        return
                    self._finalize_run(s, run, handle, context)
                except Exception as e:
                    log.exception("%s watch crash: %s", self.source, e)
                    self._on_watch_crash(s, run, stop_event, e)

            if not self._watchers.start(_watch, name=f"{self.watch_prefix}-watch-{run.id[:8]}"):
                return {"error": "shutting_down"}
            return {"run_id": run.id, "stream_id": handle.stream_id}

    # ── CRUD ─────────────────────────────────────────────────────
    def list(self) -> list[dict]:
        # Concurrent upsert/delete mutate self.schedules under _lock; an
        # unlocked sorted(values()) can hit "dictionary changed size".
        with self._lock:
            return [s.to_dict() for s in sorted(self.schedules.values(), key=lambda s: s.id)]

    def upsert(self, payload: dict) -> Any:
        sid = payload.get("id") or f"{self.id_prefix}{uuid.uuid4().hex[:8]}"
        with self._lock:
            existing = self.schedules.get(sid)
            base = existing.to_dict() if existing else {}
            base.update({k: v for k, v in payload.items() if v is not None})
            base["id"] = sid
            self._apply_upsert_defaults(base)
            allowed = {f.name for f in self.schedule_cls.__dataclass_fields__.values()}
            clean = {k: v for k, v in base.items() if k in allowed}
            sch = self.schedule_cls(**clean)
            self.schedules[sid] = sch
            self._persist()
            self._install_job(sch)
        bus.publish(self.topic_upsert, sch.to_dict())
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
        bus.publish(self.topic_delete, {"id": sid})
        return True

    def list_runs(self, limit: int = 100) -> list[dict]:
        path = self._runs_file()
        if not os.path.isfile(path):
            return []
        try:
            return read_jsonl_tail(path, limit)
        except Exception as e:
            log.warning("failed to read runs: %s", e)
            return []
