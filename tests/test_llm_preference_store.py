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


def test_get_caches_preferred_key() -> None:
    calls = []

    def load_config():
        calls.append("load")
        return {"other": "preserved", "preferred_llm_key": "alpha_oai_config"}

    store = LlmPreferenceStore(load_config=load_config)

    assert store.get_key() == "alpha_oai_config"
    assert store.get_key() == "alpha_oai_config"
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


def test_set_key_preserves_other_config_and_updates_cache() -> None:
    saved = []
    store = LlmPreferenceStore(
        load_config=lambda: {"other": "preserved", "preferred_llm_key": "old"},
        save_config=saved.append,
    )

    store.set_key("alpha_oai_config")
    store.set_key("alpha_oai_config")

    assert saved == [{"other": "preserved", "preferred_llm_key": "alpha_oai_config"}]
    assert store.get_key() == "alpha_oai_config"


def test_get_selection_caches_both_fields_with_one_load() -> None:
    calls = []

    def load_config():
        calls.append("load")
        return {"preferred_llm_key": "alpha_oai_config", "preferred_llm_no": 2}

    store = LlmPreferenceStore(load_config=load_config)

    assert store.get_selection() == ("alpha_oai_config", 2)
    assert store.get_selection() == ("alpha_oai_config", 2)
    assert store.get_key() == "alpha_oai_config"
    assert store.get() == 2
    assert calls == ["load"]

def test_set_skips_redundant_disk_write() -> None:
    saves = []
    store = LlmPreferenceStore(
        load_config=lambda: {"preferred_llm_no": 3},
        save_config=saves.append,
    )

    store.set(3)

    assert saves == []
    assert store.get() == 3
