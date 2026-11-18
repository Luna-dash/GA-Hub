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
runtime_dependencies = _load("desktop_runtime_under_test", "desktop/runtime_dependencies.py")


class AssetFilterTests(unittest.TestCase):
    def test_stage_assets_contains_only_runtime_allowlist(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            staged = build_sidecar.stage_assets(Path(tmp))
            self.assertEqual(set(staged), set(build_sidecar.RUNTIME_ASSETS))
            for name, destination in staged.items():
                self.assertEqual(
                    {str(p.relative_to(destination)) for p in destination.rglob('*') if p.is_file()},
                    set(build_sidecar.RUNTIME_ASSETS[name]),
                )

    def test_stage_assets_missing_required_file_aborts(self) -> None:
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as tmp, patch.object(build_sidecar, 'ROOT', Path(tmp)):
            with self.assertRaisesRegex(RuntimeError, 'Required desktop asset missing'):
                build_sidecar.stage_assets(Path(tmp) / 'stage')

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


class CondaRuntimeDllTests(unittest.TestCase):
    """A frozen onefile must carry the Conda DLLs its C extensions link against.

    2026-11-16: pyexpat.pyd was bundled without libexpat.dll, so the
    pkg_resources runtime hook crashed the sidecar before any business code.
    A glob matching nothing must fail the build instead of shipping that.
    """

    NAMES = (
        "libssl-3-x64.dll", "libcrypto-3-x64.dll", "libexpat.dll", "expat.dll",
        "ffi.dll", "libbz2.dll", "liblzma.dll", "sqlite3.dll", "zlib.dll",
    )

    def _args(self, names):
        with tempfile.TemporaryDirectory() as tmp:
            conda_bin = Path(tmp)
            for name in names:
                (conda_bin / name).write_bytes(b"")
            return build_sidecar.conda_runtime_binary_args(conda_bin)

    @staticmethod
    def _bundled(args):
        return {
            Path(args[index + 1].split(";", 1)[0]).name.lower()
            for index in range(0, len(args), 2)
        }

    def test_standard_python_does_not_require_conda_dlls(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(build_sidecar.runtime_binary_args(Path(tmp)), [])

    def test_conda_environment_still_rejects_missing_dlls(self):
        with tempfile.TemporaryDirectory() as tmp:
            prefix = Path(tmp)
            (prefix / "conda-meta").mkdir()
            with self.assertRaisesRegex(RuntimeError, "Conda runtime DLLs missing"):
                build_sidecar.runtime_binary_args(prefix)

    def test_conda_environment_collects_required_dlls(self):
        with tempfile.TemporaryDirectory() as tmp:
            prefix = Path(tmp)
            (prefix / "conda-meta").mkdir()
            library = prefix / "Library" / "bin"
            library.mkdir(parents=True)
            for name in self.NAMES:
                (library / name).write_bytes(b"")
            self.assertEqual(self._bundled(build_sidecar.runtime_binary_args(prefix)), set(self.NAMES))

    def test_every_critical_conda_dll_is_added_to_the_bundle(self):
        bundled = self._bundled(self._args(self.NAMES))
        for name in runtime_dependencies.CRITICAL_CONDA_DLLS:
            self.assertIn(name, bundled)
        self.assertIn("libssl-3-x64.dll", bundled)
        self.assertIn("libcrypto-3-x64.dll", bundled)

    def test_missing_expat_dll_fails_the_build_loudly(self):
        without_expat = tuple(
            name for name in self.NAMES if name not in ("libexpat.dll", "expat.dll")
        )
        with self.assertRaisesRegex(RuntimeError, "libexpat.dll"):
            self._args(without_expat)


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
        self.assertEqual(set(WINDOWS_IMPORTS), {'win32cred', 'win32timezone', 'win32file'})
        self.assertEqual(hidden_import_args('linux'), ['--hidden-import', 'rich', '--hidden-import', 'rich.cells'])
        for name in WINDOWS_IMPORTS:
            args = hidden_import_args('win32')
            self.assertEqual(args[args.index(name)-1], '--hidden-import')
        sidecar=_load('sidecar_dependencies_test','server/desktop_sidecar.py')
        with patch.object(sys,'platform','win32'):
            self.assertTrue(set(WINDOWS_IMPORTS).issubset(sidecar.selftest_modules()))
        sources = '\n'.join((ROOT / relative).read_text(encoding='utf-8') for relative in (
            'assets/nova/connector.py', 'assets/remote_access/artifacts.py',
        ))
        for name in WINDOWS_IMPORTS:
            self.assertIn('import ' + name, sources)

    def test_selftest_rejects_missing_windows_download_dependency(self):
        import importlib
        import sys
        from unittest.mock import patch

        sidecar = _load('sidecar_missing_win32file_test', 'server/desktop_sidecar.py')
        real_import = importlib.import_module

        def import_without_win32file(name):
            if name == 'win32file':
                raise ModuleNotFoundError("No module named 'win32file'")
            return real_import(name)

        with patch.object(sys, 'platform', 'win32'), patch(
            'importlib.import_module', side_effect=import_without_win32file,
        ), patch.object(sidecar, '_diagnostic') as diagnostic:
            self.assertEqual(sidecar.run_selftest(), 1)
            self.assertIn('win32file: ModuleNotFoundError', diagnostic.call_args.args[0])


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
