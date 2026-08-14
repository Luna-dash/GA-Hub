"""Tests for the GA-side legacy chat history adapter."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from server.services.legacy_chat_history_store import (
    LegacyChatHistoryFormatError,
    LegacyChatHistoryStore,
)


def test_read_missing_file_returns_empty_list(tmp_path: Path) -> None:
    store = LegacyChatHistoryStore(tmp_path / "chat_history.json")

    assert store.read() == []


def test_valid_document_round_trips(tmp_path: Path) -> None:
    path = tmp_path / "chat_history.json"
    entries = [{"id": "one"}, {"id": "two"}]
    path.write_text(json.dumps(entries), encoding="utf-8")

    assert LegacyChatHistoryStore(path).read() == entries


@pytest.mark.parametrize("payload", ["{", "{}"])
def test_invalid_document_raises_format_error(tmp_path: Path, payload: str) -> None:
    path = tmp_path / "chat_history.json"
    path.write_text(payload, encoding="utf-8")

    with pytest.raises(LegacyChatHistoryFormatError):
        LegacyChatHistoryStore(path).read()


def test_append_appends_atomically_and_removes_temp_file(tmp_path: Path) -> None:
    path = tmp_path / "nested" / "chat_history.json"
    store = LegacyChatHistoryStore(path)

    store.append({"id": "one"})
    store.append({"id": "two"})

    assert store.read() == [{"id": "one"}, {"id": "two"}]
    assert not list(path.parent.glob("*.tmp"))


def test_missing_ga_root_is_read_empty_and_write_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(LegacyChatHistoryStore, "_default_path", staticmethod(lambda: None))
    store = LegacyChatHistoryStore(path=None)

    assert store.path is None
    assert store.read() == []
    with pytest.raises(RuntimeError, match="GA_ROOT is not configured"):
        store.append({"id": "one"})
