"""Static scan: the layering direction is a contract, not a habit.

- services/ never import fastapi/pydantic (HTTP stays in routes) and never
  reach up into routes/
- routes/ never import a sibling route at MODULE level — the four known
  cross-route edges are function-local lazy imports on purpose (they defer
  the heavy GA/frontends import chain), and a module-level sibling import
  would be the sessions-as-service-locator drift reappearing

Modeled on test_event_topics / test_env_registry.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

_HTTP_IMPORT = re.compile(r"^\s*(?:import fastapi|from fastapi|import pydantic|from pydantic)\b", re.M)
_ROUTES_UPIMPORT = re.compile(r"from \.\.routes\b|from server\.routes\b")
# `from .sessions import ...` etc. at column 0 = module level (a function-local
# import is indented and sanctioned).
_SIBLING_ROUTE = re.compile(r"^from \.[a-z_]+ import ", re.M)


def _iter(pkg: str):
    return sorted((ROOT / "server" / pkg).rglob("*.py"))


def test_services_stay_free_of_http_and_pydantic() -> None:
    offenders = [
        str(path.relative_to(ROOT))
        for path in _iter("services")
        if _HTTP_IMPORT.search(path.read_text(encoding="utf-8"))
    ]
    assert offenders == []


def test_services_do_not_reach_up_into_routes() -> None:
    offenders = [
        str(path.relative_to(ROOT))
        for path in _iter("services")
        if _ROUTES_UPIMPORT.search(path.read_text(encoding="utf-8"))
    ]
    assert offenders == []


def test_routes_import_siblings_only_inside_functions() -> None:
    offenders: list[str] = []
    for path in _iter("routes"):
        text = path.read_text(encoding="utf-8")
        for match in _SIBLING_ROUTE.finditer(text):
            line_start = text.rfind("\n", 0, match.start()) + 1
            # column 0 = module level; anything indented is a sanctioned lazy
            # edge (sessions' heavy frontends chain, conversations' peek).
            if match.start() == line_start:
                offenders.append(f"{path.relative_to(ROOT)}: {match.group(0).strip()}")
    assert offenders == []
