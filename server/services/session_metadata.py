"""Lightweight GA-Hub session sidecar metadata.

This store must never contain conversation messages.  Live GeneraticAgent
instances and GA's raw archives remain the conversation truth sources.
"""
from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from .. import _paths


class SessionNotFoundError(KeyError):
    """Raised when a metadata record does not exist."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class SessionMetadataStore:
    """Small, atomic JSON sidecar for session labels and preferences."""

    def __init__(self, base_dir: Path | None = None) -> None:
        self.base_dir = base_dir or (_paths.ADMIN_DATA / "session_metadata")
        self.base_dir.mkdir(parents=True, exist_ok=True)
        self.path = self.base_dir / "sessions.json"
        self._lock = threading.RLock()

    def _read(self) -> dict[str, Any]:
        if not self.path.exists():
            return {"schema_version": 1, "sessions": []}
        data = json.loads(self.path.read_text("utf-8"))
        if data.get("schema_version") != 1 or not isinstance(data.get("sessions"), list):
            raise ValueError("unsupported session metadata format")
        return data

    def _write(self, data: dict[str, Any]) -> None:
        tmp = self.path.with_suffix(f".{uuid4().hex}.tmp")
        try:
            tmp.write_text(
                json.dumps(data, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            os.replace(tmp, self.path)
        finally:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._read()["sessions"]
            return [dict(row) for row in sorted(rows, key=lambda row: row["updated_at"], reverse=True)]

    def get(self, session_id: str) -> dict[str, Any]:
        with self._lock:
            for row in self._read()["sessions"]:
                if row["id"] == session_id:
                    return dict(row)
        raise SessionNotFoundError(session_id)

    def create(self, *, title: str = "", llm_index: int | None = None) -> dict[str, Any]:
        with self._lock:
            data = self._read()
            timestamp = _now()
            row = {
                "id": uuid4().hex,
                "title": title.strip(),
                "llm_index": llm_index,
                "status": "idle",
                "archive_path": None,
                "created_at": timestamp,
                "updated_at": timestamp,
            }
            data["sessions"].append(row)
            self._write(data)
            return dict(row)

    def update(self, session_id: str, changes: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            data = self._read()
            for row in data["sessions"]:
                if row["id"] == session_id:
                    if "title" in changes:
                        row["title"] = changes["title"].strip()
                    if "llm_index" in changes:
                        row["llm_index"] = changes["llm_index"]
                    row["updated_at"] = _now()
                    self._write(data)
                    return dict(row)
        raise SessionNotFoundError(session_id)

    def bind_archive(self, session_id: str, archive_path: str | Path) -> dict[str, Any]:
        """Bind metadata to one GA-native archive without copying its messages."""
        path = str(Path(archive_path).resolve())
        with self._lock:
            data = self._read()
            for row in data["sessions"]:
                if row["id"] == session_id:
                    current = row.get("archive_path")
                    if current and str(Path(current).resolve()) != path:
                        raise ValueError(f"session {session_id!r} is already bound to another archive")
                    row["archive_path"] = path
                    row["updated_at"] = _now()
                    self._write(data)
                    return dict(row)
        raise SessionNotFoundError(session_id)

    def delete(self, session_id: str) -> None:
        with self._lock:
            data = self._read()
            kept = [row for row in data["sessions"] if row["id"] != session_id]
            if len(kept) == len(data["sessions"]):
                raise SessionNotFoundError(session_id)
            data["sessions"] = kept
            self._write(data)
