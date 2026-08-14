"""Atomic persistence for durable GA-Hub UI preferences."""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any
from uuid import uuid4

from .. import _paths


class PreferencesFormatError(RuntimeError):
    """Raised when the persisted preferences document is unusable."""


class UiPreferencesStore:
    """Own all reads and writes for ui_preferences.json."""

    def __init__(self, path: Path | None = None) -> None:
        self.path = path or _paths.ADMIN_DATA / "ui_preferences.json"
        self._lock = threading.RLock()

    def read(self) -> dict[str, Any]:
        with self._lock:
            if not self.path.exists():
                return {"version": 1}
            try:
                data = json.loads(self.path.read_text("utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                raise PreferencesFormatError(f"unable to read UI preferences: {exc}") from exc
            if not isinstance(data, dict) or data.get("version") != 1:
                raise PreferencesFormatError("unsupported UI preferences format")
            return data

    def update(self, changes: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            data = self.read()
            data.update(changes)
            self._write(data)
            return data

    def _write(self, data: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(f".{uuid4().hex}.tmp")
        try:
            tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            os.replace(tmp, self.path)
        finally:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
