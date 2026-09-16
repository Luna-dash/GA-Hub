"""Process cage + spawn registry for GA-Hub's own long-lived children.

GA-Hub spawns three long-lived children — the conductor engine
(``frontends/gahub_app.py``), the feishu bot (``frontends/fsapp.py``) and the
external GA browser-tool worker — and all three used to be naked
``subprocess.Popen`` calls. A *graceful* close reaps them; a hard kill of
GA-Hub (crash, ``taskkill /F``, panic) did not, and the observed residue was a
6-day-old engine and a 3-day-old bot.

Two mechanisms close that hole. Neither needs the child's cooperation, which
matters because the GA checkout is read-only to this project.

**Job object cage.** One ``CreateJobObjectW`` per GA-Hub process, configured
with ``JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE``, and every child is assigned to it.
The kernel closes the handle when this process dies *by any means*, and closing
a kill-on-close job terminates its members — so the crash path is covered by
the OS, not by our cleanup code. Members' own descendants join the job
implicitly, so an engine's subagents go down with it.

**Spawn registry.** ``child_processes.json`` under ADMIN_DATA records
``{kind, pid, parent, marker, started_at}``; a row is dropped when its child is
reaped normally, and the survivors are swept once at startup. A row whose
``parent`` is gone while its ``pid`` is alive is a leak from a previous run.
This is the belt to the cage's braces: it also collects children spawned by a
build that predates the cage, and it is the only mechanism on POSIX.

**Intermediaries.** A spawn may route through a system binary instead of the
program itself (the engine goes through ``cmd.exe`` — see
``conductor_client._shell_launch``), and then the process that matters is a
*child of the child*: it does not inherit the cage, because it can be created
before the intermediary is assigned, and terminating the intermediary does not
stop it. ``cage_descendants`` closes the first half (it re-assigns the live
descendants once they exist) and ``terminate_tree`` the second (reaping by pid
stops descendants too, not just the process ``Popen`` handed back).

The desktop shell already puts the sidecar inside its own kill-on-close job
(``src-tauri/src/main.rs``), so this job is *nested* inside that one. That is
deliberate and verified on Windows: a process already inside a job can be
assigned to a new job, and the child then belongs to both. It is what makes the
"GA-Hub was killed but Tauri is still up" case recoverable — Tauri holding its
handle does not keep *our* job alive.

Escape hatch: ``GAHUB_KEEP_CHILDREN_ON_EXIT=1`` turns off the cage, the
registry and the startup sweep for this run, so children outlive GA-Hub on
purpose (debugging an engine across restarts).
"""
from __future__ import annotations

import atexit
import json
import logging
import os
import signal
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Optional

from .. import _paths
from ..constants import ENV_GAHUB_KEEP_CHILDREN_ON_EXIT
from ..process_utils import pid_alive

log = logging.getLogger(__name__)

# Job object: JOB_OBJECT_EXTENDED_LIMIT_INFORMATION (winnt.h) and the one limit
# bit that turns "handle closed" into "members terminated".
_JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
_JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
_ERROR_ACCESS_DENIED = 5
# The two rights AssignProcessToJobObject documents for the target handle.
_PROCESS_SET_QUOTA = 0x0100
_PROCESS_TERMINATE = 0x0001

# Registry sweeps touch at most a handful of rows; these bound a hung child so
# startup can never stall on one.
_SWEEP_TERMINATE_TIMEOUT = 3.0
_REAP_ALL_TIMEOUT = 5.0
_REGISTRY_VERSION = 1

_UNSET = object()


# ── Windows Job Object bindings ─────────────────────────────────
class _WindowsJobApi:
    """Minimal kernel32 surface for one kill-on-close job object."""

    def __init__(self) -> None:
        import ctypes

        class _BasicLimit(ctypes.Structure):
            # LARGE_INTEGER x2, DWORD, SIZE_T x2, DWORD, ULONG_PTR, DWORD, DWORD
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_longlong),
                ("PerJobUserTimeLimit", ctypes.c_longlong),
                ("LimitFlags", ctypes.c_uint32),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", ctypes.c_uint32),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", ctypes.c_uint32),
                ("SchedulingClass", ctypes.c_uint32),
            ]

        class _IoCounters(ctypes.Structure):
            _fields_ = [
                (name, ctypes.c_ulonglong)
                for name in (
                    "ReadOperationCount",
                    "WriteOperationCount",
                    "OtherOperationCount",
                    "ReadTransferCount",
                    "WriteTransferCount",
                    "OtherTransferCount",
                )
            ]

        class _ExtendedLimit(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", _BasicLimit),
                ("IoInfo", _IoCounters),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        self.ctypes = ctypes
        self._extended_limit = _ExtendedLimit
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        # Explicit signatures: the default restype (c_int) truncates 64-bit
        # HANDLEs, which would make every Assign/Close call unreliable.
        kernel32.CreateJobObjectW.argtypes = (ctypes.c_void_p, ctypes.c_wchar_p)
        kernel32.CreateJobObjectW.restype = ctypes.c_void_p
        kernel32.SetInformationJobObject.argtypes = (
            ctypes.c_void_p,
            ctypes.c_int,
            ctypes.c_void_p,
            ctypes.c_uint32,
        )
        kernel32.SetInformationJobObject.restype = ctypes.c_int
        kernel32.AssignProcessToJobObject.argtypes = (ctypes.c_void_p, ctypes.c_void_p)
        kernel32.AssignProcessToJobObject.restype = ctypes.c_int
        kernel32.OpenProcess.argtypes = (ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32)
        kernel32.OpenProcess.restype = ctypes.c_void_p
        kernel32.CloseHandle.argtypes = (ctypes.c_void_p,)
        kernel32.CloseHandle.restype = ctypes.c_int
        self.kernel32 = kernel32

    def create_kill_on_close(self) -> Any:
        """Return a job handle, or ``None`` when the kernel refuses."""
        handle = self.kernel32.CreateJobObjectW(None, None)
        if not handle:
            log.warning("CreateJobObjectW failed: %s", self.ctypes.get_last_error())
            return None
        limits = self._extended_limit()
        limits.BasicLimitInformation.LimitFlags = _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        configured = self.kernel32.SetInformationJobObject(
            handle,
            _JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            self.ctypes.byref(limits),
            self.ctypes.sizeof(limits),
        )
        if not configured:
            log.warning(
                "SetInformationJobObject failed: %s", self.ctypes.get_last_error()
            )
            self.kernel32.CloseHandle(handle)
            return None
        return handle

    def assign(self, job: Any, proc: Any) -> tuple[bool, int]:
        """Put ``proc`` in ``job``; returns ``(ok, last_error)``."""
        raw = getattr(proc, "_handle", None)
        if not isinstance(raw, int) or raw <= 0:
            return False, 0
        ok = bool(
            self.kernel32.AssignProcessToJobObject(job, self.ctypes.c_void_p(raw))
        )
        return ok, (0 if ok else self.ctypes.get_last_error())

    def assign_pid(self, job: Any, pid: int) -> tuple[bool, int]:
        """Put the live process ``pid`` in ``job``; returns ``(ok, last_error)``.

        ``assign`` rides on the handle ``Popen`` already holds; a descendant
        found by a process-tree walk has no such handle, so this opens one with
        exactly the two rights ``AssignProcessToJobObject`` asks for and closes
        it again. A pid that exited in between simply fails the open, which the
        caller treats as "nothing left to cage".
        """
        handle = self.kernel32.OpenProcess(
            _PROCESS_SET_QUOTA | _PROCESS_TERMINATE, False, int(pid)
        )
        if not handle:
            return False, self.ctypes.get_last_error()
        try:
            ok = bool(self.kernel32.AssignProcessToJobObject(job, handle))
            return ok, (0 if ok else self.ctypes.get_last_error())
        finally:
            self.kernel32.CloseHandle(handle)


_job_api_cache: Any = _UNSET
_job_api_lock = threading.Lock()


def _windows_job_api() -> Optional[_WindowsJobApi]:
    """The Job Object API, bound once; ``None`` off Windows or if it fails."""
    global _job_api_cache
    if os.name != "nt":
        return None
    with _job_api_lock:
        if _job_api_cache is _UNSET:
            try:
                _job_api_cache = _WindowsJobApi()
            except Exception:
                log.exception(
                    "job object API unavailable; children stay registry-only"
                )
                _job_api_cache = None
        return _job_api_cache


# ── registry file ───────────────────────────────────────────────
def _read_registry() -> list[dict]:
    path = _paths.child_processes_file()
    try:
        raw = json.loads(path.read_text("utf-8"))
    except FileNotFoundError:
        return []
    except Exception:
        log.warning("child process registry unreadable; ignoring", exc_info=True)
        return []
    entries = raw.get("entries") if isinstance(raw, dict) else None
    if not isinstance(entries, list):
        return []
    return [row for row in entries if isinstance(row, dict)]


def _write_registry(rows: list[dict]) -> None:
    path = _paths.child_processes_file()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(
            json.dumps(
                {"version": _REGISTRY_VERSION, "entries": rows},
                ensure_ascii=False,
                indent=2,
            ),
            "utf-8",
        )
        tmp.replace(path)
    except Exception:
        # Bookkeeping only: losing a row degrades the self-heal, never the run.
        log.warning("child process registry write failed", exc_info=True)


def _normalize(text: str) -> str:
    return text.replace("\\", "/").lower()


def _derive_marker(cmd: Any) -> str:
    """Pick a distinctive fragment of ``cmd`` for the registry identity check.

    A script path is stable across runs and absent from unrelated command
    lines. Commands that carry their program as an inline ``-c`` argument have
    no such fragment, so they get an empty marker and are deliberately not
    sweepable — their callers pass ``marker=`` explicitly instead. An empty
    marker can never match, so nothing is ever killed on a guess.
    """
    if isinstance(cmd, (str, bytes, os.PathLike)):
        parts = [os.fspath(cmd)]
    else:
        parts = [str(part) for part in cmd]
    for part in parts:
        if part.lower().endswith(".py"):
            return part
    return ""


def _matches_identity(pid: int, marker: Any) -> bool:
    """Confirm a live pid is still the child we recorded, not a recycled pid.

    Windows hands pid numbers out again quickly, so terminating ``pid`` purely
    because a stale row claims it was ours is exactly how a cleanup mechanism
    kills somebody else's process. The recorded marker must still be present on
    the live command line; anything unverifiable is left alone.
    """
    if not isinstance(marker, str) or not marker.strip():
        return False
    try:
        import psutil
    except Exception:
        log.warning("psutil unavailable; refusing to sweep unverified pid %s", pid)
        return False
    try:
        cmdline = psutil.Process(pid).cmdline()
    except Exception:
        return False
    return _normalize(marker) in _normalize(" ".join(cmdline or []))


def _terminate_tree(pid: int, timeout: float) -> bool:
    """Terminate ``pid`` and its descendants; ``True`` once the root is gone."""
    if not isinstance(pid, int) or pid <= 0:
        # psutil reads a missing pid as *this* process, so an unvalidated call
        # would walk up on our own tree. Callers holding a test double or a
        # child that never reported a pid get "nothing reaped" instead.
        return False
    try:
        import psutil

        root = psutil.Process(pid)
        procs: list[Any] = root.children(recursive=True)
        procs.append(root)
    except Exception:
        procs = []
    if procs:
        for proc in procs:
            try:
                proc.terminate()
            except Exception:
                pass
        try:
            _, alive = psutil.wait_procs(procs, timeout=max(0.0, timeout))
            for proc in alive:
                try:
                    proc.kill()
                except Exception:
                    pass
            if alive:
                psutil.wait_procs(alive, timeout=2.0)
        except Exception:
            pass
        return not pid_alive(pid)
    # psutil could not describe the pid at all: a bare signal is the last
    # resort, and the liveness probe still has the final word.
    try:
        os.kill(pid, signal.SIGTERM)
    except Exception:
        pass
    deadline = time.monotonic() + max(0.0, timeout)
    while time.monotonic() < deadline:
        if not pid_alive(pid):
            return True
        time.sleep(0.1)
    return not pid_alive(pid)


def _keep_children_requested() -> bool:
    value = str(os.environ.get(ENV_GAHUB_KEEP_CHILDREN_ON_EXIT) or "").strip().lower()
    return value in {"1", "true", "yes", "on"}


class ChildJob:
    """Owns the process cage and the spawn registry for one GA-Hub process."""

    _instance: "ChildJob | None" = None
    _instance_lock = threading.Lock()

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._registry_lock = threading.RLock()
        self._pids: dict[int, str] = {}
        self._job: Any = None
        self._job_attempted = False
        self._atexit_registered = False
        self._keep_children = _keep_children_requested()
        if self._keep_children:
            log.warning(
                "%s is set: children are left unmanaged and survive GA-Hub exit",
                ENV_GAHUB_KEEP_CHILDREN_ON_EXIT,
            )

    @classmethod
    def instance(cls) -> "ChildJob":
        with cls._instance_lock:
            if cls._instance is None:
                cls._instance = cls()
            return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        """Drop the singleton (tests; production never calls it)."""
        with cls._instance_lock:
            cls._instance = None

    # -- lifecycle ---------------------------------------------------
    @property
    def keep_children(self) -> bool:
        """Whether the escape hatch is active for this process."""
        return self._keep_children

    def spawn(
        self,
        cmd: Any,
        *,
        kind: str,
        marker: Optional[str] = None,
        **popen_kwargs: Any,
    ) -> subprocess.Popen:
        """``subprocess.Popen`` plus cage assignment and registry bookkeeping.

        Drop-in for the call sites that used to call ``subprocess.Popen``
        directly: ``popen_kwargs`` pass straight through, and a cage or
        registry failure is logged rather than raised — the child is already
        running and the caller's own supervision must stand.
        """
        proc = subprocess.Popen(cmd, **popen_kwargs)
        try:
            self._adopt(proc, kind=kind, marker=marker or _derive_marker(cmd))
        except Exception:
            log.exception(
                "child adoption failed kind=%s pid=%r", kind, getattr(proc, "pid", None)
            )
        return proc

    def _adopt(self, proc: Any, *, kind: str, marker: str) -> None:
        if self._keep_children:
            return
        pid = getattr(proc, "pid", None)
        if not isinstance(pid, int) or pid <= 0:
            # A test double, or a platform without pid semantics.
            return
        self._register_atexit()
        self._cage(proc, kind=kind)
        if not pid_alive(pid):
            # Gone between CreateProcess and here: nothing left to heal, and
            # registering a dead pid would only invite a later pid-reuse probe.
            return
        with self._lock:
            self._pids[pid] = kind
        self._write_row(
            {
                "kind": kind,
                "pid": pid,
                "parent": os.getpid(),
                "marker": marker,
                "started_at": time.time(),
            }
        )

    def _cage(self, proc: Any, *, kind: str) -> None:
        api = _windows_job_api()
        if api is None:
            return
        with self._lock:
            if not self._job_attempted:
                self._job_attempted = True
                self._job = api.create_kill_on_close()
            job = self._job
        if job is None:
            return
        ok, error = api.assign(job, proc)
        if ok:
            return
        if error == _ERROR_ACCESS_DENIED:
            # The usual cause is a child that already exited between Popen and
            # this call; it needs no cage.
            log.debug("job assign skipped kind=%s pid=%r (access denied)", kind,
                      getattr(proc, "pid", None))
            return
        log.warning(
            "job assign failed kind=%s pid=%r err=%s; this child is protected "
            "by the startup sweep only",
            kind,
            getattr(proc, "pid", None),
            error,
        )

    def _register_atexit(self) -> None:
        with self._lock:
            if self._atexit_registered:
                return
            self._atexit_registered = True
        atexit.register(_atexit_reap)

    def cage_descendants(self, pid: Any) -> list[int]:
        """Assign the live descendants of ``pid`` to this process's job.

        A child created *by a child* inherits the cage only if its parent was
        already a member. That is guaranteed for the feishu bot and the GA
        worker, and explicitly *not* for the engine: its ``cmd.exe``
        intermediary is caged milliseconds after ``CreateProcess`` returned, and
        cmd may already have started the engine by then. An engine left outside
        the cage outlives a hard-killed GA-Hub, which is the leak the cage
        exists to prevent — so the descendants are swept into it here.

        Idempotent (re-assigning a member is a no-op), best-effort, and cheap
        enough to call twice: once right after the spawn and once the child is
        known to be up. Returns the pids it actually caged.
        """
        if self._keep_children:
            return []
        if not isinstance(pid, int) or pid <= 0:
            return []
        api = _windows_job_api()
        if api is None:
            return []
        with self._lock:
            if not self._job_attempted:
                self._job_attempted = True
                self._job = api.create_kill_on_close()
            job = self._job
        if job is None:
            return []
        try:
            import psutil

            descendants = psutil.Process(pid).children(recursive=True)
        except Exception:
            # The intermediary may not have spawned anything yet, or may be
            # gone; both mean "nothing to adopt".
            log.debug("descendant lookup for pid %r failed", pid, exc_info=True)
            return []
        caged: list[int] = []
        for child in descendants:
            ok, error = api.assign_pid(job, child.pid)
            if ok:
                caged.append(child.pid)
            elif error != _ERROR_ACCESS_DENIED:
                log.warning(
                    "job assign failed descendant=%s parent=%s err=%s; this child "
                    "is protected by the startup sweep only",
                    child.pid, pid, error,
                )
        if caged:
            log.info("child_job caged descendants of %s: %s", pid, caged)
        return caged

    def forget(self, pid: Any) -> None:
        """Drop one child from the bookkeeping after the caller reaped it."""
        if not isinstance(pid, int) or pid <= 0:
            return
        with self._lock:
            self._pids.pop(pid, None)
        with self._registry_lock:
            rows = _read_registry()
            kept = [row for row in rows if row.get("pid") != pid]
            if len(kept) != len(rows):
                _write_registry(kept)

    def reap_all(self, timeout: float = _REAP_ALL_TIMEOUT) -> list[int]:
        """Terminate every child this process spawned (best effort)."""
        if self._keep_children:
            return []
        with self._lock:
            pids = sorted(self._pids)
        if not pids:
            return []
        deadline = time.monotonic() + max(0.0, timeout)
        reaped: list[int] = []
        for pid in pids:
            if _terminate_tree(pid, max(0.0, deadline - time.monotonic())):
                reaped.append(pid)
                self.forget(pid)
            else:
                log.warning("child pid %s survived reap; leaving its registry row", pid)
        log.info("child_job reaped %s", reaped)
        return reaped

    def sweep_registry(self) -> list[int]:
        """Reap children whose owning GA-Hub process is gone.

        Runs once at startup, before any service spawns anything. Rows owned by
        a live process are kept — that is the second-instance case — and a pid
        that cannot be positively identified as our child is never touched.
        """
        if self._keep_children:
            return []
        rows = _read_registry()
        if not rows:
            return []
        survivors: list[dict] = []
        reaped: list[int] = []
        for row in rows:
            pid = row.get("pid")
            if not isinstance(pid, int) or pid <= 0:
                continue
            parent = row.get("parent")
            if not isinstance(parent, int) or parent <= 0:
                # Unreadable owner: keep the row rather than guess at a kill.
                survivors.append(row)
                continue
            if pid_alive(parent):
                survivors.append(row)
                continue
            if not pid_alive(pid):
                continue
            if not _matches_identity(pid, row.get("marker")):
                log.warning(
                    "sweep kept pid %s: recorded identity %r is not on the live "
                    "process (recycled pid, or a foreign process)",
                    pid,
                    row.get("marker"),
                )
                continue
            if _terminate_tree(pid, _SWEEP_TERMINATE_TIMEOUT):
                log.info(
                    "child_job swept orphan kind=%s pid=%s (parent %s is gone)",
                    row.get("kind"),
                    pid,
                    parent,
                )
                reaped.append(pid)
            else:
                survivors.append(row)
        with self._registry_lock:
            _write_registry(survivors)
        return reaped

    # -- registry rows ----------------------------------------------
    def _write_row(self, row: dict) -> None:
        with self._registry_lock:
            rows = [item for item in _read_registry() if item.get("pid") != row["pid"]]
            rows.append(row)
            _write_registry(rows)


def _atexit_reap() -> None:
    """Last-chance teardown for a normal interpreter exit.

    A hard kill never reaches this — that path is the job object's job, which
    is the whole point of holding it.
    """
    try:
        ChildJob.instance().reap_all()
    except Exception:
        log.exception("atexit child reap failed")


# ── module-level facade (keeps the call sites one line) ──────────
def spawn(cmd: Any, *, kind: str, marker: Optional[str] = None, **popen_kwargs: Any):
    """See :meth:`ChildJob.spawn`."""
    return ChildJob.instance().spawn(cmd, kind=kind, marker=marker, **popen_kwargs)


def terminate_tree(pid: Any, timeout: float = _SWEEP_TERMINATE_TIMEOUT) -> bool:
    """Reap ``pid`` **and its descendants**; see :func:`_terminate_tree`.

    The public name exists because a spawn may return an intermediary rather
    than the process the work happens in: ``proc.terminate()`` on a ``cmd.exe``
    handle stops cmd, not the engine it started.
    """
    return _terminate_tree(pid, timeout)


def cage_descendants(pid: Any) -> list[int]:
    """See :meth:`ChildJob.cage_descendants`."""
    return ChildJob.instance().cage_descendants(pid)


def forget(pid: Any) -> None:
    """See :meth:`ChildJob.forget`."""
    ChildJob.instance().forget(pid)


def reap_all(timeout: float = _REAP_ALL_TIMEOUT) -> list[int]:
    """See :meth:`ChildJob.reap_all`."""
    return ChildJob.instance().reap_all(timeout=timeout)


def sweep_registry() -> list[int]:
    """See :meth:`ChildJob.sweep_registry`."""
    return ChildJob.instance().sweep_registry()


def registry_path() -> Path:
    """Where the spawn registry lives (exposed for diagnostics and tests)."""
    return _paths.child_processes_file()
