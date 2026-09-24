"""Durable rewind adapter for one GA runtime.

The adapter owns worldline checkpoint binding, native archive restoration, and
the projection cut.  It intentionally accepts only runtime-local collaborators:
the GA agent, session identity, stream projection, and a lock.
"""
from __future__ import annotations

import os
import logging
import threading
from typing import Any

from .. import _paths
from frontends.gahub.bridge import rewind as ga_rewind
from .chat_stream_projection import ChatStreamProjection
from .event_bus import bus
from ..event_topics import CHAT_REWOUND


log = logging.getLogger(__name__)


class RewindAdapter:
    def __init__(
        self,
        *,
        agent: Any,
        session_id: str,
        snapshots: ChatStreamProjection,
        lock: Any,
        checkpoint_lock: Any | None = None,
        event_bus: Any | None = None,
    ) -> None:
        self.agent = agent
        self.session_id = session_id
        self.snapshots = snapshots
        self.lock = lock
        self._checkpoint_lock = checkpoint_lock or threading.RLock()
        self.store: Any | None = None
        self._bus = event_bus or bus

    def bind_store(self) -> Any | None:
        """Bind a session runtime to GA's durable archive worldline."""
        session_id = str(self.session_id or "")
        if not session_id:
            return None
        log_path = str(getattr(self.agent, "log_path", "") or "")
        if not log_path:
            raise RuntimeError("session runtime has no GA archive path")

        temp_dir = os.path.normpath(os.path.join(str(_paths.GA_ROOT), "temp"))
        try:
            store = ga_rewind.bind_store(
                self.agent,
                temp_dir=temp_dir,
                checkpoint_lock=self._checkpoint_lock,
            )
        except Exception:
            self.store = None
            raise
        self.store = store
        return store

    def sync_store(self, *, strict: bool = False) -> Any | None:
        """Reconcile the complete native archive into the worldline tree."""
        try:
            with self._checkpoint_lock:
                store = self.store
                if store is None:
                    if strict and str(self.session_id or ""):
                        raise RuntimeError("durable rewind store is not bound")
                    return None
                return ga_rewind.sync_store(
                    self.agent,
                    store=store,
                    checkpoint_lock=self._checkpoint_lock,
                )
        except Exception:
            if strict:
                raise
            log.exception(
                "could not synchronize rewind checkpoint for session %s",
                self.session_id,
            )
            return None

    def sync_working_memory(self, result: dict) -> None:
        """Keep GA working memory aligned with restored LLM history."""
        ga_rewind.sync_working_memory(self.agent, result)

    def apply_durable(self, store: Any, turn_count: int) -> dict:
        """Rewrite archive/worldline and return durable rewind metrics."""
        self.sync_store(strict=True)
        return ga_rewind.apply_durable(
            self.agent,
            store=store,
            turn_count=turn_count,
            checkpoint_lock=self._checkpoint_lock,
        )

    def _removed_sids_after(
        self,
        all_items: list[tuple[str, Any]],
        done_items: list[tuple[str, Any]],
        turn_count: int,
        anchor_sid: str | None = None,
    ) -> list[str]:
        """Stream ids from the first removed turn to the end — shared by both
        the durable and the in-memory rewind paths."""
        removed_sids: list[str] = []
        items = list(all_items)
        if anchor_sid is not None:
            for anchor_idx, (stream_id, _snapshot) in enumerate(items):
                if stream_id == anchor_sid:
                    return [sid2 for sid2, _snap in items[anchor_idx:]]
        if done_items:
            overlap = min(turn_count, len(done_items))
            first_removed_sid = done_items[-overlap][0]
            hit = False
            for stream_id, _snapshot in all_items:
                if stream_id == first_removed_sid:
                    hit = True
                if hit:
                    removed_sids.append(stream_id)
        return removed_sids

    # ── shared planning / finalization (pure mechanics) ────────────
    # Both rewind strategies select turns from completed stream snapshots the
    # same way and publish the same success event; only the COMMIT differs
    # (durable archive/worldline rewrite vs in-memory history truncation).
    # Upper-bound validation stays per-strategy: durable counts come from the
    # worldline after archive reconciliation, legacy counts from snapshots.

    @staticmethod
    def _completed_items(
        all_items: list[tuple[str, Any]],
    ) -> list[tuple[str, Any]]:
        return [(s, snap) for s, snap in all_items if snap.done]

    @staticmethod
    def _resolve_turn_count(
        *,
        sid: str | None,
        n: int | None,
        done_items: list[tuple[str, Any]],
        scope: str,
    ) -> int:
        """Resolve a sid/n rewind request to a turn count (shared semantics)."""
        if sid:
            matches = [
                index
                for index, (stream_id, _snap) in enumerate(done_items)
                if stream_id == sid
            ]
            if not matches:
                raise ValueError(f"sid {sid!r} not found among {scope}")
            return len(done_items) - matches[0]
        if n is not None:
            if n < 1:
                raise ValueError("n must be at least 1")
            return n
        raise ValueError("either sid or n required")

    def _resolve_rewind_cut(
        self,
        *,
        all_items: list[tuple[str, Any]],
        done_items: list[tuple[str, Any]],
        sid: str | None = None,
        n: int | None = None,
    ) -> tuple[int, str | None]:
        """Resolve ``(turn_count, anchor_sid)`` for a rewind request.

        The Hub passes the clicked bubble's stream id.  A bubble belonging
        to an ABORTED (never-completed) turn exists in the projection but
        not in the durable worldline; nothing may be removed from the
        archive, yet the snapshots from that bubble onward must still be
        dropped — so the cut is anchored instead of counted.
        """
        items = list(all_items)
        if sid:
            for idx, (stream_id, _snap) in enumerate(done_items):
                if stream_id == sid:
                    return len(done_items) - idx, sid
            done_ids = {stream_id for stream_id, _snap in done_items}
            for idx, (stream_id, _snap) in enumerate(items):
                if stream_id == sid:
                    after = sum(1 for s, _ in items[idx:] if s in done_ids)
                    return after, sid
            # Unknown id (e.g. restored from history): fall back to a plain
            # count; with no count provided this raises, matching the
            # historical contract.
        return self._resolve_turn_count(
            sid=None,
            n=n,
            done_items=done_items,
            scope="current runtime turns",
        ), None

    def _drop_snapshots(self, removed_sids: list[str]) -> None:
        # ChatStreamProjection.pop(stream_id) already tolerates missing ids;
        # a default-argument pop would only match plain dicts (tests), not the
        # real projection store.
        for stream_id in removed_sids:
            self.snapshots.pop(stream_id)

    def _finalize_rewind(
        self,
        *,
        turn_count: int,
        removed_sids: list[str],
        result: dict,
        label: str,
    ) -> dict:
        """Publish the shared success event and log line after either commit."""
        out = {"removed_sids": removed_sids, **result}
        self._bus.publish(CHAT_REWOUND, {
            "removed_sids": removed_sids,
            "kept": out["kept"],
            "history_lines": out["history_lines"],
            "session_id": self.session_id,
        })
        log.info(
            "%s: dropped %d turn(s), removed %d history entries, sids=%s",
            label,
            turn_count,
            out["removed_history_entries"],
            removed_sids,
        )
        return out

    def rewind_session_turns(
        self, *, sid: str | None = None, n: int | None = None
    ) -> dict:
        """Durably rewind one Hub session without trusting UI snapshots."""
        with self._checkpoint_lock:
            if bool(getattr(self.agent, "is_running", False)):
                raise RuntimeError(
                    "cannot rewind while agent is running; abort first"
                )

            lock = self.lock
            if lock is None:
                lock = threading.RLock()
                self.lock = lock
            with lock:
                # Concurrency contract (2026-09-05 decision): snapshot objects
                # are written by fanout threads under AgentService._lock while
                # this reader holds a DIFFERENT lock — that is safe only
                # because the is_running check above (backed by the
                # coordinator's exclusive rewind gate) guarantees no stream
                # is live here. Any future "rewind while running" feature
                # must first unify the two locks.
                all_items = self.snapshots.items()
                done_items = self._completed_items(all_items)
                turn_count, anchor_sid = self._resolve_rewind_cut(
                    all_items=all_items,
                    done_items=done_items,
                    sid=sid,
                    n=n,
                )

            store = self.store
            if store is None:
                raise RuntimeError("durable rewind store is not bound")
            result = self.apply_durable(store, turn_count)

            with lock:
                removed_sids = self._removed_sids_after(
                    all_items, done_items, turn_count, anchor_sid=anchor_sid
                )
                self._drop_snapshots(removed_sids)

        return self._finalize_rewind(
            turn_count=turn_count,
            removed_sids=removed_sids,
            result=result,
            label="session rewind",
        )
