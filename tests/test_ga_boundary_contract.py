"""Static governance tests for the GA/GA-Hub dependency boundary."""
from __future__ import annotations

import ast
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
GA_MODULE_ROOTS = {
    "TMWebDriver", "agent_loop", "agentmain", "frontends", "ga", "ga_cli",
    "llmcore", "mykey", "mykey_template", "mykey_template_en", "plugins", "simphtml",
}
REGISTERED_BRIDGE_PREFIX = "frontends.gahub.bridge"

# Compatibility debt present when W3.2 began.  This is deliberately a ceiling:
# migrations may delete entries without editing the test, but new direct imports fail.
LEGACY_DIRECT_IMPORTS = {
    ("server/routes/sessions.py", "from", "frontends", ("workspace_cmd",)),
    ("server/run.py", "import", "mykey", ()),
    ("server/services/agent_service.py", "from", "agentmain", ("GeneraticAgent",)),
    ("server/services/agent_service.py", "from", "frontends.btw_cmd", ("handle_frontend_command",)),
    ("server/services/agent_service.py", "from", "frontends.continue_cmd", ("install", "reset_conversation")),
    ("server/services/agent_service.py", "from", "frontends.continue_cmd", ("release_current",)),
    ("server/services/agent_service.py", "import", "ga", ()),
    ("server/services/archive_import.py", "from", "frontends.continue_cmd", ("_new_log_path",)),
    ("server/services/archive_messages.py", "from", "frontends.continue_cmd", ("_format_response_segment", "_pairs", "_tool_results_from_prompt", "_user_text")),
    ("server/services/archive_messages.py", "from", "frontends.continue_cmd", ("_pairs", "_user_text")),
    ("server/services/archive_messages.py", "from", "frontends.continue_cmd", ("_user_text",)),
    ("server/services/archive_messages.py", "from", "frontends.continue_cmd", ("extract_ui_messages",)),
    ("server/services/archive_messages.py", "from", "frontends.continue_cmd", ("list_sessions",)),
    ("server/services/archive_messages.py", "from", "frontends.continue_cmd", ("restore",)),
    ("server/services/core_contract.py", "import", "agentmain", ()),
    ("server/services/core_contract.py", "import", "frontends.continue_cmd", ()),
    ("server/services/ga_external_worker.py", "dynamic", "ga", ()),
    ("server/services/ga_subprocess_patch.py", "import", "ga", ()),
    ("server/services/goalhive_service.py", "from", "agentmain", ("GeneraticAgent",)),
    ("server/services/llm_registry.py", "from", "llmcore", ("reload_mykeys",)),
    ("server/services/mykey_service.py", "from", "llmcore", ("resolve_client",)),
    ("server/services/rewind_adapter.py", "from", "frontends.continue_cmd", ("parse_native_log",)),
    ("server/services/rewind_adapter.py", "from", "frontends.worldline", ("RewindStore",)),
    ("server/services/rewind_adapter.py", "from", "frontends.worldline", ("restore_plan", "rewrite_projection")),
    ("server/services/session_runtime_factory.py", "from", "frontends.continue_cmd", ("_lock_path", "session_occupant")),
    ("server/services/session_runtime_factory.py", "from", "frontends.continue_cmd", ("acquire_birth_lock", "continue_inplace", "release_current")),
    ("server/services/session_runtime_factory.py", "from", "frontends.continue_cmd", ("begin_fresh_session",)),
    ("server/services/wechat_service.py", "from", "frontends.chatapp_common", ("public_access", "to_allowed_set")),
}


def _ga_imports():
    found = set()
    for path in sorted((ROOT / "server").rglob("*.py")):
        rel = path.relative_to(ROOT).as_posix()
        tree = ast.parse(path.read_text("utf-8"), filename=rel)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name.split(".", 1)[0] in GA_MODULE_ROOTS:
                        found.add((rel, "import", alias.name, ()))
            elif isinstance(node, ast.ImportFrom) and node.module:
                if node.module.split(".", 1)[0] in GA_MODULE_ROOTS:
                    names = tuple(sorted(alias.name for alias in node.names))
                    found.add((rel, "from", node.module, names))
            elif (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "import_module"
                and node.args
                and isinstance(node.args[0], ast.Constant)
                and isinstance(node.args[0].value, str)
                and node.args[0].value.split(".", 1)[0] in GA_MODULE_ROOTS
            ):
                found.add((rel, "dynamic", node.args[0].value, ()))
    return found


def test_hub_adds_ga_dependencies_only_through_registered_bridge():
    direct = {
        item for item in _ga_imports()
        if not (item[2] == REGISTERED_BRIDGE_PREFIX or item[2].startswith(REGISTERED_BRIDGE_PREFIX + "."))
    }
    unexpected = direct - LEGACY_DIRECT_IMPORTS
    assert not unexpected, (
        "new GA dependencies must use frontends.gahub.bridge; "
        f"unexpected direct imports: {sorted(unexpected)}"
    )
