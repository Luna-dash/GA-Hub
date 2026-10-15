"""Single owner of the process-lifetime session domain.

The run coordinator, the metadata store, the scheduled-chat service and the
system-channel registry used to be module globals inside
``server/routes/sessions.py``. That made an HTTP module the composition root:

- every sibling route reached into it for service location
  (``from .sessions import system_channels``), so the dependency graph ran
  route → route instead of route → service;
- ``main.py`` had to *borrow* the coordinator accessors from a route, which is
  the inversion its own comment admitted ("Coordinator accessors are injected
  here — the composition root — because services/ must not import routes/");
- the tests' monkeypatch habits leaked into production code: a store-identity
  rebind existed only because tests replaced ``_store``, and the shutdown
  verdict was three-valued only because mocks returned sentinels.

None of this is HTTP. The domain lives here, the composition root builds one
instance per app and binds it to ``app.state.session_lifecycle``, and route
modules resolve it from the app they are serving. Nothing in this module
imports fastapi/pydantic or ``server.routes``.
"""
from __future__ import annotations

import logging
import os
import threading
from typing import Any, Callable

from .. import constants
from ..event_topics import CHAT_ERROR, SESSION_RUNTIME
from .event_bus import bus
from .llm_preference_store import LlmPreferenceStore
from .llm_registry import LlmUnconfirmedError
from .scheduled_chat_service import ScheduledChat, ScheduledChatService
from .session_coordinator import (
    RuntimeState,
    SessionCoordinator,
    SessionCoordinatorStoppedError,
)
from .session_metadata import SessionMetadataStore
from .session_runtime_factory import SessionRuntimeFactory
from .session_runtime_status import STATUS_ERROR
from .system_channels import SystemChannels

log = logging.getLogger(__name__)


def _session_run_capacity() -> int:
    """Return the bounded session-run capacity (default %d).

    The gate is shared by webui chat, wechat, scheduled and autonomous
    producers, so the default leaves headroom above interactive use alone.
    """ % constants.SESSION_RUN_CAPACITY_DEFAULT
    raw = os.environ.get(
        constants.ENV_SESSION_RUN_CAPACITY,
        str(constants.SESSION_RUN_CAPACITY_DEFAULT),
    ).strip()
    try:
        capacity = int(raw)
    except ValueError:
        log.warning("invalid %s=%r; using %d",
                    constants.ENV_SESSION_RUN_CAPACITY, raw,
                    constants.SESSION_RUN_CAPACITY_DEFAULT)
        return constants.SESSION_RUN_CAPACITY_DEFAULT
    if not 1 <= capacity <= constants.SESSION_RUN_CAPACITY_MAX:
        log.warning("unsupported %s=%r; using %d",
                    constants.ENV_SESSION_RUN_CAPACITY, raw,
                    constants.SESSION_RUN_CAPACITY_DEFAULT)
        return constants.SESSION_RUN_CAPACITY_DEFAULT
    return capacity


def _publish_runtime_state(state: RuntimeState) -> None:
    """Translate one coordinator state change onto the event bus."""
    bus.publish(
        SESSION_RUNTIME,
        {
            "session_id": state.session_id,
            "status": state.status,
            "run_id": state.run_id,
            "stream_id": state.stream_id,
            "completed_run_id": state.completed_run_id,
            "outcome": state.outcome,
            "error": state.error,
        },
    )
    if state.status != STATUS_ERROR or not state.run_id or not state.stream_id:
        return
    details = {
        "abort_timeout": "停止请求超时；底层任务尚未终止，如持续占用请重启服务。",
    }
    log.warning(
        "session_runtime_error session_id=%s run_id=%s stream_id=%s "
        "code=%s runtime_before=aborting runtime_after=%s",
        state.session_id, state.run_id, state.stream_id,
        state.error or "runtime_error", state.status,
    )
    bus.publish(
        CHAT_ERROR,
        {
            "session_id": state.session_id,
            "run_id": state.run_id,
            "stream_id": state.stream_id,
            "code": state.error or "runtime_error",
            "detail": details.get(state.error, "会话运行失败，请稍后重试。"),
        },
    )


class SessionLifecycle:
    """Owns the store, the run coordinator and every producer wired to them."""

    def __init__(
        self, *, store: SessionMetadataStore | None = None,
        ensure_runtime_available: Callable[[], None] | None = None,
    ) -> None:
        self._store = store if store is not None else SessionMetadataStore()
        self._ensure_runtime_available = ensure_runtime_available
        self._coordinator: SessionCoordinator | None = None
        self._runtime_factory: SessionRuntimeFactory | None = None
        # Reentrant: coordinator() composes runtime_factory(), which locks too.
        self._lock = threading.RLock()
        self._stopping = False
        self._scheduled_chats: ScheduledChatService | None = None
        self._scheduled_chats_lock = threading.Lock()
        # Built eagerly: the registry is a cheap container (it stores the
        # lazy coordinator accessor, it does not resolve one), and building it
        # against one store at construction is what retires the old
        # "rebind when the store identity changed" branch.
        self._system_channels = SystemChannels(
            coordinator=self.coordinator,
            store=self._store,
            llm_key_resolver=self.effective_llm_key,
        )

    # ── owned objects ───────────────────────────────────────────────

    @property
    def store(self) -> SessionMetadataStore:
        """The metadata store this domain owns.

        Read-only on purpose: the coordinator, the system channels and every
        producer are built against this instance, so swapping it afterwards
        would silently split the domain in two.
        """
        return self._store

    @property
    def admission_open(self) -> bool:
        """False between begin_shutdown() and finish_shutdown()."""
        with self._lock:
            return not self._stopping

    def runtime_factory(self) -> SessionRuntimeFactory:
        """The session-scoped runtime factory, built once over the domain store.

        Callers that need a *fresh* runtime (restore swaps one in) must ask the
        domain: a route building its own factory over its own store would be a
        second owner of runtimes, and the two would disagree about which store
        minted them.
        """
        self.assert_runtime_available()
        with self._lock:
            if self._runtime_factory is None:
                self._runtime_factory = SessionRuntimeFactory(self._store)
            return self._runtime_factory

    def coordinator(self) -> SessionCoordinator:
        """The shared run coordinator, constructed on first use.

        Raises SessionCoordinatorStoppedError while the lifecycle is stopping:
        callers must not touch a coordinator that is being torn down.
        """
        self.assert_runtime_available()
        with self._lock:
            if self._stopping:
                raise SessionCoordinatorStoppedError(
                    "session runtime lifecycle is stopping"
                )
            if self._coordinator is None:
                capacity = _session_run_capacity()
                kwargs = {
                    "on_state_change": _publish_runtime_state,
                    "is_theme_task": lambda session_id: bool(self._store.get(session_id).get("theme_task")),
                }
                if capacity != 1:
                    kwargs["capacity"] = capacity
                self._coordinator = SessionCoordinator(
                    self.runtime_factory(),
                    **kwargs,
                )
            return self._coordinator

    def peek_coordinator(self) -> SessionCoordinator | None:
        """Current coordinator without constructing one (peek-only callers).

        Applies the same shutdown admission gate as :meth:`coordinator` but
        never constructs one. Runtime-touching work should use the full
        accessor.
        """
        with self._lock:
            if self._stopping:
                raise SessionCoordinatorStoppedError(
                    "session runtime lifecycle is stopping"
                )
            return self._coordinator

    def assert_runtime_available(self) -> None:
        """Apply the app's compatibility gate to HTTP and background producers."""
        if self._ensure_runtime_available is not None:
            self._ensure_runtime_available()

    def runtime_states(self) -> tuple[RuntimeState, ...]:
        """Status reads observe existing runtimes, including during shutdown."""
        with self._lock:
            coordinator = self._coordinator
        return coordinator.runtime_states() if coordinator is not None else ()

    def scheduled_chats(self) -> ScheduledChatService:
        """The process-owned scheduled-chat domain."""
        if self._scheduled_chats is None:
            with self._scheduled_chats_lock:
                if self._scheduled_chats is None:
                    self._scheduled_chats = ScheduledChatService(
                        self._dispatch_scheduled_chat
                    )
        return self._scheduled_chats

    def system_channels(self) -> SystemChannels:
        """System-channel registry (wechat / autonomous / tasks)."""
        return self._system_channels

    def attach_coordinator(self, coordinator: SessionCoordinator) -> None:
        """Adopt an already-constructed coordinator.

        The explicit form of the ownership handover that used to be a
        ``_coordinator`` monkeypatch: the domain still owns the admission gate
        and the shutdown verdict for the adopted object.
        """
        with self._lock:
            self._coordinator = coordinator

    # ── model binding ───────────────────────────────────────────────

    def effective_llm_key(self, row: dict) -> str | None:
        """Resolve a session's model binding, refusing an unconfirmed one."""
        key = row.get("llm_key")
        if isinstance(key, str) and key.strip():
            return key.strip()
        if row.get("llm_index") is not None:
            raise LlmUnconfirmedError("session llm binding must be reconfirmed")
        return LlmPreferenceStore().get_key()

    # ── lifecycle ───────────────────────────────────────────────────

    def prepare(self) -> None:
        """Allow a fresh lifespan to construct runtimes after clean teardown."""
        with self._lock:
            if self._coordinator is None:
                self._stopping = False

    def begin_shutdown(self) -> None:
        """Close the admission gate before task producers are stopped."""
        with self._lock:
            self._stopping = True

    def finish_shutdown(self) -> None:
        """Reopen runtime admission after the owning lifespan tore down."""
        with self._lock:
            self._stopping = False

    def stop_runtimes(
        self, timeout: float = 3.0, *, keep_admission_closed: bool = False
    ) -> bool:
        """Stop all session runtimes without letting teardown exceed ``timeout``."""
        self.begin_shutdown()
        with self._lock:
            coordinator = self._coordinator
        if coordinator is None:
            if not keep_admission_closed:
                with self._lock:
                    self._stopping = False
            return True
        try:
            stopped = coordinator.shutdown(timeout=timeout)
        except Exception:
            log.exception("session runtime shutdown failed")
            return False
        if stopped:
            with self._lock:
                if self._coordinator is coordinator:
                    # A fresh app lifespan must construct fresh AgentService
                    # runtimes; keeping this coordinator would reuse stopped
                    # threads.
                    self._coordinator = None
                if not keep_admission_closed:
                    self._stopping = False
        if not stopped:
            log.warning("session runtime shutdown exceeded its graceful deadline")
        return stopped

    # ── internals ───────────────────────────────────────────────────

    def _dispatch_scheduled_chat(self, task: ScheduledChat) -> None:
        row = self._store.get(task.session_id)
        try:
            llm_key = self.effective_llm_key(row)
        except LlmUnconfirmedError:
            log.warning(
                "scheduled chat skipped: session model must be reconfirmed "
                "session_id=%s",
                task.session_id,
            )
            return
        self.coordinator().submit(
            task.text,
            session_id=task.session_id,
            images=task.images,
            source="scheduled",
            llm_key=llm_key,
        )
        self._store.touch(task.session_id)


def session_lifecycle_of(app: Any) -> SessionLifecycle:
    """Resolve the session domain the composition root bound to ``app``.

    Route modules call this (through a one-line FastAPI dependency) instead of
    reaching into a sibling route for service location. It deliberately raises
    rather than lazily creating a domain: an unbound app is a wiring bug, and
    the fallback would point a "test" domain at the real user data directory.
    """
    lifecycle = getattr(getattr(app, "state", None), "session_lifecycle", None)
    if isinstance(lifecycle, SessionLifecycle):
        return lifecycle
    raise RuntimeError(
        "session domain is not bound to this app: the composition root must set "
        "app.state.session_lifecycle = SessionLifecycle()"
    )
