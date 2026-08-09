"""Bridge Hub session bindings to GA's per-agent project-mode state."""
from __future__ import annotations

from typing import Any


def activate_project(agent: Any, name: str) -> None:
    """Activate project context on the long-lived GenericAgent instance."""
    agent._ga_project_mode_name = name


def deactivate_project(agent: Any) -> None:
    """Remove project context without relying on a transient GA handler."""
    try:
        del agent._ga_project_mode_name
    except AttributeError:
        pass
