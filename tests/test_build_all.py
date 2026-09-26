from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "build_all.py"
spec = importlib.util.spec_from_file_location("build_all_under_test", SCRIPT)
assert spec and spec.loader
build_all = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build_all)


class BuildAllPathTests(unittest.TestCase):
    def test_sidecar_paths_match_target_platform(self):
        windows = build_all.sidecar_artifact_path("x86_64-pc-windows-msvc")
        self.assertTrue(str(windows).endswith("ga-hub-sidecar-x86_64-pc-windows-msvc.exe"))
        mac = build_all.sidecar_artifact_path("aarch64-apple-darwin")
        self.assertTrue(str(mac).endswith("ga-hub-sidecar-aarch64-apple-darwin"))

    def test_delivery_sidecar_sits_next_to_main_artifact(self):
        target = "x86_64-pc-windows-msvc"
        self.assertEqual(
            build_all.artifact_path(target).parent,
            build_all.delivery_sidecar_path(target).parent,
        )


class GuardTests(unittest.TestCase):
    def test_sidecar_guard_rejects_missing_and_empty(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "sidecar"
            self.assertEqual(
                build_all.sidecar_artifact_guard(path, None), build_all.EXIT_ARTIFACT_GUARD
            )
            path.write_bytes(b"")
            self.assertEqual(
                build_all.sidecar_artifact_guard(path, None), build_all.EXIT_ARTIFACT_GUARD
            )

    def test_sidecar_guard_accepts_refreshed_artifact(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "sidecar"
            path.write_bytes(b"old")
            stat = path.stat()
            before = (stat.st_mtime_ns - 10**9, stat.st_size)
            self.assertEqual(build_all.sidecar_artifact_guard(path, before), 0)

    def test_sidecar_guard_warns_on_unchanged_snapshot(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "sidecar"
            path.write_bytes(b"same")
            stat = path.stat()
            self.assertEqual(
                build_all.sidecar_artifact_guard(path, (stat.st_mtime_ns, stat.st_size)), 0
            )

    def test_sidecar_delivery_guard_rejects_desync(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "ga-hub-sidecar.exe"
            path.write_bytes(b"old")
            stat = path.stat()
            before = (stat.st_mtime_ns, stat.st_size)
            self.assertEqual(
                build_all.sidecar_delivery_guard(path, before, intermediate_refreshed=True),
                build_all.EXIT_ARTIFACT_GUARD,
            )
            self.assertEqual(
                build_all.sidecar_delivery_guard(path, before, intermediate_refreshed=False), 0
            )

    def test_sidecar_delivery_guard_rejects_missing_and_empty(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "ga-hub-sidecar.exe"
            self.assertEqual(
                build_all.sidecar_delivery_guard(path, None, intermediate_refreshed=False),
                build_all.EXIT_ARTIFACT_GUARD,
            )
            path.write_bytes(b"")
            self.assertEqual(
                build_all.sidecar_delivery_guard(path, None, intermediate_refreshed=False),
                build_all.EXIT_ARTIFACT_GUARD,
            )

    def test_artifact_guard_flags_stale_artifact(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "ga-hub-desktop.exe"
            path.write_bytes(b"old")
            stat = path.stat()
            before = (stat.st_mtime_ns, stat.st_size)
            with mock.patch.object(
                build_all, "_newest_input_mtime", return_value=stat.st_mtime + 10
            ):
                self.assertEqual(
                    build_all.artifact_guard(path, before), build_all.EXIT_ARTIFACT_GUARD
                )

    def test_artifact_guard_allows_incremental_reuse(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "ga-hub-desktop.exe"
            path.write_bytes(b"same")
            stat = path.stat()
            before = (stat.st_mtime_ns, stat.st_size)
            with mock.patch.object(build_all, "_newest_input_mtime", return_value=0.0):
                self.assertEqual(build_all.artifact_guard(path, before), 0)

    def test_artifact_guard_accepts_refreshed_artifact(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "ga-hub-desktop.exe"
            path.write_bytes(b"new")
            stat = path.stat()
            before = (stat.st_mtime_ns - 10**9, stat.st_size)
            self.assertEqual(build_all.artifact_guard(path, before), 0)


class EnvironmentTests(unittest.TestCase):
    def test_run_stage_merges_extra_environment(self):
        completed = mock.Mock(returncode=0)
        with mock.patch.object(build_all.subprocess, "run", return_value=completed) as run:
            build_all.run_stage("probe", ["fake"], extra_env={"GA_ROOT": "X", "PYTHONPATH": "X"})
        env = run.call_args.kwargs["env"]
        self.assertEqual(env["GA_ROOT"], "X")
        self.assertEqual(env["PYTHONPATH"], "X")
        self.assertEqual(env["PYTHONUTF8"], "1")
        self.assertIs(run.call_args.kwargs["stdin"], subprocess.DEVNULL)

    def test_resolve_sidecar_python_honours_override(self):
        with mock.patch.dict(os.environ, {"GA_HUB_PYTHON": "X:/custom/python"}, clear=False):
            self.assertEqual(build_all.resolve_sidecar_python(), "X:/custom/python")

    def test_resolve_sidecar_python_defaults_to_current_interpreter(self):
        with mock.patch.dict(os.environ, {"GA_HUB_PYTHON": ""}, clear=False):
            self.assertEqual(build_all.resolve_sidecar_python(), sys.executable)

    def test_build_lock_blocks_second_holder(self):
        handle, _ = build_all.acquire_build_lock()
        try:
            self.assertIsNotNone(handle)
            second, desc = build_all.acquire_build_lock()
            self.assertIsNone(second)
            self.assertTrue(desc)
        finally:
            if handle is not None:
                handle.close()

    def test_tauri_stage_command_wraps_cmd_shim_on_windows(self):
        shim = os.path.join("x", "tauri.cmd")
        command = build_all.tauri_stage_command(shim, "t")
        if os.name == "nt":
            self.assertEqual(command[0:2], ["cmd", "/c"])
            self.assertEqual(command[2], shim)
        else:
            self.assertEqual(command[0], shim)
        self.assertIn("build", command)
        self.assertIn("--target", command)


if __name__ == "__main__":
    unittest.main()
