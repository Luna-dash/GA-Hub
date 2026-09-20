"""Contract tests for the optional official-hub bridge (W3.6).

The bridge is a thin wrapper over GA's official ``frontends.hub.connect``:
it reuses the official wiring for get_outputs / abort / state / llm and only
overrides ``put_task`` (A-scheme: real submit, not the UI-park default).  It
captures the AgentService instance passed to ``attach`` by closure — there is
no dependency back into the GA-Hub ``server`` package from GA-side code.

These tests verify the acceptance surface that is GA-Hub's own responsibility:
silent degradation when the official hub module is absent, idempotent attach /
rebind-on-new-agent, the put_task hook contract (string-only, busy guard,
routed through ``svc.submit(source="hub")``, never raising), and detach.
The officially-owned hooks (get_outputs/abort/state/llm) are exercised in GA's
own hub tests, not re-asserted here.
"""
from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import server._paths as _paths  # noqa: E402

GA_ROOT = _paths.GA_ROOT
if GA_ROOT is None or not (GA_ROOT / "frontends" / "gahub").is_dir():
    pytest.skip("GA checkout not found", allow_module_level=True)

GA_ROOT_STR = str(GA_ROOT)


@pytest.fixture()
def bridge(monkeypatch):
    """Import the bridge and install a fake frontends.hub exposing connect()."""
    monkeypatch.syspath_prepend(GA_ROOT_STR)
    from frontends.gahub.bridge import official_hub

    calls = {"connect": []}

    class FakeClient:
        def __init__(self, agent, name, hooks):
            self.agent = agent
            self.name = name
            self.hooks = hooks
            self.started = True

    def fake_connect(agent, name=None, put_task=None, **overrides):
        calls["connect"].append({"agent": agent, "name": name,
                                 "put_task": put_task, **overrides})
        # Mirror the real frontends.hub.connect contract: it sets agent._hub
        # and returns agent._hub.start() (None once the loop is running).
        client = FakeClient(agent, name, {"put_task": put_task, **overrides})
        agent._hub = client
        return None  # start() already-running path

    fake_hub = SimpleNamespace(connect=fake_connect)
    monkeypatch.setitem(sys.modules, "frontends.hub", fake_hub)
    import frontends

    monkeypatch.setattr(frontends, "hub", fake_hub, raising=False)
    try:
        yield official_hub, calls
    finally:
        official_hub.detach()


def _make_service(*, run=False):
    agent = SimpleNamespace(is_running=run)
    calls = {"submit": []}
    svc = SimpleNamespace(
        agent=agent,
        submit=lambda query, source=None, **kw: calls["submit"].append(
            (query, source)) or SimpleNamespace(),
    )
    return svc, calls


def test_degrades_when_hub_missing(monkeypatch):
    """Official hub module absent -> attach() returns False, never raises."""
    monkeypatch.syspath_prepend(GA_ROOT_STR)
    from frontends.gahub.bridge import official_hub

    monkeypatch.delitem(sys.modules, "frontends.hub", raising=False)
    real_import = __import__

    def blocked(name, *a, **k):
        if name == "frontends.hub" or name.startswith("frontends.hub."):
            raise ImportError("no hub module")
        return real_import(name, *a, **k)

    monkeypatch.setattr("builtins.__import__", blocked)
    try:
        svc, _ = _make_service()
        assert official_hub.attach(svc) is False
        assert official_hub.is_attached() is False
    finally:
        official_hub.detach()


def test_attach_calls_official_connect_with_put_task_override(bridge):
    official_hub, calls = bridge
    svc, _ = _make_service()

    assert official_hub.attach(svc) is True
    assert official_hub.is_attached() is True
    assert len(calls["connect"]) == 1
    call = calls["connect"][0]
    assert call["agent"] is svc.agent
    assert call["name"] == "gahub"
    assert callable(call["put_task"])


def test_attach_idempotent_same_agent(bridge):
    official_hub, calls = bridge
    svc, _ = _make_service()

    official_hub.attach(svc)
    official_hub.attach(svc)  # same agent -> no rewire
    assert len(calls["connect"]) == 1


def test_reattach_new_agent_rewires(bridge):
    official_hub, calls = bridge
    svc1, _ = _make_service()
    svc2, _ = _make_service()

    official_hub.attach(svc1)
    official_hub.attach(svc2)  # different agent -> rewire
    assert len(calls["connect"]) == 2
    assert calls["connect"][1]["agent"] is svc2.agent


def test_put_task_routes_through_submit_with_hub_source(bridge):
    official_hub, calls = bridge
    svc, svc_calls = _make_service()
    official_hub.attach(svc)
    put = calls["connect"][0]["put_task"]

    assert put("do thing") == {"ok": 1}
    assert svc_calls["submit"] == [("do thing", "hub")]


def test_put_task_rejects_non_string(bridge):
    official_hub, calls = bridge
    svc, svc_calls = _make_service()
    official_hub.attach(svc)
    put = calls["connect"][0]["put_task"]

    assert put(None) == {"error": "text must be a string", "code": "badop"}
    assert put(123) == {"error": "text must be a string", "code": "badop"}
    assert svc_calls["submit"] == []


def test_put_task_rejects_when_busy(bridge):
    official_hub, calls = bridge
    svc, svc_calls = _make_service(run=True)
    official_hub.attach(svc)
    put = calls["connect"][0]["put_task"]

    assert put("x") == {"error": "peer gahub is busy", "code": "busy"}
    assert svc_calls["submit"] == []


def test_put_task_swallows_service_error(bridge):
    official_hub, calls = bridge
    svc, _ = _make_service()
    svc.submit = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom"))
    official_hub.attach(svc)
    put = calls["connect"][0]["put_task"]

    res = put("x")
    assert res["code"] == "nosupport"
    assert "boom" in res["error"]


def test_detach_marks_unattached_and_allows_reattach(bridge):
    official_hub, calls = bridge
    svc, _ = _make_service()

    official_hub.attach(svc)
    assert official_hub.is_attached() is True
    official_hub.detach()
    assert official_hub.is_attached() is False

    official_hub.attach(svc)
    assert official_hub.is_attached() is True
    assert len(calls["connect"]) == 2  # re-attached after detach
