"""Shared subprocess policy for the desktop host.

GA-Hub is a GUI application.  On Windows every child process must be
created without a console, including helpers started long after the main
window appears (notifications, sync jobs, bot workers, and probes).

It is also the shared home for the process-liveness probe: both the session
lock takeover (``session_runtime_factory``) and the child-process sweep
(``services/child_job``) must answer "is this pid still running" the same way.
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


# ── process liveness ────────────────────────────────────────────
_WINDOWS_STILL_ACTIVE = 259
_ERROR_ACCESS_DENIED = 5


def windows_pid_alive(pid: int) -> bool:
    import ctypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    process_query_limited_information = 0x1000
    # Explicit wide signatures: the default windll restype (c_int) truncates
    # 64-bit HANDLEs and makes probes of high-valued handles unreliable.
    kernel32.OpenProcess.argtypes = (
        ctypes.c_uint32,
        ctypes.c_int,
        ctypes.c_uint32,
    )
    kernel32.OpenProcess.restype = ctypes.c_void_p
    handle = kernel32.OpenProcess(process_query_limited_information, False, pid)
    if not handle:
        error = ctypes.get_last_error()
        if error == _ERROR_ACCESS_DENIED:
            # The process exists but cannot be probed from this token
            # (elevated/protected). Conservative direction: treat as alive —
            # taking a live holder's lock would allow two writers on one
            # archive, while waiting costs at most the usual 30s expiry.
            return True
        return False
    kernel32.GetExitCodeProcess.argtypes = (
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_ulong),
    )
    kernel32.GetExitCodeProcess.restype = ctypes.c_int
    kernel32.CloseHandle.argtypes = (ctypes.c_void_p,)
    exit_code = ctypes.c_ulong()
    try:
        if kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
            return exit_code.value == _WINDOWS_STILL_ACTIVE
        return True
    finally:
        kernel32.CloseHandle(handle)


def pid_alive(pid: int) -> bool:
    """Best-effort cross-platform process liveness probe.

    The conservative failure direction is "alive": an unprobeable pid must not
    cause a lock takeover, because taking a live session's lock would let two
    agents append to the same archive.

    Callers that use this to decide whether to *terminate* something must not
    rely on it alone — a live pid may be an unrelated process that recycled the
    number. ``services/child_job`` therefore re-checks the recorded command
    line before killing anything.
    """
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        if os.name == "nt":
            return windows_pid_alive(pid)
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        return True
    except Exception:
        return True
