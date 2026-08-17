"""Indexed archive paging regression tests."""
from __future__ import annotations

from pathlib import Path
from unittest import mock

from server.services.archive_messages import (
    _build_archive_index,
    _window_items,
    read_archive_messages,
)


def _round(index: int) -> str:
    return (
        f"=== Prompt === 2026-08-05 09:10:{index:02d}\n"
        f'{{"role":"user","content":[{{"type":"text","text":"question {index}"}}]}}\n'
        f"=== Response === 2026-08-05 09:11:{index:02d}\n"
        f"[{{'type': 'text', 'text': 'answer {index}'}}]\n"
    )


def test_indexed_pages_match_full_projection_without_read_bytes(tmp_path: Path) -> None:
    archive = tmp_path / "archive.txt"
    archive.write_text("".join(_round(index) for index in range(8)), encoding="utf-8")
    full = read_archive_messages(archive)
    expected, expected_more, expected_before = _window_items(
        full["items"], before=12, limit=5, max_chars=10_000
    )
    _build_archive_index.cache_clear()

    with mock.patch.object(Path, "read_bytes", side_effect=AssertionError("full read")):
        page = read_archive_messages(
            archive,
            before=12,
            limit=5,
            max_chars=10_000,
        )

    assert page["items"] == expected
    assert page["total"] == full["total"]
    assert page["revision"] == full["revision"]
    assert (page["has_more"], page["next_before"]) == (
        expected_more,
        expected_before,
    )


def test_archive_index_invalidates_after_append(tmp_path: Path) -> None:
    archive = tmp_path / "archive.txt"
    archive.write_text(_round(0), encoding="utf-8")
    _build_archive_index.cache_clear()

    first = read_archive_messages(archive, limit=2, max_chars=10_000)
    with archive.open("a", encoding="utf-8") as handle:
        handle.write(_round(1))
    second = read_archive_messages(archive, limit=2, max_chars=10_000)

    assert first["total"] == 2
    assert second["total"] == 4
    assert second["revision"] != first["revision"]
    assert [item["ordinal"] for item in second["items"]] == [2, 3]
    assert [item["content"] for item in second["items"] if item["role"] == "user"] == [
        "question 1"
    ]


def test_index_cache_is_reused_for_unchanged_archive(tmp_path: Path) -> None:
    archive = tmp_path / "archive.txt"
    archive.write_text("".join(_round(index) for index in range(3)), encoding="utf-8")
    _build_archive_index.cache_clear()

    read_archive_messages(archive, limit=2, max_chars=10_000)
    before = _build_archive_index.cache_info()
    read_archive_messages(archive, before=4, limit=2, max_chars=10_000)
    after = _build_archive_index.cache_info()

    assert after.hits == before.hits + 1
    assert after.misses == before.misses
