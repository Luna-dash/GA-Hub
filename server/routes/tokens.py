"""Live LLM token usage and lightweight history."""
from __future__ import annotations

import json
import logging
import threading
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Query

from .. import _paths

router = APIRouter(prefix="/api/tokens", tags=["tokens"])
log = logging.getLogger(__name__)
_HISTORY_FILE = _paths.ADMIN_DATA / "token_history.json"
_HISTORY_LOCK = threading.Lock()
_SAMPLE_INTERVAL = 60
_MAX_AGE = 30 * 24 * 3600

try:
    import cost_tracker
    cost_tracker.install()
except Exception:  # GA versions without cost_tracker remain usable
    cost_tracker = None
    log.exception("token tracker unavailable")


def _stats() -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    if cost_tracker is not None:
        for name, stat in cost_tracker.all_trackers().items():
            input_side = int(stat.input + stat.cache_create + stat.cache_read)
            rows.append({
                "thread": name,
                "requests": int(stat.requests),
                "input": int(stat.input),
                "output": int(stat.output),
                "cache_create": int(stat.cache_create),
                "cache_read": int(stat.cache_read),
                "total": int(input_side + stat.output),
                "cache_hit_rate": round(stat.cache_read / input_side * 100, 1) if input_side else 0.0,
                "elapsed_seconds": round(stat.elapsed_seconds(), 1),
            })
    rows.sort(key=lambda row: row["total"], reverse=True)
    totals = {key: sum(int(row[key]) for row in rows) for key in
              ("requests", "input", "output", "cache_create", "cache_read", "total")}
    input_side = totals["input"] + totals["cache_create"] + totals["cache_read"]
    totals["cache_hit_rate"] = round(totals["cache_read"] / input_side * 100, 1) if input_side else 0.0
    return {"available": cost_tracker is not None, "threads": rows, "totals": totals, "timestamp": int(time.time())}


def _read_history() -> list[dict[str, Any]]:
    try:
        data = json.loads(_HISTORY_FILE.read_text("utf-8"))
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def _sample(snap: dict[str, Any]) -> list[dict[str, Any]]:
    with _HISTORY_LOCK:
        history = _read_history()
        now = int(snap["timestamp"])
        history = [item for item in history if isinstance(item, dict) and int(item.get("timestamp", 0)) >= now - _MAX_AGE]
        if not history or now - int(history[-1].get("timestamp", 0)) >= _SAMPLE_INTERVAL:
            history.append({"timestamp": now, **snap["totals"]})
            try:
                _paths.ADMIN_DATA.mkdir(parents=True, exist_ok=True)
                tmp = _HISTORY_FILE.with_suffix(".json.tmp")
                tmp.write_text(json.dumps(history, ensure_ascii=False), "utf-8")
                tmp.replace(_HISTORY_FILE)
            except OSError:
                log.exception("could not persist token history")
        return history


@router.get("/stats")
def token_stats():
    snap = _stats()
    _sample(snap)
    return snap


@router.get("/history")
def token_history(hours: int = Query(24, ge=1, le=720)):
    snap = _stats()
    history = _sample(snap)
    cutoff = int(time.time()) - hours * 3600
    return {"hours": hours, "history": [item for item in history if int(item.get("timestamp", 0)) >= cutoff]}
