from __future__ import annotations

from server.services.goalhive_service import _worker_llm_instruction


def test_hive_worker_instruction_pins_every_worker_to_selected_model():
    instruction = _worker_llm_instruction(4)

    assert "--llm_no 4" in instruction
    assert "所有 Hive worker" in instruction
    assert "首个 worker" in instruction
    assert "后续扩容 worker" in instruction


def test_hive_worker_instruction_is_empty_without_selection():
    assert _worker_llm_instruction(None) == ""
