"""GA's IM [FILE:...] instruction header must not leak into archive views.

``FILE_HINT`` is prepended by GA's chat frontends before the prompt reaches the
agent, so it is archived as the head of the user's own text. The hub strips that
header in the projection layer only — the archive file is never rewritten, and
nothing past the head is touched.
"""
from __future__ import annotations

import json
import mmap
from pathlib import Path
from unittest import mock

from server.services import archive_messages
from server.services.archive_messages import (
    _FILE_HINT,
    _NATIVE_HEADER_BYTES_RE,
    _build_archive_index,
    _extract_ui_messages_from_text,
    _prompt_is_user,
    _strip_file_hint,
    _window_items,
    first_user_preview,
    read_archive_messages,
)


def _hinted(text: str) -> str:
    """Archived prompt text exactly as the IM frontend leaves it."""
    return f"{_FILE_HINT}\n\n{text}"


def _round(index: int, text: str) -> str:
    payload = {"role": "user", "content": [{"type": "text", "text": text}]}
    return (
        f"=== Prompt === 2026-08-05 09:10:{index:02d}\n"
        f"{json.dumps(payload, ensure_ascii=False)}\n"
        f"=== Response === 2026-08-05 09:11:{index:02d}\n"
        f"[{{'type': 'text', 'text': 'answer {index}'}}]\n"
    )


def _prompt_is_user_flags(archive: Path) -> list[bool]:
    """Re-run the index's grouping probe over one archive, one flag per pair."""
    with archive.open("rb") as handle, mmap.mmap(
        handle.fileno(), 0, access=mmap.ACCESS_READ
    ) as data:
        headers = list(_NATIVE_HEADER_BYTES_RE.finditer(data))
        flags: list[bool] = []
        pending: int | None = None
        for index, header in enumerate(headers):
            if header.group(1) == b"Prompt":
                pending = header.end()
            elif pending is not None:
                flags.append(_prompt_is_user(data, pending, header.start()))
                pending = None
        return flags


def test_full_projection_strips_hint_from_user_messages(tmp_path: Path) -> None:
    archive = tmp_path / "archive.txt"
    archive.write_text(
        "".join(_round(index, _hinted(f"真实问题 {index}")) for index in range(3)),
        encoding="utf-8",
    )

    result = read_archive_messages(archive)

    assert [item["content"] for item in result["items"] if item["role"] == "user"] == [
        "真实问题 0",
        "真实问题 1",
        "真实问题 2",
    ]
    assert all(_FILE_HINT not in str(item["content"]) for item in result["items"])


def test_indexed_pages_match_full_projection_after_strip(tmp_path: Path) -> None:
    archive = tmp_path / "archive.txt"
    archive.write_text(
        "".join(_round(index, _hinted(f"真实问题 {index}")) for index in range(8)),
        encoding="utf-8",
    )
    full = read_archive_messages(archive)
    expected, expected_more, expected_before = _window_items(
        full["items"], before=12, limit=5, max_chars=10_000
    )
    _build_archive_index.cache_clear()

    with mock.patch.object(Path, "read_bytes", side_effect=AssertionError("full read")):
        page = read_archive_messages(archive, before=12, limit=5, max_chars=10_000)

    assert page["items"] == expected
    assert page["total"] == full["total"] == 16
    assert page["revision"] == full["revision"]
    assert (page["has_more"], page["next_before"]) == (expected_more, expected_before)
    assert [item["content"] for item in page["items"] if item["role"] == "user"] == [
        "真实问题 3",
        "真实问题 4",
        "真实问题 5",
    ]


def test_hint_only_prompt_is_not_a_user_turn(tmp_path: Path) -> None:
    """Header-only prompts fold as continuations, matching the index grouping.

    ``_prompt_is_user`` and ``_extract_ui_messages_from_text`` must read the
    same stripped head, or the index counts and the folded message list drift
    apart and ``_read_indexed_window`` loses its count agreement. GA's own
    whole-file reader folds before any strip, so an archive whose user sent an
    empty IM message is the one case where the two projection paths can differ;
    a real prompt (header plus text) is unaffected.
    """
    archive = tmp_path / "archive.txt"
    content = _round(0, _FILE_HINT) + _round(1, _hinted("真实问题"))
    archive.write_text(content, encoding="utf-8")

    assert _strip_file_hint(_FILE_HINT) == ""
    assert _prompt_is_user_flags(archive) == [False, True]
    assert [
        message["content"]
        for message in _extract_ui_messages_from_text(content)
        if message["role"] == "user"
    ] == ["真实问题"]


def test_first_user_preview_strips_hint(tmp_path: Path) -> None:
    archive = tmp_path / "archive.txt"
    archive.write_text(_round(0, _hinted("中文任务 🚀")), encoding="utf-8")
    archive_messages._first_user_preview_head.cache_clear()

    assert first_user_preview(archive) == "中文任务 🚀"


def test_list_archive_sessions_strips_preview(monkeypatch) -> None:
    rows = [("/sessions/a.txt", 9.0, f"{_FILE_HINT} 空格分隔的预览", 4)]
    monkeypatch.setattr(archive_messages, "_ga_sessions", lambda: list(rows))

    assert archive_messages.list_archive_sessions() == [
        ("/sessions/a.txt", 9.0, "空格分隔的预览", 4)
    ]


def test_plain_text_and_midbody_file_marker_are_untouched(tmp_path: Path) -> None:
    archive = tmp_path / "archive.txt"
    archive.write_text(
        _round(0, "普通问题没有前缀")
        + _round(1, "请展示 [FILE:report.md] 里的内容")
        + _round(2, _hinted("带前缀的问题")),
        encoding="utf-8",
    )

    result = read_archive_messages(archive)

    assert [item["content"] for item in result["items"] if item["role"] == "user"] == [
        "普通问题没有前缀",
        "请展示 [FILE:report.md] 里的内容",
        "带前缀的问题",
    ]
    assert _strip_file_hint("普通问题没有前缀") == "普通问题没有前缀"
    assert (
        _strip_file_hint("请展示 [FILE:report.md] 里的内容")
        == "请展示 [FILE:report.md] 里的内容"
    )
