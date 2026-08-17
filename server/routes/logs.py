"""Log tail routes."""
from __future__ import annotations

import os
import re

from fastapi import APIRouter, Query

from .. import _paths
from ..schemas import LogLinesResp
from ..services.file_tail import read_tail_lines

router = APIRouter()

_REDACTION_RULES = (
    (re.compile(r"(?i)\b(Bearer)\s+[^\s,;]+"), r"\1 [REDACTED]"),
    (
        re.compile(
            r"(?i)(\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret)\b\s*[=:]\s*)"
            r"([^\s,;&]+)"
        ),
        r"\1[REDACTED]",
    ),
)


def _redact(line: str) -> str:
    for pattern, replacement in _REDACTION_RULES:
        line = pattern.sub(replacement, line)
    return line


def _tail(path: str, n: int, *, redact: bool = False) -> list[str]:
    if not os.path.isfile(path):
        return []
    n = max(1, min(n, 5000))
    lines = read_tail_lines(path, n)
    return [_redact(line) for line in lines] if redact else lines


@router.get("/api/logs/backend")
def log_backend(tail: int = Query(default=200, ge=1, le=5000)) -> LogLinesResp:
    """Return a bounded, redacted tail of the admin backend log."""
    path = _paths.ADMIN_DATA / "logs" / "backend.log"
    return {"lines": _tail(str(path), tail, redact=True), "file": path.name}


@router.get("/api/logs/wechat")
def log_wechat(tail: int = Query(default=200, ge=1, le=5000)) -> LogLinesResp:
    return {"lines": _tail(str(_paths.temp_dir() / "wechatapp.log"), tail), "file": None}


@router.get("/api/logs/agent")
def log_agent(tail: int = Query(default=200, ge=1, le=5000)) -> LogLinesResp:
    """Returns tail of the most recent model_responses log for the current PID."""
    mr = str(_paths.temp_dir() / "model_responses")
    if not os.path.isdir(mr):
        return {"lines": [], "file": None}
    files = [
        os.path.join(mr, n) for n in os.listdir(mr)
        if n.startswith("model_responses_") and n.endswith(".txt")
    ]
    if not files:
        return {"lines": [], "file": None}
    files.sort(key=os.path.getmtime, reverse=True)
    return {"lines": _tail(files[0], tail), "file": os.path.basename(files[0])}
