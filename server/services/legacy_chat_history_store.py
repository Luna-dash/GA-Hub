"""Read-only/compatibility access to GA's legacy chat_history.json."""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any

from .. import _paths



class LegacyChatHistoryFormatError(RuntimeError):
    """Raised when the legacy history document cannot be parsed safely."""


class LegacyChatHistoryStore:
    """Own every read and compatibility write for legacy chat_history.json.

    Normal GA-Hub persistence uses ConversationRepository under ADMIN_DATA.
    This adapter exists for one-shot migration and the legacy /archive
    compatibility endpoint; it must not become the new conversation store.
    """

    def __init__(self, path: Path | None = None) -> None:
        self.path = path if path is not None else self._default_path()
        self._lock = threading.RLock()

    @staticmethod
    def _default_path() -> Path | None:
        try:
            return _paths.memory_dir() / "chat_history.json"
        except RuntimeError:
            return None

    def read(self, *, missing_ok: bool = True) -> list[dict[str, Any]]:
        with self._lock:
            return self._read_unlocked(missing_ok=missing_ok)

    def _read_unlocked(self, *, missing_ok: bool = True) -> list[dict[str, Any]]:
        if self.path is None:
            return []
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            if missing_ok:
                return []
            raise
        except (OSError, json.JSONDecodeError) as exc:
            raise LegacyChatHistoryFormatError(f"unable to read legacy chat history: {exc}") from exc
        if not isinstance(data, list):
            raise LegacyChatHistoryFormatError("legacy chat history must be a JSON list")
        return data

    def append(self, entry: dict[str, Any]) -> None:
        with self._lock:
            if self.path is None:
                raise RuntimeError("GA_ROOT is not configured")
            entries = self._read_unlocked()
            entries.append(entry)
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".json.tmp")
            try:
                tmp.write_text(
                    json.dumps(entries, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8",
                )
                os.replace(tmp, self.path)
            finally:
                try:
                    tmp.unlink(missing_ok=True)
                except OSError:
                    pass
