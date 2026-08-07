"""Canonical conversation metadata adapter.

SessionMetadataStore is the only writable source of conversation titles.  The
legacy title sidecar is read only to migrate existing installations and is
cleared after a successful canonical read/write.
"""
from __future__ import annotations

import hashlib
from pathlib import Path

from .conversation_titles import ConversationTitleStore
from .session_metadata import SessionMetadataStore


class ConversationMetadataAdapter:
    def __init__(
        self,
        sessions: SessionMetadataStore,
        legacy_titles: ConversationTitleStore,
    ) -> None:
        self._sessions = sessions
        self._legacy_titles = legacy_titles

    @staticmethod
    def _stable_id(archive_path: str | Path) -> str:
        resolved = str(Path(archive_path).resolve())
        digest = hashlib.sha256(resolved.encode("utf-8")).hexdigest()
        return f"archive-{digest}"

    def get_title(self, conversation_id: str, archive_path: str | Path) -> str:
        row = self._sessions.find_by_archive(archive_path)
        legacy = self._legacy_titles.get(conversation_id).strip()
        if row is not None and row.get("title"):
            if legacy:
                self._legacy_titles.delete(conversation_id)
            return str(row["title"])
        if legacy:
            row = self._sessions.upsert_archive(
                self._stable_id(archive_path), archive_path, title=legacy
            )
            self._legacy_titles.delete(conversation_id)
            return str(row["title"])
        return "" if row is None else str(row.get("title") or "")

    def set_title(
        self,
        conversation_id: str,
        archive_path: str | Path,
        title: str,
    ) -> dict:
        row = self._sessions.upsert_archive(
            self._stable_id(archive_path), archive_path, title=title
        )
        self._legacy_titles.delete(conversation_id)
        return row

    def delete(self, conversation_id: str, archive_path: str | Path) -> bool:
        deleted = self._sessions.delete_by_archive(archive_path)
        self._legacy_titles.delete(conversation_id)
        return deleted
