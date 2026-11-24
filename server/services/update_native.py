"""Native external updater adapter. Never terminates the old desktop.

Detached flags alone are not proof of independence. An unrestricted scheduler
Job is accepted only after exclusion from every live desktop-owned Job.
"""
from __future__ import annotations

import ctypes
import json
import os
import secrets
import subprocess
import time
import urllib.request
from pathlib import Path

import psutil

from .self_update import atomic_json
from .update_executor import ProcessIdentity


def _process_identity(process: psutil.Process) -> ProcessIdentity:
    return ProcessIdentity(process.pid, str(process.create_time()), Path(process.exe()).resolve())


def identity(pid: int) -> ProcessIdentity:
    return _process_identity(psutil.Process(pid))


def _matching_process(value: ProcessIdentity) -> psutil.Process | None:
    try:
        process = psutil.Process(value.pid)
        if (_process_identity(process) == value and process.is_running()
                and process.status() != psutil.STATUS_ZOMBIE):
            return process
    except psutil.NoSuchProcess:
        pass
    # AccessDenied is NOT proof of exit.
    return None


def alive(value: ProcessIdentity) -> bool:
    return _matching_process(value) is not None


def _observe_children(value: ProcessIdentity, observed: set[ProcessIdentity]) -> bool:
    try:
        parent = _matching_process(value)
        if parent is None:
            return True
        children = parent.children(recursive=True)
    except psutil.NoSuchProcess:
        return True
    except psutil.AccessDenied:
        return False
    complete = True
    for child in children:
        try:
            pinned = _process_identity(child)
            if child.is_running():
                observed.add(pinned)
        except psutil.NoSuchProcess:
            # A transient child exiting does not invalidate its siblings.
            continue
        except psutil.AccessDenied:
            complete = False
    return complete


def _terminate_owned(value: ProcessIdentity) -> None:
    try:
        process = _matching_process(value)
        if process is not None:
            process.terminate()  # psutil also checks PID reuse on this instance.
    except psutil.NoSuchProcess:
        pass


def outside_job() -> bool:
    if os.name != "nt":
        return True
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.IsProcessInJob.argtypes = [wintypes.HANDLE, wintypes.HANDLE, ctypes.POINTER(wintypes.BOOL)]
    kernel.IsProcessInJob.restype = wintypes.BOOL
    inside = wintypes.BOOL()
    if not kernel.IsProcessInJob(kernel.GetCurrentProcess(), None, ctypes.byref(inside)):
        raise ctypes.WinError(ctypes.get_last_error())
    if not inside.value:
        return True
    from .update_job import safe_scheduler_job
    return safe_scheduler_job()


def desktop_environment(admin_data: Path) -> dict[str, str]:
    env = os.environ.copy()
    for name in ("GA_HUB_SIDECAR", "GA_HUB_PYTHON", "GA_HUB_BRIDGE_PORT",
                 "GA_HUB_UPDATE_NONCE", "GA_HUB_UPDATE_RECEIPT"):
        env.pop(name, None)
    env["GA_ADMIN_DATA"] = str(admin_data.resolve())
    return env


class NativeHost:
    def __init__(self, root: Path, admin_data: Path):
        self.root = root.resolve()
        self.admin_data = admin_data.resolve()
        self.children: set[ProcessIdentity] = set()
        self.started: dict[ProcessIdentity, subprocess.Popen] = {}
        self.receipt: Path | None = None
        self.nonce = ""
        self.candidate_children: dict[ProcessIdentity, set[ProcessIdentity]] = {}
        self.incomplete_candidates: set[ProcessIdentity] = set()

    def independent(self) -> bool:
        return outside_job()

    def validate_old(self, value: ProcessIdentity) -> None:
        if not alive(value):
            raise ValueError("Old desktop identity no longer matches")
        if value.pid == os.getpid():
            raise ValueError("Updater cannot update itself")
        # Snapshot exact child identities while old desktop is alive. Its Job
        # must release the backend before a candidate can share the data dir.
        self.children.clear()
        if not _observe_children(value, self.children):
            raise ValueError("Cannot verify old desktop descendants")

    def wait_old_exit(self, value: ProcessIdentity, timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if not _observe_children(value, self.children):
                return False
            if not alive(value) and not any(alive(p) for p in self.children):
                return True
            time.sleep(.2)
        return False

    def start(self, executable: Path, plan_id: str) -> ProcessIdentity:
        self.nonce = secrets.token_hex(32)
        self.receipt = self.root / "receipts" / f"{plan_id}-{self.nonce}.json"
        env = desktop_environment(self.admin_data)
        env.update(GA_ADMIN_DATA=str(self.admin_data), GA_HUB_UPDATE_NONCE=self.nonce,
                   GA_HUB_UPDATE_RECEIPT=str(self.receipt))
        process = subprocess.Popen([str(executable)], cwd=executable.parent, env=env,
                                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, close_fds=True)
        value = identity(process.pid)
        self.started[value] = process
        self.candidate_children[value] = set()
        atomic_json(self.root / "candidate-process.json", {
            "plan_id": plan_id, "pid": value.pid, "created": value.created,
            "executable": str(value.executable), "receipt": str(self.receipt), "nonce": self.nonce,
        })
        return value

    def healthy(self, value: ProcessIdentity, plan: dict, timeout: float) -> bool:
        return self._ready(value, timeout, allow_diagnostics=False)

    def rollback_ready(self, value: ProcessIdentity, plan: dict, timeout: float) -> bool:
        return self._ready(value, timeout, allow_diagnostics=True)

    def _observe_candidate(self, value: ProcessIdentity) -> None:
        children = self.candidate_children.setdefault(value, set())
        if not _observe_children(value, children):
            self.incomplete_candidates.add(value)

    def _ready(self, value: ProcessIdentity, timeout: float, *, allow_diagnostics: bool) -> bool:
        deadline = time.monotonic() + timeout
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        while time.monotonic() < deadline and alive(value):
            try:
                self._observe_candidate(value)
                data = json.loads(self.receipt.read_text(encoding="utf8"))
                if (data["nonce"] != self.nonce or data["pid"] != value.pid
                        or Path(data["executable"]).resolve() != value.executable):
                    return False
                port = data["port"]
                if type(port) is not int or not 1 <= port <= 65535:
                    return False
                request = urllib.request.Request(f"http://127.0.0.1:{port}/api/updates/ready",
                                                 headers={"X-Update-Nonce": self.nonce})
                with opener.open(request, timeout=1) as response:
                    report = json.load(response)
                backend = identity(report["pid"])
                self._observe_candidate(value)
                ancestors = {p.pid for p in psutil.Process(backend.pid).parents()}
                ready = report["ready"] is True or (
                    allow_diagnostics and report.get("diagnostic_ready") is True
                )
                if (report["nonce"] == self.nonce and ready
                        and Path(report["admin_data"]).resolve() == self.admin_data
                        and Path(report["executable"]).resolve() == backend.executable
                        and backend.executable.parent == value.executable.parent
                        and backend.executable.name == "ga-hub-sidecar.exe"
                        and value.pid in ancestors and alive(value)):
                    return True
            except (OSError, ValueError, KeyError, TypeError, psutil.Error):
                pass
            time.sleep(.2)
        return False

    def stop_candidate(self, value: ProcessIdentity, timeout: float) -> bool:
        # Never infer ownership from a numeric PID alone.
        children = self.candidate_children.get(value)
        process = self.started.get(value)
        if children is None or process is None:
            return False
        # Refresh before terminating the root; already-observed children may
        # have been reparented if the desktop crashed during readiness checks.
        self._observe_candidate(value)
        for child in tuple(children):
            if not _observe_children(child, children):
                self.incomplete_candidates.add(value)
        for target in (value, *children):
            try:
                _terminate_owned(target)
            except psutil.AccessDenied:
                # Still attempt all other known targets and verify exits below.
                continue
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            process.poll()
            try:
                if not alive(value) and not any(alive(child) for child in children):
                    return value not in self.incomplete_candidates
            except psutil.AccessDenied:
                pass
            time.sleep(.1)
        return False

    def restore(self, executable: Path, plan_id: str) -> ProcessIdentity:
        # Restore uses the same nonce/PID/path/admin-data health proof as update.
        return self.start(executable, plan_id + "-rollback")
