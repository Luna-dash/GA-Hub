"""Explicit ownership snapshot for process-lifetime GA-Hub services.

The domain services keep their compatibility singleton accessors for route
code, while FastAPI lifespan records the exact instances it actually created.
Status and shutdown paths can therefore observe/close existing owners without
using a getter that might construct fresh work during partial startup/teardown.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .agent_service import AgentService
    from .feishu_service import FeishuService
    from .scheduler_host import SchedulerHost


@dataclass(slots=True)
class AppServices:
    agent: AgentService | None = None
    feishu: FeishuService | None = None
    scheduler_host: SchedulerHost | None = None

    def clear(self) -> None:
        """Forget every owner before a new lifespan or after teardown."""
        self.agent = None
        self.feishu = None
        self.scheduler_host = None
