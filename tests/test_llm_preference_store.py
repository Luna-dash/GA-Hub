"""Unit tests for cached preferred-LLM persistence."""
from __future__ import annotations

from server.services.llm_preference_store import LlmPreferenceStore


def test_get_caches_preferred_value() -> None:
    calls = []

    def load_config():
        calls.append("load")
        return {"other": "preserved", "preferred_llm_no": 2}

    store = LlmPreferenceStore(load_config=load_config)

    assert store.get() == 2
    assert store.get() == 2
    assert calls == ["load"]


def test_get_caches_missing_preference() -> None:
    calls = []
    store = LlmPreferenceStore(load_config=lambda: calls.append("load") or {})

    assert store.get() is None
    assert store.get() is None
    assert calls == ["load"]


def test_set_preserves_other_config_and_updates_cache() -> None:
    saved = []
    store = LlmPreferenceStore(
        load_config=lambda: {"other": "preserved", "preferred_llm_no": 1},
        save_config=saved.append,
    )

    store.set(3)
    store.set(3)

    assert saved == [{"other": "preserved", "preferred_llm_no": 3}]
    assert store.get() == 3


def test_set_skips_redundant_disk_write() -> None:
    saves = []
    store = LlmPreferenceStore(
        load_config=lambda: {"preferred_llm_no": 3},
        save_config=saves.append,
    )

    store.set(3)

    assert saves == []
    assert store.get() == 3
