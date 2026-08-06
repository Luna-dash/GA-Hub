"""Live LLM token usage and lightweight history."""
from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Query

from .. import _paths

router = APIRouter(prefix="/api/tokens", tags=["tokens"])
log = logging.getLogger(__name__)
_HISTORY_FILE = _paths.ADMIN_DATA / "token_history.json"
_USAGE_FILE = _paths.ADMIN_DATA / "token_usage.json"
_HISTORY_LOCK = threading.Lock()
_SESSION_ID = uuid.uuid4().hex
_TOTAL_KEYS = ("requests", "input", "output", "cache_create", "cache_read", "total")
_SAMPLE_INTERVAL = 60
_PERSIST_INTERVAL = 15
_PERSIST_STOP = threading.Event()
_PERSIST_THREAD: threading.Thread | None = None
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


def _normalise_totals(value: Any) -> dict[str, int]:
    source = value if isinstance(value, dict) else {}
    return {key: max(0, int(source.get(key, 0) or 0)) for key in _TOTAL_KEYS}


def _with_rate(value: dict[str, Any]) -> dict[str, Any]:
    result = dict(value)
    input_side = int(result.get("input", 0)) + int(result.get("cache_create", 0)) + int(result.get("cache_read", 0))
    result["cache_hit_rate"] = round(int(result.get("cache_read", 0)) / input_side * 100, 1) if input_side else 0.0
    return result


def _week_dates(timestamp: int) -> tuple[str, str]:
    day = datetime.fromtimestamp(timestamp).date()
    start = day - timedelta(days=day.weekday())
    return start.isoformat(), (start + timedelta(days=6)).isoformat()


def _read_usage() -> dict[str, Any]:
    try:
        data = json.loads(_USAGE_FILE.read_text("utf-8"))
        if isinstance(data, dict):
            return data
    except (OSError, ValueError):
        pass
    return {"version": 2, "weeks": {}, "all_time": {}, "session": {}}


def _write_usage(data: dict[str, Any]) -> None:
    _USAGE_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = _USAGE_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), "utf-8")
    tmp.replace(_USAGE_FILE)


def _weekly_response(data: dict[str, Any], timestamp: int) -> dict[str, Any]:
    rows = []
    weeks = data.get("weeks") if isinstance(data.get("weeks"), dict) else {}
    for week_start in sorted(weeks):
        start_date = datetime.strptime(week_start, "%Y-%m-%d").date()
        rows.append({
            "week_start": week_start,
            "week_end": (start_date + timedelta(days=6)).isoformat(),
            **_with_rate(_normalise_totals(weeks[week_start])),
        })
    current_start, current_end = _week_dates(timestamp)
    current = next((row for row in rows if row["week_start"] == current_start), None)
    if current is None:
        current = {"week_start": current_start, "week_end": current_end, **_with_rate(_normalise_totals({}))}
    all_time_source = data.get("all_time")
    if not isinstance(all_time_source, dict):
        migrated = _normalise_totals({})
        for week in weeks.values():
            totals = _normalise_totals(week)
            migrated = {key: migrated[key] + totals[key] for key in _TOTAL_KEYS}
        all_time_source = migrated
    return {"all_time": _with_rate(_normalise_totals(all_time_source)), "current_week": current, "weeks": rows}


def _persist_snapshot(snap: dict[str, Any]) -> dict[str, Any]:
    """Merge this process's cumulative snapshot into durable weekly and all-time totals."""
    timestamp = int(snap.get("timestamp") or time.time())
    current = _normalise_totals(snap.get("totals"))
    with _HISTORY_LOCK:
        data = _read_usage()
        weeks = data.setdefault("weeks", {})
        session = data.get("session") if isinstance(data.get("session"), dict) else {}
        previous = _normalise_totals(session.get("totals")) if session.get("id") == _SESSION_ID else _normalise_totals({})
        delta = {key: current[key] - previous[key] if current[key] >= previous[key] else current[key] for key in _TOTAL_KEYS}
        week_start, _ = _week_dates(timestamp)
        week = _normalise_totals(weeks.get(week_start))
        weeks[week_start] = {key: week[key] + delta[key] for key in _TOTAL_KEYS}
        all_time_source = data.get("all_time")
        if not isinstance(all_time_source, dict):
            all_time = _normalise_totals({})
            for totals in weeks.values():
                values = _normalise_totals(totals)
                all_time = {key: all_time[key] + values[key] for key in _TOTAL_KEYS}
            all_time = {key: all_time[key] - delta[key] for key in _TOTAL_KEYS}
        else:
            all_time = _normalise_totals(all_time_source)
        data["all_time"] = {key: all_time[key] + delta[key] for key in _TOTAL_KEYS}
        data["session"] = {"id": _SESSION_ID, "totals": current, "updated_at": timestamp}
        data["version"] = 2
        try:
            _write_usage(data)
        except OSError:
            log.exception("could not persist cumulative token usage")
        return _weekly_response(data, timestamp)


def _flush_usage() -> None:
    try:
        _persist_snapshot(_stats())
    except Exception:
        log.exception("could not refresh cumulative token usage")


def _persistence_worker() -> None:
    while not _PERSIST_STOP.wait(_PERSIST_INTERVAL):
        _flush_usage()


def start_persistence() -> None:
    """Start one daemon that saves usage even when the stats page is not open."""
    global _PERSIST_THREAD
    if _PERSIST_THREAD is not None and _PERSIST_THREAD.is_alive():
        return
    _PERSIST_STOP.clear()
    _flush_usage()
    _PERSIST_THREAD = threading.Thread(target=_persistence_worker, name="token-usage-persist", daemon=True)
    _PERSIST_THREAD.start()


def stop_persistence() -> None:
    """Stop the daemon and synchronously save the final tracker values."""
    global _PERSIST_THREAD
    _PERSIST_STOP.set()
    thread = _PERSIST_THREAD
    if thread is not None and thread.is_alive():
        thread.join(timeout=max(1, _PERSIST_INTERVAL + 1))
    _PERSIST_THREAD = None
    _flush_usage()


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
    snap.update(_persist_snapshot(snap))
    _sample(snap)
    return snap


@router.get("/history")
def token_history(hours: int = Query(24, ge=1, le=720)):
    snap = _stats()
    snap.update(_persist_snapshot(snap))
    history = _sample(snap)
    cutoff = int(time.time()) - hours * 3600
    return {"hours": hours, "history": [item for item in history if int(item.get("timestamp", 0)) >= cutoff]}
