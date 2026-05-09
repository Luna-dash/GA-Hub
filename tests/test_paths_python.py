import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from server import _paths


def _touch_python(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/usr/bin/env python\n", "utf-8")
    return path


class PythonDiscoveryTests(unittest.TestCase):
    def test_discover_user_python_prefers_env(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            env_python = _touch_python(root / "env-python")
            ga_root = root / "GenericAgent"
            _touch_python(ga_root / ".venv/bin/python3")

            with mock.patch.dict(_paths.os.environ, {"GA_PYTHON": str(env_python)}, clear=False), \
                 mock.patch.object(_paths, "load_config", return_value={}):
                self.assertEqual(_paths.discover_user_python(ga_root), str(env_python.resolve()))

    def test_discover_user_python_prefers_config_over_ga_venv(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            configured_python = _touch_python(root / "configured-python")
            ga_root = root / "GenericAgent"
            _touch_python(ga_root / ".venv/bin/python3")

            with mock.patch.dict(_paths.os.environ, {}, clear=True), \
                 mock.patch.object(_paths, "load_config", return_value={"python_path": str(configured_python)}):
                self.assertEqual(_paths.discover_user_python(ga_root), str(configured_python.resolve()))

    def test_discover_user_python_uses_ga_venv_before_path(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            ga_root = root / "GenericAgent"
            ga_python = _touch_python(ga_root / ".venv/bin/python3")

            with mock.patch.dict(_paths.os.environ, {}, clear=True), \
                 mock.patch.object(_paths, "load_config", return_value={}), \
                 mock.patch.object(_paths.shutil, "which", return_value=str(root / "system-python")):
                self.assertEqual(_paths.discover_user_python(ga_root), str(ga_python.resolve()))

    def test_set_ga_root_rejects_bad_python_path(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            admin_data = root / "admin-data"
            config_file = admin_data / "config.json"
            ga_root = root / "GenericAgent"
            (ga_root / "memory").mkdir(parents=True)
            (ga_root / "agentmain.py").write_text("", "utf-8")

            with mock.patch.object(_paths, "ADMIN_DATA", admin_data), \
                 mock.patch.object(_paths, "CONFIG_FILE", config_file):
                with self.assertRaisesRegex(ValueError, "Python 解释器不存在"):
                    _paths.set_ga_root(str(ga_root), str(root / "missing-python"))
                self.assertFalse(config_file.exists())

    def test_set_ga_root_saves_python_path(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            admin_data = root / "admin-data"
            config_file = admin_data / "config.json"
            ga_root = root / "GenericAgent"
            (ga_root / "memory").mkdir(parents=True)
            (ga_root / "agentmain.py").write_text("", "utf-8")
            python_path = _touch_python(root / "python")

            with mock.patch.object(_paths, "ADMIN_DATA", admin_data), \
                 mock.patch.object(_paths, "CONFIG_FILE", config_file):
                _paths.set_ga_root(str(ga_root), str(python_path))

            saved = json.loads(config_file.read_text("utf-8"))
            self.assertEqual(saved["ga_root"], str(ga_root.resolve()))
            self.assertEqual(saved["python_path"], str(python_path.resolve()))


if __name__ == "__main__":
    unittest.main()
