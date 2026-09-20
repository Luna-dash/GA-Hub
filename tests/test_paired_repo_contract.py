"""Paired-checkout contract test without importing GA runtime code."""
from __future__ import annotations

import ast
from pathlib import Path

import pytest

from server import _paths
from server.services import conductor_protocol


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


def test_paired_ga_checkout_matches_hub_conductor_requirements():
    ga_root = Path(_paths.GA_ROOT) if _paths.GA_ROOT else ROOT.parent / "GA"
    contract_path = ga_root / "frontends" / "gahub" / "bridge" / "contract.py"
    if not contract_path.is_file():
        pytest.skip("requires a paired GA checkout with the registered bridge contract")

    provider = _literal_assignments(contract_path)
    assert provider["PROTOCOL_VERSION"] == conductor_protocol.PROTOCOL_VERSION
    assert provider["SERVICE_NAME"] == conductor_protocol.SERVICE_NAME
    assert set(provider["CAPABILITIES"]) >= conductor_protocol.REQUIRED_CAPABILITIES


ROOT = Path(__file__).resolve().parents[1]
