"""Preserve engine rejection evidence across the real HTTP forwarding chain."""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
import requests
from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.routes import conductor as conductor_routes
from server.services import conductor_client as client_module
from server.services.conductor_client import GaConductorClient, GahubProcessError
from server.services.conductor_service import ConductorService


def _response(payload, status_code):
    response = requests.Response()
    response.status_code = status_code
    response._content = json.dumps(payload).encode("utf-8")
    response.headers["Content-Type"] = "application/json"
    return response


def _client():
    manager = SimpleNamespace(
        base_url=lambda: "http://127.0.0.1:18770",
        _headers=lambda: {},
    )
    return GaConductorClient(manager)


def test_accept_http_409_preserves_verification_evidence_through_route(monkeypatch):
    monkeypatch.setenv("GAHUB_PATH_POLICY", "explicit_absolute")
    evidence = {
        "error": "completion_unverified",
        "id": "worker-1",
        "done_marker": False,
        "deliverables_missing": ["D:/study/GA/temp/result.txt"],
        "deliverables_stale": [],
        "quality_checks": {
            "checks_ok": False,
            "checks": [{"kind": "file_exists", "passed": False}],
        },
        "generation": 2,
        "verified_at": 1234.5,
    }
    calls = []

    def request(method, url, **kwargs):
        calls.append((method, url, kwargs.get("json")))
        if url.endswith("/status"):
            return _response({"started": True, "stopping": False}, 200)
        if url.endswith("/recovery"):
            return _response({
                "protocol_version": 2, "boot_id": "b1",
                "capabilities": ["snapshot_revision", "path_policy",
                                 "request_recovery", "guarded_actions",
                                 "operation_receipts", "sse_resync",
                                 "unified_admission"],
                "path_policy": {"mode": "explicit_absolute"},
                "requests": [],
            }, 200)
        if url.endswith("/journal"):
            return _response({"journal": {"epoch": "journal-a", "last_seq": 0},
                              "events": []}, 200)
        if url.endswith("/models"):
            return _response({}, 200)
        if url.endswith("/subagent"):
            return _response({"boot_id": "b1", "snapshot_revision": 1,
                              "items": []}, 200)
        if url.endswith("/subagent/worker-1") and method == "GET":
            return _response({"id": "worker-1", "boot_id": "b1",
                              "active_generation": 1, "command_revision": 3,
                              "review_status": "pending"}, 200)
        return _response(evidence, 409)

    monkeypatch.setattr(client_module.requests, "request", request)
    service = ConductorService.for_tests()
    service._process_manager = None
    service._ensure_relay = lambda: None
    service.client = _client()
    service.pool.client = service.client
    service.pool.update([{"id": "worker-1", "status": "stopped"}])
    monkeypatch.setattr(conductor_routes, "svc", lambda: service)
    app = FastAPI()
    app.include_router(conductor_routes.router)

    with TestClient(app) as client:
        result = client.post("/api/conductor/subagent/worker-1", json={"action": "accept"})

    assert result.status_code == 409
    # The engine's verification evidence rides through verbatim; the command
    # track only adds its own reconciliation bookkeeping keys.
    detail = result.json()["detail"]
    for key, value in evidence.items():
        assert detail[key] == value
    assert detail["operation_state"] == "rejected"
    assert detail["operation_id"]
    assert calls[-1][:2] == ("POST", "http://127.0.0.1:18770/subagent/worker-1")
    assert calls[-1][2]["action"] == "accept"


@pytest.mark.parametrize(
    ("status", "payload", "mapped_status", "mapped_detail"),
    [
        (422, {"detail": [{"loc": ["body", "goal"], "msg": "Field required"}]},
         422, [{"loc": ["body", "goal"], "msg": "Field required"}]),
        (409, {"detail": "accepted_subagent_is_terminal"},
         409, "accepted_subagent_is_terminal"),
        (503, {"error": "conductor is stopping", "retry_after": 1},
         503, {"error": "conductor is stopping", "retry_after": 1}),
        (500, {"error": "check_failed", "check_id": "check-1"},
         502, {"error": "check_failed", "check_id": "check-1"}),
    ],
)
def test_json_http_errors_keep_payload_and_route_structure(
    monkeypatch, status, payload, mapped_status, mapped_detail,
):
    monkeypatch.setattr(
        client_module.requests, "request", lambda *_args, **_kwargs: _response(payload, status))

    with pytest.raises(GahubProcessError) as caught:
        _client()._request("POST", "/subagent")

    error = caught.value
    assert error.detail == payload
    mapped = conductor_routes._engine_http_error(error)
    assert mapped.status_code == mapped_status
    assert mapped.detail == mapped_detail
    if status == 422:
        assert str(error).endswith("Field required")


def test_plain_text_http_error_keeps_legacy_message(monkeypatch):
    response = requests.Response()
    response.status_code = 409
    response._content = b"worker is already running"
    monkeypatch.setattr(
        client_module.requests, "request", lambda *_args, **_kwargs: response)

    with pytest.raises(GahubProcessError) as caught:
        _client()._request("POST", "/subagent")

    assert caught.value.detail == "worker is already running"
    mapped = conductor_routes._engine_http_error(caught.value)
    assert mapped.status_code == 409
    assert mapped.detail == "worker is already running"
