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

import asyncio
import importlib.util
import sys
import threading
import time
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

    calls = {"connect": [], "clients": [], "events": []}

    class FakeClient:
        def __init__(self, agent, name, hooks):
            self.agent = agent
            self.name = name
            self.hooks = hooks
            self.started = True
            self.stop_result = True
            self.stop_calls = 0

        def is_alive(self):
            return self.started

        def stop(self):
            self.stop_calls += 1
            calls["events"].append(("stop", self.agent))
            if self.stop_result:
                self.started = False
            return self.stop_result

    def fake_connect(agent, name=None, put_task=None, **overrides):
        calls["connect"].append({"agent": agent, "name": name,
                                 "put_task": put_task, **overrides})
        calls["events"].append(("connect", agent))
        # Mirror frontends.hub.connect: install the exact newly-started client
        # on agent._hub; start() itself has no meaningful return value.
        client = FakeClient(agent, name, {"put_task": put_task, **overrides})
        calls["clients"].append(client)
        agent._hub = client
        return None

    fake_hub = SimpleNamespace(connect=fake_connect)
    monkeypatch.setitem(sys.modules, "frontends.hub", fake_hub)
    import frontends

    monkeypatch.setattr(frontends, "hub", fake_hub, raising=False)
    try:
        yield official_hub, calls
    finally:
        official_hub.detach()
        # A test may deliberately simulate an uncooperative old loop.  Reset
        # this module singleton explicitly so that failure-path state cannot
        # leak into the next contract test.
        official_hub._client = None
        official_hub._agent = None
        official_hub._attached = False


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
    first = calls["clients"][0]
    assert official_hub.is_attached() is True
    official_hub.detach()
    assert official_hub.is_attached() is False
    assert first.stop_calls == 1
    assert svc.agent._hub is None

    official_hub.attach(svc)
    assert official_hub.is_attached() is True
    assert len(calls["connect"]) == 2  # re-attached after detach


def test_reattach_stops_old_before_connecting_new(bridge):
    official_hub, calls = bridge
    svc1, _ = _make_service()
    svc2, _ = _make_service()

    assert official_hub.attach(svc1) is True
    old = calls["clients"][0]
    assert official_hub.attach(svc2) is True

    assert calls["events"] == [
        ("connect", svc1.agent),
        ("stop", svc1.agent),
        ("connect", svc2.agent),
    ]
    assert old.is_alive() is False
    assert svc1.agent._hub is None
    assert official_hub.is_attached() is True


def test_old_shutdown_failure_blocks_replacement_and_retry_can_succeed(bridge):
    official_hub, calls = bridge
    svc1, _ = _make_service()
    svc2, _ = _make_service()

    assert official_hub.attach(svc1) is True
    old = calls["clients"][0]
    old.stop_result = False

    assert official_hub.attach(svc2) is False
    assert official_hub.is_attached() is False
    assert len(calls["connect"]) == 1
    assert svc1.agent._hub is old

    old.stop_result = True
    assert official_hub.attach(svc2) is True
    assert len(calls["connect"]) == 2
    assert svc1.agent._hub is None


def test_dead_owned_client_is_not_treated_as_idempotently_attached(bridge):
    official_hub, calls = bridge
    svc, _ = _make_service()

    assert official_hub.attach(svc) is True
    calls["clients"][0].started = False

    assert official_hub.is_attached() is False
    assert official_hub.attach(svc) is True
    assert len(calls["connect"]) == 2


def test_clear_agent_hub_only_when_bridge_still_owns_that_reference(bridge):
    official_hub, calls = bridge
    svc1, _ = _make_service()
    svc2, _ = _make_service()

    assert official_hub.attach(svc1) is True
    replacement = object()
    svc1.agent._hub = replacement

    assert official_hub.attach(svc2) is True
    assert svc1.agent._hub is replacement


def test_unowned_agent_hub_is_preserved_and_blocks_attach(bridge):
    official_hub, calls = bridge
    svc, _ = _make_service()
    foreign = object()
    svc.agent._hub = foreign

    assert official_hub.attach(svc) is False
    assert official_hub.is_attached() is False
    assert calls["connect"] == []
    assert svc.agent._hub is foreign


def test_same_agent_foreign_replacement_is_not_treated_as_idempotent(bridge):
    official_hub, calls = bridge
    svc, _ = _make_service()
    assert official_hub.attach(svc) is True
    owned = calls["clients"][0]
    foreign = object()
    svc.agent._hub = foreign

    assert official_hub.is_attached() is False
    assert official_hub.attach(svc) is False
    assert owned.stop_calls == 1
    assert calls["connect"] and len(calls["connect"]) == 1
    assert svc.agent._hub is foreign


def test_new_dead_client_fails_closed_and_is_cleaned_up(bridge, monkeypatch):
    official_hub, calls = bridge
    svc, _ = _make_service()

    import frontends.hub as fake_hub
    original_connect = fake_hub.connect

    def connect_dead(*args, **kwargs):
        result = original_connect(*args, **kwargs)
        calls["clients"][-1].started = False
        return result

    monkeypatch.setattr(fake_hub, "connect", connect_dead)
    assert official_hub.attach(svc) is False
    assert official_hub.is_attached() is False
    assert calls["clients"][0].stop_calls == 1
    assert svc.agent._hub is None


def _load_real_hub_module():
    """Load GA's hub module under a private name, isolated from bridge fakes."""
    path = Path(_paths.GA_ROOT) / "frontends" / "hub.py"
    spec = importlib.util.spec_from_file_location("_gahub_real_hub_lifecycle", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_real_hub_client_stop_cancels_blocked_handshake_and_is_one_shot(monkeypatch):
    hub = _load_real_hub_module()
    entered = threading.Event()
    connects = []

    class BlockedConnection:
        async def __aenter__(self):
            entered.set()
            await asyncio.Event().wait()

        async def __aexit__(self, exc_type, exc, tb):
            return False

    def connect(*args, **kwargs):
        connects.append((args, kwargs))
        return BlockedConnection()

    monkeypatch.setitem(sys.modules, "websockets", SimpleNamespace(connect=connect))
    client = hub.HubClient("lifecycle-test")
    client.start()
    assert entered.wait(1), "client did not enter the simulated websocket handshake"
    thread = client._thread
    assert client.is_alive() is True

    assert client.stop(timeout=1) is True
    assert thread is not None and not thread.is_alive()
    assert client.is_alive() is False
    assert client._lp is None and client._task is None and client._ws is None

    client.start()
    time.sleep(0.05)
    assert client._thread is thread
    assert len(connects) == 1


def test_real_hub_client_stopped_before_start_never_spawns_thread():
    hub = _load_real_hub_module()
    client = hub.HubClient("never-start")

    assert client.stop(timeout=0.01) is True
    client.start()
    assert client._thread is None
    assert client.is_alive() is False
