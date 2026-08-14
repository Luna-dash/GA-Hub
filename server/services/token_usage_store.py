"""Atomic persistence for durable token usage ledgers and history."""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from .. import _paths

log = logging.getLogger(__name__)


class TokenUsageStore:
    """Own all reads and writes for token usage/history sidecar files."""

    def __init__(
        self,
        *,
        usage_path: Path | None = None,
        history_path: Path | None = None,
    ) -> None:
        self.usage_path = usage_path or _paths.ADMIN_DATA / "token_usage.json"
        self.history_path = history_path or _paths.ADMIN_DATA / "token_history.json"

    def read_usage(self) -> dict[str, Any] | None:
        try:
            data = json.loads(self.usage_path.read_text("utf-8"))
            return data if isinstance(data, dict) else None
        except (OSError, ValueError):
            return None

    def write_usage(self, data: dict[str, Any]) -> None:
        self._atomic_replace(self.usage_path, json.dumps(data, ensure_ascii=False))

    def read_history(self) -> list[dict[str, Any]]:
        try:
            data = json.loads(self.history_path.read_text("utf-8"))
            return data if isinstance(data, list) else []
        except (OSError, ValueError):
            return []

    def write_history(self, history: list[dict[str, Any]]) -> None:
        self._atomic_replace(
            self.history_path, json.dumps(history, ensure_ascii=False)
        )

    @staticmethod
    def _atomic_replace(path: Path, payload: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".json.tmp")
        try:
            tmp.write_text(payload, "utf-8")
            tmp.replace(path)
        finally:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
