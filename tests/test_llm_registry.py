"""Stable MyKey assignment identity regression tests."""
from __future__ import annotations

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


class _Bridge:
    def __init__(self) -> None:
        self.revision = ("mykey.py", 1)

    def mykey_revision(self):
        return self.revision

    def model_snapshot(
        self,
        agent: _Agent,
        *,
        reload_clients: bool = False,
        force_reload: bool = False,
    ) -> list[tuple[str, int]]:
        if reload_clients:
            agent.load_llm_sessions()
        if len(agent.keys) != len(agent.llmclients):
            raise RuntimeError("LLM registry mismatch")
        return [(key, index) for index, key in enumerate(agent.keys)]

    @staticmethod
    def switch_model(agent: _Agent, index: int) -> int:
        agent.next_llm(index)
        return agent.llm_no


def _patch_bridge(bridge: _Bridge):
    return mock.patch(
        "server.services.llm_registry._model_bridge",
        return_value=bridge,
    )


def test_registry_keys_follow_assignment_order_not_backend_identity() -> None:
    agent = _Agent()
    with _patch_bridge(_Bridge()):
        assert LlmRegistry.reload_and_snapshot(agent) == [
            ("a_oai_config", 0),
            ("b_oai_config", 1),
            ("mixin_config", 2),
        ]


def test_registry_rejects_client_assignment_count_mismatch() -> None:
    agent = _Agent()
    agent.llmclients = [0, 1]
    with _patch_bridge(_Bridge()):
        try:
            LlmRegistry.snapshot(agent)
        except LlmRegistryError:
            pass
        else:
            raise AssertionError("expected a registry mismatch")


def test_switch_by_key_survives_deletion_and_reordering() -> None:
    agent = _Agent()
    with _patch_bridge(_Bridge()):
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
            raise AssertionError("expected unavailable assignment")


def test_each_open_agent_reloads_same_assignment_after_global_change_is_consumed() -> None:
    class GlobalBridge(_Bridge):
        def __init__(self) -> None:
            super().__init__()
            self.endpoint = "https://old.example/v1"
            self.consumed_revision = self.revision
            self.force_reload_calls: list[bool] = []

        def model_snapshot(
            self,
            agent: _Agent,
            *,
            reload_clients: bool = False,
            force_reload: bool = False,
        ) -> list[tuple[str, int]]:
            self.force_reload_calls.append(force_reload)
            if reload_clients and (force_reload or self.consumed_revision != self.revision):
                self.consumed_revision = self.revision
                agent.keys = ["a_oai_config"]
                agent.llmclients = [{"endpoint": self.endpoint}]
            return [("a_oai_config", 0)]

    bridge = GlobalBridge()
    first = _Agent()
    second = _Agent()
    first.keys = second.keys = ["a_oai_config"]
    first.llmclients = second.llmclients = [{"endpoint": bridge.endpoint}]

    with _patch_bridge(bridge):
        LlmRegistry.mark_agent_current(first)
        LlmRegistry.mark_agent_current(second)

        # Keep assignment name/index/count unchanged; only edit API internals.
        bridge.endpoint = "https://new.example/v1"
        bridge.revision = ("mykey.py", 2)

        assert LlmRegistry.reload_and_snapshot(first) == [("a_oai_config", 0)]
        assert first.llmclients == [{"endpoint": "https://new.example/v1"}]
        assert second.llmclients == [{"endpoint": "https://old.example/v1"}]

        # The first reload consumed the global marker. The second agent must
        # still request a force reload based on its per-agent revision.
        assert LlmRegistry.reload_and_snapshot(second) == [("a_oai_config", 0)]
        assert second.llmclients == [{"endpoint": "https://new.example/v1"}]
        assert bridge.force_reload_calls[-2:] == [True, True]
