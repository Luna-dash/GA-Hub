"""Log tail routes."""
from __future__ import annotations

import os
from collections import deque

from fastapi import APIRouter

from .. import _paths

router = APIRouter()


def _tail(path: str, n: int) -> list[str]:
    if not os.path.isfile(path):
        return []
    n = max(1, min(n, 5000))
    out: deque[str] = deque(maxlen=n)
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            out.append(line.rstrip("\n"))
    return list(out)


@router.get("/api/logs/wechat")
async def log_wechat(tail: int = 200):
    return {"lines": _tail(str(_paths.temp_dir() / "wechatapp.log"), tail)}


@router.get("/api/logs/agent")
async def log_agent(tail: int = 200):
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
