"""The app-level exception mapper is the safety net for un-translated
service exceptions: a route that forgets one except-clause must still
produce the semantic HTTP shape, never an unexplained 500.

Route-local translations always win (they raise HTTPException, which
FastAPI handles before these) — these tests cover the fallback path.
"""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.error_mapping import install_error_handlers
from server.services.llm_registry import (
    LlmRegistryError,
    LlmUnavailableError,
    LlmUnconfirmedError,
)
from server.services.session_coordinator import (
    AgentBusyError,
    SessionControlBusyError,
    SessionCoordinatorStoppedError,
)
from server.services.session_runtime_factory import RuntimeRestoreError


def _client(exc: BaseException) -> TestClient:
    app = FastAPI()
    install_error_handlers(app)

    @app.post("/boom")
    async def boom() -> dict:
        raise exc

    return TestClient(app, raise_server_exceptions=False)


def test_control_busy_maps_to_409_with_operation() -> None:
    response = _client(SessionControlBusyError("s1", "rewind")).post("/boom")
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["code"] == "session_control_active"
    assert detail["operation"] == "rewind"


def test_agent_busy_maps_to_session_active_for_same_session() -> None:
    busy = AgentBusyError("s1", "run-1")
    busy.reason = AgentBusyError.REASON_SESSION_ACTIVE
    response = _client(busy).post("/boom")
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["code"] == "session_active"
    assert detail["active_run_id"] == "run-1"


def test_capacity_overflow_maps_to_agent_busy() -> None:
    response = _client(AgentBusyError("other", "run-9")).post("/boom")
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "agent_busy"


def test_restore_failure_maps_to_409() -> None:
    response = _client(RuntimeRestoreError("restore blew up")).post("/boom")
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "restore_failed"


def test_lifecycle_stopping_maps_to_503() -> None:
    response = _client(SessionCoordinatorStoppedError("stopping")).post("/boom")
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "session_runtime_stopping"


def test_llm_families_map_to_409() -> None:
    cases = {
        LlmUnconfirmedError("x"): "llm_unconfirmed",
        LlmUnavailableError("x"): "llm_unavailable",
        LlmRegistryError("x"): "llm_registry_error",
    }
    for exc, code in cases.items():
        response = _client(exc).post("/boom")
        assert response.status_code == 409, code
        assert response.json()["detail"]["code"] == code
