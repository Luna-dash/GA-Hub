"""Storage ownership tests for token usage sidecars."""
from __future__ import annotations

import json

from server.services.token_usage_store import TokenUsageStore


def test_store_owns_atomic_usage_and_history_round_trip(tmp_path) -> None:
    usage_path = tmp_path / "token_usage.json"
    history_path = tmp_path / "token_history.json"
    store = TokenUsageStore(usage_path=usage_path, history_path=history_path)

    assert store.read_usage() is None
    assert store.read_history() == []

    store.write_usage({"version": 4, "days": {}})
    store.write_history([{"timestamp": 1, "total": 2}])

    assert json.loads(usage_path.read_text("utf-8")) == {"version": 4, "days": {}}
    assert store.read_usage() == {"version": 4, "days": {}}
    assert store.read_history() == [{"timestamp": 1, "total": 2}]


def test_store_rejects_invalid_shapes_and_cleans_temporary_files(tmp_path) -> None:
    usage_path = tmp_path / "token_usage.json"
    history_path = tmp_path / "token_history.json"
    store = TokenUsageStore(usage_path=usage_path, history_path=history_path)
    usage_path.write_text("[]", encoding="utf-8")
    history_path.write_text("{}", encoding="utf-8")

    assert store.read_usage() is None
    assert store.read_history() == []

    store.write_usage({})
    store.write_history([])
    assert list(tmp_path.glob("*.tmp")) == []
