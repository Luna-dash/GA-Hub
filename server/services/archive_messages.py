"""Read-only projection of GA-native conversation archives."""
from __future__ import annotations

from datetime import datetime
import hashlib
from pathlib import Path
import re
from typing import Any


_NATIVE_HEADER_RE = re.compile(
    r"^=== (Prompt|Response) ===(?:\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}))?.*$",
    re.MULTILINE,
)


class HistoryUnavailableError(Exception):
    """A bound archive cannot be projected safely."""


def _parse_header_time(raw: str | None) -> str | None:
    if not raw:
        return None
    try:
        return datetime.strptime(raw, "%Y-%m-%d %H:%M:%S").isoformat()
    except ValueError:
        return None


def _message_timestamps(content: str) -> list[str | None]:
    """Match GA's visible-round folding and return one time per UI bubble."""
    from frontends.continue_cmd import _pairs, _user_text

    completed_headers: list[tuple[str | None, str | None]] = []
    pending_prompt: str | None = None
    for match in _NATIVE_HEADER_RE.finditer(content):
        label, raw_time = match.groups()
        if label == "Prompt":
            pending_prompt = raw_time
        elif pending_prompt is not None:
            completed_headers.append((pending_prompt, raw_time))
            pending_prompt = None

    result: list[str | None] = []
    assistant_time: str | None = None
    assistant_open = False
    for index, (prompt, _response) in enumerate(_pairs(content)):
        prompt_time, response_time = (
            completed_headers[index] if index < len(completed_headers) else (None, None)
        )
        if _user_text(prompt):
            if assistant_open:
                result.append(_parse_header_time(assistant_time))
            result.append(_parse_header_time(prompt_time))
            assistant_time = response_time
            assistant_open = True
        elif not assistant_open:
            assistant_time = response_time
            assistant_open = True
    if assistant_open:
        result.append(_parse_header_time(assistant_time))
    return result


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
    timestamps = _message_timestamps(data.decode("utf-8", errors="replace"))
    items = [
        {
            "id": f"{index}:{hashlib.sha256(str(message).encode('utf-8')).hexdigest()[:16]}",
            "role": message.get("role", "assistant"),
            "content": message.get("content", ""),
            "ordinal": index,
            "timestamp": timestamps[index] if index < len(timestamps) else None,
        }
        for index, message in enumerate(messages)
    ]
    return {
        "archive_bound": True,
        "revision": hashlib.sha256(data).hexdigest(),
        "items": items,
    }
