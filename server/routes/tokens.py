"""Live LLM token usage and lightweight history."""
from __future__ import annotations

from contextlib import closing
import logging
import sqlite3
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request

from .. import _paths
from ..schemas import TokenStatsResp
from ..services.agy_usage import normalize_ledger_input
from ..services.session_metadata import SessionMetadataStore

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/tokens", tags=["tokens"])


class _LazySessionMetadataProxy:
    """Lazy fallback store for standalone unit callers; routes prefer app.state."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._store: SessionMetadataStore | None = None

    def _target(self) -> SessionMetadataStore:
        store = self._store
        if store is None:
            with self._lock:
                store = self._store
                if store is None:
                    store = self._store = SessionMetadataStore()
        return store

    def _has_overrides(self) -> bool:
        for key, value in self.__dict__.items():
            if key in {"_lock", "_store"}:
                continue
            if self._store is None or value != getattr(self._store, key, object()):
                return True
        return False

    def __getattr__(self, name: str) -> Any:
        return getattr(self._target(), name)


_DEFAULT_SESSION_METADATA = _LazySessionMetadataProxy()
_SESSION_METADATA: Any = _DEFAULT_SESSION_METADATA
_TOTAL_KEYS = ("requests", "input", "output", "cache_create", "cache_read", "total")
_LEDGER_CACHE_LOCK = threading.Lock()
_LEDGER_CACHE: tuple[tuple[int, str, int, int], dict[str, Any]] | None = None
_AGY_LEDGER_CACHE_LOCK = threading.Lock()
_AGY_LEDGER_CACHE: tuple[tuple[str, int, int, int, int], dict[str, Any]] | None = None


def _resolve_session_metadata(request: Request | None = None) -> Any:
    if _SESSION_METADATA is not _DEFAULT_SESSION_METADATA or _DEFAULT_SESSION_METADATA._has_overrides():
        return _SESSION_METADATA
    if request is not None:
        lifecycle = getattr(request.app.state, "session_lifecycle", None)
        if lifecycle is not None:
            return lifecycle.store
    return _DEFAULT_SESSION_METADATA

try:
    from frontends.gahub.bridge import usage as usage_bridge
except Exception:  # GA versions without the usage bridge remain usable
    usage_bridge = None
    log.exception("token tracker unavailable")


def initialize_usage_tracking() -> None:
    """Initialize the GA ledger explicitly from the application lifespan."""
    if usage_bridge is not None and _paths.GA_ROOT is not None:
        try:
            usage_bridge.initialize_usage_tracking(str(_paths.GA_ROOT))
        except Exception:
            log.exception("token tracker initialization failed")


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
    # The native ledger carries no call counter, but its rows are shaped by
    # the call that produced them: a streaming call writes a strict pair —
    # one input-side row (from the _record_usage patch) plus one output-only
    # row (from the `[Output]` print) — and a non-stream call writes a single
    # combined row.  So exactly the rows carrying input-side tokens are one
    # call each.  Compacted / legacy-migrated rows fold many calls into one;
    # one is the provable lower bound for those.
    values["requests"] = 1 if (
        values["input"] or values["cache_create"] or values["cache_read"]
    ) else 0
    values["total"] = sum(values[key] for key in ("input", "output", "cache_create", "cache_read"))
    return values


def _add_totals(left: dict[str, Any], right: dict[str, Any]) -> dict[str, int]:
    a = _normalise_totals(left)
    b = _normalise_totals(right)
    return {key: a[key] + b[key] for key in _TOTAL_KEYS}


def _ledger_cache_key() -> tuple[int, str, int, int] | None:
    if usage_bridge is None:
        return None
    read_fn = getattr(usage_bridge, "read_usage_ledger", None)
    if read_fn is None:
        return None
    path_fn = getattr(usage_bridge, "usage_ledger_path", None)
    ledger_path = None
    if callable(path_fn):
        try:
            ledger_path = path_fn()
        except Exception:
            ledger_path = None
    if not ledger_path:
        return None
    try:
        st = Path(ledger_path).stat()
        return (id(read_fn), str(ledger_path), int(st.st_mtime_ns), int(st.st_size))
    except OSError:
        return None


def _aggregate_ledger() -> dict[str, Any]:
    global _LEDGER_CACHE
    cache_key = _ledger_cache_key()
    if cache_key is not None:
        with _LEDGER_CACHE_LOCK:
            if _LEDGER_CACHE is not None and _LEDGER_CACHE[0] == cache_key:
                return _LEDGER_CACHE[1]

    days: dict[str, dict[str, int]] = {}
    sessions: dict[str, dict[str, Any]] = {}
    all_time = _normalise_totals({})
    for entry in usage_bridge.read_usage_ledger():
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
            "engine": "ga",
        }

    usage = {"days": days, "all_time": all_time, "sessions": sessions}
    if cache_key is not None:
        with _LEDGER_CACHE_LOCK:
            _LEDGER_CACHE = (cache_key, usage)
    return usage


def _agy_ledger_db_path() -> Path:
    return _paths.ADMIN_DATA / "anti_sessions.sqlite3"


def _agy_cache_key(db_path: Path) -> tuple[str, int, int, int, int] | None:
    try:
        st = db_path.stat()
    except OSError:
        return None
    wal_path = db_path.with_name(db_path.name + "-wal")
    try:
        wal_st = wal_path.stat()
        wal_mtime, wal_size = int(wal_st.st_mtime_ns), int(wal_st.st_size)
    except OSError:
        wal_mtime, wal_size = 0, 0
    return (str(db_path), int(st.st_mtime_ns), int(st.st_size), wal_mtime, wal_size)


def _parse_iso_timestamp(raw: Any) -> tuple[int, str] | None:
    text = str(raw or "").strip()
    if not text:
        return None
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone()
    return int(dt.timestamp()), dt.date().isoformat()


def _aggregate_agy_ledger(db_path: Path | None = None) -> dict[str, Any]:
    global _AGY_LEDGER_CACHE
    target = db_path if db_path is not None else _agy_ledger_db_path()
    empty = {"available": False, "days": {}, "all_time": _normalise_totals({}), "sessions": {}}
    if not target.is_file():
        return empty

    cache_key = _agy_cache_key(target)
    if cache_key is not None:
        with _AGY_LEDGER_CACHE_LOCK:
            if _AGY_LEDGER_CACHE is not None and _AGY_LEDGER_CACHE[0] == cache_key:
                return _AGY_LEDGER_CACHE[1]

    days: dict[str, dict[str, int]] = {}
    sessions: dict[str, dict[str, Any]] = {}
    all_time = _normalise_totals({})

    try:
        with closing(sqlite3.connect(target, timeout=5.0)) as conn:
            conn.row_factory = sqlite3.Row
            tables = {
                str(row[0])
                for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
            }
            if "usage_ledger" not in tables:
                return empty
            cols = {
                str(row[1])
                for row in conn.execute("PRAGMA table_info(usage_ledger)")
            }
            cw_col = "l.cache_write_tokens" if "cache_write_tokens" in cols else "0"
            thinking_col = "l.thinking_tokens" if "thinking_tokens" in cols else "0"
            calls_col = "l.model_calls" if "model_calls" in cols else "0"
            has_sessions = "runs" in tables and "sessions" in tables
            query = (
                "SELECT l.created_at, l.input_tokens, l.output_tokens, "
                "l.cache_read_tokens, "
                f"{cw_col} AS cache_write_tokens, "
                f"{thinking_col} AS thinking_tokens, "
                f"{calls_col} AS model_calls, "
                + (
                    "r.session_id AS session_id, s.id AS session_exists, s.title AS session_title "
                    "FROM usage_ledger l "
                    "LEFT JOIN runs r ON r.id = l.run_id "
                    "LEFT JOIN sessions s ON s.id = r.session_id"
                    if has_sessions
                    else "NULL AS session_id, NULL AS session_exists, NULL AS session_title FROM usage_ledger l"
                )
            )
            rows = conn.execute(query).fetchall()
    except (sqlite3.Error, OSError):
        log.warning("could not read Agy usage ledger", exc_info=True)
        return empty

    for row in rows:
        parsed_ts = _parse_iso_timestamp(row["created_at"])
        if parsed_ts is None:
            continue
        timestamp, date_key = parsed_ts
        raw_in = max(0, int(row["input_tokens"] or 0))
        raw_cr = max(0, int(row["cache_read_tokens"] or 0))
        raw_cw = max(0, int(row["cache_write_tokens"] or 0))
        _, fresh_in, cr, cw = normalize_ledger_input(raw_in, raw_cr, raw_cw)
        out = max(
            max(0, int(row["output_tokens"] or 0)),
            max(0, int(row["thinking_tokens"] or 0)),
        )
        calls = max(0, int(row["model_calls"] or 0))
        has_tokens = bool(fresh_in or out or cw or cr)
        requests = calls if calls > 0 else (1 if has_tokens else 0)
        totals = {
            "requests": requests,
            "input": fresh_in,
            "output": out,
            "cache_create": cw,
            "cache_read": cr,
            "total": fresh_in + out + cw + cr,
        }
        all_time = _add_totals(all_time, totals)
        days[date_key] = _add_totals(days.get(date_key, {}), totals)

        session_id = str(row["session_id"] or "").strip()
        if session_id and row["session_exists"] is not None:
            thread_key = f"anti:{session_id}"
            title = str(row["session_title"] or "").strip() or "未命名会话"
            current = sessions.get(thread_key, {})
            sessions[thread_key] = {
                "totals": _add_totals(current.get("totals", {}), totals),
                "updated_at": max(int(current.get("updated_at", 0) or 0), timestamp),
                "title": title,
                "engine": "anti",
            }

    usage = {"available": True, "days": days, "all_time": all_time, "sessions": sessions}
    if cache_key is not None:
        with _AGY_LEDGER_CACHE_LOCK:
            _AGY_LEDGER_CACHE = (cache_key, usage)
    return usage


def _merge_usage_sources(ga_usage: dict[str, Any], agy_usage: dict[str, Any]) -> dict[str, Any]:
    days: dict[str, dict[str, int]] = {
        date: _normalise_totals(totals)
        for date, totals in (ga_usage.get("days") or {}).items()
    }
    for date, totals in (agy_usage.get("days") or {}).items():
        days[date] = _add_totals(days.get(date, {}), totals)

    sessions: dict[str, Any] = dict(ga_usage.get("sessions") or {})
    sessions.update(agy_usage.get("sessions") or {})
    return {
        "days": days,
        "all_time": _add_totals(ga_usage.get("all_time"), agy_usage.get("all_time")),
        "sessions": sessions,
    }


def _native_ledger_usage(metadata: Any = None) -> dict[str, Any]:
    """Read GA and Agy ledgers and adapt merged totals to the WebUI schema."""
    now = int(time.time())
    empty = _normalise_totals({})
    ga_available = usage_bridge is not None
    ga_usage = _aggregate_ledger() if ga_available else {"days": {}, "all_time": empty, "sessions": {}}
    agy_usage = _aggregate_agy_ledger()
    agy_available = bool(agy_usage.get("available"))

    if not ga_available and not agy_available:
        usage = {"days": {}, "all_time": empty, "sessions": {}}
        result = {
            "available": False,
            "totals": _with_rate(empty),
            "timestamp": now,
            "by_engine": {"ga": _with_rate(empty), "anti": _with_rate(empty)},
        }
        result.update(_weekly_response(usage, now, metadata=metadata))
        return result

    usage = _merge_usage_sources(ga_usage, agy_usage)
    all_time = usage["all_time"]
    result = {
        "available": True,
        "totals": _with_rate(all_time),
        "timestamp": now,
        "by_engine": {
            "ga": _with_rate(ga_usage["all_time"]),
            "anti": _with_rate(agy_usage["all_time"]),
        },
    }
    result.update(_weekly_response(usage, now, metadata=metadata))
    return result


def _session_title(metadata: dict[str, Any]) -> str:
    title = str(metadata.get("title") or "").strip()
    if title:
        return title[:200]
    archive_path = metadata.get("archive_path")
    if archive_path:
        try:
            from ..services.archive_messages import first_user_preview

            preview = first_user_preview(str(archive_path)).strip()
            if preview:
                return preview[:200]
        except Exception:
            log.debug("could not derive token session title", exc_info=True)
    return "未命名会话"


def _session_rows(data: dict[str, Any], metadata: Any = None) -> list[dict[str, Any]]:
    source = data.get("sessions") if isinstance(data.get("sessions"), dict) else {}
    store = metadata if metadata is not None else _resolve_session_metadata()
    try:
        metadata_rows = store.list()
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
        if not isinstance(value, dict):
            continue
        metadata = metadata_by_id.get(session_id)
        engine: str | None = value.get("engine") if isinstance(value.get("engine"), str) else None
        if metadata is not None:
            title = _session_title(metadata)
            engine = engine or "ga"
        elif session_id == "conductor":
            title = "Conductor"
            engine = engine or "ga"
        elif session_id.startswith("conductor-subagent-"):
            title = f"Conductor Subagent {session_id.removeprefix('conductor-subagent-')}"
            engine = engine or "ga"
        elif engine == "anti":
            title = str(value.get("title") or "").strip() or "未命名会话"
        else:
            # Ordinary sessions without metadata are stale/orphaned and remain
            # hidden; conductor workers and active Agy sessions keep explicit identities.
            continue
        totals = _with_rate(_normalise_totals(value.get("totals")))
        rows.append({
            "thread": session_id,
            "title": title,
            **totals,
            "elapsed_seconds": 0.0,
            "updated_at": int(value.get("updated_at") or 0),
            "engine": engine,
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


def _weekly_response(data: dict[str, Any], timestamp: int, *, metadata: Any = None) -> dict[str, Any]:
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
        "threads": _session_rows(data, metadata=metadata),
    }


@router.get("/stats", response_model=TokenStatsResp)
def token_stats(request: Request = None):  # type: ignore[assignment]
    return _native_ledger_usage(metadata=_resolve_session_metadata(request))
