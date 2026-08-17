"""Black-box lifecycle tests for the Tauri-owned Python sidecar."""
from __future__ import annotations
import io
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from threading import Event, Thread
from unittest.mock import patch
from urllib.request import urlopen

from server import desktop_sidecar

ROOT = Path(__file__).resolve().parents[1]
PACKAGED_SIDECAR = (
    ROOT / "src-tauri" / "binaries" / "ga-hub-sidecar-x86_64-pc-windows-msvc.exe"
)


class OwnerStdinReaderTests(unittest.TestCase):
    def test_waiting_for_owner_does_not_lock_buffered_stdin(self) -> None:
        read_fd, write_fd = os.pipe()
        raw = os.fdopen(read_fd, "rb", buffering=0)
        buffered = io.BufferedReader(raw)
        stdin = io.TextIOWrapper(buffered, encoding="utf-8")
        server = type("Server", (), {"should_exit": False})()
        reader = Thread(target=desktop_sidecar._stdin_shutdown, args=(server,), daemon=True)
        fileno_called = Event()
        probe_done = Event()

        class ObservedStdin:
            buffer = stdin.buffer

            def fileno(self) -> int:
                fileno_called.set()
                return stdin.fileno()

        try:
            with patch.object(desktop_sidecar.sys, "stdin", ObservedStdin()):
                reader.start()
                self.assertTrue(fileno_called.wait(1))

                def probe_buffer() -> None:
                    stdin.buffer.read(0)
                    probe_done.set()

                probe = Thread(target=probe_buffer, daemon=True)
                probe.start()
                self.assertTrue(
                    probe_done.wait(1),
                    "owner-pipe wait must not monopolise BufferedReader's lock",
                )
                os.write(write_fd, b"\n")
                reader.join(1)
                probe.join(1)
        finally:
            os.close(write_fd)
            stdin.close()

        self.assertFalse(reader.is_alive())
        self.assertTrue(server.should_exit)


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

    @unittest.skipUnless(PACKAGED_SIDECAR.is_file(), "packaged Windows sidecar is not staged")
    def test_packaged_sidecar_preserves_owner_stdin_shutdown(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        ga = base / "invalid-ga"
        ga.mkdir()
        env = os.environ.copy()
        env.update({"GA_ROOT": str(ga), "GA_ADMIN_DATA": str(base / "admin-data")})
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = int(probe.getsockname()[1])
        self.proc = subprocess.Popen(
            [
                str(PACKAGED_SIDECAR),
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
                "--instance-token",
                "packaged-test-token",
            ],
            cwd=PACKAGED_SIDECAR.parent,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        deadline = time.monotonic() + 45
        while True:
            if self.proc.poll() is not None:
                self.fail(f"packaged sidecar exited before readiness: {self.proc.returncode}")
            try:
                with urlopen(f"http://127.0.0.1:{port}/api/desktop/ready", timeout=1) as response:
                    ready = json.load(response)
                break
            except Exception:
                if time.monotonic() >= deadline:
                    self.fail("packaged sidecar did not become ready")
                time.sleep(0.1)
        self.assertEqual(ready["instance_token"], "packaged-test-token")
        self.proc.stdin.write(b"\n")
        self.proc.stdin.flush()
        self.assertEqual(self.proc.wait(timeout=15), 0)


if __name__ == "__main__":
    unittest.main()
