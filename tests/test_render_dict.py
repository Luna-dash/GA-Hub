"""Tests for ``server.routes.mykey._render_value`` / ``_render_dict``.

Locks the rendering style so future edits to mykey.py round-trip cleanly
through ``ast.literal_eval`` and stay diff-friendly with hand-written
config.
"""
from __future__ import annotations

import ast
import sys
import unittest
from pathlib import Path

# Allow ``import server`` when tests are run via ``python -m unittest`` from
# either the repo root or anywhere else.
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.routes.mykey import _render_dict, _render_value  # noqa: E402


class RenderValuePrimitivesTests(unittest.TestCase):
    def test_bool_none_int_float(self):
        self.assertEqual(_render_value(True), "True")
        self.assertEqual(_render_value(False), "False")
        self.assertEqual(_render_value(None), "None")
        self.assertEqual(_render_value(42), "42")
        self.assertEqual(_render_value(1.5), "1.5")

    def test_string_uses_double_quotes(self):
        self.assertEqual(_render_value("hello"), '"hello"')

    def test_string_keeps_unicode_unescaped(self):
        # ensure_ascii=False so non-ASCII is human-readable in source.
        self.assertEqual(_render_value("你好"), '"你好"')

    def test_empty_collections(self):
        self.assertEqual(_render_value({}), "{}")
        self.assertEqual(_render_value([]), "[]")
        self.assertEqual(_render_value(()), "()")


class RenderListInlineVsBlockTests(unittest.TestCase):
    def test_short_list_inline(self):
        self.assertEqual(_render_value([1, 2, 3]), "[1, 2, 3]")

    def test_long_list_breaks(self):
        items = [f"item-{i}" for i in range(20)]
        out = _render_value(items)
        self.assertIn("\n", out)
        self.assertTrue(out.startswith("[\n"))
        self.assertTrue(out.endswith("]"))


class RenderDictRoundTripTests(unittest.TestCase):
    """The most important guarantee: ast.literal_eval(render(d)) == d."""

    def _round_trip(self, d: dict) -> None:
        rendered = _render_dict(d)
        parsed = ast.literal_eval(rendered)
        self.assertEqual(parsed, d)

    def test_simple_dict(self):
        self._round_trip({"a": 1, "b": "two"})

    def test_mixin_like_payload(self):
        # Mirrors the real shape that triggered the original indent bug:
        # a dict with reordered ``llm_nos`` lists.
        self._round_trip({
            "name": "main",
            "llm_nos": [3, 1, 2],
            "policy": "round_robin",
            "fallback": True,
        })

    def test_nested_structures(self):
        self._round_trip({
            "sessions": [
                {"var": "a", "type": "claude", "fields": {"k": "v"}},
                {"var": "b", "type": "mixin", "fields": {"llm_nos": [1, 2]}},
            ],
            "globals": {"timeout": 30, "tags": ["x", "y"]},
            "empty_list": [],
            "empty_dict": {},
        })

    def test_unicode_keys_and_values(self):
        self._round_trip({"名字": "你好", "list": ["甲", "乙"]})


class RenderDictStyleTests(unittest.TestCase):
    """Style is part of the contract — we want a clean diff vs. hand edits."""

    def test_dict_uses_4_space_indent_per_level(self):
        out = _render_dict({"outer": {"inner": 1}})
        # Outer key is indented 4 spaces, inner key 8 spaces.
        self.assertIn('\n    "outer":', out)
        self.assertIn('\n        "inner": 1', out)

    def test_dict_has_trailing_comma(self):
        out = _render_dict({"a": 1, "b": 2})
        # Last value before closing brace ends with a comma.
        self.assertIn("2,\n}", out)

    def test_insertion_order_preserved(self):
        d = {"c": 1, "a": 2, "b": 3}
        out = _render_dict(d)
        ic = out.index('"c"')
        ia = out.index('"a"')
        ib = out.index('"b"')
        self.assertLess(ic, ia)
        self.assertLess(ia, ib)

    def test_continuation_indent_relative_to_level_not_caller_column(self):
        """Regression: the original bug was indent being relative to the
        ``var = `` column instead of the nesting level. Render in isolation
        and confirm continuations align at column 4, not at some larger
        offset that would only make sense if it followed an assignment.
        """
        out = _render_dict({"name": "x", "llm_nos": [1, 2, 3, 4]})
        # All top-level keys start at column 4 (one indent level deep).
        for line in out.splitlines()[1:-1]:  # skip "{" and "}" lines
            if line.strip().startswith('"'):
                self.assertTrue(
                    line.startswith('    "'),
                    f"top-level key should sit at col 4, got: {line!r}",
                )


if __name__ == "__main__":
    unittest.main()
