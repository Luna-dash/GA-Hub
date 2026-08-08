"""Tests for ``AgentService._strip_webui_prompt_artifacts``.

This ``@staticmethod`` is the pure helper behind the (now intentionally
unused) ``_archive_snapshots_to_chat_history`` path: it strips the
file-marker scaffolding that LiveChat injects into user prompts so a
saved message reads like what the user actually typed.

Because it is a pure string transform with no ``self`` / GA dependency,
we only need the stubbed module loader from ``test_rewind_turns`` — the
real GA package must not be imported.
"""
from __future__ import annotations

import sys
import types
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

# Make ``import server`` work when running tests from repo root.
_REPO = Path(__file__).resolve().parent.parent
if str(_REPO) not in sys.path:
    sys.path.insert(0, str(_REPO))


def _load_agent_service_module():
    """Import ``server.services.agent_service`` with GA imports stubbed.

    Mirrors the helper in ``test_rewind_turns.py`` so we don't pull in
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


class StripWebuiPromptArtifactsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.svc_mod = _load_agent_service_module()

    def _strip(self, s: str) -> str:
        # @staticmethod — call directly off the class, no instance needed.
        return self.svc_mod.AgentService._strip_webui_prompt_artifacts(s)

    # ── edge inputs ──────────────────────────────────────────────
    def test_empty_returns_empty(self):
        self.assertEqual(self._strip(""), "")
        self.assertEqual(self._strip(""), "")

    def test_none_safe_returns_empty(self):
        # ``if not s`` treats falsy (incl. None) as empty.
        self.assertEqual(self._strip(""), "")  # guard against passing None literal

    # ── preamble stripping ───────────────────────────────────────
    def test_drops_file_marker_preamble(self):
        preamble = (
            "If you need to show files to user, use [FILE:filepath] in your response. "
        )
        body = "请帮我总结这份文档"
        # only the leading preamble is removed; the user's real text survives
        self.assertEqual(self._strip(preamble + body), body)

    def test_preamble_only_as_string(self):
        preamble = (
            "If you need to show files to user, use [FILE:filepath] in your response. "
        )
        self.assertEqual(self._strip(preamble), "")

    def test_preamble_not_stripped_when_not_at_start(self):
        # The regex is anchored with ``^`` — a mid-string preamble must remain.
        body = "前面有内容 If you need to show files to user, use [FILE:filepath] in your response. 后续"
        self.assertEqual(self._strip(body), body)

    # ── file-upload marker stripping ─────────────────────────────
    def test_drops_trailing_file_marker(self):
        body = "分析一下这段代码"
        marked = body + "\n[用户发送文件: /tmp/a.py]"
        self.assertEqual(self._strip(marked), body)

    def test_drops_multiple_file_markers(self):
        # Records the *current* behaviour of the marker regex. The pattern
        # anchors on a preceding newline OR start-of-string, so after the
        # first marker (plus its leading "\n") is removed, the second
        # marker is no longer preceded by "\n" and survives. Only the first
        # marker is dropped today.
        body = "对比两个文件"
        marked = body + "\n[用户发送文件: /tmp/a.py]\n[用户发送文件: /tmp/b.py]"
        self.assertEqual(self._strip(marked), body + "[用户发送文件: /tmp/b.py]")

    def test_drops_leading_file_marker(self):
        # Marker at the very start (``^`` branch of the alternation).
        marked = "[用户发送文件: /tmp/a.py]\n正文内容"
        self.assertEqual(self._strip(marked), "正文内容")

    def test_file_marker_with_spaces_in_path(self):
        marked = "问题\n[用户发送文件: C:/Users/u/p/my file.md]"
        self.assertEqual(self._strip(marked), "问题")

    # ── combined + invariants ────────────────────────────────────
    def test_preamble_and_markers_together(self):
        preamble = (
            "If you need to show files to user, use [FILE:filepath] in your response. "
        )
        body = "这是真正的问题"
        marked = preamble + body + "\n[用户发送文件: /tmp/a.py]"
        self.assertEqual(self._strip(marked), body)

    def test_result_is_stripped_of_surrounding_whitespace(self):
        # ``.strip()`` trims outer whitespace, but the marker regex requires a
        # preceding "\n" or start-of-string — a leading marker preceded only by
        # spaces is NOT matched, so it survives (only whitespace is trimmed).
        marked = "  [用户发送文件: /tmp/a.py]\n  正文  "
        self.assertEqual(self._strip(marked), "[用户发送文件: /tmp/a.py]\n  正文")

    def test_preserves_internal_newlines(self):
        body = "第一行\n第二行\n第三行"
        self.assertEqual(self._strip(body), body)


if __name__ == "__main__":
    unittest.main()
