"""Tests for ``AgentService._on_turn_end``.

The hook is a thin forwarder: it re-publishes a handful of fields from
the turn-end ``ctx`` onto the module-level event ``bus`` under the
``"agent:turn"`` topic. It touches no instance state, so we bypass
``__init__`` (which binds the real GA agent) with
``object.__new__`` — mirroring ``test_rewind_turns.py``.
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

# Make ``import server`` work when running tests from repo root.
_REPO = Path(__file__).resolve().parent.parent
if str(_REPO) not in sys.path:
    sys.path.insert(0, str(_REPO))


def _load_agent_service_module():
    """Import ``server.services.agent_service`` with GA imports stubbed."""
    from server import _paths  # noqa: F401  (sets up GA-side sys.path stubs)
    import importlib
    return importlib.import_module("server.services.agent_service")


class OnTurnEndTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.svc_mod = _load_agent_service_module()

    def _make_svc(self):
        """Bypass ``__init__``; the hook uses no instance state."""
        return object.__new__(self.svc_mod.AgentService)  # type: ignore[arg-type]

    def test_publishes_agent_turn_topic(self):
        svc = self._make_svc()
        with mock.patch.object(self.svc_mod, "bus", mock.MagicMock()) as fake_bus:
            svc._on_turn_end({"turn": 3, "summary": "ok", "exit_reason": "done"})
        fake_bus.publish.assert_called_once()
        topic, payload = fake_bus.publish.call_args.args
        self.assertEqual(topic, "agent:turn")

    def test_forwards_all_three_fields(self):
        svc = self._make_svc()
        ctx = {"turn": 7, "summary": "compiling", "exit_reason": "tool_call"}
        with mock.patch.object(self.svc_mod, "bus", mock.MagicMock()) as fake_bus:
            svc._on_turn_end(ctx)
        _, payload = fake_bus.publish.call_args.args
        self.assertEqual(payload, {
            "turn": 7,
            "summary": "compiling",
            "exit_reason": "tool_call",
        })

    def test_missing_keys_become_none(self):
        svc = self._make_svc()
        with mock.patch.object(self.svc_mod, "bus", mock.MagicMock()) as fake_bus:
            svc._on_turn_end({"turn": 1})  # summary / exit_reason absent
        _, payload = fake_bus.publish.call_args.args
        self.assertEqual(payload, {
            "turn": 1,
            "summary": None,
            "exit_reason": None,
        })

    def test_empty_ctx_all_none(self):
        svc = self._make_svc()
        with mock.patch.object(self.svc_mod, "bus", mock.MagicMock()) as fake_bus:
            svc._on_turn_end({})
        _, payload = fake_bus.publish.call_args.args
        self.assertEqual(payload, {
            "turn": None,
            "summary": None,
            "exit_reason": None,
        })

    def test_extra_keys_not_forwarded(self):
        svc = self._make_svc()
        ctx = {"turn": 2, "summary": "x", "exit_reason": "y", "extra": 42}
        with mock.patch.object(self.svc_mod, "bus", mock.MagicMock()) as fake_bus:
            svc._on_turn_end(ctx)
        _, payload = fake_bus.publish.call_args.args
        self.assertNotIn("extra", payload)
        self.assertEqual(len(payload), 3)


if __name__ == "__main__":
    unittest.main()
