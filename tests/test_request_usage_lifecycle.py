"""Request-level usage lifecycle tests for the Conductor service."""
from __future__ import annotations

from server.services.conductor_service import ConductorService, HubConductorCallbacks
from server.services.request_usage import RequestUsageStore


def test_conductor_request_lifecycle_activates_records_and_completes():
    service = object.__new__(ConductorService)
    service.usage_store = RequestUsageStore(clock=lambda: 10.0)
    request_id = service.usage_store.begin("rid-1")
    callbacks = HubConductorCallbacks(service)

    token = callbacks.on_conductor_request_started(request_id)
    service.usage_store.record({"input_tokens": 7, "output_tokens": 3}, "messages")
    callbacks.on_conductor_request_finished(request_id, token)

    row = service.usage_store.list()[0]
    assert row["request_id"] == request_id
    assert row["requests"] == 1
    assert row["input"] == 7
    assert row["output"] == 3
    assert row["attribution"] == "OK"
    assert row["completed_at"] == 10.0
