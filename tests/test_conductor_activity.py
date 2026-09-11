"""Durable 动态 projection: journal event → timeline row, and its store.

The page's 动态 tab is a durable read, so two properties matter more than any
individual mapping: a replayed journal record must fold to the *same* row (the
id is derived from epoch+seq, not from the bus's per-publish event id), and the
row the hub persists must be the row it ships live, or the page shows the same
event twice with two different wordings.
"""
from __future__ import annotations

import pytest

from server.services import conductor_activity as activity
from server.services.conductor_store import ConductorStore
from server.services.conductor_workflow import WorkflowTracker


def row(kind: str, event: dict, *, event_id: str = "journal-a:1", ts: float = 100.0):
    return activity.journal_activity(kind, event, event_id=event_id, ts=ts)


# ── worker lifecycle ────────────────────────────────────────────────────────

@pytest.mark.parametrize(("name", "expected_kind"), [
    ("spawned", "worker_spawned"),
    ("started", "worker_started"),
    ("reworked", "worker_reworked"),
    ("pending_review", "worker_pending_review"),
    ("accepted", "worker_accepted"),
    ("rejected", "worker_rejected"),
    ("timeout_total", "worker_timeout"),
    ("failed", "worker_failed"),
    ("cancelled", "worker_cancelled"),
    ("killed", "worker_killed"),
])
def test_worker_events_map_to_a_row(name, expected_kind):
    result = row(f"subagent_{name}", {"request_id": "r1", "id": "w1"})
    assert result is not None
    assert result["kind"] == expected_kind
    assert result["worker_id"] == "w1"
    assert result["id"] == "journal-a:1"


def test_completed_and_running_earn_no_row():
    # `completed` always arrives beside `pending_review`, and the journal emits
    # `started` for the same transition `running` describes: a row for either
    # would double every delivery / every start.
    assert row("subagent_completed", {"request_id": "r1", "id": "w1"}) is None
    assert row("subagent_running", {"request_id": "r1", "id": "w1"}) is None


def test_killed_carries_the_reap_reason_but_not_an_unknown_one():
    killed = row("subagent_killed", {"request_id": "r1", "id": "w1", "reason": "idle_timeout"})
    assert killed is not None
    assert "空闲超时回收" in killed["text"]
    plain = row("subagent_killed", {"request_id": "r1", "id": "w1", "reason": "operator"})
    assert plain is not None
    assert plain["text"] == "子代理已终止"


def test_milestone_needs_a_description_and_marks_unreached_ones():
    reached = row("subagent_milestone",
                  {"request_id": "r1", "id": "w1", "desc": "扫描目录", "status": "reached"})
    assert reached is not None
    assert reached["kind"] == "worker_milestone"
    assert reached["text"] == "里程碑 · 扫描目录"
    missed = row("subagent_milestone",
                 {"request_id": "r1", "id": "w1", "desc": "扫描目录", "status": "unreached"})
    assert missed is not None
    assert missed["text"] == "里程碑未达成 · 扫描目录"
    # A milestone without copy would render as an empty bullet.
    assert row("subagent_milestone", {"request_id": "r1", "id": "w1", "desc": "  "}) is None


def test_force_accept_is_recorded_as_an_override():
    result = row("subagent_force_accept", {"request_id": "r1", "id": "w1"})
    assert result is not None
    assert result["kind"] == "worker_force_accepted"
    assert result["text"] == "强制验收通过"


def test_an_event_without_a_request_id_cannot_be_placed_in_the_timeline():
    assert row("subagent_spawned", {"id": "w1"}) is None
    assert row("subagent_spawned", {"request_id": "", "id": "w1"}) is None


def test_unrelated_journal_events_are_ignored():
    assert row("subagent_unknown_future_event", {"request_id": "r1"}) is None
    assert row("chat", {"request_id": "r1"}) is None


# ── supervisor turn outcomes ───────────────────────────────────────────────

def test_turn_outcomes_record_clean_turns_and_fail_everything_else():
    assert row("request_outcome", {"request_id": "r1", "status": "ok"})["kind"] == "turn_completed"
    for status in ("failed", "error", "timeout", "cancelled", "", "something_new"):
        # An unrecognised status is an anomaly: passing it silently would make a
        # dead turn read like a clean finish.
        assert row("request_outcome", {"request_id": "r1", "status": status})["kind"] == "turn_failed"


def test_yielded_outcomes_are_not_rows():
    # It fires once per supervisor turn and only means "waiting for workers".
    assert row("request_outcome", {"request_id": "r1", "status": "yielded"}) is None


# ── workflow terminal transitions ──────────────────────────────────────────

@pytest.mark.parametrize("kind", [
    "workflow_completed", "workflow_failed", "workflow_cancelled", "workflow_killed",
])
def test_terminal_workflow_transitions_are_rows(kind):
    result = activity.workflow_activity(kind, "r1", event_id=f"wf:r1:{kind}", ts=5.0)
    assert result is not None
    assert result["kind"] == kind
    assert result["request_id"] == "r1"
    assert result["id"] == f"wf:r1:{kind}"


def test_unknown_terminal_transition_and_missing_request_are_dropped():
    assert activity.workflow_activity("workflow_something", "r1", event_id="x", ts=1.0) is None
    assert activity.workflow_activity("workflow_completed", "", event_id="x", ts=1.0) is None


def test_a_zero_timestamp_is_kept_as_zero_rather_than_dropped():
    result = row("subagent_spawned", {"request_id": "r1", "id": "w1"}, ts=0)
    assert result["at"] == 0.0
    assert result["atMs"] == 0


# ── store ──────────────────────────────────────────────────────────────────

@pytest.fixture
def store(tmp_path):
    tracker = WorkflowTracker(clock=lambda: 10.0)
    created = ConductorStore(tmp_path / "state.sqlite3", "engine-a", tracker)
    yield created
    created.close()


def sample(index: int, request_id: str = "r1") -> dict:
    return {
        "id": f"journal-a:{index}", "request_id": request_id, "kind": "worker_spawned",
        "at": float(index), "atMs": index * 1000, "text": f"row {index}", "worker_id": "w1",
    }


def test_saving_the_same_row_twice_upserts_instead_of_duplicating(store):
    store.save_activity([sample(1)])
    store.save_activity([sample(1)])
    assert [item["id"] for item in store.activity_for_request("r1", 10)] == ["journal-a:1"]


def test_rows_come_back_oldest_first_and_are_scoped_to_their_request(store):
    store.save_activity([sample(3), sample(1), sample(2, "other")])
    assert [item["id"] for item in store.activity_for_request("r1", 10)] == [
        "journal-a:1", "journal-a:3",
    ]


def test_before_ms_walks_backwards_through_the_timeline(store):
    store.save_activity([sample(index) for index in range(1, 6)])
    newest_two = store.activity_for_request("r1", 2)
    assert [item["id"] for item in newest_two] == ["journal-a:4", "journal-a:5"]
    # Callers pass the oldest row's atMs + 1 so a boundary millisecond shared by
    # two rows is re-read rather than skipped; the boundary row comes back and
    # the client dedupes it by id. Re-reading is free, losing a row is not.
    older = store.activity_for_request("r1", 2, before_ms=newest_two[0]["atMs"] + 1)
    assert [item["id"] for item in older] == ["journal-a:3", "journal-a:4"]


def test_an_empty_store_returns_no_rows(store):
    assert store.activity_for_request("r1", 10) == []


def test_forgetting_a_workflow_forgets_its_timeline(store):
    tracker = store.tracker
    tracker.admit("r1")
    tracker.record_final("r1", {"id": "final"})
    store.save_activity([sample(1)])
    with store.transaction():
        tracker.forget_workflow("r1")
    assert store.activity_for_request("r1", 10) == []


def test_rows_without_an_id_or_request_are_dropped_rather_than_stored_blank(store):
    store.save_activity([{"id": "", "request_id": "r1"}, {"id": "journal-a:1", "request_id": ""}])
    assert store.activity_for_request("r1", 10) == []
    assert store.activity_for_request("", 10) == []
