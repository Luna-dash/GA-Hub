"""Create isolated AgentService runtimes backed by GA-native archives.

Restore follows one convergence rule: the endpoint of any restore attempt is a
usable session, never an error loop. Failure causes are ranked and degraded:

- L0 healthy archive      → load normally;
- L1 lock held by a verifiably dead process → probe the recorded pid, remove
  the orphaned lock, retry once (mtime freshness alone would force a pointless
  30s wait after every unclean exit);
- L2 archive content unreadable (response-less prompt-only tail, truncated or
  foreign format) → back up the old file, mint a fresh native log for the same
  Hub session, and start clean instead of failing forever;
- L3 lock held by a live process → refuse (genuine concurrent occupancy).
"""
from __future__ import annotations

import logging
import os
import time
from pathlib import Path
from typing import Any, Callable

from .project_runtime import activate_project
from .session_metadata import SessionMetadataStore

log = logging.getLogger(__name__)

# GA's continue_inplace refuses archives whose parse can never succeed again
# (zero Prompt→Response pairs, or no native/summary structure at all). Retrying
# cannot change those bytes, so these two refusals are the exact trigger for
# L2 rotation. Everything else — transient read errors, genuine occupancy —
# keeps raising so no healthy archive is ever rotated by accident.
_CONTENT_FAILURE_MARKERS = ("为空或格式不符", "无法解析")


def _is_content_failure(message: str | None) -> bool:
    text = message or ""
    return any(marker in text for marker in _CONTENT_FAILURE_MARKERS)


class RuntimeRestoreError(RuntimeError):
    """Raised when GA cannot restore the archive bound to a Hub session."""


_WINDOWS_STILL_ACTIVE = 259
_ERROR_ACCESS_DENIED = 5


def _windows_pid_alive(pid: int) -> bool:
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


def _pid_alive(pid: int) -> bool:
    """Best-effort cross-platform process liveness probe.

    The conservative failure direction is "alive": an unprobeable pid must not
    cause a lock takeover, because taking a live session's lock would let two
    agents append to the same archive.
    """
    if pid <= 0:
        return False
    try:
        if os.name == "nt":
            return _windows_pid_alive(pid)
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        return True
    except Exception:
        return True


def _takeover_stale_lock(archive_path: str) -> bool:
    """Clear a leftover session lock whose owning process is verifiably dead.

    GA judges lock liveness purely by a 30s heartbeat window and never checks
    whether the recorded pid still exists (``continue_cmd.acquire_lock``). When
    the previous sidecar exited without releasing its locks — crash, force
    kill, or a restart — the first restore of that session inside the window
    is wrongly refused as "occupied". Verifying the holder pid and removing
    the dead lock lets the restore succeed immediately; anything we cannot
    probe is left alone so the usual 30s expiry still applies.
    """
    try:
        from frontends.continue_cmd import _lock_path, session_occupant
    except Exception:
        return False
    occupant = session_occupant(archive_path)
    if not occupant:
        return False
    pid = occupant.get("pid")
    if not isinstance(pid, int) or _pid_alive(pid):
        return False
    try:
        os.remove(_lock_path(archive_path))
    except OSError:
        return False
    return True


class SessionRuntimeFactory:
    """Lazily construct one GA runtime per Hub session.

    The sidecar stores only the native archive path. Conversation content stays
    exclusively in the live GA agent and ``model_responses_*.txt`` archive.
    """

    def __init__(
        self,
        store: SessionMetadataStore,
        *,
        service_factory: Callable[..., Any] | None = None,
        continue_inplace: Callable[..., tuple[str, bool]] | None = None,
        acquire_birth_lock: Callable[..., Any] | None = None,
        release_current: Callable[[Any], Any] | None = None,
        takeover_stale_lock: Callable[[str], bool] | None = None,
        begin_fresh_session: Callable[..., Any] | None = None,
    ) -> None:
        if service_factory is None:
            from .agent_service import AgentService

            service_factory = AgentService
        if continue_inplace is None or acquire_birth_lock is None or release_current is None:
            from frontends.continue_cmd import (
                acquire_birth_lock as ga_acquire_birth_lock,
                continue_inplace as ga_continue_inplace,
                release_current as ga_release_current,
            )

            continue_inplace = continue_inplace or ga_continue_inplace
            acquire_birth_lock = acquire_birth_lock or ga_acquire_birth_lock
            release_current = release_current or ga_release_current
        self._store = store
        self._service_factory = service_factory
        self._continue_inplace = continue_inplace
        self._acquire_birth_lock = acquire_birth_lock
        self._release_current = release_current
        self._takeover_stale_lock = takeover_stale_lock or _takeover_stale_lock
        self._begin_fresh_session = begin_fresh_session

    def _begin_fresh(self, agent: Any) -> None:
        if self._begin_fresh_session is not None:
            self._begin_fresh_session(agent)
            return
        from frontends.continue_cmd import begin_fresh_session as ga_begin_fresh

        ga_begin_fresh(agent)

    def _rotate_unreadable_archive(
        self,
        session_id: str,
        runtime: Any,
        resolved_archive: str,
    ) -> None:
        """L2 recovery: the archive exists but GA cannot parse it (typically a
        response-less prompt-only tail left by a run that died mid-first-turn).
        Retrying can never succeed — the bytes do not change — so the session
        would be permanently unopenable. Back the file up untouched, bind a
        freshly minted native log to the same Hub session, and continue clean.

        Raises RuntimeError only when the fresh session itself cannot be
        established; backup rename failures are logged and swallowed because
        the rotated session no longer references the old path.
        """
        self._begin_fresh(runtime.agent)
        timestamp = time.strftime("%Y%m%d-%H%M%S")
        backup = f"{resolved_archive}.broken-{timestamp}"
        try:
            os.replace(resolved_archive, backup)
            log.warning(
                "session %s archive was unreadable; backed up to %s and "
                "rotated to a fresh native log",
                session_id,
                backup,
            )
        except OSError:
            log.warning(
                "session %s archive was unreadable and could not be backed "
                "up (%s); continuing with a fresh native log anyway",
                session_id,
                resolved_archive,
            )
        # bind_archive refuses a rebind (the session already points at the
        # broken file); rotation is the one sanctioned overwrite path.
        self._store.rotate_archive(
            session_id, runtime.agent.log_path
        )

    def __call__(self, session_id: str):
        row = self._store.get(session_id)
        runtime = self._service_factory(
            session_id=session_id,
            manage_global_preference=False,
        )
        archive_path = row.get("archive_path")
        if archive_path:
            resolved_archive = str(Path(archive_path).resolve())
            message, ok = self._continue_inplace(
                runtime.agent,
                resolved_archive,
                agent_id=session_id,
                restore_wm=True,
            )
            if not ok and self._takeover_stale_lock(resolved_archive):
                # The first refusal came from a dead process's leftover lock;
                # it is gone now, so one immediate retry takes the session over.
                message, ok = self._continue_inplace(
                    runtime.agent,
                    resolved_archive,
                    agent_id=session_id,
                    restore_wm=True,
                )
            if not ok and _is_content_failure(message):
                # L2: the refusal is about archive CONTENT, not occupancy —
                # typically a response-less prompt-only tail from a run that
                # died before its first answer landed. Retrying is futile, so
                # rotate to a fresh log (old file backed up) and keep the
                # session usable instead of failing on every future attempt.
                self._rotate_unreadable_archive(
                    session_id, runtime, resolved_archive
                )
                ok = True
            if not ok:
                self._release_current(runtime.agent)
                raise RuntimeRestoreError(message)
        else:
            self._acquire_birth_lock(runtime.agent, session_id)
            try:
                self._store.bind_archive(session_id, runtime.agent.log_path)
            except Exception:
                self._release_current(runtime.agent)
                raise
        bind_rewind_store = getattr(runtime, "bind_rewind_store", None)
        if callable(bind_rewind_store):
            try:
                bind_rewind_store()
            except Exception as exc:
                self._release_current(runtime.agent)
                raise RuntimeRestoreError(
                    "GA rewind checkpoint initialization failed"
                ) from exc
        project_name = row.get("project_name")
        if project_name:
            activate_project(runtime.agent, project_name)
        runtime.start_run_thread()
        return runtime
