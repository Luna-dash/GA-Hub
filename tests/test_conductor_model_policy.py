"""Conductor-owned subagent model routing policy tests."""
from __future__ import annotations

import threading

import pytest
from unittest.mock import Mock, patch

from server.services.conductor_service import (
    ConductorService,
    HubConductorCallbacks,
    READMES,
)
from server.services.conductor_workflow import WorkflowTracker

import pytest

from conductor_engine import Engine
from server.services.conductor_service import ConductorService


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setenv("GAHUB_PATH_POLICY", "explicit_absolute")
    engine = Engine()
    engine.started = True
    services = []

    def create():
        service = ConductorService.for_tests(store_path=tmp_path / "state.sqlite3")
        service.client = engine
        service.pool.client = engine
        service._process_manager = None
        service._ensure_relay = lambda: None
        services.append(service)
        return service

    yield engine, create
    for service in services:
        service.store.close()


def _service(
    *,
    main: int | None = 1,
    worker: int | None = None,
    policy: str = "follow_main",
) -> ConductorService:
    service = ConductorService.for_tests()
    service._conductor_llm_index = main
    service._subagent_llm_index = worker
    service._subagent_model_policy = policy
    service._model_lock = threading.RLock()
    service.pool = Mock()
    service.pool.snapshot.return_value = []
    service.client = Mock()
    service.client.start_subagent.return_value = {
        "id": "worker-1", "active_generation": 1}
    service.client.subagent_action.return_value = {
        "id": "worker-1", "active_generation": 1}
    service.callbacks = HubConductorCallbacks(service)
    return service


def _resolve(service, requested=None):
    return service._resolve_subagent_model_from_snapshot(
        requested, service.model_policy_snapshot())


def test_default_policy_allows_explicit_dispatch_override():
    service = _service(worker=5, policy="default")

    assert _resolve(service, 3) == 3
    assert _resolve(service) == 5


def test_locked_policy_ignores_explicit_dispatch_override():
    service = _service(worker=5, policy="locked")

    assert _resolve(service, 3) == 5


def test_follow_main_policy_uses_conductor_then_global_preference():
    service = _service(main=1)
    assert _resolve(service) == 1

    service._conductor_llm_index = None
    with patch(
        "server.services.conductor_service._get_preferred_llm",
        return_value=7,
    ):
        assert _resolve(service) == 7


def test_omitted_configuration_does_not_reset_existing_default():
    service = _service(worker=5, policy="default")

    service.configure_models(llm_index=2)

    assert service.model_policy_snapshot() == {
        "llm_index": 2,
        "subagent_llm_index": 5,
        "subagent_model_policy": "default",
    }


def test_explicit_follow_main_clears_default_worker_model():
    service = _service(worker=5, policy="locked")

    service.configure_models(subagent_model_policy="follow_main")

    assert service.model_policy_snapshot()["subagent_llm_index"] is None
    assert _resolve(service) == 1


def test_follow_main_switch_pushes_explicit_engine_clear():
    """D5: the engine treats null as keep, so clearing the hub default must
    send the explicit clear flag or the stale worker model survives there."""
    service = _service(worker=5, policy="locked")

    service.configure_models(subagent_model_policy="follow_main")

    _, kwargs = service.client.push_models.call_args
    assert kwargs["clear_subagent_llm"] is True
    assert kwargs["subagent_llm_index"] is None


def test_worker_model_push_keeps_legacy_semantics_without_clear():
    service = _service(worker=5, policy="default")

    service.configure_models(llm_index=2)

    _, kwargs = service.client.push_models.call_args
    assert kwargs["clear_subagent_llm"] is False
    assert kwargs["subagent_llm_index"] == 5


def test_dispatch_entrypoint_applies_same_locked_policy(setup):
    engine, create = setup
    service = create()
    service.configure_models(subagent_llm_index=5, subagent_model_policy="locked")

    result = service.start_subagent("检查中文路径 D:\\项目\\资料 🚀", llm_index=3)

    # The locked policy wins over the explicit dispatch request, and the
    # resolved context is stamped onto the result for the UI.
    assert engine.posts[0]["llm_index"] == 5
    assert result["llm_index"] == 5
    assert result["model_policy"] == "locked"
    assert result["instruction"]


def test_dispatch_requests_a_cooperative_supervisor_yield_for_active_workflow(setup):
    engine, create = setup
    service = create()
    service.workflow_tracker.admit("request-1", boot_id="boot-a")

    result = service.start_subagent("inspect", request_id="request-1")

    # gahub_app owns the cooperative yield now; the hub only forwards the
    # request attribution so the engine can bind and auto-yield.
    assert result["request_id"] == "request-1"
    assert engine.posts[0]["request_id"] == "request-1"
    assert service.workflow_tracker.request_for_subagent("worker") == "request-1"


def test_resume_entrypoint_applies_same_locked_policy(setup):
    engine, create = setup
    service = create()
    service.configure_models(subagent_llm_index=5, subagent_model_policy="locked")

    result = service.input_subagent("worker-1", "retry", llm_index=3)

    assert engine.posts[0]["llm_index"] == 5
    assert result["llm_index"] == 5


def test_dispatch_result_uses_the_admitted_policy_snapshot(setup):
    engine, create = setup
    service = create()

    def mutate_policy_mid_dispatch():
        service.configure_models(
            subagent_llm_index=8,
            subagent_model_policy="locked",
        )

    engine.dispatch_hook = mutate_policy_mid_dispatch
    result = service.start_subagent("inspect", llm_index=3)

    # The result renders the policy resolved at prepare time, not whatever
    # the (mocked) engine call changed the configuration to mid-flight.
    assert result["llm_index"] == 3
    assert result["model_policy"] == "follow_main"
    assert service.model_policy_snapshot()["subagent_model_policy"] == "locked"


def test_default_and_locked_policies_require_a_worker_model():
    service = _service()

    for policy in ("default", "locked"):
        try:
            service.configure_models(subagent_model_policy=policy)
        except ValueError as exc:
            assert "subagent_llm_index is required" in str(exc)
        else:
            raise AssertionError(f"{policy} should require subagent_llm_index")


def test_conductor_readme_reserves_user_role_for_real_user_input():
    api_docs = READMES["api"]
    user_flow = READMES["usermsg"]
    completion_flow = READMES["subagent"]

    assert '"role": "conductor"' in api_docs
    assert "role=user" in api_docs
    assert "role=conductor" in user_flow
    assert "role=conductor" in completion_flow


# ===== no independent supervisor effort override =====

def test_model_policy_snapshot_has_no_effort_key():
    service = _service(worker=5, policy="default")

    assert service.configure_models(llm_index=2) == {
        "llm_index": 2,
        "subagent_llm_index": 5,
        "subagent_model_policy": "default",
    }


def test_configure_models_no_longer_accepts_effort_override():
    """The supervisor inherits the selected LLM entry's own mykey
    reasoning_effort; a separate Conductor override fails loudly."""
    service = _service(worker=5, policy="default")

    with pytest.raises(TypeError):
        service.configure_models(conductor_reasoning_effort="high")

    service.client.push_models.assert_not_called()


def test_cold_start_passes_only_the_model_index():
    service = _service(worker=5, policy="default")
    service._started = False
    service._relay_thread = None
    service._relay_stop = threading.Event()
    service._process_manager = Mock()
    service._lifecycle_cache = {}
    service.client.status.return_value = {"started": False}
    service.client.start.return_value = {"started": True}

    service.ensure_started()

    service.client.start.assert_called_once_with(llm_index=1)
