"""Repeatable scheduled update handoff. No builds, force kills or idle waits here."""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import time
from pathlib import Path

from .self_update import EXECUTABLES, UpdateStore, atomic_json, digest
from .update_executor import ProcessIdentity, UpdateExecutor
from .update_lock import FileMutex
from .update_native import NativeHost, alive, identity
from .update_preflight import verify_admission

COUNTDOWN = 60


def task_name(admin: Path) -> str:
    suffix = hashlib.sha256(str(admin.resolve()).casefold().encode()).hexdigest()[:12]
    return f"GAHub-Update-{suffix}"


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf8"))


def pinned(value: dict) -> ProcessIdentity:
    return ProcessIdentity(value["pid"], value["created"], Path(value["executable"]))


def ensure_installed(store: UpdateStore, admin_data: Path, desktop: Path) -> None:
    """Bootstrap the independent worker from this installation, never a URL."""
    import sys
    from .self_update import digest
    if os.name != "nt" or not getattr(sys, "frozen", False):
        return  # Developer/source installs retain the explicit installation flow.
    source = desktop.resolve().with_name("ga-hub-update.exe")
    installed = store.root / "bin/ga-hub-update.exe"
    # Never replace an executing worker or its task during an active handoff.
    if (store.root / "handoff.json").exists() and read_json(store.root / "handoff.json").get("state") in {"requested", "ready", "countdown", "switching"}:
        return
    if not source.is_file():
        raise ValueError("Bundled update helper is missing; extract the complete release ZIP")
    if installed.is_file() and digest(source) == digest(installed):
        return
    result = subprocess.run([str(source), "--admin-data", str(admin_data), "install"],
                            capture_output=True, encoding="utf-8", errors="replace", timeout=100,
                            creationflags=subprocess.CREATE_NO_WINDOW)
    if result.returncode:
        raise ValueError("Update worker installation failed: " + (result.stderr or result.stdout)[-1500:])
    if not installed.is_file() or digest(source) != digest(installed):
        raise ValueError("Installed update helper hash mismatch")


def request(store: UpdateStore, admin: Path, plan_id: str, old_pid: int) -> dict:
    """Prepare an immutable handoff request, then wake the installed fixed task."""
    with store.lock:
        plan = store.read()
        if plan.get("id") != plan_id or plan.get("state") != "prepared":
            raise ValueError("Update is not prepared")
        verify_admission(store, plan)
        old = identity(old_pid)
        if old.executable.name.lower() != EXECUTABLES[0]:
            raise ValueError("Old process is not the desktop")
        for name in EXECUTABLES:
            if not (old.executable.parent / name).is_file():
                raise ValueError("Old desktop pair is missing")
        path = store.root / "handoff.json"
        if path.exists():
            previous = read_json(path)
            if previous.get("state") in {"requested", "ready", "countdown"}:
                # Never overwrite a live worker, even for a newer plan.
                worker = previous.get("worker")
                if (worker and alive(pinned(worker))) or time.time() - previous["requested_at"] < 660:
                    raise ValueError("A handoff is already active")
        value = {"id": plan_id, "state": "requested", "requested_at": time.time(),
                 "old": {"pid": old.pid, "created": old.created, "executable": str(old.executable)},
                 "old_sha256": {n: digest(old.executable.parent / n) for n in EXECUTABLES}}
        atomic_json(path, value)
        try:
            subprocess.run(["schtasks", "/Run", "/TN", task_name(admin)],
                           check=True, capture_output=True, timeout=15)
        except (OSError, subprocess.SubprocessError):
            atomic_json(path, {**value, "state": "failed", "error": "Installed update task could not start"})
            raise ValueError("Install the fixed updater task before requesting a handoff") from None
        return value


def approve(store: UpdateStore, plan_id: str) -> dict:
    with store.lock:
        path = store.root / "handoff.json"
        value = read_json(path)
        if value.get("id") != plan_id or value.get("state") != "ready":
            raise ValueError("Independent worker is not ready")
        if not alive(pinned(value["worker"])) or not alive(pinned(value["old"])):
            raise ValueError("Worker or desktop identity changed")
        plan = store.read()
        if plan.get("id") != plan_id or plan.get("state") != "armed":
            raise ValueError("Update is not armed")
        value.update(state="countdown", not_before=time.time() + COUNTDOWN)
        atomic_json(path, value)
        return value


def close_normally(old: ProcessIdentity) -> None:
    """Request WM_CLOSE on exactly one GA-Hub window owned by the pinned PID."""
    import ctypes
    from ctypes import wintypes as w
    user = ctypes.WinDLL("user32", use_last_error=True)
    callback = ctypes.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)
    user.EnumWindows.argtypes = [callback, w.LPARAM]
    user.GetWindowThreadProcessId.argtypes = [w.HWND, ctypes.POINTER(w.DWORD)]
    user.GetWindowTextW.argtypes = [w.HWND, w.LPWSTR, ctypes.c_int]
    user.PostMessageW.argtypes = [w.HWND, w.UINT, w.WPARAM, w.LPARAM]
    windows = []

    @callback
    def inspect(hwnd, _):
        pid = w.DWORD()
        user.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value == old.pid:
            title = ctypes.create_unicode_buffer(512)
            user.GetWindowTextW(hwnd, title, 512)
            if title.value == "GA-Hub":
                windows.append(hwnd)
        return True

    if not user.EnumWindows(inspect, 0) or len(windows) != 1:
        raise ValueError(f"Ambiguous desktop window: {len(windows)}")
    if not alive(old) or not user.PostMessageW(windows[0], 0x10, 0, 0):
        raise ValueError("Normal desktop close request failed")


def worker(store: UpdateStore, admin: Path, *, approval_timeout: float = 600,
           sleep=time.sleep, clock=time.time, host_factory=NativeHost,
           close=close_normally) -> dict:
    """Same fixed task on every update; all variable input comes from handoff.json."""
    path = store.root / "handoff.json"
    marker = store.root / "maintenance.json"
    paused = False
    with FileMutex(store.root / "executor.lock"):
        with store.lock:
            value = read_json(path)
            if value.get("state") != "requested" or clock() - value["requested_at"] > approval_timeout:
                raise ValueError("No fresh handoff request")
            old = pinned(value["old"])
            me = identity(os.getpid())
            value["worker"] = {"pid": me.pid, "created": me.created, "executable": str(me.executable)}
            host = host_factory(store.root, admin)
            executor = UpdateExecutor(store, host)
        try:
            executor.arm(value["id"], old)
            with store.lock:
                value.update(state="ready")
                atomic_json(path, value)
            deadline = clock() + approval_timeout
            while True:
                with store.lock:
                    value = read_json(path)
                if value["state"] == "countdown":
                    delay = value["not_before"] - clock()
                    if delay > COUNTDOWN + 5:
                        raise ValueError("Invalid countdown")
                    sleep(max(0, delay))
                    break
                if clock() >= deadline or not alive(old):
                    raise ValueError("Approval expired or old desktop exited")
                sleep(.25)
            with store.lock:
                plan = store.read()
                if plan.get("id") != value["id"] or plan.get("state") != "armed":
                    raise ValueError("Update identity changed")
                verify_admission(store, plan)
                if not alive(old):
                    raise ValueError("Desktop identity changed before close")
                for name, expected in value["old_sha256"].items():
                    if digest(old.executable.parent / name) != expected:
                        raise ValueError("Old desktop pair changed")
                if marker.exists():
                    raise ValueError("Maintenance is already active")
                atomic_json(marker, {"id": value["id"], "worker": value["worker"]})
                paused = True
            close(old)
            result = executor.run(value["id"], exit_timeout=100, health_timeout=100)
            value.update(state=result["state"], error=result.get("error"))
            atomic_json(path, value)
            return result
        except Exception as exc:
            with store.lock:
                plan = store.read()
                if plan.get("id") == value["id"] and plan.get("state") == "armed":
                    store.transition(value["id"], {"armed"}, "failed", error=str(exc))
                value.update(state="failed", error=str(exc))
                atomic_json(path, value)
            raise
        finally:
            if paused:
                state = store.read().get("state")
                # Unresolved switch failures stay paused to avoid a competing launch.
                if state in {"succeeded", "rolled_back"} or alive(old):
                    marker.unlink(missing_ok=True)
