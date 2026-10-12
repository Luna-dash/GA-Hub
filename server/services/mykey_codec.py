"""Side-effect-free parsing and rendering for ``mykey.py``.

This module deliberately knows nothing about FastAPI, filesystem paths, backups,
or AgentService.  Keeping the codec pure gives both the raw and structured
editors one stable, independently testable interpretation of the config file.
"""
from __future__ import annotations

import ast
import keyword
import json
from typing import Any

_SESSION_KEYS = ("api", "config", "cookie")


def classify_config(var: str) -> str:
    """Classify a top-level name using AgentMain's session detection rules."""
    if not any(key in var for key in _SESSION_KEYS):
        return "global"
    if "mixin" in var:
        return "mixin"
    if "native" in var and "claude" in var:
        return "native_claude"
    if "native" in var and "oai" in var:
        return "native_oai"
    if "claude" in var:
        return "claude"
    if "oai" in var:
        return "oai"
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
        return {"sessions": [], "mixins": [], "globals": {}}

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


def render_assign(var: str, value: dict[str, Any]) -> str:
    """Render one named dictionary assignment without generated annotations."""
    return f"{var} = {render_dict(value)}\n"


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
    matches = []
    for node in tree.body:
        targets = node.targets if isinstance(node, ast.Assign) else ([node.target] if isinstance(node, ast.AnnAssign) else [])
        if any(isinstance(t, ast.Name) and t.id == var for t in targets):
            if not isinstance(node, ast.Assign) or len(targets) != 1:
                raise InvalidSourceError(f"{var}: 请在原始编辑器修改带注解或多目标赋值")
            matches.append(node)
    if len(matches) > 1:
        raise InvalidSourceError(f"{var}: 存在重复赋值，请在原始编辑器修改")
    return matches[0] if matches else None


class AssignmentConflictError(ValueError):
    """Raised when a mutation would overwrite another assignment."""


class InvalidVariableNameError(ValueError):
    """Raised when a structured mutation receives an invalid Python name."""


def _validate_variable_name(var: str) -> None:
    if not isinstance(var, str) or not var.isidentifier() or keyword.iskeyword(var):
        raise InvalidVariableNameError(var)


def _literal_fields(node: ast.Assign | None) -> dict[str, Any]:
    if node is None:
        return {}
    try:
        value = ast.literal_eval(node.value)
    except (ValueError, TypeError, SyntaxError, MemoryError, RecursionError):
        return {}
    return dict(value) if isinstance(value, dict) else {}


def _prepare_fields(fields: dict[str, Any], prior: dict[str, Any] | None = None) -> dict[str, Any]:
    rendered_fields = dict(fields)
    if rendered_fields.get("apikey") in (None, "", "***"):
        if prior and prior.get("apikey"):
            rendered_fields["apikey"] = prior["apikey"]
        if rendered_fields.get("apikey") in (None, "", "***"):
            rendered_fields.pop("apikey", None)
    return rendered_fields


def _replace_node(raw: str, node: ast.Assign, new_block: str) -> str:
    lines = raw.splitlines(keepends=True)
    end_lineno = getattr(node, "end_lineno", node.lineno)
    result = "".join(lines[: node.lineno - 1]) + new_block + "".join(lines[end_lineno:])
    return result if result.endswith("\n") else result + "\n"


def _insert_after_node(raw: str, node: ast.Assign, new_block: str) -> str:
    lines = raw.splitlines(keepends=True)
    end_lineno = getattr(node, "end_lineno", node.lineno)
    prefix = "".join(lines[:end_lineno])
    if prefix and not prefix.endswith("\n"):
        prefix += "\n"
    return prefix + new_block + "".join(lines[end_lineno:])


def rename_assignment(
    raw: str,
    old_var: str,
    new_var: str,
    fields: dict[str, Any] | None = None,
) -> str:
    """Rename one assignment in place, refusing to overwrite another one."""
    _validate_variable_name(new_var)
    tree = _parse_source(raw)
    node = _find_assignment(tree, old_var)
    if node is None:
        raise AssignmentNotFoundError(old_var)
    if old_var != new_var and _find_assignment(tree, new_var) is not None:
        raise AssignmentConflictError(new_var)
    prior = _literal_fields(node)
    values = _prepare_fields(fields if fields is not None else prior, prior)
    return _replace_node(raw, node, render_assign(new_var, values))


def duplicate_assignment(
    raw: str,
    source_var: str,
    new_var: str,
    fields: dict[str, Any] | None = None,
) -> str:
    """Copy an assignment immediately after its source, refusing collisions."""
    _validate_variable_name(new_var)
    tree = _parse_source(raw)
    source = _find_assignment(tree, source_var)
    if source is None:
        raise AssignmentNotFoundError(source_var)
    if _find_assignment(tree, new_var) is not None:
        raise AssignmentConflictError(new_var)
    prior = _literal_fields(source)
    values = _prepare_fields(fields if fields is not None else prior, prior)
    return _insert_after_node(raw, source, render_assign(new_var, values))


def upsert_assignment(raw: str, var: str, fields: dict[str, Any]) -> str:
    """Low-level dict writer; callers enforce explicit create/update semantics."""
    _validate_variable_name(var)
    node = _find_assignment(_parse_source(raw), var)
    values = _prepare_fields(fields, _literal_fields(node) if node is not None else None)
    block = render_assign(var, values)
    if node is not None:
        return _replace_node(raw, node, block)
    separator = "" if not raw or raw.endswith("\n\n") else ("\n" if raw.endswith("\n") else "\n\n")
    return raw + separator + block


def mutate_session_assignment(
    raw: str, action: str, var: str | None, new_var: str | None,
    fields: dict[str, Any] | None, session_type: str | None = None,
) -> str:
    """Plan a structured session edit; never create globals or overwrite copies."""
    target = new_var if action in {"rename", "duplicate"} else var
    _validate_variable_name(target)
    kind = classify_config(target)
    if kind == "global" or (session_type is not None and kind != session_type):
        raise InvalidVariableNameError("变量名必须符合所选 session 类型的识别规则")
    if action in {"rename", "duplicate"}:
        if not var:
            raise AssignmentNotFoundError(var)
        transform = rename_assignment if action == "rename" else duplicate_assignment
        updated = transform(raw, var, target, fields)
        renamed = {var: target} if action == "rename" else {}
        copied = {target: var} if action == "duplicate" else {}
        return _remap_mixin_references(raw, updated, renamed, copied)[0]
    node = _find_assignment(_parse_source(raw), target)
    if action == "create" and node is not None:
        raise AssignmentConflictError(target)
    if action == "update" and node is None:
        raise AssignmentNotFoundError(target)
    if action not in {"create", "update"}:
        raise ValueError(f"unsupported session action: {action}")
    updated = upsert_assignment(raw, target, fields or {})
    return _remap_mixin_references(raw, updated)[0]


def update_proxy_assignment(raw: str, value: str) -> str:
    """Replace the complete proxy AST statement, including multiline values."""
    node = _find_assignment(_parse_source(raw), "proxy")
    block = f"proxy = {value.strip()!r}\n"
    if node is not None:
        return _replace_node(raw, node, block)
    return raw + ("" if not raw or raw.endswith("\n") else "\n") + block


def delete_assignment(raw: str, var: str) -> str:
    """Delete one named top-level assignment from valid Python source."""
    node = _find_assignment(_parse_source(raw), var)
    if node is None:
        raise AssignmentNotFoundError(var)
    lines = raw.splitlines(keepends=True)
    end_lineno = getattr(node, "end_lineno", node.lineno)
    return "".join(lines[: node.lineno - 1]) + "".join(lines[end_lineno:])


def _ordered_sessions(raw: str) -> list[dict[str, Any]]:
    structured = structurize(raw)
    return sorted(structured["sessions"] + structured["mixins"], key=lambda item: item["lineno"])


def _session_name(item: dict[str, Any]) -> Any:
    # BaseSession uses get(name, model), not truthiness, stripping or var fallback.
    fields = item["fields"]
    return fields.get("name", fields.get("model", ""))


def _runtime_session_names(items: list[dict[str, Any]]) -> dict[str, Any]:
    """Mirror GA's base-first, then file-order mixin name construction."""
    names = {item["var"]: _session_name(item) for item in items if item["type"] != "mixin"}
    for item in items:
        if item["type"] != "mixin":
            continue
        members = item["fields"].get("llm_nos", [])
        if not isinstance(members, list) or not members:
            continue
        selected = []
        for member in members:
            target = None
            if isinstance(member, int) and -len(items) <= member < len(items):
                target = items[member]["var"]
            elif isinstance(member, str):
                target = next((entry["var"] for entry in items
                               if entry["var"] in names and names[entry["var"]] == member), None)
            if target not in names or not isinstance(names[target], str):
                break  # Invalid/unresolved mixins are skipped by GA.
            selected.append(names[target])
        else:
            names[item["var"]] = "|".join(selected)
    return names


def _remap_mixin_references(
    before: str, after: str, renamed: dict[str, str] | None = None,
    copied: dict[str, str] | None = None,
) -> tuple[str, int]:
    """Keep references bound to the same file-order identity across one edit.

    The index space includes mixin slots. String references use GA's first-match
    base-session name (including the model default); duplicates inherit source
    references but must not steal references from the original.
    """
    old_items = _ordered_sessions(before)
    new_items = _ordered_sessions(after)
    renamed = renamed or {}
    copied = copied or {}
    old_vars = {item["var"] for item in old_items}
    origins = {new: old for old, new in renamed.items()}
    positions = {item["var"]: index for index, item in enumerate(new_items)}
    old_positions = {item["var"]: index for index, item in enumerate(old_items)}
    old_runtime_names = _runtime_session_names(old_items)
    updated, removed = after, 0
    for mixin in (item for item in new_items if item["type"] == "mixin"):
        origin = copied.get(mixin["var"], origins.get(mixin["var"], mixin["var"]))
        if origin not in old_vars:
            continue  # New refs already use the new file order.
        old_names: dict[str, str] = {}
        for item in old_items:
            name = old_runtime_names.get(item["var"])
            if (item["type"] != "mixin" or old_positions[item["var"]] < old_positions[origin]) and isinstance(name, str):
                old_names.setdefault(name, item["var"])
        members = mixin["fields"].get("llm_nos")
        if not isinstance(members, list):
            continue
        next_members = []
        for member in members:
            old_var = None
            if isinstance(member, int) and -len(old_items) <= member < len(old_items):
                old_var = old_items[member]["var"]
            elif isinstance(member, str):
                old_var = old_names.get(member)
            if old_var is None:
                next_members.append(member)
                continue
            new_index = positions.get(renamed.get(old_var, old_var))
            if new_index is None:
                removed += 1
                continue
            if isinstance(member, int):
                next_members.append(new_index)
            else:
                current_items = _ordered_sessions(updated)
                runtime_names = _runtime_session_names(current_items)
                target_name = runtime_names.get(new_items[new_index]["var"])
                # Only earlier mixins have been resolved when GA loads this one.
                first = next((item["var"] for index, item in enumerate(current_items)
                              if (item["type"] != "mixin" or index < positions[mixin["var"]])
                              and item["var"] in runtime_names
                              and runtime_names[item["var"]] == target_name), None)
                if not isinstance(target_name, str):
                    raise AssignmentConflictError(str(target_name))
                if first != new_items[new_index]["var"]:
                    # A shortened mixin name can collide with its remaining base.
                    # Preserve identity with an index instead of silently rebinding.
                    first_item = next((item for item in current_items if item["var"] == first), None)
                    if new_items[new_index]["type"] == "mixin" or (first_item and first_item["type"] == "mixin"):
                        next_members.append(new_index)
                        continue
                    raise AssignmentConflictError(str(target_name))
                next_members.append(target_name)
        if next_members != members:
            fields = dict(mixin["fields"], llm_nos=next_members)
            updated = upsert_assignment(updated, mixin["var"], fields)
    return updated, removed


def delete_base_assignment(raw: str, var: str) -> tuple[str, int]:
    """Delete a session or mixin and remap all surviving file-order references."""
    if not any(item["var"] == var for item in _ordered_sessions(raw)):
        raise AssignmentNotFoundError(var)
    return _remap_mixin_references(raw, delete_assignment(raw, var))
