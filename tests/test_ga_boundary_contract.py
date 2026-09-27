"""Static governance tests for the GA/GA-Hub dependency boundary.

Three properties are enforced:

1. **No new direct GA dependency.** Everything Hub takes from GA must come
   through the registered ``frontends.gahub.bridge`` seam, except for the
   reviewed debt listed in ``LEGACY_DIRECT_IMPORTS``.
2. **The debt registry stays honest.** It is an exact set, not a one-way
   ratchet: a paid-off entry fails the test until it is deleted, so the list
   keeps describing reality instead of decaying into a historical document.
3. **The startup probe declares exactly this surface.** ``core_contract``
   verifies GA's symbols at boot (and gates chat on the result), so its
   declaration must cover every module/symbol the source imports — and must
   not require anything the source no longer calls.
"""
from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

import pytest

from server.services import core_contract


ROOT = Path(__file__).resolve().parents[1]
GA_MODULE_ROOTS = {
    "TMWebDriver", "agent_loop", "agentmain", "frontends", "ga", "ga_cli",
    "cost_tracker", "llmcore", "mykey", "mykey_template", "mykey_template_en",
    "plugins", "simphtml",
}
REGISTERED_BRIDGE_PREFIX = "frontends.gahub.bridge"

# Every .py tree a GA dependency can hide in. ``desktop`` builds the frozen
# sidecar and ``scripts`` drives the build chain; both run GA-adjacent code.
SCANNED_AREAS = ("server", "desktop", "scripts")

# Compatibility debt: direct GA imports sanctioned because the registered
# bridge does not cover the need yet. This is an exact set — paying an entry
# off means deleting it here (see test_debt_registry_has_no_stale_entries).
LEGACY_DIRECT_IMPORTS = {
    ("server/run.py", "import", "mykey", ()),
    ("server/services/agent_service.py", "import", "ga", ()),
    ("server/services/agent_service.py", "from", "frontends.btw_cmd", ("handle_frontend_command",)),
    ("server/services/core_contract.py", "import", "agentmain", ()),
    ("server/services/ga_external_worker.py", "dynamic", "ga", ()),
    ("server/services/ga_subprocess_patch.py", "import", "ga", ()),
    ("server/services/goalhive_service.py", "from", "agentmain", ("GeneraticAgent",)),
    ("server/services/mykey_service.py", "from", "llmcore", ("resolve_client",)),
    ("server/services/wechat_service.py", "from", "frontends.chatapp_common", ("public_access", "to_allowed_set")),
}

# The probe's own imports exist to check GA, not to use it.
PROBE_MODULE = "server/services/core_contract.py"

# GA publishes no on-disk layout guarantee, so every path Hub builds inside the
# GA checkout is named once in _paths (the GA_LAYOUT_* constants).
LAYOUT_MODULE = "server/_paths.py"

# Bridge touch points reached through a helper call (``_archive_bridge().x()``),
# so no static alias tracking can attribute them. Each is verified by the
# literal call below: stop calling it and this test asks you to drop the
# declaration from core_contract.
INDIRECT_BRIDGE_REFERENCES = (
    ("server/services/archive_messages.py", "frontends.gahub.bridge.archive", "list_native_sessions"),
    ("server/services/llm_registry.py", "frontends.gahub.bridge.model", "mykey_revision"),
    ("server/services/llm_registry.py", "frontends.gahub.bridge.model", "model_snapshot"),
    ("server/services/llm_registry.py", "frontends.gahub.bridge.model", "switch_model"),
    ("server/services/session_runtime_factory.py", "frontends.gahub.bridge.session", "acquire_birth_lock"),
    ("server/services/session_runtime_factory.py", "frontends.gahub.bridge.session", "begin_fresh_session"),
    ("server/services/session_runtime_factory.py", "frontends.gahub.bridge.session", "continue_inplace"),
    ("server/services/session_runtime_factory.py", "frontends.gahub.bridge.session", "takeover_stale_lock"),
)


def _record_imports(tree: ast.AST, rel: str, found: set[tuple]) -> None:
    """Collect GA references in one syntax tree using the tuple shape above."""
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


def _embedded_scripts(tree: ast.AST):
    """String constants that are themselves Python source.

    ``ga_external_worker`` ships a worker as an embedded script string and
    imports GA inside it; a plain module-level scan cannot see that import, so
    the dependency looked paid off while it was still there.
    """
    for node in ast.walk(tree):
        if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
            continue
        if "import" not in node.value or len(node.value) < 40:
            continue
        try:
            yield ast.parse(node.value)
        except SyntaxError:
            continue


def _scan(path: Path) -> set[tuple]:
    rel = path.relative_to(ROOT).as_posix()
    tree = ast.parse(path.read_text("utf-8"), filename=rel)
    found: set[tuple] = set()
    _record_imports(tree, rel, found)
    for embedded in _embedded_scripts(tree):
        _record_imports(embedded, rel, found)
    return found


def _ga_imports() -> set[tuple]:
    found: set[tuple] = set()
    for area in SCANNED_AREAS:
        for path in sorted((ROOT / area).rglob("*.py")):
            found |= _scan(path)
    return found


def _is_bridge(module: str) -> bool:
    return module == REGISTERED_BRIDGE_PREFIX or module.startswith(
        REGISTERED_BRIDGE_PREFIX + "."
    )


def test_hub_adds_ga_dependencies_only_through_registered_bridge():
    direct = {item for item in _ga_imports() if not _is_bridge(item[2])}
    unexpected = direct - LEGACY_DIRECT_IMPORTS
    assert not unexpected, (
        "new GA dependencies must use frontends.gahub.bridge; "
        f"unexpected direct imports: {sorted(unexpected)}"
    )


def test_debt_registry_has_no_stale_entries():
    """A paid-off entry must be deleted, not left behind.

    The registry used to be a ceiling only, so 12 of its 21 entries described
    imports that no longer existed — including the two ``continue_cmd`` symbols
    the startup probe still required. Nobody noticed because nothing checked
    this direction.
    """
    direct = {item for item in _ga_imports() if not _is_bridge(item[2])}
    stale = LEGACY_DIRECT_IMPORTS - direct
    assert not stale, (
        "these direct GA imports no longer exist — delete them from "
        f"LEGACY_DIRECT_IMPORTS: {sorted(stale)}"
    )


def test_ga_layout_paths_are_funnelled_through_the_paths_module():
    """No literal ``GA_ROOT / "..."`` join outside ``server/_paths.py``.

    GA guarantees no on-disk layout, so these couplings are the least
    contractual thing Hub does. They had already spread across seven files
    before being funnelled into named ``_paths`` helpers; this keeps the funnel
    from eroding.
    """
    pattern = re.compile(r'(GA_ROOT|ga_root)\s*/\s*"')
    offenders: list[str] = []
    for area in SCANNED_AREAS:
        for path in sorted((ROOT / area).rglob("*.py")):
            rel = path.relative_to(ROOT).as_posix()
            if rel == LAYOUT_MODULE:
                continue
            for number, line in enumerate(path.read_text("utf-8").splitlines(), 1):
                if pattern.search(line):
                    offenders.append(f"{rel}:{number}: {line.strip()}")
    assert not offenders, (
        "build GA paths through the _paths helpers instead of inline joins: "
        f"{offenders}"
    )


def test_scan_reaches_embedded_worker_scripts():
    """The embedded-script scan must actually see GA inside a script string.

    Without this, ``ga_external_worker``'s ``import_module("ga")`` (line 43,
    inside ``_WEB_TOOL_WORKER_SCRIPT``) is invisible and the dependency
    silently disappears from governance.
    """
    found = _ga_imports()
    assert ("server/services/ga_external_worker.py", "dynamic", "ga", ()) in found


def _checkout_ga_module_names() -> set[str]:
    """GA's own top-level importable names, derived from the checkout."""
    from server import _paths

    ga_root = Path(_paths.GA_ROOT) if _paths.GA_ROOT else ROOT.parent / "GA"
    names = {path.stem for path in ga_root.glob("*.py")}
    names |= {
        path.name
        for path in ga_root.iterdir()
        if path.is_dir() and (path / "__init__.py").is_file()
    }
    # ``frontends`` is a namespace package (no __init__.py) and every GA
    # frontend module is imported through it.
    if (ga_root / "frontends").is_dir():
        names.add("frontends")
    # Vendored clones and scratch space live under GA but are not GA core.
    return names - {"__init__", "repos", "temp", "assets", "memory"}


def _imported_top_level_names() -> set[str]:
    """Every top-level module name imported in the scanned areas, unfiltered.

    Deliberately *not* filtered through ``GA_MODULE_ROOTS``: the completeness
    check below asks whether that list omits a name, so deriving the answer
    through the list would hide exactly the case under test — removing an entry
    would also remove the evidence that it was needed. Relative imports are
    skipped so ``from .foo import x`` never looks like a GA dependency.
    """
    names: set[str] = set()
    for area in SCANNED_AREAS:
        for path in sorted((ROOT / area).rglob("*.py")):
            rel = path.relative_to(ROOT).as_posix()
            tree = ast.parse(path.read_text("utf-8"), filename=rel)
            for one in (tree, *_embedded_scripts(tree)):
                for node in ast.walk(one):
                    if isinstance(node, ast.Import):
                        names |= {alias.name.split(".", 1)[0] for alias in node.names}
                    elif (
                        isinstance(node, ast.ImportFrom)
                        and node.level == 0
                        and node.module
                    ):
                        names.add(node.module.split(".", 1)[0])
                    elif (
                        isinstance(node, ast.Call)
                        and isinstance(node.func, ast.Attribute)
                        and node.func.attr == "import_module"
                        and node.args
                        and isinstance(node.args[0], ast.Constant)
                        and isinstance(node.args[0].value, str)
                    ):
                        names.add(node.args[0].value.split(".", 1)[0])
    return names


def test_root_list_covers_every_ga_module_the_checkout_ships():
    """The hardcoded root list must not become a hiding place.

    A new GA module whose name is outside ``GA_MODULE_ROOTS`` would be invisible
    to every scan above. Derive the real names from the paired checkout and
    require Hub's imports to be a subset the list already covers.
    """
    from server import _paths

    ga_root = Path(_paths.GA_ROOT) if _paths.GA_ROOT else ROOT.parent / "GA"
    if not (ga_root / "agentmain.py").is_file():
        pytest.skip("requires a paired GA checkout to derive module names")

    shipped = _checkout_ga_module_names()
    uncovered = {
        name
        for name in _imported_top_level_names() & shipped
        if name not in GA_MODULE_ROOTS and name not in sys.stdlib_module_names
    }
    assert not uncovered, (
        "these GA modules are imported by Hub but missing from GA_MODULE_ROOTS, "
        f"so the boundary scan cannot see them: {sorted(uncovered)}"
    )


# ── the startup probe's declaration must equal this surface ─────────────────

def _bridge_surface_from_source() -> tuple[set[str], set[tuple[str, str]]]:
    """(modules, (module, symbol)) for every bridge reference in the source.

    Symbols are attributed through import aliases (``from ...bridge import
    session as s`` then ``s.restore_archive``); references reached through a
    helper call are listed in ``INDIRECT_BRIDGE_REFERENCES`` instead.
    """
    modules: set[str] = set()
    symbols: set[tuple[str, str]] = set()
    for area in SCANNED_AREAS:
        for path in sorted((ROOT / area).rglob("*.py")):
            rel = path.relative_to(ROOT).as_posix()
            if rel == PROBE_MODULE:
                continue
            tree = ast.parse(path.read_text("utf-8"), filename=rel)
            trees = [tree, *_embedded_scripts(tree)]
            aliases: dict[str, str] = {}
            for one in trees:
                for node in ast.walk(one):
                    if isinstance(node, ast.ImportFrom) and node.module:
                        if not _is_bridge(node.module):
                            continue
                        if node.module == REGISTERED_BRIDGE_PREFIX:
                            # from frontends.gahub.bridge import session as s
                            for alias in node.names:
                                module = f"{REGISTERED_BRIDGE_PREFIX}.{alias.name}"
                                modules.add(module)
                                aliases[alias.asname or alias.name] = module
                        else:
                            modules.add(node.module)
                            for alias in node.names:
                                symbols.add((node.module, alias.name))
                    elif (
                        isinstance(node, ast.Call)
                        and isinstance(node.func, ast.Attribute)
                        and node.func.attr == "import_module"
                        and node.args
                        and isinstance(node.args[0], ast.Constant)
                        and isinstance(node.args[0].value, str)
                        and _is_bridge(node.args[0].value)
                    ):
                        modules.add(node.args[0].value)
            for one in trees:
                for node in ast.walk(one):
                    if (
                        isinstance(node, ast.Attribute)
                        and isinstance(node.value, ast.Name)
                        and node.value.id in aliases
                    ):
                        symbols.add((aliases[node.value.id], node.attr))
    return modules, symbols


def test_probe_declares_the_whole_bridge_and_direct_surface():
    """No GA module or symbol may be used without being probed at startup."""
    modules, symbols = _bridge_surface_from_source()
    declared = core_contract._REQUIRED_GA_SYMBOLS
    declared_pairs = {
        (module, name) for module, names in declared.items() for name in names
    }

    unprobed_modules = modules - set(declared)
    assert not unprobed_modules, (
        "these GA modules are imported but the startup probe would not notice "
        f"them disappearing: {sorted(unprobed_modules)}"
    )

    unprobed_symbols = symbols - declared_pairs
    assert not unprobed_symbols, (
        "these bridge symbols are used but not declared in "
        f"core_contract._REQUIRED_GA_SYMBOLS: {sorted(unprobed_symbols)}"
    )


def test_probe_requires_nothing_the_source_stopped_calling():
    """The reverse direction: no over-declaration.

    This is the check that would have caught ``_REQUIRED_CONTINUE_CMD``: the
    probe kept demanding two ``frontends.continue_cmd`` helpers long after Hub
    moved to the session bridge, so a GA release dropping them would have
    refused chat over symbols nothing calls.
    """
    _, bridge_symbols = _bridge_surface_from_source()
    declared = core_contract._REQUIRED_GA_SYMBOLS
    declared_pairs = {
        (module, name) for module, names in declared.items() for name in names
    }

    justified = set(bridge_symbols)
    # Direct (non-bridge) debt: `from frontends.btw_cmd import x` and friends.
    justified |= {
        (module, name)
        for _, kind, module, names in _ga_imports()
        if kind == "from" and not _is_bridge(module)
        for name in names
    }
    justified |= {(module, symbol) for _, module, symbol in INDIRECT_BRIDGE_REFERENCES}
    # agentmain's class is verified through _REQUIRED_CLASS_MEMBERS, so the
    # module entry stays symbol-free on purpose.
    justified |= {("agentmain", name) for name in ("GeneraticAgent",)}

    redundant = declared_pairs - justified
    assert not redundant, (
        "these symbols are declared in core_contract._REQUIRED_GA_SYMBOLS but "
        "nothing in the source calls them — delete the declaration (or list "
        f"the call site in INDIRECT_BRIDGE_REFERENCES): {sorted(redundant)}"
    )


def test_indirect_bridge_references_are_still_real():
    """Keep the exemption list from rotting the way the ceiling did.

    The reference may be an attribute read rather than a call — the session
    factory binds ``ga_session.continue_inplace`` into a field and calls it
    later — so the check is the attribute appearing at all.
    """
    sources = {
        rel: (ROOT / rel).read_text("utf-8")
        for rel in {rel for rel, _, _ in INDIRECT_BRIDGE_REFERENCES}
    }
    for rel, _module, symbol in INDIRECT_BRIDGE_REFERENCES:
        assert f".{symbol}" in sources[rel], (
            f"{rel} no longer references .{symbol}, so the probe declaration "
            "for it is now an over-declaration — remove both"
        )
