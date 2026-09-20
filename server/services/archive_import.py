"""Copy one GA archive into a fresh native log — the "import as session" seam.

Import is the only hub operation that *mints* archive bytes, so this module owns
the whole byte-level contract of that copy:

* the copy lands on a new GA ``logid`` path (GA's own formula), so naming,
  locking and the archive catalogue keep treating it as a normal session;
* the IM ``FILE_HINT`` header GA's chat frontends prepend to every prompt is
  stripped from user prompts — assistant responses and tool results are real
  content and stay byte-identical;
* an unterminated trailing Prompt/Response block is cut, because a copy that
  cannot be parsed would be judged "unreadable" by the runtime factory and
  silently rotated to an empty log, discarding the imported history.

The source archive is opened for reading only and never written: import is a
one-way copy, which is what makes importing an IM archive still being appended
to by its bot safe.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Callable

from frontends.gahub.bridge import archive as archive_bridge

# Reuse the projection layer's constants: the header is defined once, next to
# the read-side strip that keeps it out of UI responses.
from .archive_messages import _FILE_HINT, _strip_file_hint
from .archive_messages import read_ui_messages

_WORKING_MEMORY_MARKER = "### [WORKING MEMORY]"

# Body-carrying native header line; the trailing group keeps any timestamp /
# model suffix on the line and never spans into the JSON body below it.
_HEADER_RE = re.compile(r"^=== (Prompt|Response) ===[^\n]*\n", re.MULTILINE)

# A freshly minted logid can, in principle, name a file somebody else created
# in the same clock tick; re-mint a few times before giving up rather than
# overwrite an existing session's archive.
_LOG_PATH_ATTEMPTS = 8


class ArchiveNotImportableError(Exception):
    """The source archive has no complete turn to import."""


def _iter_blocks(text: str) -> list[tuple[str, int, int, int]]:
    """``(label, header_start, body_start, body_end)`` for every native header.

    A block runs to the next header, so a dangling trailing block is simply the
    last one; text before the first header (if any) is never a block.
    """
    headers = list(_HEADER_RE.finditer(text))
    blocks = []
    for index, header in enumerate(headers):
        end = headers[index + 1].start() if index + 1 < len(headers) else len(text)
        blocks.append((header.group(1), header.start(), header.end(), end))
    return blocks


def _completed_pair_indexes(blocks: list[tuple[str, int, int, int]]) -> list[int]:
    """Indexes of the Responses closing a pair, using GA's own pairing rules.

    GA's ``_pairs`` pairs the *most recent* Prompt with each Response, so an
    orphan Prompt before a Response is not an error there and must not be
    treated as a truncated tail here.
    """
    pairs: list[int] = []
    pending = False
    for index, (label, *_positions) in enumerate(blocks):
        if label == "Prompt":
            pending = True
        elif pending:
            pending = False
            pairs.append(index)
    return pairs


def trim_incomplete_tail(text: str) -> str:
    """Cut everything after the last complete Prompt→Response pair.

    GA appends a Prompt when a turn starts and its matching Response only once
    the LLM call returned, so a session that died mid-turn ends with a dangling
    block. Import must not carry that over: the copy has to parse.

    Text without native headers is returned untouched — those archives are
    parsed by GA's summary fallback, not by pair structure.
    """
    blocks = _iter_blocks(text)
    pairs = _completed_pair_indexes(blocks)
    if not blocks or (pairs and pairs[-1] == len(blocks) - 1):
        return text
    kept_end = blocks[pairs[-1]][3] if pairs else blocks[0][1]
    return text[:kept_end]


def _strip_leading_hints(text: str) -> str:
    """Drop the IM header and any immediate repeat of it (idempotent)."""
    while True:
        stripped = _strip_file_hint(text)
        if stripped == text:
            return text
        text = stripped


def _remove_hints(text: str) -> str:
    """Remove every FILE_HINT literal plus the whitespace trailing it.

    Working-memory blocks echo earlier prompts verbatim as ``[USER]: <hint>
    <原话>`` (GA joins the archived lines with spaces), so an occasional
    mid-block hint is expected there — unlike a user prompt, where only the
    head can be a frontend header.
    """
    out = text
    while True:
        index = out.find(_FILE_HINT)
        if index < 0:
            return out
        end = index + len(_FILE_HINT)
        while end < len(out) and out[end].isspace():
            end += 1
        out = out[:index] + out[end:]


def _clean_user_text(text: str) -> str:
    """Apply the FILE_HINT rules to one text block of a user prompt."""
    if text.startswith(_FILE_HINT):
        return _strip_leading_hints(text)
    # Working memory is detected by containment, the way GA's own
    # ``_INJECT_MARKERS`` does: the anchor prompt usually starts with the
    # marker, but a ``[SYSTEM TIPS]`` line can precede it (real archives do
    # both), and either way the block is an injected, not a typed, message.
    if _WORKING_MEMORY_MARKER in text:
        return _remove_hints(text)
    return text


def _clean_prompt_body(body: str) -> str:
    """Strip hints from one Prompt body; anything not a user message is kept.

    Only text blocks are candidates: tool_result content is genuine tool output
    that must survive verbatim. An unchanged body is returned as-is so archives
    without IM headers copy byte-for-byte.
    """
    try:
        message = json.loads(body)
    except ValueError:
        return body
    if not isinstance(message, dict) or message.get("role") != "user":
        return body
    blocks = message.get("content")
    if not isinstance(blocks, list):
        return body

    changed = False
    for block in blocks:
        if not isinstance(block, dict) or block.get("type") != "text":
            continue
        value = block.get("text")
        if not isinstance(value, str):
            continue
        cleaned = _clean_user_text(value)
        if cleaned != value:
            block["text"] = cleaned
            changed = True
    if not changed:
        return body
    # Share the body's surrounding whitespace, so the next header still starts
    # its own line after the re-serialised JSON.
    head = len(body) - len(body.lstrip())
    tail = len(body) - len(body.rstrip())
    return (
        body[:head]
        + json.dumps(message, ensure_ascii=False)
        + body[len(body) - tail:]
    )


def strip_file_hints(text: str) -> str:
    """Strip IM FILE_HINT echoes from user prompts; all other blocks untouched."""
    out = text
    # Back to front: rewriting a body leaves every earlier offset valid.
    for label, _start, body_start, body_end in reversed(_iter_blocks(text)):
        if label != "Prompt":
            continue
        body = out[body_start:body_end]
        cleaned = _clean_prompt_body(body)
        if cleaned != body:
            out = out[:body_start] + cleaned + out[body_end:]
    return out


def prepare_import_text(text: str) -> str:
    """Text for the imported copy: complete turns only, no IM hints."""
    blocks = _iter_blocks(text)
    if blocks and not _completed_pair_indexes(blocks):
        raise ArchiveNotImportableError(
            "archive has no complete Prompt/Response turn to import"
        )
    return strip_file_hints(trim_incomplete_tail(text))


def _mint_log_path(new_log_path: Callable[[], str]) -> Path:
    for _ in range(_LOG_PATH_ATTEMPTS):
        candidate = Path(new_log_path())
        if not candidate.exists():
            return candidate
    raise OSError("could not mint a free GA log path for the imported copy")


def copy_archive_for_import(
    source: str | Path,
    *,
    new_log_path: Callable[[], str] | None = None,
) -> tuple[Path, int]:
    """Write the sanitised copy of ``source`` to a fresh log; returns the path.

    The copy is staged under a non-enumerable name and renamed into place, so a
    half-written file can never be read as a session.  The returned count is
    the copy's visible message count, computed before the rename: nothing is
    left that can fail after the new archive becomes visible.
    """
    factory = new_log_path or archive_bridge.mint_native_log_path
    data = Path(source).read_bytes()
    text = prepare_import_text(data.decode("utf-8", errors="replace"))
    target = _mint_log_path(factory)
    # The GA glob only picks up model_responses_*.txt, so the staging file is
    # invisible to the catalogue while it is being written.
    staging = target.with_name(f"{target.name}.importing")
    try:
        # Bytes, not text: GA writes its archives in text mode, so on Windows
        # they carry CRLF — re-encoding through text mode would double every
        # "\r\n" into "\r\r\n".
        staging.write_bytes(text.encode("utf-8"))
        imported_lines = len(read_ui_messages(staging))
        os.replace(staging, target)
    except BaseException:
        try:
            staging.unlink(missing_ok=True)
        except OSError:
            pass
        raise
    return target, imported_lines
