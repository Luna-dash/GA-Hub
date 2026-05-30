"""Tests for ``AgentService.rewind_turns``.

We don't run the real ``__init__`` (which imports the GA agent and binds
hooks). Instead we build a minimal stub instance via ``object.__new__``
and feed the smallest set of attributes the method touches:
  * ``agent.is_running`` flag (must be False)
  * ``agent.llmclient.backend.history`` (the list it cuts)
  * ``agent.history`` (TUI-parity log; appended on success)
  * ``_snapshots`` ordered dict (sid → snapshot, snapshot.done flag)
  * ``_lock``

This isolates the rewind algorithm from GA bootstrap costs.
"""
from __future__ import annotations

import sys
import threading
import types
import unittest
from collections import OrderedDict
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

# Make ``import server`` work when running tests from repo root.
_REPO = Path(__file__).resolve().parent.parent
if str(_REPO) not in sys.path:
    sys.path.insert(0, str(_REPO))


def _load_agent_service_module():
    """Import ``server.services.agent_service`` with GA imports stubbed.

    Mirrors the helper in ``test_paths_python.py`` so we don't pull in
    the real GA package just to read the class definition.
    """
    from server import _paths  # local import; needs sys.path bootstrap above

    fake_ga = types.SimpleNamespace()
    fake_ga.web_scan = lambda **_kw: {"status": "in-process"}
    fake_ga.web_execute_js = lambda *_a, **_kw: {"status": "in-process"}
    fake_ga.subprocess = types.SimpleNamespace(Popen=lambda *_a, **_kw: None)

    fake_agentmain = types.ModuleType("agentmain")
    fake_agentmain.GeneraticAgent = type("GeneraticAgent", (), {})

    fake_continue = types.ModuleType("frontends.continue_cmd")
    fake_continue.install = lambda *_a, **_kw: None
    fake_continue.reset_conversation = lambda *_a, **_kw: None

    modules = {
        "ga": fake_ga,
        "agentmain": fake_agentmain,
        "frontends": types.ModuleType("frontends"),
        "frontends.continue_cmd": fake_continue,
    }
    with TemporaryDirectory() as td:
        with mock.patch.object(_paths, "GA_ROOT", Path(td)), \
             mock.patch.object(_paths, "discover_user_python", return_value="/tmp/py"), \
             mock.patch.dict(sys.modules, modules):
            sys.modules.pop("server.services.agent_service", None)
            import importlib
            return importlib.import_module("server.services.agent_service")


def _make_user_msg(text: str) -> dict:
    """A 'real' user turn — content list with a text block (TUI parity)."""
    return {"role": "user", "content": [{"type": "text", "text": text}]}


def _make_tool_result(tool_use_id: str = "tu_1") -> dict:
    """Tool-result user message — must be skipped by rewind cut detection."""
    return {
        "role": "user",
        "content": [{"type": "tool_result", "tool_use_id": tool_use_id, "content": "ok"}],
    }


def _make_assistant(text: str) -> dict:
    return {"role": "assistant", "content": [{"type": "text", "text": text}]}


class RewindTurnsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.svc_mod = _load_agent_service_module()

    def _make_svc(self, history: list[dict], snapshots: list[tuple[str, bool]]):
        """Build a minimal AgentService stub.

        ``snapshots`` is a list of ``(sid, done)`` pairs in insertion order.
        """
        AgentService = self.svc_mod.AgentService
        svc = object.__new__(AgentService)  # bypass __init__
        svc._lock = threading.RLock()
        svc._snapshots = OrderedDict()
        for sid, done in snapshots:
            snap = types.SimpleNamespace(done=done)
            svc._snapshots[sid] = snap

        backend = types.SimpleNamespace(history=list(history))
        llmclient = types.SimpleNamespace(backend=backend)
        svc.agent = types.SimpleNamespace(
            is_running=False,
            llmclient=llmclient,
            history=[],  # GA working-memory log
        )
        return svc

    # ── happy paths ────────────────────────────────────────────────

    def test_rewind_by_n_drops_last_turn(self):
        history = [
            _make_user_msg("u1"), _make_assistant("a1"),
            _make_user_msg("u2"), _make_assistant("a2"),
        ]
        svc = self._make_svc(history, [("s1", True), ("s2", True)])

        # Patch the module-level ``bus`` so publish doesn't spam a real bus.
        with mock.patch.object(self.svc_mod, "bus", mock.MagicMock()) as fake_bus:
            result = svc.rewind_turns(n=1)

        self.assertEqual(result["removed_sids"], ["s2"])
        self.assertEqual(result["kept"], 1)
        self.assertEqual(result["history_lines"], 2)  # u1 + a1 only
        self.assertEqual(result["removed_history_entries"], 2)
        self.assertNotIn("s2", svc._snapshots)
        self.assertIn("s1", svc._snapshots)
        self.assertEqual(svc.agent.history, ["[USER]: /rewind 1"])
        fake_bus.publish.assert_called_once()
        topic, payload = fake_bus.publish.call_args[0]
        self.assertEqual(topic, "chat:rewound")
        self.assertEqual(payload["removed_sids"], ["s2"])

    def test_rewind_by_sid_drops_that_turn_and_all_after(self):
        history = [
            _make_user_msg("u1"), _make_assistant("a1"),
            _make_user_msg("u2"), _make_assistant("a2"),
            _make_user_msg("u3"), _make_assistant("a3"),
        ]
        svc = self._make_svc(history, [
            ("s1", True), ("s2", True), ("s3", True),
        ])
        with mock.patch.object(self.svc_mod, "bus", mock.MagicMock()):
            result = svc.rewind_turns(sid="s2")

        # s2 and s3 both gone, s1 kept.
        self.assertEqual(result["removed_sids"], ["s2", "s3"])
        self.assertEqual(list(svc._snapshots.keys()), ["s1"])
        self.assertEqual(result["history_lines"], 2)

    def test_rewind_skips_tool_result_messages(self):
        # Real shape: u1, assistant-with-tool-use, tool_result (user role!), assistant final, u2, a2
        # Only u1 and u2 should count as "real" user turns.
        history = [
            _make_user_msg("u1"),
            _make_assistant("calling tool"),
            _make_tool_result(),                     # role=user but tool_result → skip
            _make_assistant("after tool"),
            _make_user_msg("u2"),
            _make_assistant("a2"),
        ]
        svc = self._make_svc(history, [("s1", True), ("s2", True)])

        with mock.patch.object(self.svc_mod, "bus", mock.MagicMock()):
            result = svc.rewind_turns(n=1)

        # Cut at u2 (index 4) → keep first 4 entries.
        self.assertEqual(result["history_lines"], 4)
        self.assertEqual(result["removed_history_entries"], 2)
        self.assertEqual(result["removed_sids"], ["s2"])

    # ── error paths ────────────────────────────────────────────────

    def test_rewind_refuses_while_running(self):
        svc = self._make_svc([_make_user_msg("u1"), _make_assistant("a1")],
                             [("s1", True)])
        svc.agent.is_running = True
        with self.assertRaises(RuntimeError) as cm:
            svc.rewind_turns(n=1)
        self.assertIn("running", str(cm.exception).lower())

    def test_rewind_with_no_done_turns_raises(self):
        svc = self._make_svc([], [("s1", False)])  # snapshot exists but not done
        with self.assertRaises(ValueError) as cm:
            svc.rewind_turns(n=1)
        self.assertIn("no completed turns", str(cm.exception).lower())

    def test_rewind_n_out_of_range(self):
        svc = self._make_svc(
            [_make_user_msg("u1"), _make_assistant("a1")],
            [("s1", True)],
        )
        with mock.patch.object(self.svc_mod, "bus", mock.MagicMock()):
            with self.assertRaises(ValueError):
                svc.rewind_turns(n=2)
            with self.assertRaises(ValueError):
                svc.rewind_turns(n=0)

    def test_rewind_unknown_sid_raises(self):
        svc = self._make_svc(
            [_make_user_msg("u1"), _make_assistant("a1")],
            [("s1", True)],
        )
        with self.assertRaises(ValueError) as cm:
            svc.rewind_turns(sid="nope")
        self.assertIn("not found", str(cm.exception).lower())

    def test_rewind_requires_sid_or_n(self):
        svc = self._make_svc(
            [_make_user_msg("u1"), _make_assistant("a1")],
            [("s1", True)],
        )
        with self.assertRaises(ValueError):
            svc.rewind_turns()


if __name__ == "__main__":
    unittest.main()
