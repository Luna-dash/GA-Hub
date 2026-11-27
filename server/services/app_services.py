"""Explicit ownership snapshot for process-lifetime GA-Hub services.

The domain services keep their compatibility singleton accessors for route
code, while FastAPI lifespan records the exact instances it actually created.
Status and shutdown paths can therefore observe/close existing owners without
using a getter that might construct fresh work during partial startup/teardown.
"""
from __future__ import annotations

import logging
import sys
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .agent_service import AgentService
    from .conductor_service import ConductorService
    from .im_adapter import IMRegistry
    from .scheduler_host import SchedulerHost

log = logging.getLogger(__name__)


@dataclass(slots=True)
class AppServices:
    agent: AgentService | None = None
    conductor: ConductorService | None = None
    im: IMRegistry | None = None
    scheduler_host: SchedulerHost | None = None
    mykey_sync: Any | None = None
    goalhive: Any | None = None
    agy_runtime: Any | None = None

    def clear(self) -> None:
        """Forget every owner before a new lifespan or after teardown."""
        self.agent = None
        self.conductor = None
        self.im = None
        self.scheduler_host = None
        self.mykey_sync = None
        self.goalhive = None
        self.agy_runtime = None

    def status_snapshot(self) -> dict[str, Any]:
        """Merge per-service status reports; failures degrade, never raise."""
        out: dict[str, Any] = {}
        if self.agent is not None:
            out["agent"] = self.agent.status().__dict__
        if self.im is not None:
            try:
                out["im"] = self.im.status_snapshot()
            except Exception:
                log.exception("im status read failed")
        if self.scheduler_host is not None:
            scheduler_status = self.scheduler_host.status()
            out["schedulers"] = scheduler_status
            for source in ("autonomous", "tasks"):
                count = scheduler_status.get(source, {}).get("schedule_count")
                if count is not None:
                    out[source] = {"schedule_count": count}
        return out

    def shutdown_all(self) -> None:
        """Close owned services in dependency order (producers first)."""
        host = self.scheduler_host
        if host is not None:
            try:
                if host.shutdown_all() is False:
                    log.warning("scheduler host shutdown exceeded its graceful deadline")
            except Exception:
                log.exception("scheduler host shutdown failed")
        # Goal/Hive runs its own agent/tools; stop it before conductor & agent.
        try:
            if self.goalhive is not None:
                stopped = self.goalhive.shutdown()
                if stopped is False:
                    log.warning("goalhive shutdown exceeded its graceful deadline")
                elif "server.services.goalhive_service" in sys.modules:
                    sys.modules["server.services.goalhive_service"].clear_goalhive_service(self.goalhive)
            elif "server.services.goalhive_service" in sys.modules:
                if not sys.modules["server.services.goalhive_service"].shutdown_goalhive_service():
                    log.warning("goalhive shutdown exceeded its graceful deadline")
        except Exception:
            log.exception("goalhive shutdown failed")
        if self.im is not None:
            try:
                self.im.shutdown_all()
            except Exception:
                log.exception("im shutdown failed")
        # The conductor engine may still reach hub HTTP APIs while it is
        # being stopped, so it closes before the agent that serves them.
        if self.conductor is not None:
            try:
                if self.conductor.shutdown() is False:
                    log.warning("conductor shutdown did not finish before its deadline")
            except Exception:
                log.exception("conductor shutdown failed")
        if self.agent is not None:
            try:
                if self.agent.shutdown() is False:
                    log.warning("agent shutdown missed its graceful deadline")
            except Exception:
                log.exception("agent shutdown failed")
        elif "server.services.agent_service" in sys.modules:
            try:
                peek = sys.modules["server.services.agent_service"].AgentService.peek_instance()
                if peek is not None and peek.shutdown() is False:
                    log.warning("lazy agent shutdown missed its graceful deadline")
            except Exception:
                log.exception("lazy agent shutdown failed")
        if self.agy_runtime is not None:
            try:
                self.agy_runtime.shutdown()
            except Exception:
                log.exception("agy runtime shutdown failed")
        elif "server.services.agy_runtime" in sys.modules:
            try:
                sys.modules["server.services.agy_runtime"].runtime.shutdown()
            except Exception:
                log.exception("agy runtime shutdown failed")
        # Last: no service owns these children any more. Each service above
        # already stops the one it started; this is the catch-all for a child
        # the services never tracked (the external GA worker has no owner
        # object), and it is the graceful half of the guarantee whose crash
        # half is the kill-on-close job in services/child_job.
        try:
            from . import child_job

            child_job.reap_all()
        except Exception:
            log.exception("child process reap failed")
