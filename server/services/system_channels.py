"""Background producers as system sessions on the single chat chain.

Before the merge the hub ran two chat executions in parallel: web sessions
went through ``SessionCoordinator`` (capacity gate, precise abort, SessionStore
history), while wechat / autonomous / scheduled tasks talked to the global
``AgentService`` singleton (no gate, one-size-fits-all abort, legacy history).
Every background producer now owns a stable ``kind="system"`` session row and
enters the SAME coordinator, so one admission gate and one abort semantics
cover the whole hub. The per-channel history lands in the session store for
free, which is what retires the legacy chat-history double write.

A system session is deliberately invisible in the default session list
(``GET /api/sessions`` hides ``kind="system"`` unless asked otherwise): it is
plumbing for unattended producers, not something a user chats into.

Feishu is NOT one of these channels: ``fsapp.py`` is a GA-repo frontend that
runs its own agent in its own process and only mirrors log markers back; the
hub never executes its tasks (GA-Hub must not modify the GA repo).
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any, Callable

if TYPE_CHECKING:  # pragma: no cover - import cycle guard for type hints only
    from .agent_service import StreamHandle
    from .session_coordinator import RuntimeState, SessionCoordinator
    from .session_metadata import SessionMetadataStore

log = logging.getLogger(__name__)

# Stable, self-describing session ids. The id IS the channel key so the row is
# idempotent across restarts (ensure() is a no-op once it exists).
SYSTEM_CHANNEL_TITLES: dict[str, str] = {
    "wechat": "微信 Bot",
    "autonomous": "自主模式",
    "scheduled_task": "定时任务",
}


def system_session_id(channel: str) -> str:
    return f"system-{channel}"


class SystemChannel:
    """One background producer's session-scoped chat surface.

    Duck-types the slice of ``AgentService`` its consumer uses — ``submit``,
    ``abort``, ``switch_llm``, ``list_llms`` and the ``agent`` introspection —
    so the producer call sites keep their shape while admission moves under
    the coordinator's capacity gate.
    """

    def __init__(
        self,
        channel: str,
        *,
        coordinator: Callable[[], "SessionCoordinator"],
        store: "SessionMetadataStore",
        llm_key_resolver: Callable[[dict], str | None],
    ) -> None:
        if channel not in SYSTEM_CHANNEL_TITLES:
            raise ValueError(f"unknown system channel: {channel}")
        self.channel = channel
        self._coordinator_factory = coordinator
        self._store = store
        self._llm_key_resolver = llm_key_resolver

    @property
    def session_id(self) -> str:
        return system_session_id(self.channel)

    @property
    def title(self) -> str:
        return SYSTEM_CHANNEL_TITLES[self.channel]

    def _coordinator(self) -> "SessionCoordinator":
        return self._coordinator_factory()

    def _ensure_row(self) -> dict[str, Any]:
        row, created = self._store.ensure(
            self.session_id, title=self.title, kind="system"
        )
        if created:
            log.info("created system session for channel %s", self.channel)
        return row

    # ── chat surface (duck-typed AgentService slice) ────────────────

    def submit(
        self,
        text: str,
        *,
        source: str,
        images: list[str] | None = None,
    ) -> "StreamHandle":
        """Admit one task through the shared coordinator; return its stream."""
        self._ensure_row()
        row = self._store.get(self.session_id)
        llm_key = self._llm_key_resolver(row)
        _, handle = self._coordinator().submit_stream(
            text,
            session_id=self.session_id,
            source=source,
            images=images,
            llm_key=llm_key,
        )
        return handle

    def abort(self) -> "RuntimeState":
        """Abort this channel's current run (idempotent when idle)."""
        self._ensure_row()
        return self._coordinator().abort_if_current(session_id=self.session_id)

    @property
    def agent(self):
        """The channel runtime's GA agent (creates the runtime on first touch).

        Background producers introspect it for LLM listing/switching and idle
        checks, exactly like they did against the global singleton.
        """
        return self._coordinator().ensure_runtime(self.session_id).agent

    def runtime(self):
        """Return the channel runtime if it exists, never creating one."""
        return self._coordinator().peek_runtime(self.session_id)

    def switch_llm(self, n: int) -> dict:
        runtime = self._coordinator().ensure_runtime(self.session_id)
        switch = getattr(runtime, "switch_llm", None)
        if callable(switch):
            return switch(n)
        return runtime.agent.switch_llm(n)

    def list_llms(self) -> list[dict]:
        return self.agent.list_llms()


class SystemChannels:
    """Registry of the hub's system channels (one per background producer)."""

    def __init__(
        self,
        *,
        coordinator: Callable[[], "SessionCoordinator"],
        store: "SessionMetadataStore",
        llm_key_resolver: Callable[[dict], str | None],
    ) -> None:
        self._coordinator = coordinator
        self._store = store
        self._llm_key_resolver = llm_key_resolver
        self._channels: dict[str, SystemChannel] = {}

    @property
    def store(self) -> "SessionMetadataStore":
        return self._store

    def channel(self, channel: str) -> SystemChannel:
        if channel not in self._channels:
            self._channels[channel] = SystemChannel(
                channel,
                coordinator=self._coordinator,
                store=self._store,
                llm_key_resolver=self._llm_key_resolver,
            )
        return self._channels[channel]
