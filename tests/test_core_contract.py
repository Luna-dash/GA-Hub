"""Tests for the GA core contract probe (P0).

Two concerns are covered:

* **Structure / serialization** — ``ContractReport`` / ``Check`` shape and
  ``to_dict`` output, exercised in an isolated setup-mode environment (no
  GA_ROOT) so they never touch a real GenericAgent checkout.

* **Live contract** — when a real GA_ROOT is configured, the probe must pass
  against the *actual* GA core source, and every hard dependency declared in
  ``core_contract`` must still be present there. This is the drift guard: if
  GA core removes/renames a symbol that ``agent_service`` calls, this test
  fails loudly instead of letting chat silently break.
"""
from __future__ import annotations

import os
import subprocess
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock


class ContractReportStructureTests(unittest.TestCase):
    """Pure shape tests — no real GA core, no network."""

    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        self._env = mock.patch.dict(
            os.environ,
            {
                "GA_ADMIN_DATA": self._tmp.name,
                # Unset GA_ROOT → probe reports not_configured deterministically.
                "GA_ROOT": "",
            },
            clear=False,
        )
        self._env.start()
        # discover_ga_root() may resolve the real GA checkout on the dev box
        # even when GA_ROOT is unset (it walks parent dirs). Force the
        # module-level attr to None so these shape tests are environment-agnostic.
        import server._paths as paths
        self._root_patch = mock.patch.object(paths, "GA_ROOT", None)
        self._root_patch.start()

    def tearDown(self) -> None:
        self._root_patch.stop()
        self._env.stop()
        self._tmp.cleanup()

    def test_not_configured_report_shape(self):
        from server.services import core_contract

        report = core_contract.probe_core_contract()
        self.assertFalse(report.ok)
        self.assertIsNone(report.ga_root)
        self.assertEqual(report.items, [])
        self.assertEqual(len(report.errors), 1)
        self.assertIn("not_configured", report.errors[0])

    def test_to_dict_round_trip(self):
        from server.services import core_contract
        from dataclasses import asdict

        report = core_contract.probe_core_contract()
        d = report.to_dict()
        # to_dict must produce plain JSON-serializable primitives.
        self.assertIsInstance(d, dict)
        self.assertIn("ok", d)
        self.assertIn("errors", d)
        self.assertIn("items", d)
        self.assertEqual(d["items"], [])
        self.assertIsInstance(d["errors"], list)
        # Items (when present) are dicts, not dataclass instances.
        rep2 = core_contract.ContractReport(
            ga_root="x", core_commit=None, ok=False,
            items=[core_contract.Check("n", False, "d")],
            errors=["e"],
        )
        self.assertEqual(rep2.to_dict()["items"], [{"name": "n", "ok": False, "detail": "d"}])

    def test_git_probe_does_not_inherit_desktop_owner_pipe(self):
        from server.services import core_contract

        completed = subprocess.CompletedProcess([], 0, stdout="abc123\n", stderr="")
        with mock.patch("subprocess.run", return_value=completed) as run:
            self.assertEqual(core_contract._core_commit(Path("C:/ga")), "abc123")

        self.assertIs(run.call_args.kwargs["stdin"], subprocess.DEVNULL)


class LiveContractTests(unittest.TestCase):
    """Run against the real GA core if GA_ROOT resolves to a checkout."""

    def setUp(self) -> None:
        import server._paths as paths

        # The probe reads `_paths.GA_ROOT` (a module attr resolved at import),
        # not os.environ — so we patch that attr directly. Prefer the recent
        # configured checkout; else a sibling ``../GA`` (the paired-checkout
        # convention ``test_paired_repo_contract`` already relies on) so this
        # guard actually runs on a dev box instead of silently skipping.
        discovered = paths.discover_ga_root()
        env_root = os.environ.get("GA_ROOT") or ""
        sibling = Path(__file__).resolve().parents[1].parent / "GA"
        if discovered is not None:
            self._ga_root = discovered
        elif env_root and os.path.isdir(env_root):
            self._ga_root = Path(env_root)
        elif (sibling / "agentmain.py").is_file():
            self._ga_root = sibling
        else:
            self._ga_root = None
        if self._ga_root is not None:
            self._patch = mock.patch.object(paths, "GA_ROOT", self._ga_root)
            self._patch.start()

    def tearDown(self) -> None:
        if getattr(self, "_patch", None) is not None:
            self._patch.stop()

    def _skip_if_no_core(self):
        if self._ga_root is None:
            self.skipTest("no GA_ROOT configured — live contract test needs a real GA core")

    def test_probe_passes_against_real_core(self):
        self._skip_if_no_core()
        from server.services import core_contract

        report = core_contract.probe_core_contract()
        self.assertTrue(
            report.ok,
            f"core contract probe failed against {report.ga_root}: {report.errors}",
        )
        self.assertIsNotNone(report.core_commit)
        self.assertTrue(report.items)

    def test_declared_symbols_match_real_source(self):
        """Every hard dependency in core_contract must exist in real GA core.

        This is the drift guard: rename/removal of a contract symbol surfaces
        here, not as an opaque runtime error in agent_service.
        """
        self._skip_if_no_core()
        from server.services import core_contract
        import importlib
        import inspect

        report = core_contract.probe_core_contract()
        self.assertTrue(report.ok, report.errors)

        # Cross-check each declared set against the live symbols directly, so a
        # future probe implementation change can't mask a real drift.
        import agentmain
        GA = agentmain.GeneraticAgent
        for name in core_contract._REQUIRED_CLASS_MEMBERS:
            self.assertTrue(
                callable(getattr(GA, name, None)),
                f"drift: GeneraticAgent.{name} no longer callable in real core",
            )
        for attr in core_contract._REQUIRED_INIT_ATTRS:
            import re
            src = inspect.getsource(GA.__init__)
            self.assertTrue(
                re.search(rf"\bself\.{re.escape(attr)}\b\s*[:=]", src),
                f"drift: GeneraticAgent.__init__ no longer assigns self.{attr}",
            )
        for module_name, names in core_contract._REQUIRED_GA_SYMBOLS.items():
            module = importlib.import_module(module_name)
            for name in names:
                self.assertTrue(
                    callable(getattr(module, name, None)),
                    f"drift: {module_name}.{name} no longer callable in real core",
                )

    def test_probe_names_the_symbol_a_ga_upgrade_removed(self):
        """A renamed bridge function must be reported as *that symbol*.

        The whole point of the widened declaration is diagnosability: the user
        sees which GA symbol is gone instead of an ``ImportError`` from a
        worker thread. Simulate a GA upgrade that dropped one workspace
        function and assert the probe names it.
        """
        self._skip_if_no_core()
        import sys
        import types

        from server.services import core_contract

        stub = types.ModuleType("frontends.gahub.bridge.workspace")
        for name in ("list_workspaces", "prepare_workspace", "get_workspace"):
            setattr(stub, name, lambda *a, **k: None)  # remove_workspace: gone

        with mock.patch.dict(
            sys.modules, {"frontends.gahub.bridge.workspace": stub}
        ):
            report = core_contract.probe_core_contract()

        self.assertFalse(report.ok)
        failed = [c.name for c in report.items if not c.ok]
        self.assertIn("frontends.gahub.bridge.workspace.remove_workspace", failed)
        self.assertTrue(
            any("remove_workspace" in err for err in report.errors),
            report.errors,
        )

    def test_declaration_does_not_require_ga_symbols_hub_stopped_calling(self):
        """The startup gate must not fail chat for a symbol nothing calls.

        ``frontends.continue_cmd.install`` / ``reset_conversation`` were pinned
        here long after Hub moved to ``frontends.gahub.bridge.session``; GA
        dropping them would have turned chat into a 503 for no reason.
        """
        self._skip_if_no_core()
        from server.services import core_contract

        declared = {
            f"{module}.{name}"
            for module, names in core_contract._REQUIRED_GA_SYMBOLS.items()
            for name in names
        }
        self.assertNotIn("frontends.continue_cmd.install", declared)
        self.assertNotIn("frontends.continue_cmd.reset_conversation", declared)


if __name__ == "__main__":
    unittest.main()
