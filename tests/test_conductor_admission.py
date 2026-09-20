"""Request admission wiring tests for the Conductor service (command track).

Admission is no longer a synchronous notify(): ``add_chat_message`` persists
a chat command (minting/minting-through the request id), the engine POST
carries the operation id for idempotency, and the engine's echoed item is
mirrored into the hub log. These tests pin that wiring against the
in-memory engine transport.
"""
from __future__ import annotations

import pytest

from conductor_engine import Engine
from server.services.conductor_client import GahubProcessError
from server.services.conductor_service import ConductorService


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setenv("GAHUB_PATH_POLICY", "explicit_absolute")
    engine = Engine()
    services = []

    def create():
        service = ConductorService.for_tests(store_path=tmp_path / "state.sqlite3")
        service.client = engine
        service.pool.client = engine
        service._process_manager = None
        service._ensure_relay = lambda: None
        starts = []

        def ensure_started(**kwargs):
            starts.append(kwargs)
            engine.started = True
            return True

        service.ensure_started = ensure_started
        service.ensure_started_calls = starts
        services.append(service)
        return service

    yield engine, create
    for service in services:
        service.store.close()


def test_user_chat_message_is_admitted_with_a_request_id(setup):
    engine, create = setup
    service = create()

    item = service.add_chat_message("hello", role="user", operation_id="op-fixed")

    # The request id is minted hub-side and rides the whole pipeline.
    request_id = item["request_id"]
    assert request_id
    assert engine.posts[0]["request_id"] == request_id
    # P0 idempotency: the caller's operation id rides through admission
    # verbatim so a retried POST /chat replays instead of double-admitting.
    assert engine.posts[0]["operation_id"] == "op-fixed"
    # Cold start happens on the delivery path (the same one the command
    # loop's retry uses), never before the command is persisted.
    assert service.ensure_started_calls == [{}]
    assert service.store.command("op-fixed")["state"] == "succeeded"


def test_add_chat_message_mints_operation_id_when_absent(setup):
    engine, create = setup
    service = create()

    service.add_chat_message("hello", role="user")

    assert engine.posts[0]["operation_id"]  # fresh id per logical admission


def test_conductor_plan_and_report_do_not_recursively_admit_user_tasks(setup):
    engine, create = setup
    service = create()

    service.add_chat_message("算一下", role="conductor")
    plan_item = service.add_chat_message("派单中", role="conductor")
    report_item = service.add_chat_message("结果", role="conductor")

    # Conductor-authored chat never creates a user task: no request minted,
    # no engine wake, exactly one mirror entry per message.
    assert plan_item.get("request_id") is None
    assert report_item.get("request_id") is None
    assert all(post["role"] == "conductor" for post in engine.posts)
    assert service.ensure_started_calls == []


def test_user_followup_appends_to_an_open_workflow_without_forking_a_task(setup):
    """Conversation continuity: a user message naming the request id of an
    open workflow stays on that workflow — the engine wakes the supervisor
    under the same id, so the UI thread never forks. 2026-09 UI audit."""
    engine, create = setup
    service = create()
    service.workflow_tracker.admit("req-open", boot_id="boot-a")

    item = service.add_chat_message(
        "补充说明", role="user", request_id="req-open",
        operation_id="op-followup",
    )

    assert item["request_id"] == "req-open"
    assert engine.posts[0]["request_id"] == "req-open"


def test_user_followup_on_a_closed_workflow_reopens_it(setup):
    """W2.2 方案1（续作）：append to a finished workflow reuses its identity.
    The hub reopens the workflow (terminal state cleared, back to open) and
    tells the engine to re-arm the closed request budget via reopen=True, so
    the follow-up continues the same task instead of forking a new one."""
    engine, create = setup
    service = create()
    service.workflow_tracker.admit("req-dead")
    service.workflow_tracker.fail_supervisor(
        "req-dead", phase="finish", error="closed")

    item = service.add_chat_message("再来一次", role="user", request_id="req-dead")

    # The same request id is reused — no fork.
    assert item["request_id"] == "req-dead"
    # The workflow is reopened hub-side (open again, not terminal).
    assert service.workflow_tracker.is_open("req-dead")
    # The engine is told to re-arm the closed budget for this id.
    assert engine.posts[0]["request_id"] == "req-dead"
    assert engine.posts[0]["reopen"] is True


def test_reopened_workflow_completes_again_with_new_workers(setup):
    """Regression (W2.2 review): a reopened workflow must reach
    ``workflow_completed`` again once the follow-up round finishes.

    The prior round's workers belong to subagents that already exited, so
    ``reopen()`` must keep their terminal (accepted/rejected) state instead of
    reviving them to ``running``. Reviving them would leave dangling workers
    that never emit another event, which both trips
    ``_assert_ready_for_final`` (open workers) and blocks
    ``_complete_if_ready`` — the continued work could never complete.
    """
    engine, create = setup
    service = create()
    tracker = service.workflow_tracker

    # Round 1: a real worker runs and is accepted, then the round finalizes.
    tracker.admit("req-reopen")
    tracker.record_subagent_event("agent-old", "spawned", request_id="req-reopen")
    tracker.record_subagent_event("agent-old", "accepted", request_id="req-reopen")
    final1 = tracker.record_final("req-reopen", {"id": "item-1"})
    assert final1 is not None
    assert final1[0] == "conductor:workflow_completed"
    assert not tracker.is_open("req-reopen")

    # Follow-up: the closed workflow reopens under the same id.
    item = service.add_chat_message("再补一句", role="user", request_id="req-reopen")
    assert item["request_id"] == "req-reopen"
    assert engine.posts[0]["reopen"] is True
    assert tracker.is_open("req-reopen")

    # Round 2: the follow-up dispatches a brand-new worker (fresh agent id).
    # The stale prior-round worker stays closed and must not block completion.
    tracker.record_subagent_event("agent-new", "spawned", request_id="req-reopen")
    tracker.record_subagent_event("agent-new", "accepted", request_id="req-reopen")
    final2 = tracker.record_final("req-reopen", {"id": "item-2"})

    assert final2 is not None
    assert final2[0] == "conductor:workflow_completed"
    assert not tracker.is_open("req-reopen")


def test_user_followup_on_an_unknown_request_id_admits_a_new_task(setup):
    engine, create = setup
    service = create()

    item = service.add_chat_message("新任务", role="user", request_id="req-ghost")

    assert item["request_id"] != "req-ghost"
    assert service.workflow_tracker.has_request(item["request_id"])
    assert engine.posts[0]["request_id"] == item["request_id"]


def test_conductor_not_running_does_not_block_admission(setup):
    """Chat admission is the only cold-start entry: it starts the supervisor
    even when the engine is currently stopped."""
    engine, create = setup
    engine.started = False
    service = create()

    item = service.add_chat_message("hello", role="user", operation_id="op-cold")

    assert service.ensure_started_calls == [{}]
    assert service.store.command("op-cold")["state"] == "succeeded"
    assert item["request_id"]
