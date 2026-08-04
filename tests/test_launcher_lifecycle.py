"""Process-lifecycle contracts for the desktop launcher.

The launcher is loaded explicitly because its production entrypoint uses the
``.pyw`` suffix and must not execute ``main()`` during unit tests.
"""
from __future__ import annotations

import importlib.machinery
import importlib.util
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]


def _load_launcher():
    path = ROOT / "launch_webui.pyw"
    loader = importlib.machinery.SourceFileLoader("launch_webui_under_test", str(path))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[loader.name] = module
    loader.exec_module(module)
    return module


launcher = _load_launcher()


class LauncherLifecycleTests(unittest.TestCase):
    def test_safe_term_stops_after_graceful_exit(self) -> None:
        proc = mock.Mock()

        launcher._safe_term(proc)

        proc.terminate.assert_called_once_with()
        proc.wait.assert_called_once_with(timeout=3)
        proc.kill.assert_not_called()

    def test_safe_term_escalates_after_timeout(self) -> None:
        proc = mock.Mock()
        proc.wait.side_effect = subprocess.TimeoutExpired(cmd="backend", timeout=3)

        launcher._safe_term(proc)

        proc.terminate.assert_called_once_with()
        proc.kill.assert_called_once_with()

    def test_windows_kill_pid_reports_taskkill_failure(self) -> None:
        failed = subprocess.CompletedProcess(args=["taskkill"], returncode=1)
        with (
            mock.patch.object(launcher.os, "name", "nt"),
            mock.patch.object(launcher.os, "getpid", return_value=999),
            mock.patch.object(launcher.subprocess, "run", return_value=failed) as run,
        ):
            killed = launcher._kill_pid(123)

        self.assertFalse(killed)
        run.assert_called_once()

    def test_kill_pid_never_targets_launcher_itself(self) -> None:
        with (
            mock.patch.object(launcher.os, "getpid", return_value=123),
            mock.patch.object(launcher.subprocess, "run") as run,
        ):
            killed = launcher._kill_pid(123)

        self.assertFalse(killed)
        run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
