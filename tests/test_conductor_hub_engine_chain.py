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
    service = object.__new__(ConductorService)
    service._process_manager = manager
    service.client = GaConductorClient(manager)
    return service


def test_accept_forwards_force_through_the_real_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Regression: force used to raise TypeError at the service→client seam."""
    engine = _FakeEngine()
    engine.on("GET", "/health", {})
    engine.on("GET", "/status", {"started": True, "stopping": False})
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
    """A clean accept stays a plain accept: no force flag on the wire."""
    engine = _FakeEngine()
    engine.on("GET", "/health", {})
    engine.on("GET", "/status", {"started": True, "stopping": False})
    engine.on("POST", "/subagent", {"id": "w1", "status": "stopped"})
    service = _chain_service(monkeypatch, engine)

    service.accept_subagent("w1")

    accept_calls = [c for c in engine.calls
                    if c["method"] == "POST" and "/subagent/" in c["path"]]
    assert accept_calls[0]["json"].get("force") is None


def test_journal_epoch_change_resets_cursor_and_replays(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A fresh engine journal must renumber the cursor, not filter on it.

    Regression: the old code logged "replaying its events" but kept the old
    high-water seq, so after an engine restart every event of the new
    journal (seq restarting at 1) was silently dropped.
    """
    engine = _FakeEngine()
    service = _chain_service(monkeypatch, engine)
    service._journal_cursor = {"seq": 5000, "epoch": "epoch-1"}
    fed: list[dict] = []
    service._on_sse_event = fed.append  # type: ignore[method-assign]

    # First fetch uses the stale floor: the fresh journal has nothing above
    # seq 5000, but its metadata reveals the epoch change...
    def journal_payload(after_seq: int) -> dict:
        if after_seq >= 5000:
            return {"journal": {"epoch": "epoch-2", "last_seq": 2,
                                "disabled": False}, "events": []}
        return {"journal": {"epoch": "epoch-2", "last_seq": 2,
                            "disabled": False},
                "events": [
                    {"seq": 1, "payload": {"event": "subagent_started",
                                           "id": "w1"}},
                    {"seq": 2, "payload": {"event": "pending_review",
                                           "id": "w1"}},
                ]}

    def _fake_request(method, url, **kwargs):
        path = "/" + url.split("/", 3)[-1]
        assert method == "GET" and path.startswith("/journal")
        return _FakeResponse(journal_payload(int(kwargs["params"]["after_seq"])))

    monkeypatch.setattr(conductor_client_module.requests, "request", _fake_request)

    service._replay_journal()

    # ...so the replay must restart from 0 and feed the new journal's events.
    assert [e["event"] for e in fed] == ["subagent_started", "pending_review"]
    assert service._journal_cursor == {"seq": 2, "epoch": "epoch-2"}


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
