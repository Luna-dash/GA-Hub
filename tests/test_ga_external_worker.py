"""Unit tests for ``server.services.ga_external_worker._ExternalGaWebTools``.

These tests exercise the IPC layer in isolation by replacing
``subprocess.Popen`` with a fake that emulates a long-lived JSON-protocol
child process. They protect against regressions like the missing
``import time`` import that the original in-line implementation hid behind
mocked tests.
"""
from __future__ import annotations

import io
import json
import logging
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from server.services import ga_external_worker as gew


class _FakeStdin:
    def __init__(self) -> None:
        self.lines: list[str] = []
        self.flushed = False

    def write(self, data: str) -> int:
        self.lines.append(data)
        return len(data)

    def flush(self) -> None:
        self.flushed = True

    def close(self) -> None:
        pass


class _FakeProc:
    """Minimal Popen stand-in that replays a scripted stdout sequence."""

    def __init__(self, stdout_lines: list[str], stderr_lines: list[str] | None = None,
                 exit_code: int | None = None) -> None:
        self.stdin = _FakeStdin()
        self.stdout = io.StringIO("".join(stdout_lines))
        self.stderr = io.StringIO("".join(stderr_lines or []))
        self.returncode: int | None = exit_code
        self.pid = 4242
        self.killed = False

    def poll(self) -> int | None:
        return self.returncode

    def kill(self) -> None:
        self.killed = True
        if self.returncode is None:
            self.returncode = -9


class ExternalGaWebToolsTests(unittest.TestCase):
    def _patch_popen(self, factory):
        return mock.patch.object(gew.subprocess, "Popen", side_effect=factory)

    def test_call_returns_worker_result(self):
        # Pre-seed exactly one response so the reader thread delivers it.
        proc = _FakeProc([
            json.dumps({"id": "REQ", "ok": True, "result": {"status": "ok", "tabs": []}}) + "\n",
        ])

        def factory(*_args, **_kwargs):
            return proc

        worker = gew._ExternalGaWebTools("/tmp/py", Path("/tmp/ga"), timeout=2.0)
        # Force deterministic id so the in-memory exchange matches.
        with self._patch_popen(factory), \
             mock.patch.object(gew.uuid, "uuid4", return_value=mock.Mock(hex="REQ")):
            result = worker.call("web_scan", {"tabs_only": True})

        self.assertEqual(result, {"status": "ok", "tabs": []})
        # Sanity-check the JSON request that was streamed to stdin.
        sent = json.loads(proc.stdin.lines[0])
        self.assertEqual(sent, {"id": "REQ", "tool": "web_scan", "args": {"tabs_only": True}})
        self.assertTrue(proc.stdin.flushed)

    def test_call_uses_time_module_for_timeout(self):
        # Empty stdout means no response will ever arrive; the call must
        # rely on ``time.time()`` and ``self._cond.wait`` to bail out.
        # Regression guard: prior refactor lost ``import time`` and would
        # raise ``NameError`` here instead of returning a structured error.
        proc = _FakeProc([])

        def factory(*_args, **_kwargs):
            return proc

        worker = gew._ExternalGaWebTools("/tmp/py", Path("/tmp/ga"), timeout=0.05)
        with self._patch_popen(factory):
            result = worker.call("web_scan", {})

        self.assertEqual(result.get("status"), "error")
        self.assertIn("timed out", result.get("msg", ""))
        self.assertTrue(proc.killed)

    def test_call_detects_early_worker_exit(self):
        # Worker reports a non-zero exit before any response is queued.
        proc = _FakeProc([], exit_code=2)

        def factory(*_args, **_kwargs):
            return proc

        worker = gew._ExternalGaWebTools("/tmp/py", Path("/tmp/ga"), timeout=1.0)
        with self._patch_popen(factory):
            result = worker.call("web_execute_js", {"script": "return 1"})

        self.assertEqual(result.get("status"), "error")
        self.assertIn("exited before responding", result.get("msg", ""))

    def test_first_stderr_line_logged_at_warning(self):
        # Drive ``_read_stderr`` directly so we don't need a real subprocess.
        proc = _FakeProc(
            stdout_lines=[],
            stderr_lines=[
                "ImportError: GA deps missing\n",
                "Traceback frame 2\n",
            ],
        )
        worker = gew._ExternalGaWebTools("/tmp/py", Path("/tmp/ga"))
        with self.assertLogs(gew.log, level="DEBUG") as captured:
            worker._read_stderr(proc)

        warnings = [r for r in captured.records if r.levelno == logging.WARNING]
        debugs = [r for r in captured.records if r.levelno == logging.DEBUG]
        self.assertEqual(len(warnings), 1)
        self.assertIn("ImportError: GA deps missing", warnings[0].getMessage())
        self.assertEqual(len(debugs), 1)
        self.assertIn("Traceback frame 2", debugs[0].getMessage())


if __name__ == "__main__":
    unittest.main()
