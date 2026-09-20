"""Stable assignment-name registry for GA's positional LLM list."""
from __future__ import annotations

import importlib
import threading
import weakref
from contextlib import contextmanager
from typing import Any


def _model_bridge():
    """Load the GA-owned model bridge after GA_ROOT path bootstrap."""
    return importlib.import_module("frontends.gahub.bridge.model")


class LlmUnconfirmedError(RuntimeError):
    """A session still stores a positional llm_index whose key is unknown.

    Raised when the persisted (llm_index-only) binding cannot be re-confirmed
    against the current mykey snapshot; the UI re-binds the session model.
    """


class LlmUnavailableError(LookupError):
    """Raised when a stable MyKey assignment is no longer selectable."""


class LlmRegistryError(RuntimeError):
    """Raised when GA's clients cannot be mapped back to assignments."""


class LlmRegistry:
    """Map MyKey assignment names to client indexes for one runtime.

    GA intentionally keeps unsuccessful mixin placeholders in ``llmclients``.
    Therefore the mapping is built from assignment order, not backend identity.
    The process-wide lock coordinates reload / resolve / switch with MyKey edits;
    model requests never hold it.
    """

    _lock = threading.RLock()
    _agent_versions: "weakref.WeakKeyDictionary[Any, tuple[str, int] | None]" = weakref.WeakKeyDictionary()

    @staticmethod
    def _mykey_version() -> tuple[str, int] | None:
        return _model_bridge().mykey_revision()

    @classmethod
    def mark_agent_current(cls, agent: Any) -> None:
        """Record the MyKey revision from which this agent built its clients."""
        with cls._lock:
            cls._agent_versions[agent] = cls._mykey_version()

    @classmethod
    @contextmanager
    def synchronized(cls):
        """Hold the reload/resolve critical section."""
        with cls._lock:
            yield

    @classmethod
    def reload_and_snapshot(cls, agent: Any) -> list[tuple[str, int]]:
        with cls._lock:
            try:
                current_version = cls._mykey_version()
                force_reload = (
                    agent in cls._agent_versions
                    and cls._agent_versions[agent] != current_version
                )
                entries = _model_bridge().model_snapshot(
                    agent,
                    reload_clients=True,
                    force_reload=force_reload,
                )
                cls._agent_versions[agent] = cls._mykey_version()
                return entries
            except Exception as exc:
                raise LlmRegistryError(f"failed to reload LLM sessions: {exc}") from exc

    @classmethod
    def snapshot(cls, agent: Any) -> list[tuple[str, int]]:
        with cls._lock:
            try:
                return _model_bridge().model_snapshot(agent)
            except Exception as exc:
                raise LlmRegistryError(f"failed to snapshot LLM sessions: {exc}") from exc

    @classmethod
    def resolve(cls, agent: Any, key: str, *, reload: bool = True) -> int:
        with cls._lock:
            entries = cls.reload_and_snapshot(agent) if reload else cls.snapshot(agent)
            for candidate, index in entries:
                if candidate == key:
                    return index
            raise LlmUnavailableError(f"LLM assignment {key!r} is unavailable")

    @classmethod
    def switch_by_key(cls, agent: Any, key: str) -> int:
        with cls._lock:
            index = cls.resolve(agent, key)
            return _model_bridge().switch_model(agent, index)

    @classmethod
    def switch_by_index(cls, agent: Any, index: int) -> tuple[int, str]:
        """Switch using a caller-visible snapshot index inside the same lock."""
        with cls._lock:
            entries = cls.reload_and_snapshot(agent)
            by_index = {entry_index: assignment for assignment, entry_index in entries}
            key = by_index.get(int(index))
            if key is None:
                raise LlmUnavailableError(f"llm index has no assignment: {index}")
            return _model_bridge().switch_model(agent, int(index)), key
