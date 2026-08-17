"""Bounded readers for append-only text and JSONL files."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


def read_tail_lines(path: str | Path, limit: int, *, max_limit: int = 5000) -> list[str]:
    """Return final text lines without scanning bytes before the requested tail."""
    limit = max(1, min(int(limit), max_limit))
    try:
        with Path(path).open("rb") as handle:
            end = int(handle.seek(0, os.SEEK_END))
            if end <= 0:
                return []
            position = end
            data = b""
            block_size = 64 * 1024
            while position > 0 and data.count(b"\n") <= limit:
                start = max(0, position - block_size)
                handle.seek(start)
                data = handle.read(position - start) + data
                position = start
    except (FileNotFoundError, IsADirectoryError):
        return []

    text = data.decode("utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
    return text.splitlines()[-limit:]


def read_jsonl_tail(path: str | Path, limit: int, *, max_limit: int = 5000) -> list[dict[str, Any]]:
    """Parse the final raw JSONL lines and return valid records newest first."""
    out: list[dict[str, Any]] = []
    for line in reversed(read_tail_lines(path, limit, max_limit=max_limit)):
        try:
            value = json.loads(line)
        except (json.JSONDecodeError, TypeError):
            continue
        if isinstance(value, dict):
            out.append(value)
    return out
