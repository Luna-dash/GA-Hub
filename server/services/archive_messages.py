"""Read-only projection of GA-native conversation archives."""
from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any


class HistoryUnavailableError(Exception):
    """A bound archive cannot be projected safely."""


def read_ui_messages(archive_path: str | Path) -> list[dict[str, Any]]:
    """Read GA's UI-level messages without creating a second message source."""
    path = Path(archive_path).resolve()
    if not path.is_file():
        raise HistoryUnavailableError
    from frontends.continue_cmd import extract_ui_messages

    try:
        return extract_ui_messages(path)
    except (OSError, ValueError, TypeError, UnicodeError) as exc:
        raise HistoryUnavailableError from exc


def read_archive_messages(archive_path: str | Path | None) -> dict[str, Any]:
    """Return UI messages from one bound GA archive, never persisting content."""
    if not archive_path:
        return {"archive_bound": False, "revision": None, "items": []}
    path = Path(archive_path).resolve()
    try:
        data = path.read_bytes()
        messages = read_ui_messages(path)
    except (OSError, HistoryUnavailableError) as exc:
        raise HistoryUnavailableError from exc
    items = [
        {
            "id": f"{index}:{hashlib.sha256(str(message).encode('utf-8')).hexdigest()[:16]}",
            "role": message.get("role", "assistant"),
            "content": message.get("content", ""),
            "ordinal": index,
        }
        for index, message in enumerate(messages)
    ]
    return {
        "archive_bound": True,
        "revision": hashlib.sha256(data).hexdigest(),
        "items": items,
    }
