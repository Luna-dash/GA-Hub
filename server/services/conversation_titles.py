"""One-shot migration from the legacy conversation-title sidecar.

``SessionMetadataStore`` is the only writable source of conversation titles.
Historically titles lived in ``ADMIN_DATA/conversation_metadata/titles.json``
keyed by GA session id, while the canonical store keys rows by resolved
archive path — so the sweep needs the caller's sid→path map to place each
title.  After a successful sweep the sidecar file is removed; entries whose
session no longer exists are dropped with it.
"""
from __future__ import annotations

import json
import logging
import threading
from pathlib import Path
from typing import Callable

from .. import _paths
from .session_metadata import SessionMetadataStore

log = logging.getLogger(__name__)

_migrate_lock = threading.Lock()
_migrated = False


def legacy_titles_path() -> Path:
    return _paths.ADMIN_DATA / "conversation_metadata" / "titles.json"


def _read_legacy_titles(sidecar: Path) -> dict[str, str]:
    try:
        data = json.loads(sidecar.read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    titles = data.get("titles") if isinstance(data, dict) else None
    if not isinstance(titles, dict):
        return {}
    return {
        key: value for key, value in titles.items()
        if isinstance(key, str) and isinstance(value, str) and value
    }


def migrate_legacy_titles(
    store: SessionMetadataStore,
    resolve_archive_path: Callable[[str], str | None],
    *,
    sidecar: Path | None = None,
) -> int:
    """Fold legacy titles into the canonical store; returns migrated count.

    Idempotent: when the sidecar file is absent this is a no-op.  The file
    is unlinked only after the whole sweep succeeded, so a crashed run is
    simply retried by a later process. The once-flag also moves only on
    success — never before the work it claims to have done.
    """
    global _migrated
    with _migrate_lock:
        if _migrated:
            return 0
        sidecar = sidecar or legacy_titles_path()
        titles = _read_legacy_titles(sidecar)
        if not titles:
            _migrated = True
            return 0
        migrated = 0
        for sid, title in titles.items():
            path = resolve_archive_path(sid)
            if path is None:
                continue
            store.set_title_for_archive(path, title)
            migrated += 1
        try:
            sidecar.unlink(missing_ok=True)
        except OSError:
            log.warning("could not remove legacy titles sidecar", exc_info=True)
        _migrated = True
        if migrated:
            log.info("migrated %d legacy conversation titles", migrated)
        return migrated
