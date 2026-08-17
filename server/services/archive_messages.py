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


def _window_items(
    items: list[dict[str, Any]],
    *,
    before: int | None,
    limit: int | None,
    max_chars: int | None,
) -> tuple[list[dict[str, Any]], bool, int | None]:
    """Return a newest-first bounded slice while preserving display order.

    ``before`` is an exclusive message ordinal.  A missing ``limit`` keeps the
    legacy full-history behaviour for non-GA-Hub clients.  When bounded, the
    character budget prevents a handful of very large Markdown responses from
    rebuilding a multi-megabyte DOM on first paint.
    """
    end = len(items) if before is None else max(0, min(before, len(items)))
    if limit is None:
        return items[:end], False, None

    start = end
    selected_chars = 0
    while start > 0 and end - start < limit:
        item_chars = len(str(items[start - 1].get("content", "")))
        if max_chars is not None and start < end and selected_chars + item_chars > max_chars:
            break
        start -= 1
        selected_chars += item_chars

    # Avoid opening a page with an orphaned assistant answer when the paired
    # user prompt is immediately before it.  This may exceed the soft budget by
    # one message, which is preferable to losing the turn boundary.
    if start > 0 and items[start].get("role") == "assistant" and items[start - 1].get("role") == "user":
        start -= 1

    has_more = start > 0
    return items[start:end], has_more, start if has_more else None


def read_archive_messages(
    archive_path: str | Path | None,
    *,
    before: int | None = None,
    limit: int | None = None,
    max_chars: int | None = None,
) -> dict[str, Any]:
    """Return UI messages from one bound GA archive, never persisting content."""
    if not archive_path:
        return {
            "archive_bound": False,
            "revision": None,
            "items": [],
            "total": 0,
            "has_more": False,
            "next_before": None,
        }
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
    window, has_more, next_before = _window_items(
        items,
        before=before,
        limit=limit,
        max_chars=max_chars,
    )
    return {
        "archive_bound": True,
        "revision": hashlib.sha256(data).hexdigest(),
        "items": window,
        "total": len(items),
        "has_more": has_more,
        "next_before": next_before,
    }
