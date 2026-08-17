"""Shared subprocess policy for the desktop host.

GA-Hub is a GUI application.  On Windows every child process must be
created without a console, including helpers started long after the main
window appears (notifications, sync jobs, bot workers, and probes).
"""
from __future__ import annotations

import os
import subprocess
from typing import Any


_CREATE_NO_WINDOW = 0x08000000


def hidden_process_kwargs(
    *,
    new_process_group: bool = False,
    existing_creationflags: int = 0,
) -> dict[str, Any]:
    """Return platform-safe kwargs that suppress Windows console windows.

    ``CREATE_NO_WINDOW`` prevents conhost allocation.  ``SW_HIDE`` is kept as
    a second layer for executables that still inspect ``STARTUPINFO``.  The
    returned mapping is empty on non-Windows platforms.
    """
    if os.name != "nt":
        return {}

    flags = existing_creationflags | getattr(
        subprocess,
        "CREATE_NO_WINDOW",
        _CREATE_NO_WINDOW,
    )
    if new_process_group:
        flags |= getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)

    kwargs: dict[str, Any] = {"creationflags": flags}
    startupinfo_factory = getattr(subprocess, "STARTUPINFO", None)
    if startupinfo_factory is not None:
        startupinfo = startupinfo_factory()
        startupinfo.dwFlags |= getattr(subprocess, "STARTF_USESHOWWINDOW", 1)
        startupinfo.wShowWindow = getattr(subprocess, "SW_HIDE", 0)
        kwargs["startupinfo"] = startupinfo
    return kwargs
