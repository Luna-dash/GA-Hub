"""Black-box lifecycle tests for the Tauri-owned Python sidecar."""
from __future__ import annotations
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]


class DesktopSidecarTests(unittest.TestCase):
    def _spawn(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        ga = base / "invalid-ga"
        ga.mkdir()
        env = os.environ.copy()
        env.update({"GA_ROOT": str(ga), "GA_ADMIN_DATA": str(base / "admin-data"), "PYTHONUNBUFFERED": "1"})
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "server.desktop_sidecar", "--port", "0", "--instance-token", "test-token"],
            cwd=ROOT, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace",
        )
        line = self.proc.stdout.readline()
        if not line:
            _, stderr = self.proc.communicate(timeout=10)
            self.fail(
                "sidecar exited before emitting its lifecycle event "
                f"(code={self.proc.returncode}, executable={sys.executable!r}, stderr={stderr!r})"
            )
        self.event = json.loads(line)

    def tearDown(self) -> None:
        proc = getattr(self, "proc", None)
        if proc is not None:
            if proc.poll() is None:
                proc.kill()
            proc.communicate(timeout=10)
        temp = getattr(self, "temp", None)
        if temp is not None:
            temp.cleanup()

    def test_ready_identity_and_graceful_stdin_shutdown(self) -> None:
        self._spawn()
        self.assertEqual(self.event["event"], "starting")
        self.assertEqual(self.event["instance_token"], "test-token")
        self.assertGreater(self.event["port"], 0)
        deadline = time.monotonic() + 20
        while True:
            try:
                with urlopen(f"http://127.0.0.1:{self.event['port']}/api/desktop/ready", timeout=1) as response:
                    ready = json.load(response)
                break
            except Exception:
                if time.monotonic() >= deadline:
                    self.fail("sidecar did not become ready")
                time.sleep(0.1)
        self.assertEqual(ready["instance_token"], "test-token")
        self.proc.stdin.write("\n")
        self.proc.stdin.flush()
        self.assertEqual(self.proc.wait(timeout=10), 0)
        remaining = [json.loads(line) for line in self.proc.stdout if line.startswith("{")]
        self.assertTrue(any(item.get("event") == "stopped" and item.get("graceful") for item in remaining))

    def test_invalid_non_loopback_bind_is_rejected(self) -> None:
        result = subprocess.run(
            [sys.executable, "-m", "server.desktop_sidecar", "--host", "0.0.0.0"],
            cwd=ROOT, capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("loopback", result.stderr)


if __name__ == "__main__":
    unittest.main()
