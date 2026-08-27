"""Live LLM token usage and lightweight history."""
from __future__ import annotations

import time
from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter, Query

from .. import _paths
from ..services.session_metadata import SessionMetadataStore

router = APIRouter(prefix="/api/tokens", tags=["tokens"])
_SESSION_METADATA = SessionMetadataStore()
_TOTAL_KEYS = ("requests", "input", "output", "cache_create", "cache_read", "total")

try:
    import cost_tracker
    cost_tracker.install()
    if _paths.GA_ROOT is not None:
        # Reuse GA's native JSONL ledger exactly as the official desktop
        # bridge does.  GA-Hub is only a reader/presenter of that ledger.
        cost_tracker.init_ledger(str(_paths.GA_ROOT))
except Exception:  # GA versions without cost_tracker remain usable
    cost_tracker = None
    log.exception("token tracker unavailable")




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


def _ledger_totals(entry: dict[str, Any]) -> dict[str, int]:
    """Translate one native GA ledger record into the WebUI field names."""
    try:
        values = {
            "input": max(0, int(entry.get("i", 0) or 0)),
            "output": max(0, int(entry.get("o", 0) or 0)),
            "cache_create": max(0, int(entry.get("cc", 0) or 0)),
            "cache_read": max(0, int(entry.get("cr", 0) or 0)),
        }
    except (TypeError, ValueError):
        return _normalise_totals({})
    # Native GA's ledger does not persist request counts.  Do not invent one
    # (a compacted row may represent arbitrarily many calls).
    values["requests"] = 0
    values["total"] = sum(values[key] for key in ("input", "output", "cache_create", "cache_read"))
    return values


def _add_totals(left: dict[str, Any], right: dict[str, Any]) -> dict[str, int]:
    a = _normalise_totals(left)
    b = _normalise_totals(right)
    return {key: a[key] + b[key] for key in _TOTAL_KEYS}


def _native_ledger_usage() -> dict[str, Any]:
    """Read GA's official ledger and adapt it to the existing WebUI schema."""
    now = int(time.time())
    if cost_tracker is None:
        empty = _normalise_totals({})
        usage = {"days": {}, "all_time": empty, "sessions": {}}
        result = {"available": False, "totals": _with_rate(empty), "timestamp": now}
        result.update(_weekly_response(usage, now))
        return result

    days: dict[str, dict[str, int]] = {}
    sessions: dict[str, dict[str, Any]] = {}
    all_time = _normalise_totals({})
    for entry in cost_tracker.read_ledger():
        if not isinstance(entry, dict):
            continue
        key = entry.get("k")
        if not isinstance(key, str) or not key:
            continue
        try:
            timestamp = int(float(entry.get("t", 0) or 0))
        except (TypeError, ValueError):
            continue
        totals = _ledger_totals(entry)
        all_time = _add_totals(all_time, totals)
        date_key = datetime.fromtimestamp(timestamp).date().isoformat()
        days[date_key] = _add_totals(days.get(date_key, {}), totals)
        session_id = key.removeprefix("GA-")
        current = sessions.get(session_id, {})
        sessions[session_id] = {
            "totals": _add_totals(current.get("totals", {}), totals),
            "updated_at": max(int(current.get("updated_at", 0) or 0), timestamp),
        }

    usage = {"days": days, "all_time": all_time, "sessions": sessions}
    result = {"available": True, "totals": _with_rate(all_time), "timestamp": now}
    result.update(_weekly_response(usage, now))
    return result


def _native_ledger_history(hours: int) -> list[dict[str, Any]]:
    """Return native ledger events in the legacy history response shape."""
    if cost_tracker is None:
        return []
    cutoff = int(time.time()) - hours * 3600
    history = []
    for entry in cost_tracker.read_ledger():
        if not isinstance(entry, dict):
            continue
        try:
            timestamp = int(float(entry.get("t", 0) or 0))
        except (TypeError, ValueError):
            continue
        if timestamp >= cutoff:
            history.append({"timestamp": timestamp, **_with_rate(_ledger_totals(entry))})
    history.sort(key=lambda item: item["timestamp"])
    return history














def _session_title(metadata: dict[str, Any]) -> str:
    title = str(metadata.get("title") or "").strip()
    if title:
        return title[:200]
    archive_path = metadata.get("archive_path")
    if archive_path:
        try:
            from .conversations import _first_user_preview

            preview = _first_user_preview(str(archive_path)).strip()
            if preview:
                return preview[:200]
        except Exception:
            log.debug("could not derive token session title", exc_info=True)
    return "未命名会话"


def _session_rows(data: dict[str, Any]) -> list[dict[str, Any]]:
    source = data.get("sessions") if isinstance(data.get("sessions"), dict) else {}
    try:
        metadata_rows = _SESSION_METADATA.list()
    except (OSError, ValueError):
        log.warning("could not read session titles for token statistics", exc_info=True)
        metadata_rows = []
    metadata_by_id = {
        str(row.get("id")): row
        for row in metadata_rows
        if isinstance(row, dict) and row.get("id")
    }
    rows = []
    for session_id, value in source.items():
        session_id = str(session_id)
        metadata = metadata_by_id.get(session_id)
        if metadata is not None:
            title = _session_title(metadata)
        elif session_id == "conductor":
            title = "Conductor"
        elif session_id.startswith("conductor-subagent-"):
            title = f"Conductor Subagent {session_id.removeprefix('conductor-subagent-')}"
        else:
            # Ordinary sessions without metadata are stale/orphaned and remain
            # hidden; conductor workers are stable native-ledger identities.
            continue
        if not isinstance(value, dict):
            continue
        totals = _with_rate(_normalise_totals(value.get("totals")))
        rows.append({
            "thread": session_id,
            "title": title,
            **totals,
            "elapsed_seconds": 0.0,
            "updated_at": int(value.get("updated_at") or 0),
        })
    rows.sort(key=lambda row: (row["total"], row["updated_at"]), reverse=True)
    return rows




def _weeks_from_days(days_source: dict[str, Any]) -> list[dict[str, Any]]:
    grouped: dict[str, dict[str, int]] = {}
    for day_key, value in days_source.items():
        try:
            day = datetime.strptime(str(day_key), "%Y-%m-%d").date()
        except (TypeError, ValueError):
            continue
        week_start = (day - timedelta(days=day.weekday())).isoformat()
        current = _normalise_totals(grouped.get(week_start))
        totals = _normalise_totals(value)
        grouped[week_start] = {key: current[key] + totals[key] for key in _TOTAL_KEYS}
    rows = []
    for week_start in sorted(grouped):
        start_date = datetime.strptime(week_start, "%Y-%m-%d").date()
        rows.append({
            "week_start": week_start,
            "week_end": (start_date + timedelta(days=6)).isoformat(),
            **_with_rate(grouped[week_start]),
        })
    return rows


def _weekly_response(data: dict[str, Any], timestamp: int) -> dict[str, Any]:
    days_source = data.get("days") if isinstance(data.get("days"), dict) else {}
    days = [
        {"date": date, **_with_rate(_normalise_totals(days_source[date]))}
        for date in sorted(days_source)
    ]
    rows = _weeks_from_days(days_source)
    current_start, current_end = _week_dates(timestamp)
    current = next((row for row in rows if row["week_start"] == current_start), None)
    if current is None:
        current = {"week_start": current_start, "week_end": current_end, **_with_rate(_normalise_totals({}))}
    all_time_source = data.get("all_time")
    if not isinstance(all_time_source, dict):
        migrated = _normalise_totals({})
        legacy_weeks = data.get("weeks") if isinstance(data.get("weeks"), dict) else {}
        for week in legacy_weeks.values():
            totals = _normalise_totals(week)
            migrated = {key: migrated[key] + totals[key] for key in _TOTAL_KEYS}
        all_time_source = migrated
    return {
        "all_time": _with_rate(_normalise_totals(all_time_source)),
        "current_week": current,
        "weeks": rows,
        "days": days,
        "threads": _session_rows(data),
    }
















@router.get("/stats")
def token_stats():
    return _native_ledger_usage()


@router.get("/history")
def token_history(hours: int = Query(24, ge=1, le=720)):
    return {"hours": hours, "history": _native_ledger_history(hours)}
