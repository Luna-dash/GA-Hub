"""Create isolated AgentService runtimes backed by GA-native archives."""
from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

from .session_metadata import SessionMetadataStore


class RuntimeRestoreError(RuntimeError):
    """Raised when GA cannot restore the archive bound to a Hub session."""


class SessionRuntimeFactory:
    """Lazily construct one GA runtime per Hub session.

    The sidecar stores only the native archive path. Conversation content stays
    exclusively in the live GA agent and ``model_responses_*.txt`` archive.
    """

    def __init__(
        self,
        store: SessionMetadataStore,
        *,
        service_factory: Callable[..., Any] | None = None,
        continue_inplace: Callable[..., tuple[str, bool]] | None = None,
        acquire_birth_lock: Callable[..., Any] | None = None,
        release_current: Callable[[Any], Any] | None = None,
    ) -> None:
        if service_factory is None:
            from .agent_service import AgentService

            service_factory = AgentService
        if continue_inplace is None or acquire_birth_lock is None or release_current is None:
            from frontends.continue_cmd import (
                acquire_birth_lock as ga_acquire_birth_lock,
                continue_inplace as ga_continue_inplace,
                release_current as ga_release_current,
            )

            continue_inplace = continue_inplace or ga_continue_inplace
            acquire_birth_lock = acquire_birth_lock or ga_acquire_birth_lock
            release_current = release_current or ga_release_current
        self._store = store
        self._service_factory = service_factory
        self._continue_inplace = continue_inplace
        self._acquire_birth_lock = acquire_birth_lock
        self._release_current = release_current

    def __call__(self, session_id: str):
        row = self._store.get(session_id)
        runtime = self._service_factory(
            session_id=session_id,
            manage_global_preference=False,
        )
        archive_path = row.get("archive_path")
        if archive_path:
            message, ok = self._continue_inplace(
                runtime.agent,
                str(Path(archive_path).resolve()),
                agent_id=session_id,
                restore_wm=True,
            )
            if not ok:
                self._release_current(runtime.agent)
                raise RuntimeRestoreError(message)
        else:
            self._acquire_birth_lock(runtime.agent, session_id)
            try:
                self._store.bind_archive(session_id, runtime.agent.log_path)
            except Exception:
                self._release_current(runtime.agent)
                raise
        runtime.start_run_thread()
        return runtime
