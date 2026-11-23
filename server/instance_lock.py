"""Cross-mode OS file mutex guarding one ADMIN_DATA directory.

Both ``server.run`` (browser/CLI mode) and ``server.desktop_sidecar`` (Tauri
desktop mode) mutate the same ``ADMIN_DATA`` directory, run background
schedulers, and sweep orphaned child processes on startup. Port-based socket
locks cannot prevent two launchers on different ports from corrupting the same
data directory, and ``SO_REUSEADDR`` on Windows allows duplicate binds.

Byte 0 holds the non-blocking OS lock; bytes 1+ store the owning PID in plain
ASCII so a competing process on Windows (where byte-range locks are mandatory)
can still read and report the holder PID without touching the locked byte.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import BinaryIO


class AdminDataLockBusyError(RuntimeError):
    def __init__(self, lock_path: Path, holder_pid: int | None = None) -> None:
        self.lock_path = lock_path
        self.holder_pid = holder_pid
        owner = f"PID {holder_pid}" if holder_pid else "another GA-Hub backend process"
        super().__init__(
            f"GA-Hub data directory is already in use by {owner} ({lock_path}). "
            "Close the running desktop app or CLI server before starting a second instance."
        )


def _read_holder_pid(handle: BinaryIO) -> int | None:
    try:
        handle.seek(1)
        raw = handle.read(64).decode("ascii", errors="ignore").strip()
        return int(raw) if raw.isdigit() else None
    except OSError:
        return None


def acquire_admin_data_lock(admin_data: Path) -> BinaryIO:
    """Acquire a non-blocking exclusive lock on ``admin_data / 'hub-backend.lock'``."""
    lock_path = admin_data.resolve() / "hub-backend.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    handle = open(lock_path, "a+b")
    try:
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
        handle.seek(0)
        if os.name == "nt":
            import msvcrt

            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as exc:
        holder_pid = _read_holder_pid(handle)
        handle.close()
        raise AdminDataLockBusyError(lock_path, holder_pid) from exc

    handle.seek(1)
    handle.truncate(1)
    handle.write(f"{os.getpid()}\n".encode("ascii"))
    handle.flush()
    return handle


def release_admin_data_lock(handle: BinaryIO | None) -> None:
    """Release a previously acquired ``hub-backend.lock`` handle."""
    if handle is None or handle.closed:
        return
    try:
        handle.seek(0)
        if os.name == "nt":
            import msvcrt

            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    except OSError:
        pass
    finally:
        handle.close()
