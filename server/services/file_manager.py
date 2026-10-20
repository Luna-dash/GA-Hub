"""Reuse one Explorer window per Hub process, without adopting user windows.

COM proxies never cross threads/apartments. Only the owned HWND and pending
launch snapshot survive a call. A slow launch is retained, never retried by
spawning more windows on subsequent clicks.
"""
from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path
from threading import Lock


class ExplorerWindow:
    def __init__(self):
        self._lock = Lock()
        self._hwnd: int | None = None
        self._pending: tuple[set[int], Path] | None = None

    def reveal(self, path: Path) -> None:
        # Bounded admission also exists at the route; serialize COM navigation.
        if not self._lock.acquire(timeout=8):
            raise OSError("file manager is busy")
        try:
            import pythoncom
            from win32com.client import dynamic

            pythoncom.CoInitialize()
            shell = None
            try:
                shell = dynamic.Dispatch("Shell.Application")
                self._reveal(shell, path)
            except Exception as exc:
                raise OSError("file manager navigation failed; please retry") from exc
            finally:
                # Release apartment-owned proxies before COM teardown.
                shell = None
                pythoncom.CoUninitialize()
        finally:
            self._lock.release()

    @staticmethod
    def _windows(shell):
        result = {}
        for window in shell.Windows():
            try:
                if Path(window.FullName).name.lower() == "explorer.exe":
                    result[int(window.HWND)] = window
            except Exception:
                # Explorer can unregister a closed window during enumeration.
                continue
        return result

    @staticmethod
    def _folder(window) -> str:
        return os.path.normcase(os.path.normpath(window.Document.Folder.Self.Path))

    def _reveal(self, shell, path: Path) -> None:
        folder = path if path.is_dir() else path.parent
        expected = os.path.normcase(os.path.normpath(str(folder)))
        windows = self._windows(shell)
        window = windows.get(self._hwnd)
        if window is None:
            self._hwnd = None
            if self._pending is None:
                # /n requests a new window even when this directory is already
                # open. Only newly registered HWNDs may subsequently be owned.
                before = set(windows)
                subprocess.Popen(f'explorer.exe /n,"{folder}"')
                self._pending = (before, folder)
            before, launched_folder = self._pending
            launched = os.path.normcase(os.path.normpath(str(launched_folder)))
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                for hwnd, candidate in self._windows(shell).items():
                    try:
                        if hwnd not in before and self._folder(candidate) == launched:
                            self._hwnd, window = hwnd, candidate
                            self._pending = None
                            break
                    except Exception:
                        continue
                if window is not None:
                    break
                time.sleep(.05)
            if window is None:
                raise OSError("file manager is still opening; please retry")

        if self._folder(window) != expected:
            window.Navigate2(str(folder))
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                if self._folder(window) == expected:
                    if path != folder:
                        item = window.Document.Folder.ParseName(path.name)
                        if item is None:
                            raise OSError("file is not visible in its folder")
                        # SELECT | DESELECTOTHERS | ENSUREVISIBLE | FOCUSED
                        window.Document.SelectItem(item, 1 | 4 | 8 | 16)
                    self._activate(self._hwnd)
                    return
            except Exception:
                # Navigation replaces Document asynchronously.
                pass
            time.sleep(.05)
        raise OSError("file manager is still navigating; please retry")

    @staticmethod
    def _activate(hwnd):
        import win32con
        import win32gui

        if win32gui.IsIconic(hwnd):
            win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        # A request runs on a worker thread, not the foreground UI thread.
        # First use the ordinary API; only borrow the foreground input queue
        # when Windows refuses it. Never change global focus-lock settings.
        try:
            win32gui.SetForegroundWindow(hwnd)
        except Exception:
            pass
        if win32gui.GetForegroundWindow() == hwnd:
            return

        import win32api
        import win32process

        current_thread = win32api.GetCurrentThreadId()
        foreground = win32gui.GetForegroundWindow()
        foreground_thread = (win32process.GetWindowThreadProcessId(foreground)[0]
                             if foreground else 0)
        attached = False
        try:
            if foreground_thread and foreground_thread != current_thread:
                win32process.AttachThreadInput(current_thread, foreground_thread, True)
                attached = True
            win32gui.BringWindowToTop(hwnd)
            win32gui.SetForegroundWindow(hwnd)
        except Exception:
            pass
        finally:
            if attached:
                try:
                    win32process.AttachThreadInput(current_thread, foreground_thread, False)
                except Exception:
                    pass
        # Focus remains subject to Windows policy (e.g. another desktop).
        if win32gui.GetForegroundWindow() != hwnd:
            win32gui.FlashWindow(hwnd, True)


explorer_window = ExplorerWindow()
