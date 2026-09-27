"""Paired-checkout contract tests without importing GA runtime code.

Hub consumes four GA-side declarations that live in the *other* checkout:

* the Conductor wire contract (``bridge/contract.py``);
* the native archive block format — Hub slices archives inside bounded byte
  windows itself, because the bridge only projects whole archives;
* the failure copy Hub matches to tell "unreadable archive" (rotate it) from
  "occupied / transient" (raise);
* the Goal/Hive prompts replicated verbatim into ``goalhive_service``.

Each is asserted against the paired GA source here so a GA change fails a named
test, instead of silently degrading a feature. Every test skips when no paired
checkout is present (e.g. CI without GA).
"""
from __future__ import annotations

import ast
from pathlib import Path

import pytest

from server import _paths
from server.services import conductor_protocol


ROOT = Path(__file__).resolve().parents[1]


def _ga_root() -> Path:
    return Path(_paths.GA_ROOT) if _paths.GA_ROOT else ROOT.parent / "GA"


def _require(checkout_relative: str) -> Path:
    path = _ga_root() / checkout_relative
    if not path.is_file():
        pytest.skip(f"requires a paired GA checkout ({checkout_relative})")
    return path


def _literal_assignments(path: Path) -> dict[str, object]:
    tree = ast.parse(path.read_text("utf-8"), filename=str(path))
    values = {}
    for node in tree.body:
        if not isinstance(node, ast.Assign) or len(node.targets) != 1:
            continue
        target = node.targets[0]
        if isinstance(target, ast.Name):
            try:
                values[target.id] = ast.literal_eval(node.value)
            except (TypeError, ValueError):
                pass
    return values


def _string_literals(node: ast.AST) -> str:
    """Literal parts of a string expression, ignoring interpolated tails."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        return "".join(_string_literals(value) for value in node.values)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        return _string_literals(node.left) + _string_literals(node.right)
    return ""


def _returned_prompt(path: Path, function: str) -> str:
    """The literal text a ``build_*_prompt``-style function returns."""
    tree = ast.parse(path.read_text("utf-8"), filename=str(path))
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == function:
            for child in ast.walk(node):
                if isinstance(child, ast.Return) and child.value is not None:
                    return _string_literals(child.value)
    raise AssertionError(f"{function} not found in {path}")


def test_paired_ga_checkout_matches_hub_conductor_requirements():
    contract_path = _require("frontends/gahub/bridge/contract.py")
    provider = _literal_assignments(contract_path)
    assert provider["PROTOCOL_VERSION"] == conductor_protocol.PROTOCOL_VERSION
    assert provider["SERVICE_NAME"] == conductor_protocol.SERVICE_NAME
    assert set(provider["CAPABILITIES"]) >= conductor_protocol.REQUIRED_CAPABILITIES


def test_hub_matches_the_ga_failure_copy_it_classifies():
    """``_CONTENT_FAILURE_MARKERS`` decides rotate-vs-raise for a bad archive.

    Hub has no structured failure reason from GA (``continue_inplace`` returns
    ``(message, ok)``), so it matches GA's copy. Reword the copy in GA and this
    fails, which is the point: without the pin the same change silently turns
    "rotate the unreadable archive" into "refuse to open the session forever".
    """
    markers = _literal_assignments(
        ROOT / "server" / "services" / "session_runtime_factory.py"
    )["_CONTENT_FAILURE_MARKERS"]
    assert markers, "marker list vanished — update this pin"

    frontends = _ga_root() / "frontends"
    if not frontends.is_dir():
        pytest.skip("requires a paired GA checkout (frontends/)")
    haystack = "\n".join(
        path.read_text("utf-8", errors="replace")
        for path in sorted(frontends.glob("*.py"))
    )
    missing = [marker for marker in markers if marker not in haystack]
    assert not missing, (
        "GA no longer produces this failure copy, so Hub cannot tell an "
        f"unreadable archive from a transient failure: {missing}"
    )


def _module_constants(path: Path) -> dict[str, object]:
    """Evaluate module-level constant assignments, in order.

    Supports the shapes these two files use: plain literals, tuple unpacking
    (``VER, MSG_USER, ... = '2.1.10', 1, ...``), integer bit expressions
    (``(2 << 16) | (1 << 8) | 10``) and f-strings over earlier constants
    (``UA = f"openclaw-weixin/{VER}"``). Anything it cannot evaluate is skipped,
    so an unrelated dynamic assignment never breaks the comparison.
    """
    tree = ast.parse(path.read_text("utf-8"), filename=str(path))
    env: dict[str, object] = {}

    def evaluate(node: ast.AST):
        if isinstance(node, ast.Constant):
            return node.value
        if isinstance(node, ast.Name):
            return env[node.id]
        if isinstance(node, ast.BinOp):
            left, right = evaluate(node.left), evaluate(node.right)
            if isinstance(node.op, ast.LShift):
                return left << right
            if isinstance(node.op, ast.BitOr):
                return left | right
            if isinstance(node.op, ast.Add):
                return left + right
            raise TypeError(ast.dump(node.op))
        if isinstance(node, ast.JoinedStr):
            rendered = ""
            for value in node.values:
                if isinstance(value, ast.Constant):
                    rendered += str(value.value)
                elif isinstance(value, ast.FormattedValue):
                    rendered += str(evaluate(value.value))
            return rendered
        raise TypeError(ast.dump(node))

    for node in tree.body:
        if not isinstance(node, ast.Assign) or len(node.targets) != 1:
            continue
        target = node.targets[0]
        if isinstance(target, ast.Name):
            try:
                env[target.id] = evaluate(node.value)
            except Exception:  # noqa: BLE001 — unrelated dynamic assignment
                pass
        elif isinstance(target, ast.Tuple) and isinstance(node.value, (ast.Tuple, ast.List)):
            names = [item.id for item in target.elts if isinstance(item, ast.Name)]
            if len(names) != len(node.value.elts):
                continue
            for name, element in zip(names, node.value.elts):
                try:
                    env[name] = evaluate(element)
                except Exception:  # noqa: BLE001
                    pass
    return env


def test_hub_ilink_protocol_constants_match_ga_inline_copy():
    """GA inlined Hub's WxBotClient; nothing imports across the two repos.

    So the wire-visible constants *are* the shared contract. Bumping the iLink
    protocol on one side only is invisible to every other check.
    """
    hub = _module_constants(ROOT / "server" / "services" / "wx_bot_client.py")
    ga = _module_constants(_require("frontends/wechatapp.py"))
    for name in ("API", "CDN_BASE", "VER", "ILINK_APP_CLIENT_VERSION", "UA"):
        assert name in hub, f"{name} missing from wx_bot_client"
        assert name in ga, f"{name} missing from GA's inlined copy"
        assert hub[name] == ga[name], (
            f"iLink {name} drifted: Hub={hub[name]!r} GA={ga[name]!r} — mirror "
            "the protocol change into the other checkout"
        )


def _regex_pattern(path: Path, constant: str) -> str:
    """The literal pattern compiled into a module-level ``re.compile`` constant."""
    tree = ast.parse(path.read_text("utf-8"), filename=str(path))
    for node in tree.body:
        if (
            isinstance(node, ast.Assign)
            and isinstance(node.targets[0], ast.Name)
            and node.targets[0].id == constant
        ):
            call = node.value
            assert isinstance(call, ast.Call) and call.args, f"{constant} is not re.compile"
            pattern = call.args[0]
            assert isinstance(pattern, ast.Constant) and isinstance(pattern.value, str)
            return pattern.value
    raise AssertionError(f"{constant} not found in {path}")


def test_hub_archive_block_format_matches_the_ga_writer():
    """Hub slices ``model_responses`` blocks itself, inside byte windows.

    The registered archive bridge projects a whole archive; Hub needs a bounded
    window (multi-GB logs), so the block header spelling is a real dependency on
    GA's writer. This asserts the header the *parser* requires, not merely that
    the bytes appear somewhere in the file, and pins it against GA's writer — a
    format change fails here rather than quietly emptying session previews and
    archive search.
    """
    headers = ("=== Prompt ===", "=== Response ===")
    source = ROOT / "server" / "services" / "archive_messages.py"
    parser = _regex_pattern(source, "_PROMPT_BLOCK_RE")
    # The parser anchors on the Prompt header and treats either header as the
    # end of a block, so only the opener has to appear verbatim.
    assert "=== Prompt ===" in parser, (
        f"Hub's block parser no longer matches the block header: {parser!r}"
    )

    # Hub also *writes* whole blocks: its synthetic probes are appended to the
    # archive for GA to read back, so both headers must stay recognizable in
    # both directions.
    unparsed = [
        header for header in headers if header not in source.read_text("utf-8")
    ]
    assert not unparsed, f"Hub stopped emitting block headers: {unparsed}"

    writer = _require("frontends/worldline.py").read_text("utf-8")
    missing = [header for header in headers if header not in writer]
    assert not missing, (
        f"GA's archive writer renamed a block header Hub parses: {missing}"
    )


def test_hub_goal_and_hive_prompts_still_match_ga():
    """The two prompts are replicated verbatim, so they must stay identical.

    Hub cannot import ``slash_cmds`` (it drags GA's command layer in), so it
    keeps a copy. If GA rewords a prompt, users would get different behaviour
    depending on which entry point started the run.
    """
    hub_assignments = _literal_assignments(
        ROOT / "server" / "services" / "goalhive_service.py"
    )
    slash_cmds = _require("frontends/slash_cmds.py")
    pairs = {
        "_GOAL_PROMPT": _returned_prompt(slash_cmds, "build_goal_prompt"),
        "_HIVE_PROMPT": _returned_prompt(slash_cmds, "build_hive_prompt"),
    }
    for name, ga_text in pairs.items():
        hub_text = hub_assignments.get(name)
        assert hub_text is not None, f"{name} missing from goalhive_service"
        assert hub_text == ga_text, (
            f"{name} drifted from GA's slash_cmds ({name}: {hub_text!r} != "
            f"{ga_text!r}) — re-replicate it or move the prompt into the bridge"
        )
