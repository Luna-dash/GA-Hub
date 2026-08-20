"""Stable assignment-name registry for GA's positional LLM list."""
from __future__ import annotations

import os
import sys
import threading
import weakref
from typing import Any
from contextlib import contextmanager


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
        llmcore = sys.modules.get("llmcore")
        path = getattr(llmcore, "_mykey_path", None) if llmcore is not None else None
        if not path:
            return None
        try:
            return os.fspath(path), os.stat(path).st_mtime_ns
        except OSError:
            return None

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
                if agent in cls._agent_versions and cls._agent_versions[agent] != current_version:
                    # GA's reload flag is process-global. Another agent may already
                    # have consumed it, so force this stale agent to rebuild once.
                    llmcore = sys.modules.get("llmcore")
                    if llmcore is not None:
                        llmcore._mykey_mtime = None
                agent.load_llm_sessions()
                cls._agent_versions[agent] = cls._mykey_version()
            except Exception as exc:
                raise LlmRegistryError(f"failed to reload LLM sessions: {exc}") from exc
            return cls.snapshot(agent)

    @classmethod
    def snapshot(cls, agent: Any) -> list[tuple[str, int]]:
        with cls._lock:
            from llmcore import reload_mykeys

            clients = getattr(agent, "llmclients", None)
            if clients is None:
                raise LlmRegistryError("agent has no llmclients after reload")
            try:
                mykeys, _changed = reload_mykeys()
            except Exception as exc:
                raise LlmRegistryError(f"failed to reload mykey assignments: {exc}") from exc

            keys = [
                var
                for var, cfg in mykeys.items()
                if isinstance(cfg, dict)
                if any(token in var for token in ("api", "config", "cookie"))
            ]
            if len(keys) != len(clients):
                raise LlmRegistryError(
                    f"LLM registry mismatch: {len(keys)} assignments, "
                    f"{len(clients)} clients"
                )
            return [(key, index) for index, key in enumerate(keys)]

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
            agent.next_llm(index)
            return int(getattr(agent, "llm_no", index))

    @classmethod
    def switch_by_index(cls, agent: Any, index: int) -> tuple[int, str]:
        """Switch using a caller-visible snapshot index inside the same lock."""
        with cls._lock:
            entries = cls.reload_and_snapshot(agent)
            by_index = {entry_index: assignment for assignment, entry_index in entries}
            key = by_index.get(int(index))
            if key is None:
                raise LlmUnavailableError(f"llm index has no assignment: {index}")
            agent.next_llm(int(index))
            return int(getattr(agent, "llm_no", index)), key
