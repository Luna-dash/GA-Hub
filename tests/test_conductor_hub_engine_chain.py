"""Real service→client→(fake HTTP) chain tests for the conductor boundary.

The route/service unit tests mock the service layer, so a Python-level
signature mismatch between ``ConductorService`` and ``GaConductorClient``
passes them silently (this is exactly how the force-accept TypeError
survived: ``accept_subagent`` forwarded ``force=`` to a client that never
accepted it).  These tests build a REAL ``ConductorService`` around a REAL
``GaConductorClient`` and stub only the HTTP transport, so any contract
break between hub layers surfaces as an exception here.
"""
from __future__ import annotations

import json
import sys
import threading
import time
from typing import Any

import pytest

import server.services.conductor_client as conductor_client_module
from server.services.conductor_client import (
    GahubProcessManager,
    GaConductorClient,
)
from server.services.conductor_ext_timeout import TimeoutMonitor
from server.services.conductor_service import ConductorService


class _FakeResponse:
    def __init__(self, payload: dict, status_code: int = 200):
        self.status_code = status_code
        self._payload = payload
        self.text = json.dumps(payload)
        self.content = self.text.encode("utf-8")

    def json(self) -> dict:
        return self._payload


class _FakeEngine:
    """Stub HTTP transport in front of a scripted engine response table."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self._lock = threading.Lock()
        self.routes: list[tuple[str, str, dict]] = []

    def on(self, method: str, path_prefix: str, payload: dict) -> None:
        self.routes.append((method, path_prefix, payload))

    def respond(self, method: str, path: str, kwargs: dict) -> _FakeResponse:
        with self._lock:
            self.calls.append({
                "method": method,
                "path": path,
                "json": kwargs.get("json"),
                "params": kwargs.get("params") or {},
            })
        for route_method, prefix, payload in reversed(self.routes):
            if method == route_method and path.startswith(prefix):
                return _FakeResponse(payload)
        return _FakeResponse({})

    def install(self, monkeypatch: pytest.MonkeyPatch) -> None:
        fake = self

        def _request(method, url, **kwargs):
            path = "/" + url.split("/", 3)[-1]
            return fake.respond(method, path, kwargs)

        def _get(url, **kwargs):
            path = "/" + url.split("/", 3)[-1]
            return fake.respond("GET", path, kwargs)

        monkeypatch.setattr(conductor_client_module.requests, "request", _request)
        monkeypatch.setattr(conductor_client_module.requests, "get", _get)


def _chain_service(monkeypatch: pytest.MonkeyPatch, engine: _FakeEngine) -> ConductorService:
    """Real service + real client; only the HTTP layer is scripted."""
    engine.install(monkeypatch)
    manager = GahubProcessManager(
        ga_root="D:/nonexistent-ga", port=18770, token="test-token",
        python_exe=sys.executable, spawn_enabled=False,
    )
    service = ConductorService.for_tests()
    service._process_manager = manager
    service.client = GaConductorClient(manager)
    # These tests script individual HTTP endpoints; keep the SSE relay
    # thread (started by _assert_engine_ready once /status reports
    # started) out of the picture entirely.
    service._ensure_relay = lambda: None  # type: ignore[method-assign]
    return service


def _wire_recovery_protocol(engine: _FakeEngine) -> None:
    """Script the endpoints the command track touches before the accept POST:
    status probe, recovery protocol, journal catch-up, worker envelope."""
    engine.on("GET", "/status", {"started": True, "stopping": False})
    engine.on("GET", "/recovery",
              {"protocol_version": 2, "boot_id": "b1",
               "capabilities": ["snapshot_revision", "path_policy",
                                "request_recovery", "guarded_actions",
                                "operation_receipts"],
               "path_policy": {"mode": "explicit_absolute"},
               "requests": []})
    engine.on("GET", "/journal",
              {"journal": {"epoch": "journal-a", "last_seq": 0,
                           "disabled": False}, "events": []})
    engine.on("GET", "/subagent",
              {"boot_id": "b1", "snapshot_revision": 1, "items": []})


def test_accept_forwards_force_through_the_real_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Regression: force used to raise TypeError at the service→client seam."""
    monkeypatch.setenv("GAHUB_PATH_POLICY", "explicit_absolute")
    engine = _FakeEngine()
    _wire_recovery_protocol(engine)
    engine.on("GET", "/subagent/w1",
              {"id": "w1", "boot_id": "b1", "active_generation": 1,
               "command_revision": 3, "review_status": "pending"})
    engine.on("POST", "/subagent", {"id": "w1", "status": "stopped",
                                    "active_generation": 1})
    service = _chain_service(monkeypatch, engine)

    result = service.accept_subagent("w1", "人工核对证据后强制通过", force=True)

    assert result["id"] == "w1"
    accept_calls = [c for c in engine.calls
                    if c["method"] == "POST" and "/subagent/" in c["path"]]
    assert len(accept_calls) == 1
    assert accept_calls[0]["json"]["action"] == "accept"
    # The audited escape hatch must reach the engine verbatim.
    assert accept_calls[0]["json"]["force"] is True
    assert accept_calls[0]["json"]["msg"] == "人工核对证据后强制通过"


def test_plain_accept_omits_force(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A clean accept stays a plain accept: force is never truthy on the wire."""
    monkeypatch.setenv("GAHUB_PATH_POLICY", "explicit_absolute")
    engine = _FakeEngine()
    _wire_recovery_protocol(engine)
    engine.on("GET", "/subagent/w1",
              {"id": "w1", "boot_id": "b1", "active_generation": 1,
               "command_revision": 3, "review_status": "pending"})
    engine.on("POST", "/subagent", {"id": "w1", "status": "stopped"})
    service = _chain_service(monkeypatch, engine)

    service.accept_subagent("w1")

    accept_calls = [c for c in engine.calls
                    if c["method"] == "POST" and "/subagent/" in c["path"]]
    assert accept_calls[0]["json"]["action"] == "accept"
    assert not accept_calls[0]["json"].get("force")


def test_timeout_monitor_survives_malformed_snapshots() -> None:
    """One bad check must not kill the monitor thread (silence-forever bug)."""
    class _BadState:
        @property
        def status(self) -> str:
            raise RuntimeError("malformed engine snapshot")

    class _BadCore:
        lock = None
        subagents = {"w1": _BadState()}

    monitor = TimeoutMonitor(
        _BadCore(), check_interval=0.05, silence_timeout=1.0,
        total_timeout=2.0, publish=lambda *args: None,
    )
    monitor.start()
    try:
        # Without the guard the thread dies on its first tick (~50ms).
        time.sleep(0.4)
        thread = monitor._thread
        assert thread is not None
        assert thread.is_alive(), "monitor thread died after a failed check"
    finally:
        assert monitor.stop(timeout=2.0) is True
