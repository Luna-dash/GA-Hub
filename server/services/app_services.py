"""Explicit ownership snapshot for process-lifetime GA-Hub services.

The domain services keep their compatibility singleton accessors for route
code, while FastAPI lifespan records the exact instances it actually created.
Status and shutdown paths can therefore observe/close existing owners without
using a getter that might construct fresh work during partial startup/teardown.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .agent_service import AgentService
    from .conductor_service import ConductorService
    from .feishu_service import FeishuService
    from .scheduler_host import SchedulerHost
    from .wechat_service import WeChatService

log = logging.getLogger(__name__)


@dataclass(slots=True)
class AppServices:
    agent: AgentService | None = None
    conductor: ConductorService | None = None
    feishu: FeishuService | None = None
    scheduler_host: SchedulerHost | None = None
    wechat: "WeChatService | None" = None

    def clear(self) -> None:
        """Forget every owner before a new lifespan or after teardown."""
        self.agent = None
        self.conductor = None
        self.feishu = None
        self.scheduler_host = None
        self.wechat = None

    def status_snapshot(self) -> dict[str, Any]:
        """Merge per-service status reports; failures degrade, never raise."""
        out: dict[str, Any] = {}
        if self.agent is not None:
            out["agent"] = self.agent.status().__dict__
        if self.feishu is not None:
            try:
                out["feishu"] = self.feishu.status()
            except Exception:
                log.exception("feishu status read failed")
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
        # wx threads submit through the coordinator: stop them while the
        # producers shut down, before the agent they can invoke. WeChat is
        # lazily built (first /api/wechat/login), so cover both the owned
        # slot and the compatibility singleton.
        try:
            from .wechat_service import WeChatService

            WeChatService.shutdown_existing()
        except Exception:
            log.exception("wechat shutdown failed")
        if self.feishu is not None:
            try:
                self.feishu.shutdown()
            except Exception:
                log.exception("feishu shutdown failed")
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
