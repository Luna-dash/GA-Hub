"""Public behavior contracts for the side-effect-free MyKey codec."""
from __future__ import annotations

import ast
import unittest

from server.services.mykey_codec import (
    AssignmentConflictError,
    AssignmentNotFoundError,
    InvalidSourceError,
    InvalidVariableNameError,
    classify_config,
    delete_assignment,
    delete_base_assignment,
    duplicate_assignment,
    rename_assignment,
    render_assign,
    structurize,
    upsert_assignment,
    validate_text,
)


class MyKeyCodecTests(unittest.TestCase):
    def test_structurize_buckets_supported_configs_and_preserves_fields(self) -> None:
        raw = '''\
native_claude_api = {"apikey": "secret", "model": "sonnet"}
oai_config = {"apikey": "other", "model": "gpt"}
mixin_config = {"llm_nos": [1, 2]}
proxy = "http://localhost:7890"
dynamic = make_config()
'''

        result = structurize(raw)

        self.assertEqual([item["type"] for item in result["sessions"]], ["native_claude", "oai"])
        self.assertEqual(result["sessions"][0]["fields"]["apikey"], "secret")
        self.assertEqual(result["mixins"][0]["fields"]["llm_nos"], [1, 2])
        self.assertNotIn("mixin", result)
        self.assertEqual(result["globals"], {"proxy": "http://localhost:7890"})

    def test_invalid_source_returns_empty_structure(self) -> None:
        self.assertEqual(
            structurize("broken = {") ,
            {"sessions": [], "mixins": [], "globals": {}},
        )

    def test_validate_text_reports_syntax_location_without_executing(self) -> None:
        ok, message, line, column = validate_text("token = {\n")
        self.assertFalse(ok)
        self.assertIsInstance(message, str)
        self.assertEqual(line, 1)
        self.assertIsInstance(column, int)

    def test_render_assign_round_trips_literal(self) -> None:
        rendered = render_assign("oai_config", {"apikey": "abc", "models": ["a", "b"]})
        self.assertTrue(rendered.startswith("oai_config = "))
        assignment = ast.parse(rendered).body[0]
        self.assertIsInstance(assignment, ast.Assign)
        self.assertEqual(ast.literal_eval(assignment.value), {"apikey": "abc", "models": ["a", "b"]})

    def test_classification_matches_agent_session_names(self) -> None:
        self.assertEqual(classify_config("native_claude_api"), "native_claude")
        self.assertEqual(classify_config("native_oai_config"), "native_oai")
        self.assertEqual(classify_config("mixin_config"), "mixin")
        self.assertEqual(classify_config("proxy"), "global")

    def test_upsert_replaces_assignment_and_preserves_blank_apikey(self) -> None:
        raw = 'before = 1\nnative_oai_config = {"apikey": "secret", "model": "old"}\nafter = 2\n'
        out = upsert_assignment(
            raw,
            "native_oai_config",
            {"apikey": "***", "model": "new"},
        )
        self.assertEqual(out.count("native_oai_config ="), 1)
        self.assertIn('"apikey": "secret"', out)
        self.assertIn('"model": "new"', out)
        self.assertTrue(out.startswith("before = 1\n"))
        self.assertTrue(out.endswith("after = 2\n"))

    def test_upsert_appends_new_assignment_to_valid_source(self) -> None:
        out = upsert_assignment("global_value = 1\n", "oai_config", {"model": "gpt"})
        self.assertNotIn("# ── 通过 webui 新增 ──", out)
        self.assertIn("oai_config", out)
        self.assertIn("oai_config =", out)
        self.assertEqual(validate_text(out)[0], True)

    def test_delete_assignment_removes_only_named_assignment(self) -> None:
        raw = 'one = {"x": 1}\ntwo = {"x": 2}\n'
        self.assertEqual(delete_assignment(raw, "one"), 'two = {"x": 2}\n')
        with self.assertRaises(AssignmentNotFoundError):
            delete_assignment(raw, "missing")

    def test_mutations_reject_invalid_existing_source(self) -> None:
        with self.assertRaises(InvalidSourceError):
            upsert_assignment("broken = {\n", "new_config", {})
        with self.assertRaises(InvalidSourceError):
            delete_assignment("broken = {\n", "broken")

    def test_delete_base_assignment_preserves_source_order_indexes(self) -> None:
        raw = '''mixin_config = {"llm_nos": [0, 1, 2]}
alpha_oai_config = {"name": "alpha", "apikey": "secret"}
beta_oai_config = {"name": "beta", "apikey": "other"}
'''

        updated, removed = delete_base_assignment(raw, "alpha_oai_config")
        rendered = structurize(updated)
        self.assertEqual(removed, 1)
        self.assertEqual(rendered["mixins"][0]["fields"]["llm_nos"], [0, 1])
        self.assertFalse(any(item["var"] == "alpha_oai_config" for item in rendered["sessions"]))
    def test_rename_replaces_in_place_and_keeps_masked_apikey(self) -> None:
        raw = '''first = {"value": 1}
old_oai_config = {"apikey": "secret", "model": "gpt"}
last = {"value": 3}
'''

        updated = rename_assignment(
            raw,
            "old_oai_config",
            "renamed_oai_config",
            {"apikey": "***", "model": "gpt-4o"},
        )

        self.assertLess(updated.index("first"), updated.index("renamed_oai_config"))
        self.assertLess(updated.index("renamed_oai_config"), updated.index("last"))
        self.assertNotIn("old_oai_config", updated)
        self.assertEqual(
            ast.literal_eval(ast.parse(updated).body[1].value),
            {"apikey": "secret", "model": "gpt-4o"},
        )

    def test_duplicate_is_inserted_after_source(self) -> None:
        raw = '''first = {"value": 1}
source_oai_config = {"apikey": "secret", "model": "gpt"}
last = {"value": 3}
'''

        updated = duplicate_assignment(raw, "source_oai_config", "copy_oai_config")

        self.assertLess(updated.index("source_oai_config"), updated.index("copy_oai_config"))
        self.assertLess(updated.index("copy_oai_config"), updated.index("last"))
        self.assertEqual(structurize(updated)["sessions"][1]["var"], "copy_oai_config")

    def test_structured_mutations_reject_name_collisions(self) -> None:
        raw = 'source_oai_config = {"apikey": "secret"}\ntarget_oai_config = {}\n'
        with self.assertRaises(AssignmentConflictError):
            rename_assignment(raw, "source_oai_config", "target_oai_config")
        with self.assertRaises(AssignmentConflictError):
            duplicate_assignment(raw, "source_oai_config", "target_oai_config")
        with self.assertRaises(InvalidVariableNameError):
            duplicate_assignment(raw, "source_oai_config", "not-a-name")

    def test_upsert_new_assignment_does_not_add_webui_comment(self) -> None:
        updated = upsert_assignment("existing = {}\n", "new_oai_config", {"model": "gpt"})
        self.assertNotIn("webui", updated)
        self.assertIn("new_oai_config", updated)


if __name__ == "__main__":
    unittest.main()
