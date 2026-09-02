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
    service = _bare_service()
    service._journal_cursor = {"seq": 3, "epoch": "old-epoch"}
    service.client = _FakeJournalClient([
        {"journal": {"last_seq": 4, "epoch": "new-epoch"},
         "events": [
             {"seq": 4, "type": "engine_started",
              "payload": {"event": "engine_started"}},
         ]},
    ])
    fed: list = []
    service._on_sse_event = fed.append

    service._replay_journal()

    assert fed == [{"event": "engine_started"}]
    assert service._journal_cursor == {"seq": 4, "epoch": "new-epoch"}


# NOTE: operation_id propagation (client body) and schema-bound tests belong
# to the P0 idempotency commit, not this journal-replay change.
