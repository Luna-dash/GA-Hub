"""build_all 的契约测试：路径、守卫语义、预检、锁、编码、退出码。

这些用例锁的是 docs/BUILD.md「构建纪律与验收」与 AGENTS.md 构建红线的
脚本侧实现——改语义必须同步改这里和那两份文档。
"""
from __future__ import annotations

import hashlib
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

    def test_host_target_path_is_the_non_canonical_release_dir(self):
        path = build_all.host_target_artifact_path()
        self.assertEqual(path.parent, build_all.ROOT / "src-tauri" / "target" / "release")


class GuardTests(unittest.TestCase):
    """三件产物共用一套语义：缺失 / 为空 / 未被本次构建重写 → 5，其余情况不通过。"""

    GUARDS = ("artifact_guard", "sidecar_artifact_guard", "sidecar_delivery_guard")

    def test_missing_artifact_fails(self):
        with tempfile.TemporaryDirectory() as td:
            for name in self.GUARDS:
                with self.subTest(guard=name):
                    guard = getattr(build_all, name)
                    self.assertEqual(
                        guard(Path(td) / "gone", None), build_all.EXIT_ARTIFACT_GUARD
                    )

    def test_empty_artifact_fails(self):
        with tempfile.TemporaryDirectory() as td:
            for name in self.GUARDS:
                with self.subTest(guard=name):
                    path, _ = _touch(Path(td) / name / "artifact", b"")
                    self.assertEqual(
                        getattr(build_all, name)(path, None), build_all.EXIT_ARTIFACT_GUARD
                    )

    def test_artifact_produced_from_nothing_passes(self):
        """构建前不存在、构建后存在 —— 首次构建的合法形态。"""
        with tempfile.TemporaryDirectory() as td:
            for name in self.GUARDS:
                with self.subTest(guard=name):
                    path, _ = _touch(Path(td) / name / "artifact")
                    self.assertEqual(getattr(build_all, name)(path, None), 0)

    def test_refreshed_artifact_passes(self):
        with tempfile.TemporaryDirectory() as td:
            for name in self.GUARDS:
                with self.subTest(guard=name):
                    path, before = _touch(Path(td) / name / "artifact")
                    older = (before[0] - 10**9, before[1] - 1)
                    self.assertEqual(getattr(build_all, name)(path, older), 0)

    def test_unrefreshed_artifact_fails(self):
        """未重写 = 没有产出新产物：写到了别处 / 这一步被跳过，一律不放行。

        2026-09-26 两次真实全链（冷 114.0s、热 93.2s）实测三件产物每次都被重写，
        所以「未重写」不可能是合法增量复用——旧的「警告放行」分支已删除。
        """
        with tempfile.TemporaryDirectory() as td:
            for name in self.GUARDS:
                with self.subTest(guard=name):
                    path, before = _touch(Path(td) / name / "artifact")
                    self.assertEqual(
                        getattr(build_all, name)(path, before), build_all.EXIT_ARTIFACT_GUARD
                    )

    def test_refreshed_detection_uses_mtime_or_size(self):
        with tempfile.TemporaryDirectory() as td:
            path, before = _touch(Path(td) / "artifact", b"old")
            self.assertFalse(build_all._refreshed(path, before))
            self.assertTrue(build_all._refreshed(path, None), "构建前不存在 → 是本次产出")
            path.write_bytes(b"new-and-longer")
            self.assertTrue(build_all._refreshed(path, before))

    def test_guard_reports_the_path_it_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            stream = io.StringIO()
            with redirect_stdout(stream):
                code = build_all.artifact_guard(Path(td) / "ga-hub-desktop.exe", None)
            self.assertEqual(code, build_all.EXIT_ARTIFACT_GUARD)
            self.assertIn("ga-hub-desktop.exe", stream.getvalue())


class HostTargetLeakTests(unittest.TestCase):
    """非正式区残留：存在即报告（旧实现等「构建中刷新」这个永远不会发生的事件）。"""

    def test_reports_existing_host_target_artifact(self):
        with tempfile.TemporaryDirectory() as td:
            with mock.patch.object(build_all, "ROOT", Path(td)):
                path, _ = _touch(build_all.host_target_artifact_path())
                stream = io.StringIO()
                with redirect_stdout(stream):
                    found = build_all.report_host_target_leak()
            self.assertTrue(found)
            self.assertIn(str(path), stream.getvalue())
            self.assertIn("非正式区", stream.getvalue())

    def test_silent_when_absent(self):
        with tempfile.TemporaryDirectory() as td:
            with mock.patch.object(build_all, "ROOT", Path(td)):
                stream = io.StringIO()
                with redirect_stdout(stream):
                    found = build_all.report_host_target_leak()
            self.assertFalse(found)
            self.assertEqual(stream.getvalue(), "")


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


class OccupancyTests(unittest.TestCase):
    def test_absent_artifact_is_not_busy(self):
        with tempfile.TemporaryDirectory() as td:
            self.assertFalse(build_all._locked_by_process(Path(td) / "gone"))

    def test_writable_unlocked_artifact_is_not_busy(self):
        with tempfile.TemporaryDirectory() as td:
            path, _ = _touch(Path(td) / "ga-hub-desktop.exe")
            self.assertFalse(build_all._locked_by_process(path))
            self.assertFalse(build_all._readonly_artifact(path))

    def test_readonly_artifact_is_not_reported_as_busy(self):
        """只读属性不是「应用没退出」：EACCES 也可能来自权限，别误导排查方向。"""
        with tempfile.TemporaryDirectory() as td:
            path, _ = _touch(Path(td) / "ga-hub-desktop.exe")
            os.chmod(path, stat.S_IREAD)
            try:
                self.assertTrue(build_all._readonly_artifact(path))
                self.assertFalse(build_all._locked_by_process(path))
            finally:
                os.chmod(path, stat.S_IREAD | stat.S_IWRITE)

    @unittest.skipUnless(os.name == "nt", "独占句柄共享语义仅 Windows")
    def test_real_exclusive_handle_is_reported_busy(self):
        """真实 OS 拒绝（不是伪造的 winerror）必须判定为占用。

        运行中的映像被写方式打开实测只报 errno 13 且没有 winerror——用伪造
        winerror 的单测曾经在真实现场漏判（build_all --full 之后的冒烟实测），
        所以这里让另一个进程持独占句柄，走真实的共享冲突路径。
        """
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
                self.assertTrue(build_all._locked_by_process(path))
            finally:
                holder.kill()
                holder.wait(timeout=10)


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

    def test_failed_stage_exits_3(self):
        with mock.patch.object(build_all.subprocess, "run", return_value=mock.Mock(returncode=7)):
            stream = io.StringIO()
            with redirect_stdout(stream):
                with self.assertRaises(SystemExit) as raised:
                    build_all.run_stage("probe", ["fake"])
        self.assertEqual(raised.exception.code, build_all.EXIT_STAGE_FAILED)

    def test_resolve_sidecar_python_honours_override(self):
        with mock.patch.dict(os.environ, {"GA_HUB_PYTHON": "X:/custom/python"}, clear=False):
            self.assertEqual(build_all.resolve_sidecar_python(), "X:/custom/python")

    def test_resolve_sidecar_python_defaults_to_current_interpreter(self):
        with mock.patch.dict(os.environ, {"GA_HUB_PYTHON": ""}, clear=False):
            self.assertEqual(build_all.resolve_sidecar_python(), sys.executable)

    def test_build_lock_blocks_second_holder(self):
        """锁语义：第二个持有者被拒；持有者释放后不留僵尸锁。

        用临时锁文件而不是真实路径：``--full`` 正是「持有真实构建锁 → 跑整个
        测试集」，测试若去抢同一把锁必然失败（实测 ``build_all.py --full`` 因此
        以 rc=3 中止——发布前命令跑不通）。锁的**位置**由另一个用例单独锁住。
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

    def test_tauri_stage_skips_bundling_unless_requested(self):
        """默认不打包安装包（便携版两个 exe 才是交付物）；--bundle 才交给 bundler。"""
        self.assertIn("--no-bundle", build_all.tauri_stage_command("tauri", "t"))
        self.assertNotIn(
            "--no-bundle", build_all.tauri_stage_command("tauri", "t", bundle=True)
        )


class BundleGuardTests(unittest.TestCase):
    def test_requested_bundle_without_output_fails(self):
        with tempfile.TemporaryDirectory() as td:
            with mock.patch.object(build_all, "ROOT", Path(td)):
                stream = io.StringIO()
                with redirect_stdout(stream):
                    code = build_all.bundle_guard("x86_64-pc-windows-msvc")
            self.assertEqual(code, build_all.EXIT_ARTIFACT_GUARD)
            self.assertIn("--bundle", stream.getvalue())

    def test_requested_bundle_lists_installers(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            msi = root / "src-tauri" / "target" / "t" / "release" / "bundle" / "msi" / "GA-Hub.msi"
            msi.parent.mkdir(parents=True)
            msi.write_bytes(b"m" * 1024)
            with mock.patch.object(build_all, "ROOT", root):
                stream = io.StringIO()
                with redirect_stdout(stream):
                    code = build_all.bundle_guard("t")
            self.assertEqual(code, 0)
            self.assertIn("GA-Hub.msi", stream.getvalue())


class FingerprintTests(unittest.TestCase):
    def test_sha256_matches_hashlib(self):
        with tempfile.TemporaryDirectory() as td:
            path, _ = _touch(Path(td) / "artifact", b"ga-hub")
            self.assertEqual(
                build_all._sha256(path), hashlib.sha256(b"ga-hub").hexdigest()
            )

    def test_fingerprint_block_lists_size_and_digest(self):
        with tempfile.TemporaryDirectory() as td:
            path, _ = _touch(Path(td) / "ga-hub-desktop.exe", b"x" * 2048)
            stream = io.StringIO()
            with redirect_stdout(stream):
                build_all._log_fingerprints((path, Path(td) / "missing"))
            output = stream.getvalue()
            self.assertIn("ga-hub-desktop.exe", output)
            self.assertIn("sha256", output)
            self.assertIn(build_all._sha256(path)[:16], output)
            self.assertIn("2.0 KB", output)


class LoggingTests(unittest.TestCase):
    def test_log_survives_unencodable_stdout(self):
        """控制台码页编码不了 ✓/✗/⚠ 时，日志必须降级而不是让构建崩在输出上。"""
        buffer = io.BytesIO()
        wrapper = io.TextIOWrapper(buffer, encoding="ascii", errors="strict")
        with mock.patch.object(build_all.sys, "stdout", wrapper):
            build_all._log("✗ sidecar 中间产物缺失")
        wrapper.flush()
        self.assertIn(b"[build_all]", buffer.getvalue())

    def test_module_import_pins_utf8(self):
        """import 时即固定 UTF-8：守卫/--help 都可能先于 main() 输出。"""
        self.assertTrue(hasattr(build_all, "_force_utf8_stdio"))
        source = SCRIPT.read_text(encoding="utf-8").replace("\r\n", "\n")
        call = source.index("\n_force_utf8_stdio()\n")  # 顶格的模块级调用
        self.assertLess(call, source.index("def main("))
        self.assertNotIn("    _force_utf8_stdio()\n", source, "main() 里不应再重复调用")


if __name__ == "__main__":
    unittest.main()
