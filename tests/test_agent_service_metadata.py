"""Unit tests for read-only LLM/Mixin metadata."""
from __future__ import annotations

import unittest

from server.services.agent_service import _llm_membership_metadata


class SingleBackend:
    def __init__(self, name: str):
        self.name = name


class MixinSession:
    def __init__(self, names: list[str], current_name: str):
        self._sessions = [SingleBackend(name) for name in names]
        self.current_name = current_name


class LlmMembershipMetadataTests(unittest.TestCase):
    def test_aggregates_members_across_every_mixin(self):
        backends = [
            SingleBackend("alpha"),
            SingleBackend("beta"),
            SingleBackend("gamma"),
            MixinSession(["alpha", "beta"], "beta"),
            MixinSession(["gamma", "alpha", "gamma"], "gamma"),
        ]

        rows = _llm_membership_metadata(backends)

        self.assertEqual([row["in_mixin"] for row in rows[:3]], [True, True, True])
        self.assertEqual(rows[3], {
            "kind": "mixin",
            "members": ["alpha", "beta"],
            "active_member": "beta",
            "in_mixin": False,
        })
        self.assertEqual(rows[4]["members"], ["gamma", "alpha"])
        self.assertEqual(rows[4]["active_member"], "gamma")

    def test_handles_missing_backend_and_unnamed_members(self):
        unnamed = SingleBackend("")
        rows = _llm_membership_metadata([None, MixinSession(["alpha", ""], "")])
        rows_with_unnamed = _llm_membership_metadata([unnamed])

        self.assertEqual(rows[0], {
            "kind": "single",
            "members": [],
            "active_member": "",
            "in_mixin": False,
        })
        self.assertEqual(rows[1]["members"], ["alpha"])
        self.assertFalse(rows_with_unnamed[0]["in_mixin"])


if __name__ == "__main__":
    unittest.main()
