"""Read-only projection of GA-native conversation archives.

Two layers share this module's GA-native boundary:

* The message projection index (per-file mmap group offsets, bounded paging).
* The archive *catalogue* — which GA sessions exist right now, their GA-order
  rows and their basename ids. Route code keeps HTTP shaping, title metadata,
  delete orchestration and exports; enumeration/signature/lookup mechanics
  live here so there is one catalogue implementation for list + point lookup.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from functools import lru_cache
import hashlib
import mmap
import os
from pathlib import Path
import re
import threading
from typing import Any

from .. import _paths  # Bootstrap GA's import path for the native archive parser.


_NATIVE_HEADER_RE = re.compile(
    r"^=== (Prompt|Response) ===(?:\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}))?.*$",
    re.MULTILINE,
)
_NATIVE_HEADER_BYTES_RE = re.compile(
    rb"^=== (Prompt|Response) ===(?:\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}))?[^\r\n]*(?:\r?\n|\r)",
    re.MULTILINE,
)
_TOOL_RESULT_BYTES_RE = re.compile(rb'"type"\s*:\s*"tool_result"')

# GA's chat frontends prepend this instruction to every IM prompt before handing
# it to the agent, so it is archived as the head of the user's own text.  The
# archive file is never rewritten: projection strips the header on the way out.
_FILE_HINT = "If you need to show files to user, use [FILE:filepath] in your response."


def _strip_file_hint(text: str) -> str:
    """Drop a leading IM [FILE:...] instruction header, else return text as-is.

    Only the head is touched, so a ``[FILE:...]`` marker the user typed inside
    their own question survives.  The header is followed by ``\\n\\n`` in the
    archive but is whitespace-collapsed to a single space in GA previews, hence
    the argument-less ``lstrip()``.
    """
    if text.startswith(_FILE_HINT):
        return text[len(_FILE_HINT):].lstrip()
    return text


class HistoryUnavailableError(Exception):
    """A bound archive cannot be projected safely."""


@dataclass(frozen=True)
class _ArchiveGroup:
    start: int
    end: int
    item_start: int
    item_count: int


@dataclass(frozen=True)
class _ArchiveIndex:
    path: Path
    revision: str
    groups: tuple[_ArchiveGroup, ...]
    total: int


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
        messages = extract_ui_messages(path)
    except (OSError, ValueError, TypeError, UnicodeError) as exc:
        raise HistoryUnavailableError from exc
    for message in messages:
        if message.get("role") == "user" and isinstance(message.get("content"), str):
            message["content"] = _strip_file_hint(message["content"])
    return messages


def _extract_ui_messages_from_text(content: str) -> list[dict[str, Any]]:
    """Run GA's UI folding helpers against an already-read archive slice."""
    from frontends.continue_cmd import (
        _format_response_segment,
        _pairs,
        _tool_results_from_prompt,
        _user_text,
    )

    pairs = _pairs(content)
    if not pairs:
        return []
    next_tool_results = [{} for _ in pairs]
    for index in range(len(pairs) - 1):
        next_tool_results[index] = _tool_results_from_prompt(pairs[index + 1][0])

    out: list[dict[str, Any]] = []
    assistant: dict[str, Any] | None = None
    round_turn = 0
    for index, (prompt, response) in enumerate(pairs):
        user = _strip_file_hint(_user_text(prompt))
        segment = _format_response_segment(response, next_tool_results[index])
        if user:
            if assistant is not None:
                out.append(assistant)
            out.append({"role": "user", "content": user})
            assistant = {
                "role": "assistant",
                "content": f"\n\n**LLM Running (Turn 1) ...**\n\n{segment}",
            }
            round_turn = 1
        else:
            if assistant is None:
                assistant = {"role": "assistant", "content": ""}
                round_turn = 1
            round_turn += 1
            marker = f"\n\n**LLM Running (Turn {round_turn}) ...**\n\n"
            assistant["content"] = (assistant["content"] or "") + marker + segment
    if assistant is not None:
        out.append(assistant)
    return [message for message in out if str(message.get("content") or "").strip()]


def _items_from_messages(
    messages: list[dict[str, Any]],
    timestamps: list[str | None],
    ordinal_start: int = 0,
) -> list[dict[str, Any]]:
    """Attach stable ids/ordinals/timestamps — the single item assembler.

    Both parse paths (GA-native full-file reads and hub-side slice folding)
    must produce identical item shapes; this is where that invariant lives.
    """
    return [
        {
            "id": f"{ordinal_start + index}:{hashlib.sha256(str(message).encode('utf-8')).hexdigest()[:16]}",
            "role": message.get("role", "assistant"),
            "content": message.get("content", ""),
            "ordinal": ordinal_start + index,
            "timestamp": timestamps[index] if index < len(timestamps) else None,
        }
        for index, message in enumerate(messages)
    ]


def _items_from_text(content: str, ordinal_start: int = 0) -> list[dict[str, Any]]:
    messages = _extract_ui_messages_from_text(content)
    timestamps = _message_timestamps(content)
    return _items_from_messages(messages, timestamps, ordinal_start)


def _prompt_is_user(data: mmap.mmap, start: int, end: int) -> bool:
    """Identify a real user prompt without decoding large tool-result blocks."""
    if _TOOL_RESULT_BYTES_RE.search(data, start, end):
        return False
    from frontends.continue_cmd import _user_text

    # Same head-strip as _extract_ui_messages_from_text: a group whose count
    # disagreed with the folded message list would silently drop indexed paging.
    return bool(_strip_file_hint(_user_text(data[start:end].decode("utf-8", errors="replace"))))


@lru_cache(maxsize=64)
def _build_archive_index(
    path_text: str,
    device: int,
    inode: int,
    mtime_ns: int,
    size: int,
) -> _ArchiveIndex:
    """Build a compact group-offset index; signature fields form the cache key."""
    del device, inode, mtime_ns, size
    path = Path(path_text)
    try:
        with path.open("rb") as handle:
            stat = os.fstat(handle.fileno())
            if stat.st_size == 0:
                return _ArchiveIndex(path, hashlib.sha256(b"").hexdigest(), (), 0)
            with mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ) as data:
                revision = hashlib.sha256(data).hexdigest()
                headers = list(_NATIVE_HEADER_BYTES_RE.finditer(data))
                pairs: list[tuple[int, int, int, bool]] = []
                pending: tuple[int, int] | None = None
                for index, header in enumerate(headers):
                    body_end = headers[index + 1].start() if index + 1 < len(headers) else len(data)
                    label = header.group(1)
                    if label == b"Prompt":
                        pending = (header.start(), header.end())
                    elif pending is not None:
                        prompt_start, prompt_body_start = pending
                        pairs.append((
                            prompt_start,
                            body_end,
                            prompt_body_start,
                            _prompt_is_user(data, prompt_body_start, header.start()),
                        ))
                        pending = None

                raw_groups: list[tuple[int, int, int]] = []
                current_start: int | None = None
                current_count = 0
                current_end = 0
                for pair_start, pair_end, _prompt_body_start, is_user in pairs:
                    if is_user and current_start is not None:
                        raw_groups.append((current_start, pair_start, current_count))
                        current_start = None
                    if current_start is None:
                        current_start = pair_start
                        current_count = 2 if is_user else 1
                    current_end = pair_end
                if current_start is not None:
                    raw_groups.append((current_start, current_end, current_count))

                groups: list[_ArchiveGroup] = []
                item_start = 0
                for start, end, item_count in raw_groups:
                    groups.append(_ArchiveGroup(start, end, item_start, item_count))
                    item_start += item_count
                return _ArchiveIndex(path, revision, tuple(groups), item_start)
    except (OSError, ValueError) as exc:
        raise HistoryUnavailableError from exc


def _archive_index(path: Path) -> _ArchiveIndex:
    try:
        stat = path.stat()
    except OSError as exc:
        raise HistoryUnavailableError from exc
    return _build_archive_index(
        str(path),
        int(getattr(stat, "st_dev", 0)),
        int(getattr(stat, "st_ino", 0)),
        int(getattr(stat, "st_mtime_ns", int(stat.st_mtime * 1_000_000_000))),
        int(stat.st_size),
    )


def _read_indexed_window(
    index: _ArchiveIndex,
    *,
    before: int | None,
    limit: int,
    max_chars: int | None,
) -> tuple[list[dict[str, Any]], bool, int | None] | None:
    end = index.total if before is None else max(0, min(before, index.total))
    if end == 0:
        return [], False, None

    # One extra ordinal is enough for _window_items' assistant/user pairing fix.
    candidate_start = max(0, end - limit - 1)
    groups = [
        group
        for group in index.groups
        if group.item_start < end and group.item_start + group.item_count > candidate_start
    ]
    if not groups:
        return None
    try:
        with index.path.open("rb") as handle:
            handle.seek(groups[0].start)
            raw = handle.read(groups[-1].end - groups[0].start)
    except OSError as exc:
        raise HistoryUnavailableError from exc

    items = _items_from_text(raw.decode("utf-8", errors="replace"), groups[0].item_start)
    expected_count = groups[-1].item_start + groups[-1].item_count - groups[0].item_start
    if len(items) != expected_count:
        return None
    candidates = [
        item for item in items if candidate_start <= int(item["ordinal"]) < end
    ]
    window, _local_has_more, _local_before = _window_items(
        candidates,
        before=None,
        limit=limit,
        max_chars=max_chars,
    )
    has_more = bool(window and int(window[0]["ordinal"]) > 0)
    return window, has_more, int(window[0]["ordinal"]) if has_more else None


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
    if limit is not None:
        index = _archive_index(path)
        indexed = _read_indexed_window(
            index,
            before=before,
            limit=limit,
            max_chars=max_chars,
        )
        if indexed is not None:
            window, has_more, next_before = indexed
            return {
                "archive_bound": True,
                "revision": index.revision,
                "items": window,
                "total": index.total,
                "has_more": has_more,
                "next_before": next_before,
            }

    try:
        data = path.read_bytes()
        messages = read_ui_messages(path)
    except (OSError, HistoryUnavailableError) as exc:
        raise HistoryUnavailableError from exc
    timestamps = _message_timestamps(data.decode("utf-8", errors="replace"))
    items = _items_from_messages(messages, timestamps)
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


# ── GA archive catalogue ──────────────────────────────────────────
# Which GA-native sessions exist right now. list_sessions() (without a
# rewind_root) enumerates exactly temp/model_responses/model_responses_*.txt,
# so the directory signature below fully covers its scan universe: if no
# archive path changed mtime/size/name, the GA enumeration result cannot have
# changed either.

_CATALOGUE_LOCK = threading.Lock()
_CATALOGUE_STATE: tuple | None = None
_CATALOGUE_INDEX: dict[str, tuple] = {}


def _ga_sessions() -> list[tuple]:
    """Return GA's session list, mirroring server/routes/agent.py.

    list_sessions() -> [(path, mtime, preview, n_rounds)] sorted by mtime desc.
    Importing inside the function keeps the (optional) GA path injection local.
    """
    from frontends.continue_cmd import list_sessions

    return list_sessions()


def _catalogue_signature() -> tuple:
    root = _paths.GA_ROOT
    if root is None:
        return ()
    archive_dir = Path(root) / "temp" / "model_responses"
    entries = []
    try:
        paths = archive_dir.glob("model_responses_*.txt")
        for path in paths:
            try:
                stat = path.stat()
                entries.append((path.name, stat.st_mtime_ns, stat.st_size))
            except OSError:
                continue
    except OSError:
        return ()
    return tuple(sorted(entries))


def invalidate_archive_catalogue() -> None:
    """Drop the cached GA session catalogue (after archive deletion)."""
    global _CATALOGUE_STATE, _CATALOGUE_INDEX
    with _CATALOGUE_LOCK:
        _CATALOGUE_STATE = None
        _CATALOGUE_INDEX = {}


def refresh_archive_catalogue() -> dict[str, tuple]:
    """Return the basename→GA-row map, re-scanning GA only when files changed."""
    global _CATALOGUE_STATE, _CATALOGUE_INDEX
    signature = _catalogue_signature()
    with _CATALOGUE_LOCK:
        if signature != _CATALOGUE_STATE:
            index: dict[str, tuple] = {}
            for row in _ga_sessions():
                index.setdefault(os.path.basename(row[0]), row)
            _CATALOGUE_INDEX = index
            _CATALOGUE_STATE = signature
        return _CATALOGUE_INDEX


def archive_session_by_id(cid: str) -> tuple | None:
    """Find a GA session tuple by its basename id (newest row wins)."""
    return refresh_archive_catalogue().get(cid)


def list_archive_sessions() -> list[tuple]:
    """GA-order session rows (mtime desc) — the one enumeration for listings.

    GA's preview carries the IM [FILE:...] header, so it is stripped here where
    both the listing and its title/content search consume these rows.
    """
    return [
        (path, mtime, _strip_file_hint(preview), *rest)
        for path, mtime, preview, *rest in _ga_sessions()
    ]


def _stat_signature(path_text: str) -> tuple[int, int] | None:
    try:
        stat = os.stat(path_text)
    except OSError:
        return None
    return (
        int(getattr(stat, "st_mtime_ns", int(stat.st_mtime * 1_000_000_000))),
        int(stat.st_size),
    )


# Listing only needs the first real user question.  Reading a bounded head is
# enough for native GA archives (the prompt header and JSON normally occur in
# the first few KB), while keeping a pathological multi-GB archive from
# turning one list request into a full-history parse.  Content search reads
# bounded chunks so "search all archives" cannot read whole multi-GB files.
FIRST_USER_PREVIEW_READ_BYTES = 64 * 1024
SEARCH_READ_CHUNK_BYTES = 256 * 1024
_PROMPT_BLOCK_RE = re.compile(
    r"^=== Prompt ===[^\r\n]*\r?\n(.*?)(?=^=== (?:Prompt|Response) ===|\Z)",
    re.DOTALL | re.MULTILINE,
)


@lru_cache(maxsize=1024)
def _first_user_preview_head(path: str, mtime_ns: int, size: int) -> str:
    """Extract the first user question from a bounded archive head.

    ``mtime_ns`` and ``size`` are part of the cache key; callers never need a
    global invalidation when a session is appended or replaced.  Parsing uses
    GA's own ``_user_text`` filtering so tool-result continuations and working
    memory injections retain the existing title semantics.
    """
    del mtime_ns, size  # identity-only cache inputs
    try:
        with open(path, "rb") as fh:
            head = fh.read(FIRST_USER_PREVIEW_READ_BYTES)
        from frontends.continue_cmd import _user_text
    except (OSError, ImportError):
        return ""
    text = head.decode("utf-8", errors="replace")
    for body in _PROMPT_BLOCK_RE.findall(text):
        content = _strip_file_hint(_user_text(body))
        if content:
            return " ".join(content.split())[:200]
    return ""


def first_user_preview(archive_path: str | Path) -> str:
    """Return the original user question used as the default display title."""
    path = os.path.abspath(str(archive_path))
    signature = _stat_signature(path)
    if signature is None:
        return ""
    return _first_user_preview_head(path, signature[0], signature[1])


@lru_cache(maxsize=2048)
def _archive_contains_query(
    path: str,
    mtime_ns: int,
    size: int,
    query: str,
) -> bool:
    """Search an archive in bounded chunks, caching by file revision."""
    del mtime_ns, size
    needle = query.encode("utf-8", errors="ignore").lower()
    if not needle:
        return True
    overlap = max(0, len(needle) - 1)
    carry = b""
    try:
        with open(path, "rb") as handle:
            while True:
                chunk = handle.read(SEARCH_READ_CHUNK_BYTES)
                if not chunk:
                    return False
                haystack = carry + chunk.lower()
                if needle in haystack:
                    return True
                carry = haystack[-overlap:] if overlap else b""
    except OSError:
        return False


def restore_ga_archive(agent, path: str):
    """Run GA's blocking archive restore — the single GA-frontend seam.

    Both restore routes (agent sessions/{idx} and conversations/{cid}) go
    through here so "which GA helper mutates the working history" has one
    home next to the archive read/enumerate helpers.
    """
    from frontends.continue_cmd import restore

    return restore(agent, path)


def archive_contains(archive_path: str | Path, query: str) -> bool:
    """Bounded chunked raw-text search with a per-revision cache."""
    path = os.path.abspath(str(archive_path))
    signature = _stat_signature(path)
    if signature is None:
        return False
    return _archive_contains_query(path, signature[0], signature[1], query)
