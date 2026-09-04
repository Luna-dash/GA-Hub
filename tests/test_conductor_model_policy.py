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


def test_dispatch_entrypoint_applies_same_locked_policy():
    service = _service(worker=5, policy="locked")
    prompt = "检查中文路径 D:\\项目\\资料 🚀"

    result = service.start_subagent(prompt, llm_index=3)

    service.client.start_subagent.assert_called_once()
    args, kwargs = service.client.start_subagent.call_args
    assert args == (prompt, None, 5)
    assert kwargs["goal"] is None and kwargs["boundaries"] is None
    assert kwargs["deliverables"] is None and kwargs["done_when"] is None
    assert kwargs["checks"] is None
    assert kwargs["operation_id"]            # P0: hub mints the idempotency key
    assert result["llm_index"] == 5
    assert result["model_policy"] == "locked"


def test_dispatch_requests_a_cooperative_supervisor_yield_for_active_workflow():
    service = _service(worker=5, policy="locked")
    service.workflow_tracker = WorkflowTracker(clock=lambda: 10.0)
    service.workflow_tracker.admit("request-1")

    result = service.start_subagent(
        "inspect",
        request_id="request-1",
    )

    # gahub_app owns the cooperative yield now; the hub only forwards the
    # request attribution so the engine can bind and auto-yield.
    assert result["request_id"] == "request-1"
    service.client.start_subagent.assert_called_once()
    args, kwargs = service.client.start_subagent.call_args
    assert args == ("inspect", "request-1", 5)
    assert kwargs["operation_id"]
    assert service.workflow_tracker.request_for_subagent("worker-1") == "request-1"


def test_resume_entrypoint_applies_same_locked_policy():
    service = _service(worker=5, policy="locked")

    result = service.input_subagent("worker-1", "retry", llm_index=3)

    service.client.subagent_action.assert_called_once_with(
        "worker-1", "input", "retry", request_id=None, llm_index=5
    )
    assert result["llm_index"] == 5


def test_dispatch_result_uses_the_admitted_policy_snapshot():
    service = _service(worker=5, policy="default")

    def update_policy_after_admission(*_args, **_kwargs):
        service.configure_models(
            subagent_llm_index=8,
            subagent_model_policy="locked",
        )
        return {"id": "worker-1"}

    service.client.start_subagent.side_effect = update_policy_after_admission

    result = service.start_subagent("inspect", llm_index=3)

    service.client.start_subagent.assert_called_once()
    args, kwargs = service.client.start_subagent.call_args
    assert args == ("inspect", None, 3)
    assert kwargs["goal"] is None and kwargs["boundaries"] is None
    assert kwargs["deliverables"] is None and kwargs["done_when"] is None
    assert kwargs["checks"] is None
    assert kwargs["operation_id"]
    assert result["llm_index"] == 3
    assert result["model_policy"] == "default"
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


def test_pool_mirror_abort_stamps_hub_origin():
    """User/UI aborts must be marked hub-origin so the engine records a
    terminal user cancel; supervisor self-API aborts stay recoverable.
    request_id rides along (None when the caller has no tracker context)."""
    from server.services.conductor_service import PoolMirror
    client = Mock()
    mirror = PoolMirror(client)
    mirror.abort_subagent("worker-1")
    client.subagent_action.assert_called_once_with(
        "worker-1", "abort", origin="hub", request_id=None)
