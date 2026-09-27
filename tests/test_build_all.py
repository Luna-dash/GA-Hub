"""build_all 的契约测试：路径、守卫语义、预检、占用、失败体检、锁、退出码。

锁的是 docs/BUILD.md「构建纪律与验收」与 AGENTS.md 构建红线的脚本侧实现——
改语义必须同步改这里和那两份文档。
"""
from __future__ import annotations

import importlib.util
import io
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "build_all.py"
spec = importlib.util.spec_from_file_location("build_all_under_test", SCRIPT)
assert spec and spec.loader
build_all = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build_all)

ARTIFACTS = ("sidecar 中间产物", "sidecar 交付副本", "主程序产物")


def _touch(path: Path, payload: bytes = b"old") -> tuple[Path, tuple[int, int]]:
    """写一个产物并返回它的构建前快照（用于守卫用例）。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    stat_result = path.stat()
    return path, (stat_result.st_mtime_ns, stat_result.st_size)


# 让另一个进程持独占句柄，制造**真实**的 Windows 共享冲突（不伪造 winerror：
# 伪造的 winerror=32 曾经让单测通过、真实现场漏判）。
EXCLUSIVE_HOLDER = """
import ctypes, sys, time
GENERIC_READ, GENERIC_WRITE, OPEN_EXISTING = 0x80000000, 0x40000000, 3
INVALID = ctypes.c_void_p(-1).value
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
kernel32.CreateFileW.restype = ctypes.c_void_p
kernel32.CreateFileW.argtypes = [
    ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32,
    ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p,
]
handle = kernel32.CreateFileW(
    sys.argv[1], GENERIC_READ | GENERIC_WRITE, 0, None, OPEN_EXISTING, 0, None
)
print("HOLDER", handle not in (None, INVALID), flush=True)
time.sleep(float(sys.argv[2]))
"""


class PathTests(unittest.TestCase):
    def test_artifact_paths_cover_the_three_deliverables(self):
        paths = build_all.artifact_paths("x86_64-pc-windows-msvc")
        self.assertEqual(tuple(paths), ARTIFACTS)
        self.assertEqual(
            paths["主程序产物"],
            build_all.ROOT
            / "src-tauri"
            / "target"
            / "x86_64-pc-windows-msvc"
            / "release"
            / "ga-hub-desktop.exe",
        )
        self.assertEqual(
            paths["sidecar 中间产物"],
            build_all.ROOT
            / "src-tauri"
            / "binaries"
            / "ga-hub-sidecar-x86_64-pc-windows-msvc.exe",
        )
        # 交付副本必须与主程序同目录（应用从主 exe 旁边解析 sidecar）
        self.assertEqual(paths["sidecar 交付副本"].parent, paths["主程序产物"].parent)

    def test_non_windows_target_drops_the_exe_suffix(self):
        paths = build_all.artifact_paths("aarch64-apple-darwin")
        self.assertEqual(paths["主程序产物"].name, "ga-hub-desktop")
        self.assertEqual(paths["sidecar 中间产物"].name, "ga-hub-sidecar-aarch64-apple-darwin")

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

    def test_tauri_stage_always_skips_bundling(self):
        """交付物只有便携版两个 exe：安装包不在本链职责内（实测每次 ~104MB/+24s）。"""
        command = build_all.tauri_stage_command("tauri", "t")
        self.assertIn("--no-bundle", command)
        self.assertNotIn("--bundle", command)
        self.assertNotIn("--bundle", build_all.__doc__)


class GuardTests(unittest.TestCase):
    """三件产物共用同一套守卫语义。"""

    def test_missing_artifact_fails(self):
        for label in ARTIFACTS:
            with self.subTest(label=label), tempfile.TemporaryDirectory() as td:
                stream = io.StringIO()
                with redirect_stdout(stream):
                    code = build_all.check_artifact(label, Path(td) / "gone.exe", None)
                self.assertEqual(code, build_all.EXIT_ARTIFACT_GUARD)
                self.assertIn("缺失", stream.getvalue())

    def test_empty_artifact_fails(self):
        for label in ARTIFACTS:
            with self.subTest(label=label), tempfile.TemporaryDirectory() as td:
                path, before = _touch(Path(td) / "artifact.exe", b"")
                stream = io.StringIO()
                with redirect_stdout(stream):
                    code = build_all.check_artifact(label, path, before)
                self.assertEqual(code, build_all.EXIT_ARTIFACT_GUARD)
                self.assertIn("为空文件", stream.getvalue())

    def test_unrefreshed_artifact_fails(self):
        """未被本次构建重写 = 交付了上一次的旧产物——没有合法的增量复用。"""
        for label in ARTIFACTS:
            with self.subTest(label=label), tempfile.TemporaryDirectory() as td:
                path, before = _touch(Path(td) / "artifact.exe")
                stream = io.StringIO()
                with redirect_stdout(stream):
                    code = build_all.check_artifact(label, path, before)
                self.assertEqual(code, build_all.EXIT_ARTIFACT_GUARD)
                self.assertIn("未被本次构建重写", stream.getvalue())
                self.assertIn(label, stream.getvalue())

    def test_artifact_produced_from_nothing_passes(self):
        for label in ARTIFACTS:
            with self.subTest(label=label), tempfile.TemporaryDirectory() as td:
                path, _ = _touch(Path(td) / "artifact.exe")
                stream = io.StringIO()
                with redirect_stdout(stream):
                    code = build_all.check_artifact(label, path, None)
                self.assertEqual(code, 0)
                self.assertIn("已刷新", stream.getvalue())

    def test_refreshed_artifact_passes(self):
        with tempfile.TemporaryDirectory() as td:
            path, before = _touch(Path(td) / "artifact.exe")
            path.write_bytes(b"new-and-longer")
            stream = io.StringIO()
            with redirect_stdout(stream):
                code = build_all.check_artifact("主程序产物", path, before)
            self.assertEqual(code, 0)
            self.assertIn("已刷新", stream.getvalue())

    def test_every_artifact_has_a_hint(self):
        self.assertEqual(set(build_all.ARTIFACT_HINTS), set(ARTIFACTS))
        self.assertEqual(set(build_all.artifact_paths("x86_64-pc-windows-msvc")), set(ARTIFACTS))


class BlockerTests(unittest.TestCase):
    """预检的占用/权限探测。"""

    def test_absent_artifact_is_not_blocked(self):
        with tempfile.TemporaryDirectory() as td:
            self.assertEqual(build_all.artifact_blocker(Path(td) / "gone"), "")

    def test_writable_unlocked_artifact_is_not_blocked(self):
        with tempfile.TemporaryDirectory() as td:
            path, _ = _touch(Path(td) / "ga-hub-desktop.exe")
            self.assertEqual(build_all.artifact_blocker(path), "")

    def test_readonly_file_is_reported_as_permission_not_as_running_app(self):
        """只读属性同样报 EACCES，不能误导成「GA-Hub 没退出」。"""
        with tempfile.TemporaryDirectory() as td:
            path, _ = _touch(Path(td) / "ga-hub-desktop.exe")
            os.chmod(path, stat.S_IREAD)
            try:
                blocker = build_all.artifact_blocker(path)
            finally:
                os.chmod(path, stat.S_IREAD | stat.S_IWRITE)
            self.assertIn("写权限", blocker)
            self.assertNotIn("占用", blocker)

    @unittest.skipUnless(os.name == "nt", "独占句柄共享语义仅 Windows")
    def test_real_exclusive_handle_is_reported_as_running_app(self):
        """真实 OS 拒绝（不是伪造的 winerror）必须判定为占用。"""
        with tempfile.TemporaryDirectory() as td:
            path, _ = _touch(Path(td) / "ga-hub-desktop.exe")
            holder = subprocess.Popen(
                [sys.executable, "-c", EXCLUSIVE_HOLDER, str(path), "10"],
                stdout=subprocess.PIPE,
                text=True,
            )
            try:
                assert holder.stdout is not None
                self.assertIn("HOLDER True", holder.stdout.readline())
                self.assertIn("占用", build_all.artifact_blocker(path))
            finally:
                holder.kill()
                holder.wait(timeout=10)


class PreflightTests(unittest.TestCase):
    def _preflight(self, root: Path, *, ga_root: Path | None, npm="npm", tauri="tauri"):
        with mock.patch.object(build_all, "ROOT", root), \
             mock.patch.object(build_all.shutil, "which", return_value="cargo"), \
             mock.patch.object(build_all, "_has_pyinstaller", return_value=True):
            stream = io.StringIO()
            with redirect_stdout(stream):
                with self.assertRaises(SystemExit) as raised:
                    build_all.preflight("python", npm, tauri, ga_root=ga_root)
            return raised.exception.code, stream.getvalue()

    def test_missing_prerequisites_exit_2_with_actionable_messages(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "webui").mkdir()  # 存在但没有 node_modules
            code, output = self._preflight(root, ga_root=root / "GA")
            self.assertEqual(code, build_all.EXIT_PREFLIGHT)
            self.assertIn("npm ci --prefix webui", output)
            self.assertIn("GA_ROOT", output)

    def test_toolchain_gaps_are_reported(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "webui" / "node_modules").mkdir(parents=True)
            code, output = self._preflight(root, ga_root=None, npm="", tauri="")
            self.assertEqual(code, build_all.EXIT_PREFLIGHT)
            self.assertIn("npm", output)
            self.assertIn("tauri CLI", output)

    def test_missing_pyinstaller_points_at_the_fix(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "webui" / "node_modules").mkdir(parents=True)
            with mock.patch.object(build_all, "ROOT", root), \
                 mock.patch.object(build_all.shutil, "which", return_value="cargo"), \
                 mock.patch.object(build_all, "_has_pyinstaller", return_value=False):
                stream = io.StringIO()
                with redirect_stdout(stream):
                    with self.assertRaises(SystemExit) as raised:
                        build_all.preflight("python", "npm", "tauri")
            self.assertEqual(raised.exception.code, build_all.EXIT_PREFLIGHT)
            self.assertIn("PyInstaller", stream.getvalue())

    def test_preflight_passes_without_full(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "webui" / "node_modules").mkdir(parents=True)
            with mock.patch.object(build_all, "ROOT", root), \
                 mock.patch.object(build_all.shutil, "which", return_value="cargo"), \
                 mock.patch.object(build_all, "_has_pyinstaller", return_value=True):
                stream = io.StringIO()
                with redirect_stdout(stream):
                    build_all.preflight("python", "npm", "tauri")
            self.assertIn("✓ 预检通过", stream.getvalue())


class ConsistencyTests(unittest.TestCase):
    """阶段失败后的产物体检：守卫覆盖不到失败路径。"""

    def _run(self, paths, before):
        stream = io.StringIO()
        with redirect_stdout(stream):
            build_all.report_consistency(paths, before)
        return stream.getvalue()

    def test_no_stage_wrote_anything(self):
        with tempfile.TemporaryDirectory() as td:
            path, snapshot = _touch(Path(td) / "ga-hub-desktop.exe")
            output = self._run({"主程序产物": path}, {"主程序产物": snapshot})
            self.assertIn("本次没有写入任何产物", output)

    def test_partial_refresh_is_reported_as_mismatched(self):
        """「一半新一半旧」必须被点名（实测冒烟出现过这种混搭）。"""
        with tempfile.TemporaryDirectory() as td:
            fresh, fresh_before = _touch(Path(td) / "ga-hub-sidecar.exe")
            fresh.write_bytes(b"new-sidecar")
            stale, stale_before = _touch(Path(td) / "ga-hub-desktop.exe")
            output = self._run(
                {"sidecar 交付副本": fresh, "主程序产物": stale},
                {"sidecar 交付副本": fresh_before, "主程序产物": stale_before},
            )
            self.assertIn("本次已重写", output)
            self.assertIn("仍是构建前的版本", output)
            self.assertIn("产物集不配套", output)

    def test_missing_artifact_also_counts_as_mismatched(self):
        with tempfile.TemporaryDirectory() as td:
            fresh, _ = _touch(Path(td) / "ga-hub-sidecar.exe")
            output = self._run(
                {"sidecar 交付副本": fresh, "主程序产物": Path(td) / "gone.exe"},
                {"sidecar 交付副本": None, "主程序产物": None},
            )
            self.assertIn("不存在", output)
            self.assertIn("产物集不配套", output)

    def test_all_refreshed_is_reported_honestly(self):
        with tempfile.TemporaryDirectory() as td:
            path, _ = _touch(Path(td) / "ga-hub-sidecar.exe")
            output = self._run({"sidecar 交付副本": path}, {"sidecar 交付副本": None})
            self.assertIn("都是本次产出", output)


class StageTests(unittest.TestCase):
    def test_run_stage_merges_extra_environment(self):
        completed = mock.Mock(returncode=0)
        with mock.patch.object(build_all.subprocess, "run", return_value=completed) as run:
            build_all.run_stage("probe", ["fake"], extra_env={"GA_ROOT": "X", "PYTHONPATH": "X"})
        env = run.call_args.kwargs["env"]
        self.assertEqual(env["GA_ROOT"], "X")
        self.assertEqual(env["PYTHONPATH"], "X")
        self.assertEqual(env["PYTHONUTF8"], "1")
        self.assertIs(run.call_args.kwargs["stdin"], subprocess.DEVNULL)

    def test_failed_stage_raises_stage_failed(self):
        """阶段失败抛 StageFailed：main 才能把产物体检跑到失败路径上。"""
        with mock.patch.object(build_all.subprocess, "run", return_value=mock.Mock(returncode=7)):
            stream = io.StringIO()
            with redirect_stdout(stream):
                with self.assertRaises(build_all.StageFailed) as raised:
                    build_all.run_stage("probe", ["fake"])
        self.assertEqual(raised.exception.stage, "probe")
        self.assertIn("链式中止", stream.getvalue())


class InterpreterTests(unittest.TestCase):
    def test_resolve_sidecar_python_honours_override(self):
        with mock.patch.dict(os.environ, {"GA_HUB_PYTHON": "X:/custom/python"}, clear=False):
            self.assertEqual(build_all.resolve_sidecar_python(), "X:/custom/python")

    def test_resolve_sidecar_python_defaults_to_current_interpreter(self):
        with mock.patch.dict(os.environ, {"GA_HUB_PYTHON": ""}, clear=False):
            self.assertEqual(build_all.resolve_sidecar_python(), sys.executable)


class LockTests(unittest.TestCase):
    def test_build_lock_blocks_second_holder(self):
        """锁语义：第二个持有者被拒；持有者释放后不留僵尸锁。

        用临时锁文件而不是真实路径：``--full`` 正是「持有真实构建锁 → 跑整个
        测试集」，测试若去抢同一把锁必然失败（发布前命令因此曾以 rc=3 中止）。
        锁的**位置**由另一个用例单独锁住。
        """
        with tempfile.TemporaryDirectory() as td:
            lock_path = Path(td) / ".build_all.lock"
            with mock.patch.object(build_all, "build_lock_path", return_value=lock_path):
                handle, desc = build_all.acquire_build_lock()
                try:
                    self.assertIsNotNone(handle, desc)
                    second, blocked = build_all.acquire_build_lock()
                    self.assertIsNone(second)
                    self.assertTrue(blocked)
                finally:
                    if handle is not None:
                        handle.close()
                after, _ = build_all.acquire_build_lock()
                try:
                    self.assertIsNotNone(after, "锁必须随持有者退出释放（不能有僵尸锁）")
                finally:
                    if after is not None:
                        after.close()

    def test_lock_path_is_the_documented_location(self):
        self.assertEqual(
            build_all.build_lock_path(),
            build_all.ROOT / "src-tauri" / "target" / ".build_all.lock",
        )


class MainFlowTests(unittest.TestCase):
    def _patched(self):
        return (
            mock.patch.object(build_all, "acquire_build_lock", return_value=(mock.Mock(), "lock")),
            mock.patch.object(build_all, "resolve_npm", return_value="npm"),
            mock.patch.object(build_all, "resolve_tauri", return_value="tauri"),
            mock.patch.object(build_all, "resolve_sidecar_python", return_value="python"),
            mock.patch.object(build_all, "preflight"),
            mock.patch.object(build_all, "artifact_blocker", return_value=""),
        )

    def test_stage_failure_runs_artifact_checkup_and_returns_3(self):
        """阶段失败 → 报告产物一致性，但退出码保持 3（不是 5）。"""
        patches = self._patched()
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], \
             mock.patch.object(
                 build_all, "run_stage", side_effect=build_all.StageFailed("前端生产构建")
             ), \
             mock.patch.object(build_all, "report_consistency") as report, \
             mock.patch.object(build_all, "check_artifact") as guard:
            stream = io.StringIO()
            with redirect_stdout(stream):
                code = build_all.main([])
        self.assertEqual(code, build_all.EXIT_STAGE_FAILED)
        report.assert_called_once()
        guard.assert_not_called()

    def test_blocked_artifact_returns_2_before_any_stage(self):
        patches = self._patched()
        with patches[0], patches[1], patches[2], patches[3], patches[4], \
             mock.patch.object(build_all, "artifact_blocker", return_value="被占用"), \
             mock.patch.object(build_all, "run_stage") as stage:
            stream = io.StringIO()
            with redirect_stdout(stream):
                code = build_all.main([])
        self.assertEqual(code, build_all.EXIT_PREFLIGHT)
        stage.assert_not_called()
        self.assertIn("被占用", stream.getvalue())

    def test_successful_chain_runs_guards_and_returns_0(self):
        patches = self._patched()
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], \
             mock.patch.object(build_all, "run_stage") as stage, \
             mock.patch.object(build_all, "check_artifact", return_value=0) as guard:
            stream = io.StringIO()
            with redirect_stdout(stream):
                code = build_all.main([])
        self.assertEqual(code, 0)
        self.assertEqual(stage.call_count, 3)  # 前端 / sidecar / tauri
        self.assertEqual(guard.call_count, 3)
        self.assertIn("构建链全部通过", stream.getvalue())

    def test_full_chain_adds_the_two_test_stages(self):
        patches = self._patched()
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], \
             mock.patch.object(build_all, "run_stage") as stage, \
             mock.patch.object(build_all, "check_artifact", return_value=0), \
             mock.patch.object(Path, "is_dir", return_value=True):
            with redirect_stdout(io.StringIO()):
                code = build_all.main(["--full"])
        self.assertEqual(code, 0)
        self.assertEqual(stage.call_count, 5)  # pytest / vitest / 前端 / sidecar / tauri


class SourceHygieneTests(unittest.TestCase):
    def test_module_import_pins_utf8(self):
        """import 时即固定 UTF-8：--help 与把模块当库调用都发生在 main() 之前。"""
        recorder = mock.Mock()
        fake = mock.Mock(reconfigure=recorder)
        with mock.patch.object(sys, "stdout", fake), mock.patch.object(sys, "stderr", fake):
            probe_spec = importlib.util.spec_from_file_location("build_all_pin_probe", SCRIPT)
            assert probe_spec and probe_spec.loader
            probe_spec.loader.exec_module(importlib.util.module_from_spec(probe_spec))
        recorder.assert_called_with(encoding="utf-8", errors="replace")


if __name__ == "__main__":
    unittest.main()
