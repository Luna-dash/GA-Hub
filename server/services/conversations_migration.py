"""Idempotent one-shot migration: v1 ``chat_history.json`` → v2 repository.

The legacy store is a single JSON list living inside the GA repo's ``memory/``
directory. This migration **reads it once** (read-only, never writes back) and
imports each entry as a v2 Conversation into GA-Hub's own store
(``ADMIN_DATA/conversations_v2/``). The GA repo file is left untouched.

Idempotency: a marker file ``.migrated_v1`` is written on success. Re-runs
skip already-imported ids (matched by the original v1 id preserved as
Conversation.id) and are therefore safe to repeat.
"""
from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any

from server import _paths
from server.services.conversation_repository import (
    Conversation,
    ConversationRepository,
    Message,
    STATUS_IDLE,
    MSG_COMPLETE,
)

log = logging.getLogger(__name__)

MIGRATION_MARKER = ".migrated_v1"


def _legacy_chat_history_path() -> Path | None:
    """Path to the legacy GA-side chat_history.json, if GA_ROOT is configured."""
    try:
        return _paths.memory_dir() / "chat_history.json"
    except RuntimeError:
        # GA_ROOT not configured — nothing to migrate from.
        return None


def _read_legacy_entries() -> list[dict[str, Any]]:
    p = _legacy_chat_history_path()
    if p is None or not p.exists():
        return []
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        log.warning("could not read legacy chat_history.json: %s", e)
        return []
    if not isinstance(data, list):
        log.warning("legacy chat_history.json is not a list; skipping migration")
        return []
    return data


def _entry_to_conversation(entry: dict[str, Any]) -> Conversation:
    sid = str(entry.get("id") or "")
    if not sid:
        return Conversation(
            id="",  # caller filters these out
            title="",
        )
    created = int(entry.get("created_at") or 0)
    updated = int(entry.get("updated_at") or created)
    msgs: list[Message] = []
    for i, m in enumerate(entry.get("messages") or []):
        if not isinstance(m, dict):
            continue
        msgs.append(
            Message(
                id=f"{sid}-{i}",
                role=m.get("role", "user"),
                content=m.get("content", ""),
                created_at=int(m.get("created_at") or created or 0),
                stream_id=None,
                source="webui",
                status=MSG_COMPLETE,
            )
        )
    return Conversation(
        id=sid,
        title=str(entry.get("title") or "新会话"),
        created_at=created,
        updated_at=updated,
        model_index=int(entry.get("model_index") or 0),
        model_key=entry.get("model_key"),
        status=STATUS_IDLE,
        messages=msgs,
        _revision=0,
    )


def run_migration(repo: ConversationRepository | None = None, *, force: bool = False) -> dict[str, Any]:
    """Import legacy v1 conversations into the v2 repository.

    Returns a small stats dict. Idempotent: skips the marker (unless ``force``)
    and skips ids already present in the v2 store.
    """
    repo = repo or ConversationRepository()
    marker = repo.base_dir / MIGRATION_MARKER
    if marker.exists() and not force:
        log.info("v1→v2 migration already done (marker present); skipping")
        return {"skipped": True, "imported": 0, "already_present": 0, "failed": 0}

    entries = _read_legacy_entries()
    existing = set(repo.all_ids())
    imported = 0
    already = 0
    failed = 0

    for entry in entries:
        if not isinstance(entry, dict):
            failed += 1
            continue
        sid = str(entry.get("id") or "").strip()
        if not sid:
            failed += 1
            continue
        if sid in existing:
            already += 1
            continue
        conv = _entry_to_conversation(entry)
        try:
            # write directly to preserve the original v1 id (create() makes a uuid)
            payload = conv.to_dict()
            p = repo._session_path(sid)
            repo._atomic_write_json(p, payload)
            repo._upsert_index(conv)
            existing.add(sid)
            imported += 1
        except Exception as e:  # pragma: no cover - defensive
            log.warning("failed to import legacy entry %s: %s", sid, e)
            failed += 1

    # Write marker regardless of failures so we don't loop forever; `force` can rerun.
    try:
        marker.write_text(
            json.dumps(
                {"migrated_at": int(time.time()), "imported": imported, "failed": failed}
            ),
            encoding="utf-8",
        )
    except OSError as e:
        log.warning("could not write migration marker: %s", e)

    log.info("v1→v2 migration: imported=%d already=%d failed=%d", imported, already, failed)
    return {"skipped": False, "imported": imported, "already_present": already, "failed": failed}
