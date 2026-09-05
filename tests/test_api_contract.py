"""Tests for the generated backend API contract."""
from __future__ import annotations

import json
import os
import runpy
import shutil
import subprocess
import sys
import unittest
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import mock
from pathlib import Path


from server.main import app


ROOT = Path(__file__).resolve().parents[1]
OPENAPI_PATH = ROOT / "docs" / "api" / "openapi.json"


class GeneratedApiContractTests(unittest.TestCase):
    def test_checked_in_openapi_matches_running_app(self) -> None:
        """Fail when routes or schemas change without regenerating the artifact."""
        with OPENAPI_PATH.open(encoding="utf-8") as handle:
            checked_in = json.load(handle)

        self.assertEqual(app.openapi(), checked_in)

    def test_generated_typescript_contract_is_fresh(self) -> None:
        """schema.d.ts must match docs/api/openapi.json (webui checker)."""
        webui = ROOT / "webui"
        npm = shutil.which("npm")
        if npm is None or not (webui / "node_modules" / "openapi-typescript").exists():
            self.skipTest("webui toolchain not installed")
        run = subprocess.run(
            [npm, "run", "api:check"],
            cwd=webui,
            capture_output=True,
            text=True,
            shell=os.name == "nt",
            encoding="utf-8",
            errors="replace",
        )
        detail = "api contract stale:" + chr(10) + run.stdout + run.stderr
        self.assertEqual(run.returncode, 0, detail)

    def test_exporter_refuses_setup_mode_document(self) -> None:
        script = runpy.run_path(str(ROOT / "scripts" / "export_openapi.py"))
        script["main"].__globals__["app"] = SimpleNamespace(
            openapi=lambda: {"info": {"title": "GA Hub API (setup mode)"}}
        )

        with TemporaryDirectory() as temporary:
            output = Path(temporary) / "openapi.json"
            argv = ["export_openapi.py", "--output", str(output)]
            with mock.patch.object(sys, "argv", argv):
                with self.assertRaises(SystemExit) as refusal:
                    script["main"]()

        self.assertIn("Refusing to export setup-mode OpenAPI", str(refusal.exception))


if __name__ == "__main__":
    unittest.main()
