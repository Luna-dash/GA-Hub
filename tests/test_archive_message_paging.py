"""Indexed archive paging regression tests."""
from __future__ import annotations

import json
from pathlib import Path
from unittest import mock

import pytest

from server import _paths
from server.services import archive_messages

pytestmark = pytest.mark.skipif(_paths.GA_ROOT is None, reason="requires configured GA_ROOT")
from server.services.archive_messages import (
    _build_archive_index,
    _project_indexed_groups,
    _window_items,
    read_archive_messages,
    read_archive_total,
)


def _round(index: int) -> str:
    return (
        f"=== Prompt === 2026-08-05 09:10:{index:02d}\n"
        f'{{"role":"user","content":[{{"type":"text","text":"question {index}"}}]}}\n'
        f"=== Response === 2026-08-05 09:11:{index:02d}\n"
        f"[{{'type': 'text', 'text': 'answer {index}'}}]\n"
    )


def test_desktop_pages_bound_source_reads_and_preserve_full_history(tmp_path: Path) -> None:
    archive = tmp_path / "desktop.txt"
    payload = "字" * 400_000
    archive.write_text("".join(
        _round(i).replace(f"answer {i}", payload if i == 1 else "x" * 20_000)
        for i in range(4)
    ), encoding="utf-8")
    full = read_archive_messages(archive)
    with mock.patch("server.services.archive_messages._items_from_text",
                    wraps=archive_messages._items_from_text) as project:
        newest = read_archive_messages(archive, desktop=True)
        assert [item["ordinal"] for item in newest["items"]] == [4, 5, 6, 7]
        assert project.call_count == 2  # The oversized older turn was not parsed.
        older = read_archive_messages(archive, desktop=True, before=newest["next_before"], turns=20)
        assert [item["ordinal"] for item in older["items"]] == [2, 3]
        assert len(older["items"][-1]["content"]) >= len(payload)
        oldest = read_archive_messages(archive, desktop=True, before=older["next_before"], turns=20)
        assert oldest["has_more"] is False
        assert oldest["next_before"] is None
    assert oldest["items"] + older["items"] + newest["items"] == full["items"]


def test_desktop_content_budget_never_splits_a_turn(tmp_path: Path) -> None:
    archive = tmp_path / "chars.txt"
    archive.write_text("".join(_round(i).replace(f"answer {i}", "x" * 7_000)
                               for i in range(3)), encoding="utf-8")
    page = read_archive_messages(archive, desktop=True, turns=20, max_chars=10_000)
    assert [item["ordinal"] for item in page["items"]] == [4, 5]
    assert page["next_before"] == 4


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


def test_total_matches_full_projection_without_rendering_responses(tmp_path: Path) -> None:
    archive = tmp_path / "archive.txt"
    archive.write_text(_round(0) + _round(1) + _round(2).split("=== Response ===")[0],
                       encoding="utf-8")
    expected = read_archive_messages(archive)["total"]
    assert expected == 4
    _build_archive_index.cache_clear()

    with mock.patch.object(Path, "read_bytes", side_effect=AssertionError("full read")), \
         mock.patch("server.services.archive_messages._items_from_text",
                    side_effect=AssertionError("rendered archive")):
        assert read_archive_total(archive) == expected
        assert read_archive_total(None) == 0


def test_cached_projection_is_isolated_and_invalidated(tmp_path: Path) -> None:
    archive = tmp_path / "archive.txt"
    archive.write_text(_round(0), encoding="utf-8")
    _project_indexed_groups.cache_clear()

    first = read_archive_messages(archive, limit=2)
    original = first["items"][0]["content"]
    first["items"][0]["content"] = "caller mutation"
    assert read_archive_messages(archive, limit=2)["items"][0]["content"] == original
    assert _project_indexed_groups.cache_info().hits == 1

    archive.write_text(_round(0) + _round(1), encoding="utf-8")
    assert read_archive_messages(archive, limit=2)["items"][0]["content"] == "question 1"
    assert _project_indexed_groups.cache_info().misses == 2


def _entry(role: str, text: str, stamp: str) -> str:
    if role == "user":
        return (
            f"=== Prompt === {stamp}\n"
            f'{{"role":"user","content":[{{"type":"text","text":"{text}"}}]}}\n'
        )
    return f"=== Response === {stamp}\n[{{'type': 'text', 'text': '{text}'}}]\n"


def _turns_archive(tmp_path: Path, turns: int, *, day: str = "2026-08-05", base: str = "09") -> Path:
    archive = tmp_path / "archive.txt"
    parts: list[str] = []
    for turn in range(turns):
        stamp = f"{day} {base}:{turn:02d}:00"
        parts.append(_entry("user", f"question {turn}", stamp))
        parts.append(_entry("assistant", f"answer {turn}", f"{day} {base}:{turn:02d}:30"))
    archive.write_text("".join(parts), encoding="utf-8")
    _build_archive_index.cache_clear()
    return archive


def test_turn_pages_count_real_user_turns_and_skip_injections(tmp_path: Path) -> None:
    archive = tmp_path / "archive.txt"
    parts: list[str] = []
    for turn in range(30):
        stamp = f"2026-08-05 09:{turn:02d}:00"
        parts.append(_entry("user", f"question {turn}", stamp))
        parts.append(_entry("assistant", f"answer {turn}", f"2026-08-05 09:{turn:02d}:30"))
        if turn % 10 == 9:
            # Retry / auto-continue injections read as user prompts in the raw
            # archive but must not be counted as human turns.
            parts.append(_entry("assistant", "[ERROR] Incomplete response.", f"2026-08-05 09:{turn:02d}:40"))
            parts.append(_entry("user", "继续上一条回复", f"2026-08-05 09:{turn:02d}:41"))
            parts.append(_entry("assistant", f"answer {turn} continued", f"2026-08-05 09:{turn:02d}:42"))
    archive.write_text("".join(parts), encoding="utf-8")
    _build_archive_index.cache_clear()

    full = read_archive_messages(archive)["items"]
    q25 = next(
        item for item in full
        if item.get("role") == "user" and item.get("content") == "question 25"
    )
    expected = [item for item in full if int(item["ordinal"]) >= int(q25["ordinal"])]

    page = read_archive_messages(archive, turns=5, max_chars=8_000_000)

    assert page["items"] == expected
    assert page["has_more"] is True
    assert page["next_before"] == int(q25["ordinal"])


def test_turn_pages_snap_to_day_boundary(tmp_path: Path) -> None:
    archive = tmp_path / "archive.txt"
    parts: list[str] = []
    for turn in range(5):  # 08-05 late evening, five turns
        stamp = f"2026-08-05 23:{40 + turn:02d}:00"
        parts.append(_entry("user", f"late {turn}", stamp))
        parts.append(_entry("assistant", f"late answer {turn}", f"2026-08-05 23:{40 + turn:02d}:30"))
    for turn in range(12):  # 08-06, twelve turns
        stamp = f"2026-08-06 00:{turn:02d}:00"
        parts.append(_entry("user", f"early {turn}", stamp))
        parts.append(_entry("assistant", f"early answer {turn}", f"2026-08-06 00:{turn:02d}:30"))
    archive.write_text("".join(parts), encoding="utf-8")
    _build_archive_index.cache_clear()

    # Exact 8-turn cut starts mid-day (early 4): snapping extends backwards to
    # the day edge by adding the four remaining 00:xx turns (≤ _TURN_SNAP_EXTEND).
    page = read_archive_messages(archive, turns=8, max_chars=8_000_000)
    assert page["items"][0].get("content") == "early 0"
    assert len([item for item in page["items"] if item.get("role") == "user"]) == 12
    assert page["has_more"] is True

    # A cut that already lands on the day edge is returned as-is.
    page2 = read_archive_messages(archive, turns=12, max_chars=8_000_000)
    assert page2["items"][0].get("content") == "early 0"
    assert len([item for item in page2["items"] if item.get("role") == "user"]) == 12


def test_turn_page_respects_char_budget_but_keeps_progress(tmp_path: Path) -> None:
    archive = tmp_path / "archive.txt"
    parts: list[str] = []
    for turn in range(4):
        stamp = f"2026-08-05 10:{turn:02d}:00"
        parts.append(_entry("user", f"question {turn}", stamp))
        parts.append(_entry("assistant", "x" * 600_000, f"2026-08-05 10:{turn:02d}:30"))
    archive.write_text("".join(parts), encoding="utf-8")
    _build_archive_index.cache_clear()

    # Four ~600K turns exceed the 1.5M soft budget: the page drops down to the
    # two newest turns instead of returning nothing.
    page = read_archive_messages(archive, turns=10, max_chars=1_500_000)
    user_turns = [item for item in page["items"] if item.get("role") == "user"]
    assert len(user_turns) == 2
    assert page["items"][0].get("content") == "question 2"
    assert page["has_more"] is True


def test_turns_take_precedence_over_limit(tmp_path: Path) -> None:
    archive = _turns_archive(tmp_path, 6, base="11")
    page = read_archive_messages(archive, before=None, limit=2, max_chars=8_000_000, turns=3)
    user_turns = [item for item in page["items"] if item.get("role") == "user"]
    assert [item.get("content") for item in user_turns] == [
        "question 3", "question 4", "question 5",
    ]
    assert page["has_more"] is True


def _prompt_entry(text: str, stamp: str) -> str:
    payload = json.dumps(
        {"role": "user", "content": [{"type": "text", "text": text}]},
        ensure_ascii=False,
    )
    return f"=== Prompt === {stamp}\n{payload}\n"


def test_injections_with_appended_context_stay_hidden(tmp_path: Path) -> None:
    """GA archives auto-retry injections together with runtime context in the
    same text block (a ``cwd = ...`` preamble or the ``---``-wrapped PROJECT
    MODE block).  The projection must still hide those injections, while a
    user quotation that continues with a real question is preserved.
    """
    archive = tmp_path / "archive.txt"
    retry = "[ERROR] Incomplete response. Regenerate and tooluse."
    legacy = (
        "上一条回复因可恢复的传输/网络错误（ConnectionError）中断。"
        "请自动重试并从中断处继续，不要重复已经完成的内容。"
    )
    quoted = f"{retry}\n这条注入是什么意思？"
    response = "=== Response === {0}\n[{{'type': 'text', 'text': 'answer'}}]\n"
    parts = [
        _prompt_entry("real question", "2026-08-05 09:00:00"),
        response.format("2026-08-05 09:00:30"),
        _prompt_entry(
            f"{retry}\ncwd = D:\\study\\GA\\temp (./)\n[Memory] (../memory)",
            "2026-08-05 09:01:00",
        ),
        response.format("2026-08-05 09:01:30"),
        _prompt_entry(
            f"{legacy}\n\n---\n[PROJECT MODE: x]\nbody\n---",
            "2026-08-05 09:02:00",
        ),
        response.format("2026-08-05 09:02:30"),
        _prompt_entry(quoted, "2026-08-05 09:03:00"),
        response.format("2026-08-05 09:03:30"),
    ]
    archive.write_text("".join(parts), encoding="utf-8")
    _build_archive_index.cache_clear()

    items = read_archive_messages(archive)["items"]

    users = [item["content"] for item in items if item["role"] == "user"]
    assert users == ["real question", quoted]
