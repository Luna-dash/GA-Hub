"""Response-contract tests for the Conductor boundary (compat defaults).

The response models deliberately backfill missing engine fields with
compatibility defaults (extra=allow + defaults) so one drifted snapshot
cannot 500 the page.  The flip side — silent protocol drift — is covered by
the PoolMirror structured warning asserted here, per the 2026-09 review's
"compat without blindness" requirement.
"""
from __future__ import annotations

import logging

from server.schemas import ConductorSubagent
from server.services.conductor_client import GaConductorClient
from server.services.conductor_service import ConductorService, PoolMirror
from server.services.conductor_workflow import WorkflowTracker


def test_minimal_engine_snapshot_backfills_compat_defaults():
    sub = ConductorSubagent(id="w1", reply="", status="running")
    assert sub.prompt == ""
    assert sub.created_at == 0
    assert sub.updated_at == 0
    assert sub.review_status == "none"
    assert sub.attempt == 1
    assert sub.stage is None


def test_full_engine_snapshot_is_not_overridden():
    sub = ConductorSubagent(
        id="w2", prompt="real prompt", reply="done", status="stopped",
        created_at=111, updated_at=222, review_status="accepted",
        attempt=2, generation=3, stage="accepted",
    )
    assert sub.prompt == "real prompt"
    assert sub.created_at == 111 and sub.updated_at == 222
    assert sub.attempt == 2 and sub.generation == 3


def test_engine_only_extra_fields_pass_through():
    sub = ConductorSubagent(
        id="w3", reply="", status="stopped",
        manifest={"goal": "g"}, quality_checks={"checks": []},
        done_marker=True,
    )
    assert sub.model_extra["manifest"] == {"goal": "g"}
    assert sub.model_extra["done_marker"] is True


def _mirror_with(item: dict) -> PoolMirror:
    mirror = PoolMirror(GaConductorClient.__new__(GaConductorClient))
    mirror.update([item])
    return mirror


def test_pool_mirror_flags_missing_core_fields(caplog):
    mirror = _mirror_with({"id": "w-drift", "reply": "", "status": "running"})
    with caplog.at_level(logging.WARNING, logger="server.services.conductor_service"):
        items = mirror.snapshot()
    assert items[0]["stage"] == "running"
    drift = [r for r in caplog.records if "protocol drift" in r.getMessage()]
    assert drift, "missing prompt/created_at/updated_at must be logged"
    assert "w-drift" in drift[0].getMessage()


def test_pool_mirror_stays_silent_on_complete_snapshots(caplog):
    mirror = _mirror_with({
        "id": "w-full", "prompt": "p", "reply": "r", "status": "stopped",
        "created_at": 1, "updated_at": 2, "attempt": 1,
        "review_status": "pending",
    })
    with caplog.at_level(logging.WARNING, logger="server.services.conductor_service"):
        items = mirror.snapshot()
    assert items[0]["stage"] == "reviewing"
    assert not [r for r in caplog.records if "protocol drift" in r.getMessage()]


def test_workflow_payload_carries_the_hub_decided_stage():
    tracker = WorkflowTracker()
    tracker.admit("req-1")
    tracker.bind_subagent("req-1", "w1", generation=1)
    snapshot = tracker.snapshot("req-1")
    assert snapshot is not None
    assert snapshot["stage"] == "supervising"


def test_fill_dispatch_defaults_fills_only_missing_fields():
    """All four dispatch verbs route through _fill_dispatch_defaults; the
    helper must fill hub-resolved context without clobbering engine values,
    and must not invent a request_id when no owner was bound."""
    fill = ConductorService._fill_dispatch_defaults

    # Everything missing -> the resolved trio lands.
    result: dict = {}
    fill(result, llm_index=3, model_policy="locked", request_id="req-1")
    assert result == {"request_id": "req-1", "llm_index": 3,
                      "model_policy": "locked"}

    # Engine-provided values are never overridden.
    result = {"request_id": "engine-req", "llm_index": 7,
              "model_policy": "follow_main"}
    fill(result, llm_index=3, model_policy="locked", request_id="req-1")
    assert result == {"request_id": "engine-req", "llm_index": 7,
                      "model_policy": "follow_main"}

    # No owner bound (workerless/admission race) -> no request_id invented.
    result = {"llm_index": 1}
    fill(result, llm_index=1, model_policy="default", request_id=None)
    assert result == {"llm_index": 1, "model_policy": "default"}
