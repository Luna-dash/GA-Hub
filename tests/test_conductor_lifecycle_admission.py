"""Lifecycle admission + stranded-workflow abandonment (2026-09 audit P1).

- Subagent operations require a live supervisor: they refuse loudly
  (``ConductorNotRunning`` → HTTP 409) instead of cold-starting the
  supervisor or orphaning workers under a dead one.
- A manual stop abandons stranded ``admitted`` workflows so the next cold
  start does not resurrect work the user gave up on (user-confirmed policy:
  manual stop = abandon).
"""
from __future__ import annotations

import asyncio
import threading
from unittest.mock import Mock

import pytest
from fastapi import HTTPException

from server.services.conductor_service import (
    ConductorNotRunning,
    ConductorService,
)
from server.services.conductor_workflow import WorkflowTracker


def _live_relay(service: ConductorService) -> None:
    """A relay thread that blocks forever satisfies ``_ensure_relay``."""
    stop = threading.Event()
    service._relay_stop = stop
    relay = threading.Thread(target=stop.wait, daemon=True)
    relay.start()
    service._relay_thread = relay


def _ready_service(started: bool) -> ConductorService:
    service = object.__new__(ConductorService)
    service._process_manager = Mock()
    service.client = Mock()
    service.client.status.return_value = {"started": started}
    _live_relay(service)
    return service


def test_subagent_ops_refuse_when_engine_not_started():
    """start/input/accept/rework never cold-start the supervisor."""
    service = _ready_service(started=False)
    with pytest.raises(ConductorNotRunning):
        service.start_subagent("do work")
    with pytest.raises(ConductorNotRunning):
        service.input_subagent("worker-1", "hello")
    with pytest.raises(ConductorNotRunning):
        service.accept_subagent("worker-1")
    with pytest.raises(ConductorNotRunning):
        service.rework_subagent("worker-1", "again")
    # Every op checked engine-process liveness first, but the refusal comes
    # from the supervisor started-flag: a stopped conductor (engine process
    # still alive) must not gain workers it cannot wake.
    assert service._process_manager.ensure_running.call_count == 4


def test_assert_engine_ready_passes_when_started():
    service = _ready_service(started=True)
    service._assert_engine_ready()  # must not raise


def test_route_maps_conductor_not_running_to_409():
    from server.routes.conductor import _dispatch_through_engine

    def boom():
        raise ConductorNotRunning("conductor is not running")

    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(_dispatch_through_engine(boom))
    assert excinfo.value.status_code == 409
    assert "conductor is not running" in excinfo.value.detail


# ── manual stop = abandon stranded workflows ─────────────────────────────────

def _stoppable_service(tracker: WorkflowTracker) -> ConductorService:
    service = object.__new__(ConductorService)
    service.workflow_tracker = tracker
    service.chat_messages = []
    service.client = Mock()
    service.client.stop.return_value = {"stopped": True}
    service._publish_workflow_transition = Mock()
    service.lifecycle_status = Mock(return_value={})
    return service


def test_stop_abandons_stranded_workflows():
    tracker = WorkflowTracker(clock=lambda: 10.0)
    tracker.admit("rid-stranded")
    service = _stoppable_service(tracker)

    assert service.stop() is True

    published = service._publish_workflow_transition.call_args_list
    assert len(published) == 1
    topic, payload = published[0].args[0]
    assert topic == "conductor:workflow_failed"
    assert payload["request_id"] == "rid-stranded"
    assert payload["phase"] == "stopped_by_user"
    assert payload["terminal_event"] == "workflow_failed"
    # Terminal workflows are invisible to the cold-start redispatch sweep.
    assert tracker.stranded_admitted() == []
    assert tracker.snapshot("rid-stranded")["status"] == "failed"


def test_stop_leaves_supervising_workflows_alone():
    """Workflows with workers keep their own terminal path (worker
    CANCELLED events); the stop sweep only takes workerless ``admitted``."""
    tracker = WorkflowTracker(clock=lambda: 10.0)
    tracker.admit("rid-live")
    tracker.bind_subagent("rid-live", "worker-1", 1)
    service = _stoppable_service(tracker)

    assert service.stop() is True

    service._publish_workflow_transition.assert_not_called()
    assert tracker.snapshot("rid-live")["status"] == "supervising"


def test_stop_failure_does_not_abandon_anything():
    tracker = WorkflowTracker(clock=lambda: 10.0)
    tracker.admit("rid-stranded")
    service = _stoppable_service(tracker)
    service.client.stop.return_value = {"stopped": False}

    assert service.stop() is False

    service._publish_workflow_transition.assert_not_called()
    assert len(tracker.stranded_admitted()) == 1
