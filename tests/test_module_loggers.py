"""Static guard: any server module that calls bare ``log.xxx`` must define a
module-level ``log``.

Regression origin: ``routes/tokens.py`` lost its logger in a cleanup commit
while its call sites stayed — importing the module with the GA ``cost_tracker``
extra unavailable raised ``NameError`` at import time (aborting the whole
backend), and a corrupt ``sessions.json`` turned a graceful fallback into a
500.
"""
from __future__ import annotations

import ast
import pathlib
import re

import server

_PATTERN = re.compile(r"(?<![\w.])log\.\w")


def _defines_module_level_log(tree: ast.Module) -> bool:
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == "log" for t in node.targets
        ):
            return True
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id == "log":
            return True
        if isinstance(node, ast.Import) and any(
            a.asname == "log" or (a.asname is None and a.name == "log") for a in node.names
        ):
            return True
        if isinstance(node, ast.ImportFrom) and any(
            a.asname == "log" or (a.asname is None and a.name == "log") for a in node.names
        ):
            return True
    return False


def test_every_server_module_calling_log_defines_it() -> None:
    package_root = pathlib.Path(server.__file__).resolve().parent
    offenders: list[str] = []

    for py in sorted(package_root.rglob("*.py")):
        if py.name == "__init__.py":
            continue
        source = py.read_text(encoding="utf-8")
        if not _PATTERN.search(source):
            continue
        tree = ast.parse(source)
        if _defines_module_level_log(tree):
            continue
        rel = py.relative_to(package_root.parent).with_suffix("")
        dotted = ".".join(rel.parts)
        if not dotted.startswith("server."):
            continue
        import importlib

        module = importlib.import_module(dotted)
        if not hasattr(module, "log"):
            offenders.append(dotted)

    assert offenders == [], f"modules using bare `log.` without defining it: {offenders}"
