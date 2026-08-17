"""Bounded append-only file reader tests."""
from __future__ import annotations

import json
import tracemalloc
from pathlib import Path

from server.services.file_tail import read_jsonl_tail, read_tail_lines


def test_tail_lines_handles_crlf_unicode_and_partial_final_line(tmp_path: Path) -> None:
    path = tmp_path / "app.log"
    path.write_bytes("first\r\n中文 second\r\npartial".encode("utf-8"))

    assert read_tail_lines(path, 2) == ["中文 second", "partial"]


def test_jsonl_tail_preserves_raw_line_limit_and_newest_order(tmp_path: Path) -> None:
    path = tmp_path / "runs.jsonl"
    path.write_text(
        "\n".join([
            json.dumps({"id": 1}),
            "not-json",
            json.dumps({"id": 2}),
            json.dumps(["not", "an", "object"]),
            json.dumps({"id": 3}),
        ]) + "\n",
        encoding="utf-8",
    )

    assert read_jsonl_tail(path, 4) == [{"id": 3}, {"id": 2}]


def test_large_tail_has_bounded_python_memory(tmp_path: Path) -> None:
    path = tmp_path / "large.log"
    line = b"x" * 1023 + b"\n"
    with path.open("wb") as handle:
        for _ in range(20_000):
            handle.write(line)

    tracemalloc.start()
    lines = read_tail_lines(path, 20)
    _current, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()

    assert len(lines) == 20
    assert peak < 2 * 1024 * 1024
