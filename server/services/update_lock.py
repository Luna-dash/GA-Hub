"""Reentrant thread + OS file locks shared by API and external updater."""
from __future__ import annotations

import os
import threading
import time
from pathlib import Path


class FileMutex:
    def __init__(self, path: Path, timeout: float = 10):
        self.path, self.timeout = path, timeout
        self._thread = threading.RLock()
        self._depth = 0
        self._file = None

    def __enter__(self):
        self._thread.acquire()
        try:
            if not self._depth:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                file = open(self.path, "a+b")
                if not file.tell():
                    file.write(b"\0")
                    file.flush()
                deadline = time.monotonic() + self.timeout
                while True:
                    try:
                        file.seek(0)
                        if os.name == "nt":
                            import msvcrt
                            msvcrt.locking(file.fileno(), msvcrt.LK_NBLCK, 1)
                        else:
                            import fcntl
                            fcntl.flock(file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                        break
                    except OSError:
                        if time.monotonic() >= deadline:
                            file.close()
                            raise TimeoutError(f"Updater lock busy: {self.path}")
                        time.sleep(.05)
                self._file = file
            self._depth += 1
            return self
        except BaseException:
            self._thread.release()
            raise

    def __exit__(self, *_):
        try:
            self._depth -= 1
            if not self._depth:
                file, self._file = self._file, None
                try:
                    file.seek(0)
                    if os.name == "nt":
                        import msvcrt
                        msvcrt.locking(file.fileno(), msvcrt.LK_UNLCK, 1)
                    else:
                        import fcntl
                        fcntl.flock(file.fileno(), fcntl.LOCK_UN)
                finally:
                    file.close()
        finally:
            self._thread.release()
