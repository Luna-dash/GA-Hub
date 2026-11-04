"""sidecar 打包契约：资源目录里的解释器缓存不得进包；运行期自检必须存在。

背景（2026-11-03 审计）：`--add-data` 整棵目录入包，把 `assets/nova/__pycache__`
里早已删除的 `server.cpython-312.pyc` 一起带进了成品——源码撤回了，字节码还在。
这些用例锁住「先过滤再入包」和 build_all 的运行期守卫。
"""
from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _load(name: str, relative: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


build_sidecar = _load("build_sidecar_under_test", "desktop/build_sidecar.py")
build_all = _load("build_all_under_test_packaging", "scripts/build_all.py")


class AssetFilterTests(unittest.TestCase):
    def test_ignore_drops_interpreter_caches(self) -> None:
        ignored = build_sidecar.asset_ignore(
            "assets/nova", ["__pycache__", "connector.py", "pair.cmd", "stale.pyc", "x.pyo"]
        )
        self.assertEqual(ignored, {"__pycache__", "stale.pyc", "x.pyo"})

    def test_ignore_keeps_real_assets(self) -> None:
        names = ["CONNECTOR.md", "connector.py", "pair.cmd", "run.cmd", "setup.cmd"]
        self.assertEqual(build_sidecar.asset_ignore("assets/nova", names), set())

    def test_stage_assets_copies_without_pycache(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            staging = Path(tmp)
            staged = build_sidecar.stage_assets(staging)
            self.assertIn("nova", staged)
            copied = sorted(p.name for p in staged["nova"].rglob("*"))
            self.assertNotIn("__pycache__", copied)
            self.assertFalse([name for name in copied if name.endswith((".pyc", ".pyo"))])
            self.assertIn("connector.py", copied)

    def test_stage_assets_does_not_keep_files_deleted_from_repo(self) -> None:
        """暂存目录跨构建复用，旧副本必须被清掉，否则删除的文件会继续入包。"""
        with tempfile.TemporaryDirectory() as tmp:
            staging = Path(tmp)
            stale_dir = staging / "nova"
            stale_dir.mkdir(parents=True)
            (stale_dir / "removed_module.py").write_text("raise SystemExit", encoding="utf-8")
            staged = build_sidecar.stage_assets(staging)
            self.assertFalse((staged["nova"] / "removed_module.py").exists())


class RuntimeGuardTests(unittest.TestCase):
    def test_selftest_exit_is_not_zero_when_binary_is_missing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            code = build_all.check_sidecar_runtime(Path(tmp) / "does-not-exist.exe")
            self.assertEqual(code, build_all.EXIT_ARTIFACT_GUARD)

    def test_guard_is_wired_into_main(self) -> None:
        source = (ROOT / "scripts" / "build_all.py").read_text(encoding="utf-8")
        guard_block = source.split('_stage("产物守卫")', 1)[1]
        self.assertIn("check_sidecar_runtime", guard_block)


class SelftestEntryTests(unittest.TestCase):
    def test_sidecar_exposes_selftest_flag(self) -> None:
        sidecar = _load("desktop_sidecar_under_test", "server/desktop_sidecar.py")
        args = sidecar._parse_args(["--selftest"])
        self.assertTrue(args.selftest)
        self.assertIn("pyexpat", sidecar.selftest_modules())

    def test_selftest_passes_in_development_env(self) -> None:
        sidecar = _load("desktop_sidecar_under_test_dev", "server/desktop_sidecar.py")
        self.assertEqual(sidecar.run_selftest(), 0)


if __name__ == "__main__":
    unittest.main()


class WindowsDependencyTests(unittest.TestCase):
    def test_shared_manifest_matches_packaging_and_frozen_selftest(self):
        import sys
        from unittest.mock import patch
        from desktop.runtime_dependencies import WINDOWS_IMPORTS, hidden_import_args
        self.assertEqual(set(WINDOWS_IMPORTS), {'win32cred','win32timezone'})
        self.assertEqual(hidden_import_args('linux'), ['--hidden-import', 'rich', '--hidden-import', 'rich.cells'])
        for name in WINDOWS_IMPORTS:
            args = hidden_import_args('win32')
            self.assertEqual(args[args.index(name)-1], '--hidden-import')
        sidecar=_load('sidecar_dependencies_test','server/desktop_sidecar.py')
        with patch.object(sys,'platform','win32'):
            self.assertTrue(set(WINDOWS_IMPORTS).issubset(sidecar.selftest_modules()))
        source=(ROOT/'assets/nova/connector.py').read_text(encoding='utf-8')
        for name in WINDOWS_IMPORTS:
            self.assertIn('import '+name,source)


class CommonDependencyTests(unittest.TestCase):
    def test_rich_cells_is_packaged_and_selftested_on_every_platform(self):
        from unittest.mock import patch
        from desktop.runtime_dependencies import hidden_import_args
        import sys

        sidecar = _load('sidecar_common_dependencies_test', 'server/desktop_sidecar.py')
        for platform in ('win32', 'linux', 'darwin'):
            args = hidden_import_args(platform)
            with patch.object(sys, 'platform', platform):
                modules = sidecar.selftest_modules()
            for name in ('rich', 'rich.cells'):
                self.assertIn(name, args)
                self.assertEqual(args[args.index(name) - 1], '--hidden-import')
                self.assertIn(name, modules)

    def test_selftest_rejects_missing_rich_cells(self):
        from unittest.mock import patch
        import importlib

        sidecar = _load('sidecar_missing_rich_cells_test', 'server/desktop_sidecar.py')
        real_import = importlib.import_module

        def import_without_cells(name):
            if name == 'rich.cells':
                raise ModuleNotFoundError("No module named 'rich.cells'")
            return real_import(name)

        with patch('importlib.import_module', side_effect=import_without_cells):
            self.assertEqual(sidecar.run_selftest(), 1)
