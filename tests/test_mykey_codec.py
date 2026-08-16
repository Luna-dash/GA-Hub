"""Public behavior contracts for the side-effect-free MyKey codec."""
from __future__ import annotations

import ast
import unittest

from server.services.mykey_codec import (
    AssignmentNotFoundError,
    InvalidSourceError,
    classify_config,
    delete_assignment,
    delete_base_assignment,
    remove_mixin_references,
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
        self.assertEqual(result["mixin"], result["mixins"][0])
        self.assertEqual(result["globals"], {"proxy": "http://localhost:7890"})

    def test_invalid_source_returns_empty_structure(self) -> None:
        self.assertEqual(
            structurize("broken = {") ,
            {"sessions": [], "mixins": [], "mixin": None, "globals": {}},
        )

    def test_validate_text_reports_syntax_location_without_executing(self) -> None:
        ok, message, line, column = validate_text("token = {\n")
        self.assertFalse(ok)
        self.assertIsInstance(message, str)
        self.assertEqual(line, 1)
        self.assertIsInstance(column, int)

    def test_render_assign_round_trips_literal(self) -> None:
        rendered = render_assign("oai_config", {"apikey": "abc", "models": ["a", "b"]}, "primary")
        self.assertTrue(rendered.startswith("# primary\noai_config = "))
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
        self.assertIn("# ── 通过 webui 新增 ──", out)
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

    def test_remove_mixin_references_by_name_and_index(self) -> None:
        raw = '''alpha_oai_config = {"name": "alpha", "apikey": "secret"}
beta_oai_config = {"name": "beta", "apikey": "secret"}
mixin_one_config = {"llm_nos": ["alpha", "beta"]}
mixin_two_config = {"llm_nos": [0, 1]}
other_mixin_config = {"llm_nos": ["beta"]}
'''

        updated, removed = remove_mixin_references(raw, "alpha_oai_config", target_index=0)
        rendered = structurize(updated)
        self.assertEqual(removed, 2)
        self.assertEqual(rendered["mixins"][0]["fields"]["llm_nos"], ["beta"])
        self.assertEqual(rendered["mixins"][1]["fields"]["llm_nos"], [1])
        self.assertEqual(rendered["mixins"][2]["fields"]["llm_nos"], ["beta"])

        final, removed = remove_mixin_references(updated, "alpha_oai_config", target_index=0)
        self.assertEqual(removed, 0)
        self.assertIn("alpha_oai_config", final)

    def test_remove_mixin_references_by_index_without_name(self) -> None:
        raw = '''alpha_oai_config = {"apikey": "secret"}
beta_oai_config = {"apikey": "other"}
mixin_config = {"llm_nos": [0, 1]}
'''

        updated, removed = remove_mixin_references(raw, "alpha_oai_config", target_index=0)
        rendered = structurize(updated)
        self.assertEqual(removed, 1)
        self.assertEqual(rendered["mixins"][0]["fields"]["llm_nos"], [1])

    def test_delete_base_assignment_preserves_source_order_indexes(self) -> None:
        raw = '''mixin_config = {"llm_nos": [0, 1, 2]}
alpha_oai_config = {"name": "alpha", "apikey": "secret"}
beta_oai_config = {"name": "beta", "apikey": "other"}
'''

        updated, removed = delete_base_assignment(raw, "alpha_oai_config")
        rendered = structurize(updated)
        self.assertEqual(removed, 1)
        self.assertEqual(rendered["mixins"][0]["fields"]["llm_nos"], [0, 2])
        self.assertFalse(any(item["var"] == "alpha_oai_config" for item in rendered["sessions"]))


if __name__ == "__main__":
    unittest.main()
