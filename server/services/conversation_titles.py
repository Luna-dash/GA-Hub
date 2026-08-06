"""Atomic GA-Hub sidecar for user-assigned raw conversation titles."""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any
from uuid import uuid4

from .. import _paths


class ConversationTitleStore:
    """Persist display titles without modifying GA-native archives."""

    def __init__(self, base_dir: Path | None = None) -> None:
        self.base_dir = base_dir or (_paths.ADMIN_DATA / "conversation_metadata")
        self.base_dir.mkdir(parents=True, exist_ok=True)
        self.path = self.base_dir / "titles.json"
        self._lock = threading.RLock()

    def _read(self) -> dict[str, Any]:
        if not self.path.exists():
            return {"schema_version": 1, "titles": {}}
        data = json.loads(self.path.read_text("utf-8"))
        if data.get("schema_version") != 1 or not isinstance(data.get("titles"), dict):
            raise ValueError("unsupported conversation title format")
        return data

    def _write(self, data: dict[str, Any]) -> None:
        tmp = self.path.with_name(f".{self.path.name}.{os.getpid()}.{uuid4().hex}.tmp")
        try:
            tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", "utf-8")
            os.replace(tmp, self.path)
        finally:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass

    def get(self, conversation_id: str) -> str:
        with self._lock:
            value = self._read()["titles"].get(conversation_id, "")
            return value if isinstance(value, str) else ""

    def set(self, conversation_id: str, title: str) -> None:
        with self._lock:
            data = self._read()
            if title:
                data["titles"][conversation_id] = title
            else:
                data["titles"].pop(conversation_id, None)
            self._write(data)

    def delete(self, conversation_id: str) -> None:
        with self._lock:
            data = self._read()
            if conversation_id in data["titles"]:
                del data["titles"][conversation_id]
                self._write(data)
