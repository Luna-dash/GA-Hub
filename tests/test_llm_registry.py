"""Stable MyKey assignment identity regression tests."""
from __future__ import annotations

import sys
import types
from unittest import mock

from server.services.llm_registry import (
    LlmRegistry,
    LlmRegistryError,
    LlmUnavailableError,
)


class _Agent:
    def __init__(self) -> None:
        self.keys = ["a_oai_config", "b_oai_config", "mixin_config"]
        self.llmclients = list(range(len(self.keys)))
        self.llm_no = 0
        self.next_llm_calls: list[int] = []

    def load_llm_sessions(self) -> None:
        self.llmclients = list(range(len(self.keys)))

    def next_llm(self, index: int) -> None:
        self.next_llm_calls.append(index)
        self.llm_no = index


def _llmcore(keys) -> types.ModuleType:
    module = types.ModuleType("llmcore")
    module.reload_mykeys = lambda: ({key: {} for key in keys()}, True)  # type: ignore[attr-defined]
    return module


def test_registry_keys_follow_assignment_order_not_backend_identity() -> None:
    agent = _Agent()
    with mock.patch.dict(sys.modules, {"llmcore": _llmcore(lambda: agent.keys)}):
        assert LlmRegistry.reload_and_snapshot(agent) == [
            ("a_oai_config", 0),
            ("b_oai_config", 1),
            ("mixin_config", 2),
        ]


def test_registry_rejects_client_assignment_count_mismatch() -> None:
    agent = _Agent()
    agent.llmclients = [0, 1]
    with mock.patch.dict(sys.modules, {"llmcore": _llmcore(lambda: agent.keys)}):
        try:
            LlmRegistry.snapshot(agent)
        except LlmRegistryError:
            pass
        else:
            raise AssertionError("expected a registry mismatch")


def test_switch_by_key_survives_deletion_and_reordering() -> None:
    agent = _Agent()
    with mock.patch.dict(sys.modules, {"llmcore": _llmcore(lambda: agent.keys)}):
        assert LlmRegistry.switch_by_key(agent, "b_oai_config") == 1
        assert agent.next_llm_calls == [1]

        agent.keys = ["new_oai_config", "a_oai_config", "mixin_config", "b_oai_config"]
        agent.llmclients = list(range(len(agent.keys)))
        assert LlmRegistry.resolve(agent, "b_oai_config") == 3
        assert LlmRegistry.switch_by_key(agent, "b_oai_config") == 3
        assert agent.next_llm_calls == [1, 3]

        agent.keys.remove("b_oai_config")
        agent.llmclients = list(range(len(agent.keys)))
        try:
            LlmRegistry.resolve(agent, "b_oai_config")
        except LlmUnavailableError:
            pass
        else:
            raise AssertionError("expected a deleted key to be unavailable")
