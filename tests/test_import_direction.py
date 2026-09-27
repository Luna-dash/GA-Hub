"""Static scan: the layering direction is a contract, not a habit.

- services/ never import fastapi/pydantic (HTTP stays in routes) and never
  reach up into routes/
- routes/ never import a sibling route AT ALL — not at module level and not as
  a function-local lazy import either. Shared state belongs to a service the
  composition root owns and binds to the app (`app.state.session_lifecycle`).
  The function-local form was the loophole: `conversations` used
  `from .sessions import peek_coordinator` inside a function to dodge the
  module-level rule, which still made a route module the de-facto owner of
  process-wide state.

Modeled on test_event_topics / test_env_registry.
Companion: tests/test_session_domain_contract.py (who owns the session domain).
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

_HTTP_IMPORT = re.compile(r"^\s*(?:import fastapi|from fastapi|import pydantic|from pydantic)\b", re.M)
_ROUTES_UPIMPORT = re.compile(r"from \.\.routes\b|from server\.routes\b")
# `from .sessions import ...` / `from ..routes import ...`, at any indentation.
_SIBLING_ROUTE = re.compile(r"^\s*from \.[a-z_]+ import |^\s*from \.\.routes\b", re.M)


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


def test_routes_never_import_a_sibling_route() -> None:
    offenders: list[str] = []
    for path in _iter("routes"):
        text = path.read_text(encoding="utf-8")
        for match in _SIBLING_ROUTE.finditer(text):
            line_no = text.count("\n", 0, match.start()) + 1
            offenders.append(
                f"{path.relative_to(ROOT)}:{line_no}: {match.group(0).strip()}"
            )
    assert offenders == []
