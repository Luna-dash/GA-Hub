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
_DETACHED_PROCESS = 0x00000008
_CREATE_NEW_CONSOLE = 0x00000010


def install_silent_subprocess_default() -> bool:
    """Ensure every Windows ``subprocess.Popen`` in this process defaults to ``CREATE_NO_WINDOW``.

    The packaged desktop sidecar (PyInstaller ``--noconsole``) and ``pythonw.exe``
    launches have no attached console. Any in-process GA module, plugin, stdlib
    helper, or third-party package that calls ``subprocess.Popen`` / ``run``
    without ``CREATE_NO_WINDOW`` would otherwise flash a black ``conhost.exe``
    window.

    Only ``CREATE_NO_WINDOW`` is added (never ``SW_HIDE`` in ``STARTUPINFO``),
    so GUI-subsystem binaries such as ``explorer.exe`` remain visible while all
    console binaries (``powershell.exe``, ``pwsh.exe``, ``cmd.exe``, ``python.exe``,
    ``git.exe``, ``agy.exe``) run silently. Callers that explicitly pass
    ``CREATE_NEW_CONSOLE`` or ``DETACHED_PROCESS`` are left untouched.

    Idempotent; returns ``True`` when the guard is active on Windows.
    """
    if os.name != "nt":
        return False
    current_init = subprocess.Popen.__init__
    if getattr(current_init, "_ga_hub_silent_default", False):
        return True

    no_window = getattr(subprocess, "CREATE_NO_WINDOW", _CREATE_NO_WINDOW)
    explicit_console_modes = (
        getattr(subprocess, "CREATE_NEW_CONSOLE", _CREATE_NEW_CONSOLE)
        | getattr(subprocess, "DETACHED_PROCESS", _DETACHED_PROCESS)
    )

    def _silent_popen_init(self, *args: Any, **kwargs: Any) -> None:
        flags = kwargs.get("creationflags", 0) or 0
        if not (flags & explicit_console_modes):
            kwargs["creationflags"] = flags | no_window
        current_init(self, *args, **kwargs)

    _silent_popen_init._ga_hub_silent_default = True  # type: ignore[attr-defined]
    _silent_popen_init._ga_hub_orig_init = current_init  # type: ignore[attr-defined]
    subprocess.Popen.__init__ = _silent_popen_init  # type: ignore[method-assign]
    return True


def hidden_process_kwargs(
    *,
    new_process_group: bool = False,
    existing_creationflags: int = 0,
    detach_console: bool = False,
) -> dict[str, Any]:
    """Return platform-safe kwargs that suppress Windows console windows.

    ``CREATE_NO_WINDOW`` is the default for normal child processes. Use
    ``detach_console`` for piped CLI probes that must start without a console
    (Windows ignores ``CREATE_NO_WINDOW`` when ``DETACHED_PROCESS`` is set).
    ``SW_HIDE`` supplies an additional window visibility hint. The returned
    mapping is empty on non-Windows platforms.
    """
    if os.name != "nt":
        return {}

    no_window = getattr(subprocess, "CREATE_NO_WINDOW", _CREATE_NO_WINDOW)
    if detach_console:
        flags = (existing_creationflags & ~no_window) | getattr(subprocess, "DETACHED_PROCESS", _DETACHED_PROCESS)
    else:
        flags = existing_creationflags | no_window
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
