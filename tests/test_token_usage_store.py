"""Storage ownership tests for token usage sidecars."""
from __future__ import annotations

import json
from multiprocessing import get_context
from pathlib import Path

from server.services.token_usage_store import TokenUsageStore


def _increment_usage(usage_path: str, history_path: str, start, count: int) -> None:
    store = TokenUsageStore(
        usage_path=Path(usage_path),
        history_path=Path(history_path),
    )
    start.wait(timeout=5)
    for _ in range(count):
        with store.transaction():
            data = store.read_usage() or {"count": 0}
            data["count"] = int(data.get("count") or 0) + 1
            store.write_usage(data)


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


def test_transaction_serializes_updates_from_two_processes(tmp_path) -> None:
    usage_path = tmp_path / "token_usage.json"
    history_path = tmp_path / "token_history.json"
    context = get_context("spawn")
    start = context.Event()
    processes = [
        context.Process(
            target=_increment_usage,
            args=(str(usage_path), str(history_path), start, 20),
        )
        for _ in range(2)
    ]
    for process in processes:
        process.start()
    start.set()
    for process in processes:
        process.join(timeout=10)
        if process.is_alive():
            process.terminate()
            process.join(timeout=2)
        assert process.exitcode == 0

    assert TokenUsageStore(
        usage_path=usage_path,
        history_path=history_path,
    ).read_usage() == {"count": 40}
