"""The contract Conductor's collaborators depend on, and their wiring.

``ConductorCommands`` and ``ConductorRecovery`` used to hold the whole
``ConductorService`` and reach straight into its private members
(``service._assert_open``, ``service._publish``, ``service._lifecycle_cache``,
``service._notifications_dirty``, ``service._chat_lock``). Nothing stopped a
collaborator from touching anything else on a 1300-line god object, no fake
could stand in for it, and every test had to build the full service — engine
client, process manager, pool mirror, timeout monitor — just to reach one verb.

This module names the dependency instead. ``ConductorKernel`` is the surface
those two collaborators are allowed to use, with public names; the service
implements it, and a test can implement it in ten lines. The structural guard
in ``tests/test_conductor_collaborators_contract.py`` enforces both halves:
neither collaborator may name ``service`` at all, and the kernel may not grow a
private member.

``build_collaborators`` is the only place where the store, the workflow tracker
and the two collaborators are wired together. Keeping it here rather than
inline in ``ConductorService._init_fields`` makes the one structural invariant
visible and testable: a tracker and its store are one pair, and both
collaborators talk to the same kernel.
"""
from __future__ import annotations

import threading
from typing import TYPE_CHECKING, Optional, Protocol, runtime_checkable

from .conductor_commands import ConductorCommands
from .conductor_recovery import ConductorRecovery
from .conductor_store import ConductorStore
from .conductor_workflow import WorkflowTracker

if TYPE_CHECKING:  # the service imports this module, so these stay type-only
    from .conductor_client import GaConductorClient
    from .conductor_service import HubConductorCallbacks, PoolMirror, SubagentModelPolicy


class ChatGuard:
    """Re-entrant guard around the mirrored chat history.

    Handed to collaborators that read ``chat_messages`` while the relay or a
    route may be appending to it. The lock object itself stays private to the
    service, so no auxiliary object can hold it open past its own block.
    """

    __slots__ = ("_lock",)

    def __init__(self) -> None:
        self._lock = threading.RLock()

    def __enter__(self) -> "ChatGuard":
        self._lock.acquire()
        return self

    def __exit__(self, *exc_info: object) -> None:
        self._lock.release()


@runtime_checkable
class ConductorKernel(Protocol):
    """What the command track and the recovery loop may ask of the service.

    Every member below is one the two collaborators actually use — nothing is
    declared speculatively. Adding a member here is the reviewable act of
    widening what the collaborators can reach; the structural guard fails if a
    collaborator reaches for anything else (or for a private name).
    """

    # ── collaborators and engine handles ─────────────────────────────────
    workflow_tracker: WorkflowTracker
    store: ConductorStore
    client: "GaConductorClient"
    pool: "PoolMirror"
    callbacks: "HubConductorCallbacks"
    commands: ConductorCommands

    # ── admission and engine lifecycle ───────────────────────────────────
    def assert_open(self) -> None:
        """Raise when the service is terminally shut down."""

    def assert_engine_ready(self) -> None:
        """Refuse when the supervisor is not running (never cold-starts it)."""

    def ensure_started(self, wake_recovery: bool = True) -> bool:
        """Start the engine when it is not running (chat admission does this)."""

    def ensure_relay(self) -> None:
        """Make sure the journal relay thread is running."""

    def configure_models(
        self,
        llm_index: Optional[int] = None,
        subagent_llm_index: Optional[int] = None,
        subagent_model_policy: Optional["SubagentModelPolicy"] = None,
    ) -> dict:
        """Apply the requested model policy and return the effective one."""

    def push_models_to_engine(self, snapshot: Optional[dict] = None) -> None:
        """Push the selected model policy to a live engine."""

    def admit_action_models(
        self,
        llm_index: Optional[int],
        request_id: Optional[str],
        conductor_llm_index: Optional[int],
        subagent_llm_index: Optional[int],
        subagent_model_policy: Optional["SubagentModelPolicy"],
    ) -> tuple[WorkflowTracker, dict, Optional[int]]:
        """Shared prelude for the action verbs: readiness, request, models."""    # ── hub-side effects ─────────────────────────────────────────────────
    def publish(self, topic: str, payload: dict) -> None:
        """Publish one bus notification once the current transaction commits."""

    def publish_workflow_transition(self, transition: tuple[str, dict]) -> None:
        """Publish a terminal workflow transition (deferred, like publish)."""

    def on_remote_chat(self, item: dict) -> None:
        """Mirror one engine-side chat item into the hub history."""

    def mark_notifications_dirty(self) -> None:
        """Flag that a deferred notification was lost."""

    def clear_notifications_dirty(self) -> None:
        """Clear the lost-notification flag after a resync was published."""

    def remember_lifecycle(self, status: dict, *, merge: bool = False) -> None:
        """Cache an engine status probe (``merge`` for partial relay updates)."""

    def chat_guard(self) -> ChatGuard:
        """Guard for reading or writing ``chat_messages``."""

    @property
    def notifications_dirty(self) -> bool:
        """Whether a notification was lost and a resync is owed."""

    @property
    def auto_accept(self) -> bool:
        """Whether clean deliveries are accepted without a human verdict."""


def build_collaborators(
    kernel: ConductorKernel,
    *,
    store_path: str,
    engine_base_url: str,
) -> tuple[ConductorStore, ConductorRecovery, ConductorCommands]:
    """Wire the store, the recovery loop and the command track to one kernel.

    The store seeds the tracker from its rows and then attaches itself, so the
    three objects at the centre of the cluster are built as one unit: no caller
    can pair a tracker with a second store, and both collaborators receive the
    same kernel. Returns ``(store, recovery, commands)``.
    """
    store = ConductorStore(store_path, engine_base_url, kernel.workflow_tracker)
    recovery = ConductorRecovery(kernel, store)
    commands = ConductorCommands(kernel, store, recovery)
    # Post-commit publish failures are reported back through this hook instead
    # of a lambda reaching into the service's private flag.
    store.notification_failed = kernel.mark_notifications_dirty
    return store, recovery, commands


__all__ = ["ChatGuard", "ConductorKernel", "build_collaborators"]
