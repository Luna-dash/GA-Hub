"""Side-effect-free parsing and rendering for ``mykey.py``.

This module deliberately knows nothing about FastAPI, filesystem paths, backups,
or AgentService.  Keeping the codec pure gives both the raw and structured
editors one stable, independently testable interpretation of the config file.
"""
from __future__ import annotations

import ast
import json
from typing import Any

_SESSION_KEYS = ("api", "config", "cookie")


def classify_config(var: str) -> str:
    """Classify a top-level name using AgentMain's session detection rules."""
    if not any(key in var for key in _SESSION_KEYS):
        return "global"
    if "native" in var and "claude" in var:
        return "native_claude"
    if "native" in var and "oai" in var:
        return "native_oai"
    if "claude" in var:
        return "claude"
    if "oai" in var:
        return "oai"
    if "mixin" in var:
        return "mixin"
    return "global"


def structurize(raw: str) -> dict[str, Any]:
    """Parse literal top-level assignments into sessions, mixins and globals.

    Dynamic expressions are intentionally skipped rather than executed; users
    can still maintain those through the raw editor.
    """
    sessions: list[dict[str, Any]] = []
    mixins: list[dict[str, Any]] = []
    globals_: dict[str, Any] = {}
    try:
        tree = ast.parse(raw)
    except SyntaxError:
        return {"sessions": [], "mixins": [], "mixin": None, "globals": {}}

    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        if len(node.targets) != 1 or not isinstance(node.targets[0], ast.Name):
            continue
        var = node.targets[0].id
        try:
            value = ast.literal_eval(node.value)
        except (ValueError, TypeError, MemoryError, RecursionError):
            continue
        kind = classify_config(var)
        if kind == "global":
            globals_[var] = value
            continue
        if not isinstance(value, dict):
            continue
        entry = {
            "var": var,
            "type": kind,
            "fields": dict(value),
            "lineno": node.lineno,
            "end_lineno": getattr(node, "end_lineno", node.lineno),
        }
        (mixins if kind == "mixin" else sessions).append(entry)

    return {
        "sessions": sessions,
        "mixins": mixins,
        "mixin": mixins[0] if mixins else None,
        "globals": globals_,
    }


def validate_text(text: str) -> tuple[bool, str | None, int | None, int | None]:
    """Return ``(ok, message, line, column)`` without executing the source."""
    try:
        ast.parse(text)
        compile(text, "mykey.py", "exec")
    except SyntaxError as exc:
        return False, str(exc.msg), exc.lineno, exc.offset
    return True, None, None, None


def render_value(value: Any, level: int = 0, width: int = 88) -> str:
    """Render a literal in the diff-friendly style used by ``mykey.py``."""
    ind = "    " * level
    ind1 = "    " * (level + 1)
    if isinstance(value, bool):
        return "True" if value else "False"
    if value is None:
        return "None"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, dict):
        if not value:
            return "{}"
        items = [
            f"{ind1}{render_value(key)}: {render_value(item, level + 1, width)}"
            for key, item in value.items()
        ]
        return "{\n" + ",\n".join(items) + ",\n" + ind + "}"
    if isinstance(value, (list, tuple)):
        open_bracket, close_bracket = ("[", "]") if isinstance(value, list) else ("(", ")")
        if not value:
            return open_bracket + close_bracket
        rendered = [render_value(item, level + 1, width) for item in value]
        inline = open_bracket + ", ".join(rendered) + close_bracket
        if len(ind) + len(inline) <= width and "\n" not in inline:
            return inline
        return (
            open_bracket
            + "\n"
            + ",\n".join(f"{ind1}{item}" for item in rendered)
            + ",\n"
            + ind
            + close_bracket
        )
    return repr(value)


def render_dict(value: dict[str, Any]) -> str:
    """Render a dictionary that round-trips through ``ast.literal_eval``."""
    return render_value(value, 0)


def render_assign(var: str, value: dict[str, Any], header_comment: str | None = None) -> str:
    """Render one named dictionary assignment and optional heading comment."""
    prefix = f"# {header_comment}\n" if header_comment else ""
    return f"{prefix}{var} = {render_dict(value)}\n"


class InvalidSourceError(ValueError):
    """Raised when an assignment mutation cannot safely parse the source."""


class AssignmentNotFoundError(LookupError):
    """Raised when deleting a top-level assignment that does not exist."""


def _parse_source(raw: str) -> ast.Module:
    try:
        return ast.parse(raw)
    except SyntaxError as exc:
        raise InvalidSourceError(exc.msg) from exc


def _find_assignment(tree: ast.Module, var: str) -> ast.Assign | None:
    for node in tree.body:
        if (
            isinstance(node, ast.Assign)
            and len(node.targets) == 1
            and isinstance(node.targets[0], ast.Name)
            and node.targets[0].id == var
        ):
            return node
    return None


def upsert_assignment(raw: str, var: str, fields: dict[str, Any]) -> str:
    """Replace or append one dictionary assignment in valid Python source.

    A missing, blank, or masked ``apikey`` means "keep the prior literal key".
    No secret is synthesized when the assignment or prior key does not exist.
    """
    tree = _parse_source(raw)
    node = _find_assignment(tree, var)
    rendered_fields = dict(fields)
    if rendered_fields.get("apikey") in (None, "", "***"):
        if node is not None:
            try:
                prior = ast.literal_eval(node.value)
                if isinstance(prior, dict) and prior.get("apikey"):
                    rendered_fields["apikey"] = prior["apikey"]
            except (ValueError, TypeError, SyntaxError):
                pass
        if rendered_fields.get("apikey") in (None, "", "***"):
            rendered_fields.pop("apikey", None)

    new_block = render_assign(var, rendered_fields)
    if node is not None:
        lines = raw.splitlines(keepends=True)
        end_lineno = getattr(node, "end_lineno", node.lineno)
        result = "".join(lines[: node.lineno - 1]) + new_block + "".join(lines[end_lineno:])
    else:
        separator = "" if raw.endswith("\n\n") else ("\n" if raw.endswith("\n") else "\n\n")
        result = raw + separator + "\n# ── 通过 webui 新增 ──\n" + new_block
    return result if result.endswith("\n") else result + "\n"


def delete_assignment(raw: str, var: str) -> str:
    """Delete one named top-level assignment from valid Python source."""
    node = _find_assignment(_parse_source(raw), var)
    if node is None:
        raise AssignmentNotFoundError(var)
    lines = raw.splitlines(keepends=True)
    end_lineno = getattr(node, "end_lineno", node.lineno)
    return "".join(lines[: node.lineno - 1]) + "".join(lines[end_lineno:])


def remove_mixin_references(
    raw: str,
    var: str,
    *,
    target_index: int | None = None,
) -> tuple[str, int]:
    """Remove one base assignment's references from all mixin configs."""
    structured = structurize(raw)
    target = next(
        (item for item in structured["sessions"] if item["var"] == var),
        None,
    )
    if target is None:
        raise AssignmentNotFoundError(var)
    target_name = str(target["fields"].get("name", "")).strip()
    if not target_name and target_index is None:
        return raw, 0

    updated = raw
    removed = 0
    for mixin in structured["mixins"]:
        old_members = mixin["fields"].get("llm_nos")
        if not isinstance(old_members, list):
            continue
        new_members = [
            member
            for member in old_members
            if not (
                (isinstance(member, str) and member == target_name)
                or (target_index is not None and isinstance(member, int) and not isinstance(member, bool) and member == target_index)
            )
        ]
        if len(new_members) == len(old_members):
            continue
        fields = dict(mixin["fields"])
        fields["llm_nos"] = new_members
        updated = upsert_assignment(updated, mixin["var"], fields)
        removed += len(old_members) - len(new_members)
    return updated, removed


def delete_base_assignment(raw: str, var: str) -> tuple[str, int]:
    """Delete one base LLM and stale mixin references in source order."""
    structured = structurize(raw)
    if not any(item["var"] == var for item in structured["sessions"]):
        raise AssignmentNotFoundError(var)
    ordered = sorted(
        (item for bucket in ("sessions", "mixins") for item in structured[bucket]),
        key=lambda item: item["lineno"],
    )
    target_index = next(
        index for index, item in enumerate(ordered) if item["var"] == var
    )
    new_text, removed_references = remove_mixin_references(
        raw, var, target_index=target_index
    )
    return delete_assignment(new_text, var), removed_references
