"""Regression tests for cross-platform desktop notifications."""
from __future__ import annotations

import subprocess
import unittest
from unittest import mock

from server.services import notify_service as notify


class NotifyServiceTests(unittest.TestCase):
    def test_spawn_reports_nonzero_exit_as_failure(self):
        proc = mock.Mock()
        proc.wait.return_value = 7
        proc.returncode = 7

        with mock.patch.object(notify.subprocess, "Popen", return_value=proc):
            self.assertFalse(notify._spawn(["notifier"], wait_sec=1))

        proc.wait.assert_called_once_with(timeout=1)

    def test_windows_uses_topmost_popup_and_checks_startup(self):
        with (
            mock.patch.object(notify.shutil, "which", return_value=r"C:\\Windows\\powershell.exe"),
            mock.patch.object(notify, "_spawn", return_value=True) as spawn,
        ):
            self.assertTrue(notify._send_windows("Title", "Body"))

        spawn.assert_called_once()
        command = spawn.call_args.args[0]
        script = command[-1]
        self.assertIn("TopMost", script)
        self.assertIn("Application]::Run", script)
        self.assertEqual(spawn.call_args.kwargs["wait_sec"], 1)

    def test_windows_popup_safely_quotes_apostrophes(self):
        with (
            mock.patch.object(notify.shutil, "which", return_value=r"C:\\Windows\\powershell.exe"),
            mock.patch.object(notify, "_spawn", return_value=True) as spawn,
        ):
            notify._send_windows("Bob's run", "it's ready")

        script = spawn.call_args.args[0][-1]
        self.assertIn("'Bob''s run'", script)
        self.assertIn("'it''s ready'", script)

    def test_windows_popup_click_restores_and_activates_gahub(self):
        with (
            mock.patch.object(notify.shutil, "which", return_value=r"C:\\Windows\\powershell.exe"),
            mock.patch.object(notify, "_spawn", return_value=True) as spawn,
        ):
            notify._send_windows("Title", "Body")

        script = spawn.call_args.args[0][-1]
        self.assertIn("GenericAgent", script)
        self.assertIn("GA-Hub", script)
        self.assertIn("ShowWindowAsync", script)
        self.assertIn("BringWindowToTop", script)
        self.assertIn("SetForegroundWindow", script)
        self.assertIn('FindWindow("Tauri Window", "GenericAgent")', script)
        self.assertLess(
            script.index('FindWindow("Tauri Window", "GenericAgent")'),
            script.index('-like "GA-Hub*"'),
        )
        self.assertIn("$form.Add_Click", script)
        self.assertIn("$titleLabel.Add_Click", script)
        self.assertIn("$bodyLabel.Add_Click", script)


if __name__ == "__main__":
    unittest.main()
