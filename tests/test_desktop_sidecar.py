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
from unittest.mock import Mock, patch
from urllib.request import urlopen

from server import desktop_sidecar

ROOT = Path(__file__).resolve().parents[1]
SIDECAR_SOURCE = ROOT / "server" / "desktop_sidecar.py"
PACKAGED_SIDECAR = (
    ROOT / "src-tauri" / "binaries" / "ga-hub-sidecar-x86_64-pc-windows-msvc.exe"
)


def _current_packaged_sidecar_is_staged() -> bool:
    try:
        return (
            PACKAGED_SIDECAR.is_file()
            and PACKAGED_SIDECAR.stat().st_mtime_ns >= SIDECAR_SOURCE.stat().st_mtime_ns
        )
    except OSError:
        return False


class OwnerStdinReaderTests(unittest.TestCase):
    def test_waiting_for_owner_does_not_lock_buffered_stdin(self) -> None:
        read_fd, write_fd = os.pipe()
        raw = os.fdopen(read_fd, "rb", buffering=0)
        buffered = io.BufferedReader(raw)
        stdin = io.TextIOWrapper(buffered, encoding="utf-8")
        server = type("Server", (), {"should_exit": False})()
        fileno_called = Event()
        probe_done = Event()

        class ObservedStdin:
            buffer = stdin.buffer

            def fileno(self) -> int:
                fileno_called.set()
                return stdin.fileno()

        try:
            with (
                patch.object(desktop_sidecar.sys, "stdin", ObservedStdin()),
                patch.object(desktop_sidecar, "_emit"),
            ):
                fd = desktop_sidecar._owner_stdin_fd()
                reader = Thread(
                    target=desktop_sidecar._stdin_shutdown,
                    args=(server, fd),
                    daemon=True,
                )
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

    def test_owner_pipe_eof_requests_shutdown(self) -> None:
        read_fd, write_fd = os.pipe()
        reader_fd = os.dup(read_fd)
        server = type("Server", (), {"should_exit": False})()
        arm_hard_exit = Mock()
        reader = Thread(
            target=desktop_sidecar._stdin_shutdown,
            args=(server, reader_fd, arm_hard_exit),
            daemon=True,
        )
        try:
            with patch.object(desktop_sidecar, "_emit") as emit:
                reader.start()
                os.close(write_fd)
                write_fd = -1
                reader.join(1)
            self.assertFalse(reader.is_alive())
            self.assertTrue(server.should_exit)
            arm_hard_exit.assert_called_once_with()
            emit.assert_called_once_with("shutdown_requested", reason="owner_eof")
        finally:
            if write_fd >= 0:
                os.close(write_fd)
            os.close(read_fd)

    def test_owner_pipe_read_error_arms_hard_exit(self) -> None:
        read_fd, write_fd = os.pipe()
        server = type("Server", (), {"should_exit": False})()
        arm_hard_exit = Mock()
        os.close(read_fd)

        try:
            with patch.object(desktop_sidecar, "_emit") as emit:
                desktop_sidecar._stdin_shutdown(server, read_fd, arm_hard_exit)
        finally:
            os.close(write_fd)

        self.assertTrue(server.should_exit)
        arm_hard_exit.assert_called_once_with()
        emit.assert_called_once()
        self.assertEqual(emit.call_args.args, ("shutdown_requested",))
        self.assertEqual(emit.call_args.kwargs["reason"], "owner_stdin_error")
        self.assertTrue(emit.call_args.kwargs["detail"])

    def test_owner_shutdown_byte_does_not_arm_hard_exit(self) -> None:
        read_fd, write_fd = os.pipe()
        reader_fd = os.dup(read_fd)
        server = type("Server", (), {"should_exit": False})()
        arm_hard_exit = Mock()

        try:
            os.write(write_fd, b"x")
            with patch.object(desktop_sidecar, "_emit") as emit:
                desktop_sidecar._stdin_shutdown(server, reader_fd, arm_hard_exit)
        finally:
            os.close(write_fd)
            os.close(read_fd)

        self.assertTrue(server.should_exit)
        arm_hard_exit.assert_not_called()
        emit.assert_called_once_with("shutdown_requested", reason="owner_stdin")

    def test_owner_exit_watchdog_enforces_deadline(self) -> None:
        hard_exit_called = Event()

        watchdog = desktop_sidecar._start_owner_exit_watchdog(
            timeout_seconds=0.01,
            hard_exit=hard_exit_called.set,
        )

        self.assertTrue(hard_exit_called.wait(1))
        watchdog.join(1)
        self.assertFalse(watchdog.is_alive())

    @unittest.skipUnless(os.name == "nt", "Windows hard-exit fallback only")
    def test_windows_watchdog_falls_back_to_process_exit(self) -> None:
        with patch.object(desktop_sidecar.os, "_exit") as hard_exit:
            desktop_sidecar._hard_exit_owned_process_group()

        hard_exit.assert_called_once_with(desktop_sidecar.OWNER_HARD_EXIT_CODE)

    @unittest.skipUnless(os.name == "posix", "POSIX process-group behavior only")
    def test_posix_watchdog_kills_only_an_isolated_process_group(self) -> None:
        with (
            patch.object(desktop_sidecar.os, "getpid", return_value=1234),
            patch.object(desktop_sidecar.os, "getpgrp", return_value=1234),
            patch.object(desktop_sidecar.os, "killpg") as kill_group,
            patch.object(desktop_sidecar.os, "_exit") as hard_exit,
        ):
            desktop_sidecar._hard_exit_owned_process_group()

        kill_group.assert_called_once_with(1234, desktop_sidecar.signal.SIGKILL)
        hard_exit.assert_not_called()

    def test_owned_mode_rejects_missing_stdin_before_startup(self) -> None:
        stderr = io.StringIO()
        with (
            patch.object(desktop_sidecar.sys, "stdin", None),
            patch.object(desktop_sidecar.sys, "stderr", stderr),
        ):
            code = desktop_sidecar.main(["--owned-stdin"])

        self.assertEqual(code, 2)
        self.assertIn("owned stdin unavailable", stderr.getvalue())

    def test_owned_mode_rejects_invalid_stdin_fd_before_startup(self) -> None:
        stderr = io.StringIO()

        class InvalidStdin:
            def fileno(self) -> int:
                return -1

        with (
            patch.object(desktop_sidecar.sys, "stdin", InvalidStdin()),
            patch.object(desktop_sidecar.sys, "stderr", stderr),
        ):
            code = desktop_sidecar.main(["--owned-stdin"])

        self.assertEqual(code, 2)
        self.assertIn("valid file descriptor", stderr.getvalue())


class DesktopSidecarTests(unittest.TestCase):
    def _spawn(self, *, owned_stdin: bool = True) -> None:
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        ga = base / "invalid-ga"
        ga.mkdir()
        env = os.environ.copy()
        env.update({"GA_ROOT": str(ga), "GA_ADMIN_DATA": str(base / "admin-data"), "PYTHONUNBUFFERED": "1"})
        command = [
            sys.executable,
            "-m",
            "server.desktop_sidecar",
            "--port",
            "0",
            "--instance-token",
            "test-token",
        ]
        if owned_stdin:
            command.append("--owned-stdin")
        self.proc = subprocess.Popen(
            command,
            cwd=ROOT, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace",
            start_new_session=os.name == "posix",
        )
        line = self.proc.stdout.readline()
        if not line:
            _, stderr = self.proc.communicate(timeout=10)
            self.fail(
                "sidecar exited before emitting its lifecycle event "
                f"(code={self.proc.returncode}, executable={sys.executable!r}, stderr={stderr!r})"
            )
        self.event = json.loads(line)

    def _wait_ready(self) -> dict[str, object]:
        deadline = time.monotonic() + 20
        while True:
            try:
                with urlopen(
                    f"http://127.0.0.1:{self.event['port']}/api/desktop/ready",
                    timeout=1,
                ) as response:
                    return json.load(response)
            except Exception:
                if self.proc.poll() is not None:
                    self.fail(f"sidecar exited before readiness: {self.proc.returncode}")
                if time.monotonic() >= deadline:
                    self.fail("sidecar did not become ready")
                time.sleep(0.1)

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
        ready = self._wait_ready()
        self.assertEqual(ready["instance_token"], "test-token")
        self.proc.stdin.write("\n")
        self.proc.stdin.flush()
        self.assertEqual(self.proc.wait(timeout=10), 0)
        remaining = [json.loads(line) for line in self.proc.stdout if line.startswith("{")]
        self.assertTrue(any(item.get("reason") == "owner_stdin" for item in remaining))
        self.assertTrue(any(item.get("event") == "stopped" and item.get("graceful") for item in remaining))

    def test_owner_pipe_eof_stops_sidecar_without_leaving_a_process(self) -> None:
        self._spawn()
        ready = self._wait_ready()
        self.assertEqual(ready["instance_token"], "test-token")

        self.proc.stdin.close()
        self.proc.stdin = None
        self.assertEqual(self.proc.wait(timeout=10), 0)
        remaining = [json.loads(line) for line in self.proc.stdout if line.startswith("{")]
        self.assertTrue(any(item.get("reason") == "owner_eof" for item in remaining))
        self.assertIsNotNone(self.proc.poll())

    def test_manual_mode_does_not_depend_on_stdin(self) -> None:
        self._spawn(owned_stdin=False)
        self._wait_ready()

        self.proc.stdin.close()
        self.proc.stdin = None
        time.sleep(0.5)
        self.assertIsNone(self.proc.poll())
        self.proc.terminate()
        self.proc.wait(timeout=10)

    def test_invalid_non_loopback_bind_is_rejected(self) -> None:
        result = subprocess.run(
            [sys.executable, "-m", "server.desktop_sidecar", "--host", "0.0.0.0"],
            cwd=ROOT, capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("loopback", result.stderr)

    def _spawn_packaged_sidecar(self) -> dict[str, object]:
        if not _current_packaged_sidecar_is_staged():
            self.skipTest("packaged Windows sidecar is absent or predates the owned-stdin source")
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
                "--owned-stdin",
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
        return ready

    def test_packaged_sidecar_preserves_owner_stdin_shutdown(self) -> None:
        ready = self._spawn_packaged_sidecar()
        self.assertEqual(ready["instance_token"], "packaged-test-token")
        self.proc.stdin.write(b"\n")
        self.proc.stdin.flush()
        self.assertEqual(self.proc.wait(timeout=15), 0)

    def test_packaged_sidecar_exits_when_owner_pipe_closes(self) -> None:
        ready = self._spawn_packaged_sidecar()
        self.assertEqual(ready["instance_token"], "packaged-test-token")
        self.proc.stdin.close()
        self.proc.stdin = None
        self.assertEqual(self.proc.wait(timeout=15), 0)


if __name__ == "__main__":
    unittest.main()
