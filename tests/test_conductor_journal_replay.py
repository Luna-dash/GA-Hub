"""P0/P2-A hub-side regression: operation idempotency + journal replay.

Covers the hub half of the reconciliation loop: the hub mints/forwards
``operation_id`` on chat and dispatch (the engine replays the first terminal
answer for a retried id), and the SSE relay replays missed journal events
after every reconnect from an exact cursor.
"""
from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from server.services import conductor_client as ccm
from server.services import conductor_service as cs
from server.services.conductor_client import GaConductorClient
from server.services.conductor_service import ConductorService


def _bare_service() -> ConductorService:
    return object.__new__(ConductorService)


# ===== client: operation_id rides in the request body =====

def _capture_client(monkeypatch) -> list:
    calls: list = []

    def fake_request(self, method, path, *, json_body=None, params=None,
                     timeout=None):
        calls.append((method, path, json_body, params))
        return {}

    monkeypatch.setattr(GaConductorClient, "_request", fake_request)
    return calls


def test_post_chat_body_carries_operation_id(monkeypatch):
    calls = _capture_client(monkeypatch)
    client = GaConductorClient(None)
    client.post_chat("hi", "user", "rid-1", operation_id="op-abc")
    method, path, body, _params = calls[0]
    assert (method, path) == ("POST", "/chat")
    assert body["operation_id"] == "op-abc"


def test_post_chat_omits_operation_id_when_absent(monkeypatch):
    calls = _capture_client(monkeypatch)
    client = GaConductorClient(None)
    client.post_chat("hi", "user", "rid-1")
    _method, _path, body, _params = calls[0]
    assert "operation_id" not in body


def test_start_subagent_body_carries_operation_id(monkeypatch):
    calls = _capture_client(monkeypatch)
    client = GaConductorClient(None)
    client.start_subagent("do work", "rid-1", 2, goal="g",
                          deliverables=[{"path": "D:\\x.md"}],
                          operation_id="op-xyz")
    method, path, body, _params = calls[0]
    assert (method, path) == ("POST", "/subagent")
    assert body["operation_id"] == "op-xyz"


# ===== client: on_reconnect fires after connect, before live frames =====

class _FakeSseResponse:
    status_code = 200

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def iter_lines(self, decode_unicode=True):
        yield 'data: {"event": "chat_read"}'


def test_stream_events_replays_journal_before_live_frames(monkeypatch):
    order: list = []
    cycles = {"n": 0}

    def fake_get(*args, **kwargs):
        return _FakeSseResponse()

    monkeypatch.setattr(ccm.requests, "get", fake_get)
    client = GaConductorClient(None)
    client.pm = SimpleNamespace(
        ensure_running=lambda: None,
        _headers=lambda: {},
        base_url=lambda: "http://127.0.0.1:1",
    )

    def on_event(event):
        order.append(("live", event))
        cycles["n"] += 1

    def should_stop():
        return cycles["n"] > 0

    def on_reconnect():
        order.append(("replay", {"event": "request_started", "jseq": 4}))

    client.stream_events(on_event, should_stop, on_reconnect=on_reconnect)

    assert [kind for kind, _ in order] == ["replay", "live"]
    # The replayed event flows through the same on_event handler as a live one.
    assert order[1] == ("live", {"event": "chat_read"})


def test_stream_events_survives_a_failing_reconnect_hook(monkeypatch):
    cycles = {"n": 0}

    def fake_get(*args, **kwargs):
        return _FakeSseResponse()

    monkeypatch.setattr(ccm.requests, "get", fake_get)
    client = GaConductorClient(None)
    client.pm = SimpleNamespace(
        ensure_running=lambda: None,
        _headers=lambda: {},
        base_url=lambda: "http://127.0.0.1:1",
    )

    def on_event(event):
        cycles["n"] += 1

    def should_stop():
        return cycles["n"] > 0

    def on_reconnect():
        raise RuntimeError("replay exploded")

    client.stream_events(on_event, should_stop, on_reconnect=on_reconnect)
    assert cycles["n"] == 1     # live frames still processed


# ===== service: cursor advance + jseq stripping =====

def test_on_sse_event_advances_cursor_and_strips_jseq():
    service = _bare_service()
    service._journal_cursor = {"seq": None, "epoch": None}
    seen: list = []
    service.callbacks = SimpleNamespace(
        on_conductor_event=lambda kind, payload: seen.append((kind, payload)),
    )

    service._on_sse_event({"event": "error", "detail": "x", "jseq": 7})

    assert service._journal_cursor["seq"] == 7
    # The internal cursor field never reaches downstream handlers.
    assert seen == [("error", {"detail": "x"})]


def test_on_sse_event_keeps_max_seq_on_out_of_order_delivery():
    service = _bare_service()
    service._journal_cursor = {"seq": 9, "epoch": None}
    service.callbacks = SimpleNamespace(on_conductor_event=lambda *a: None)

    service._on_sse_event({"event": "error", "jseq": 4})

    assert service._journal_cursor["seq"] == 9


# ===== service: journal replay after reconnect =====

class _FakeJournalClient:
    """Scripted /journal answers; records the after_seq of every read."""

    def __init__(self, responses: list[dict]):
        self.responses = list(responses)
        self.reads: list[tuple[int, int]] = []

    def journal(self, after_seq: int = 0, limit: int = 500) -> dict:
        self.reads.append((after_seq, limit))
        return self.responses.pop(0) if self.responses else {
            "journal": {"last_seq": after_seq}, "events": []}


def test_replay_journal_baselines_first_connect_without_feeding_history():
    service = _bare_service()
    service._journal_cursor = {"seq": None, "epoch": None}
    service.client = _FakeJournalClient([
        {"journal": {"last_seq": 41, "epoch": "e1"}, "events": []},
    ])
    fed: list = []
    service._on_sse_event = fed.append

    service._replay_journal()

    assert service.client.reads == [(0, 1)]
    assert service._journal_cursor == {"seq": 41, "epoch": "e1"}
    assert fed == []            # hello snapshot re-syncs state, no replay


def test_replay_journal_feeds_missed_events_and_advances_cursor():
    service = _bare_service()
    service._journal_cursor = {"seq": 3, "epoch": "e1"}
    service.client = _FakeJournalClient([
        {"journal": {"last_seq": 6, "epoch": "e1"},
         "events": [
             {"seq": 4, "type": "request_started",
              "payload": {"event": "request_started", "request_id": "r1"}},
             {"seq": 5, "type": "worker_dispatched",
              "payload": {"event": "subagent_started", "id": "w1"}},
             {"seq": 6, "type": "request_outcome",
              "payload": {"event": "request_outcome", "request_id": "r1"}},
         ]},
    ])
    fed: list = []
    service._on_sse_event = fed.append

    service._replay_journal()

    assert [e["request_id"] if "request_id" in e else e["id"] for e in fed] == \
        ["r1", "w1", "r1"]
    assert service._journal_cursor["seq"] == 6
    # The catch-up read used the cursor and the max page.
    assert service.client.reads == [(3, 5000)]


def test_replay_journal_skips_disabled_journal():
    service = _bare_service()
    service._journal_cursor = {"seq": None, "epoch": None}
    service.client = _FakeJournalClient([
        {"journal": {"disabled": True}, "events": []},
    ])
    fed: list = []
    service._on_sse_event = fed.append

    service._replay_journal()

    assert service._journal_cursor == {"seq": None, "epoch": None}
    assert fed == []


def test_replay_journal_never_raises(monkeypatch):
    service = _bare_service()
    service._journal_cursor = {"seq": 3, "epoch": "e1"}

    class ExplodingClient:
        def journal(self, after_seq=0, limit=500):
            raise RuntimeError("engine gone mid-replay")

    service.client = ExplodingClient()
    service._on_sse_event = Mock()

    service._replay_journal()   # must not raise

    service._on_sse_event.assert_not_called()
    assert service._journal_cursor["seq"] == 3


def test_replay_journal_handles_engine_restart_with_fresh_epoch():
    """An epoch change means the engine rebuilt its journal file, so seq
    restarts at 1 (conductor_journal.py only mints a new epoch with a new
    file).  The old high-water cursor would filter every event of the new
    journal, so the replay must reset it and start over."""
    service = _bare_service()
    service._journal_cursor = {"seq": 3, "epoch": "old-epoch"}
    service.client = _FakeJournalClient([
        # First read still uses the stale floor; the fresh journal has
        # nothing above seq 3, but its metadata reveals the epoch change.
        {"journal": {"last_seq": 2, "epoch": "new-epoch"}, "events": []},
        # After the reset the replay starts from the new journal's beginning.
        {"journal": {"last_seq": 2, "epoch": "new-epoch"},
         "events": [
             {"seq": 1, "type": "engine_started",
              "payload": {"event": "engine_started"}},
             {"seq": 2, "type": "subagent_started",
              "payload": {"event": "subagent_started"}},
         ]},
    ])
    fed: list = []
    service._on_sse_event = fed.append

    service._replay_journal()

    assert fed == [{"event": "engine_started"}, {"event": "subagent_started"}]
    assert service._journal_cursor == {"seq": 2, "epoch": "new-epoch"}
    assert service.client.reads == [(3, 5000), (0, 5000)]


# ===== schemas: operation_id accepted and bounded =====

def test_conductor_chat_schema_accepts_operation_id():
    from server.schemas import ConductorChatIn
    body = ConductorChatIn(msg="hi", operation_id="op-1")
    assert body.operation_id == "op-1"
    with pytest.raises(Exception):
        ConductorChatIn(msg="hi", operation_id="x" * 129)


def test_conductor_start_subagent_schema_accepts_operation_id():
    from server.schemas import ConductorStartSubagent
    body = ConductorStartSubagent(prompt="p", operation_id="op-2")
    assert body.operation_id == "op-2"


def test_replay_journal_paginates_when_backlog_exceeds_one_page():
    """A long disconnect can outgrow one catch-up page: the replay loops
    until a short page instead of stalling the remainder until some future
    reconnect (2026-09 audit P2)."""
    service = _bare_service()
    service._journal_cursor = {"seq": 0, "epoch": "e1"}
    service.client = _FakeJournalClient([
        {"journal": {"epoch": "e1"},
         "events": [{"seq": 1, "payload": {"event": "a"}},
                    {"seq": 2, "payload": {"event": "b"}}]},
        {"journal": {"epoch": "e1"},
         "events": [{"seq": 3, "payload": {"event": "c"}},
                    {"seq": 4, "payload": {"event": "d"}}]},
        {"journal": {"epoch": "e1"},
         "events": [{"seq": 5, "payload": {"event": "e"}}]},
    ])
    fed: list = []
    service._on_sse_event = fed.append
    service._JOURNAL_REPLAY_BATCH = 2  # instance cap shadows the class default

    service._replay_journal()

    assert fed == [{"event": "a"}, {"event": "b"}, {"event": "c"},
                   {"event": "d"}, {"event": "e"}]
    assert service.client.reads == [(0, 2), (2, 2), (4, 2)]
    assert service._journal_cursor["seq"] == 5


def test_replay_journal_pagination_breaks_on_a_page_without_progress():
    """Defensive: a full page of stale records must not spin the loop."""
    service = _bare_service()
    service._journal_cursor = {"seq": 3, "epoch": "e1"}
    service.client = _FakeJournalClient([
        {"journal": {"epoch": "e1"},
         "events": [{"seq": 1, "payload": {"event": "stale"}},
                    {"seq": 2, "payload": {"event": "stale"}}]},
    ])
    fed: list = []
    service._on_sse_event = fed.append
    service._JOURNAL_REPLAY_BATCH = 2

    service._replay_journal()

    assert fed == []
    assert service._journal_cursor["seq"] == 3
