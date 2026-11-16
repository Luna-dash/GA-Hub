"""Admission failures do not start a desktop or touch production data."""
import json
from types import SimpleNamespace

import pytest

from server.services import update_preflight as module
from server.services.self_update import UpdateStore, atomic_json
from test_self_update import prepare, release


def test_selftest_failure_revokes_previous_admission_and_isolates(tmp_path, monkeypatch):
    store = UpdateStore(tmp_path / "updates")
    plan = prepare(store, release(tmp_path))
    receipt = store.root / "admission" / f"{plan['id']}.json"
    atomic_json(receipt, {"passed": True})
    monkeypatch.setenv("GA_ROOT", "production-core")
    monkeypatch.setenv("GA_ADMIN_DATA", "production-admin")
    monkeypatch.setenv("GA_HUB_UPDATE_NONCE", "production-nonce")
    calls = []
    def fail_selftest(command, **kwargs):
        calls.append((command, kwargs))
        return SimpleNamespace(returncode=7, stdout=b"failure", stderr=b"missing DLL")
    monkeypatch.setattr(module.subprocess, "run", fail_selftest)
    with pytest.raises(ValueError, match="selftest failed"):
        module.preflight(store, plan["id"])
    assert not receipt.exists()
    command, options = calls[0]
    assert command[-1] == "--selftest"
    assert options["env"]["GA_HUB_UPDATE_PREFLIGHT"] == "1"
    assert options["env"]["GA_ADMIN_DATA"].startswith(str(store.root))
    assert "GA_ROOT" not in options["env"]
    assert "GA_HUB_UPDATE_NONCE" not in options["env"]
    assert store.read()["state"] == "prepared"


def test_cancelled_plan_cannot_preflight(tmp_path):
    store = UpdateStore(tmp_path / "updates")
    plan = prepare(store, release(tmp_path))
    store.cancel(plan["id"])
    with pytest.raises(ValueError):
        module.preflight(store, plan["id"])
