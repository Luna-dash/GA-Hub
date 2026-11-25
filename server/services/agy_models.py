"""Hot-reloaded local configuration and persisted upstream catalog for Agy models.

Stores sync schedule (default: local 6-hour clock boundaries 00:00, 06:00, 12:00,
18:00), default model/effort fallback targets, user-editable alias mappings,
custom quota group rules, and per-profile synced model metadata in
`~/.genericagent-admin/agy_models.json`.
"""
from __future__ import annotations

import json
import logging
import re
import threading
import time
from copy import deepcopy
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from .. import _paths
from . import agy_profile

log = logging.getLogger(__name__)

DEFAULT_MODEL_ID = "gemini-4-hydrogen-high"
DEFAULT_EFFORT_LEVEL = "high"
DEFAULT_SCHEDULE_HOURS: tuple[int, ...] = (0, 6, 12, 18)

_DEFAULT_QUOTA_RULES: list[dict[str, str]] = [
    {"pattern": r"(?:claude|gpt|^3p-)", "group": "claude-3p"},
    {"pattern": r"gemini-3", "group": "gemini-3"},
]

_lock = threading.RLock()
_cache: tuple[tuple[str, int, int], dict[str, Any]] | None = None


def config_path() -> Path:
    return _paths.ADMIN_DATA / "agy_models.json"


def is_orchestrator_model(model_id: str) -> bool:
    return "orchestrator" in (model_id or "").lower()


def _local_now(now: datetime | None = None) -> datetime:
    if now is None:
        return datetime.now().astimezone()
    if now.tzinfo is None:
        return now.astimezone()
    return now.astimezone()


def normalize_schedule_hours(raw: Any) -> list[int]:
    if not isinstance(raw, list):
        return list(DEFAULT_SCHEDULE_HOURS)
    hours = sorted({int(h) for h in raw if isinstance(h, (int, float)) and not isinstance(h, bool) and 0 <= int(h) <= 23})
    return hours or list(DEFAULT_SCHEDULE_HOURS)


def latest_scheduled_slot(now: datetime | None = None, schedule_hours: list[int] | tuple[int, ...] | None = None) -> datetime:
    """Return the most recent local clock boundary `<= now` from `schedule_hours`."""
    current = _local_now(now)
    hours = normalize_schedule_hours(list(schedule_hours) if schedule_hours is not None else None)
    base_day = current.replace(hour=0, minute=0, second=0, microsecond=0)
    today_candidates = [base_day.replace(hour=h) for h in hours if h <= current.hour]
    if today_candidates:
        return today_candidates[-1]
    yesterday = base_day - timedelta(days=1)
    return yesterday.replace(hour=hours[-1])


def next_scheduled_slot(now: datetime | None = None, schedule_hours: list[int] | tuple[int, ...] | None = None) -> datetime:
    """Return the earliest local clock boundary strictly `> now` from `schedule_hours`."""
    current = _local_now(now)
    hours = normalize_schedule_hours(list(schedule_hours) if schedule_hours is not None else None)
    base_day = current.replace(hour=0, minute=0, second=0, microsecond=0)
    for h in hours:
        candidate = base_day.replace(hour=h)
        if candidate > current:
            return candidate
    tomorrow = base_day + timedelta(days=1)
    return tomorrow.replace(hour=hours[0])


def _parse_iso(raw: str | None) -> datetime | None:
    if not raw or not isinstance(raw, str):
        return None
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        return dt.astimezone() if dt.tzinfo else dt.replace(tzinfo=_local_now().tzinfo)
    except ValueError:
        return None


def _default_payload() -> dict[str, Any]:
    return {
        "schema_version": 1,
        "sync": {
            "auto_sync": True,
            "schedule_hours": list(DEFAULT_SCHEDULE_HOURS),
            "last_synced_at": None,
            "last_error": None,
        },
        "defaults": {
            "model": DEFAULT_MODEL_ID,
            "effort": DEFAULT_EFFORT_LEVEL,
            "allow_auto_fallback": True,
        },
        "aliases": {},
        "quota_rules": deepcopy(_DEFAULT_QUOTA_RULES),
        "profiles": {},
    }


def _normalize_item(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    mid = str(raw.get("id") or "").strip()
    if not mid:
        return None
    item: dict[str, Any] = {
        "id": mid,
        "display_name": str(raw.get("display_name") or mid).strip() or mid,
    }
    is_orch = raw.get("is_orchestrator") is True or is_orchestrator_model(mid)
    if is_orch:
        item["is_orchestrator"] = True
    else:
        raw_efforts = raw.get("efforts")
        if isinstance(raw_efforts, list):
            efforts = [str(e).strip().lower() for e in raw_efforts if isinstance(e, str) and str(e).strip()]
            if efforts:
                item["efforts"] = list(dict.fromkeys(efforts))
        if isinstance(raw.get("default_effort"), str) and raw["default_effort"].strip():
            item["default_effort"] = raw["default_effort"].strip().lower()
    if raw.get("is_default") is True:
        item["is_default"] = True
    return item


def _normalize_payload(raw: Any) -> dict[str, Any]:
    base = _default_payload()
    if not isinstance(raw, dict):
        return base

    sync_raw = raw.get("sync") if isinstance(raw.get("sync"), dict) else {}
    base["sync"] = {
        "auto_sync": bool(sync_raw.get("auto_sync", True)),
        "schedule_hours": normalize_schedule_hours(sync_raw.get("schedule_hours")),
        "last_synced_at": sync_raw.get("last_synced_at") if isinstance(sync_raw.get("last_synced_at"), str) else None,
        "last_error": sync_raw.get("last_error") if isinstance(sync_raw.get("last_error"), str) else None,
    }

    def_raw = raw.get("defaults") if isinstance(raw.get("defaults"), dict) else {}
    def_model = str(def_raw.get("model") or DEFAULT_MODEL_ID).strip() or DEFAULT_MODEL_ID
    def_effort = str(def_raw.get("effort") or DEFAULT_EFFORT_LEVEL).strip() or DEFAULT_EFFORT_LEVEL
    base["defaults"] = {
        "model": def_model,
        "effort": def_effort,
        "allow_auto_fallback": bool(def_raw.get("allow_auto_fallback", True)),
    }

    aliases_raw = raw.get("aliases")
    if isinstance(aliases_raw, dict):
        base["aliases"] = {
            str(k).strip(): str(v).strip()
            for k, v in aliases_raw.items()
            if isinstance(k, str) and isinstance(v, str) and k.strip() and v.strip()
        }

    rules_raw = raw.get("quota_rules")
    if isinstance(rules_raw, list):
        cleaned_rules: list[dict[str, str]] = []
        for entry in rules_raw:
            if not isinstance(entry, dict):
                continue
            pattern = str(entry.get("pattern") or "").strip()
            group = str(entry.get("group") or "").strip()
            if not pattern or not group:
                continue
            try:
                re.compile(pattern, re.I)
            except re.error:
                continue
            cleaned_rules.append({"pattern": pattern, "group": group})
        if cleaned_rules:
            base["quota_rules"] = cleaned_rules

    profiles_raw = raw.get("profiles")
    if isinstance(profiles_raw, dict):
        cleaned_profiles: dict[str, dict[str, Any]] = {}
        for pid, entry in profiles_raw.items():
            if not isinstance(pid, str) or not pid.strip() or not isinstance(entry, dict):
                continue
            items = []
            seen: set[str] = set()
            for raw_item in entry.get("items") or []:
                norm = _normalize_item(raw_item)
                if norm and norm["id"] not in seen:
                    seen.add(norm["id"])
                    items.append(norm)
            cleaned_profiles[pid.strip()] = {
                "updated_at": entry.get("updated_at") if isinstance(entry.get("updated_at"), str) else None,
                "source": entry.get("source") if isinstance(entry.get("source"), str) else None,
                "items": items,
            }
        base["profiles"] = cleaned_profiles

    return base


def reset_cache() -> None:
    global _cache
    with _lock:
        _cache = None


def load_models_config() -> dict[str, Any]:
    """Read `agy_models.json` with `(path, mtime_ns, size)` hot-reload cache."""
    global _cache
    path = config_path()
    with _lock:
        try:
            st = path.stat()
            sig = (str(path), st.st_mtime_ns, st.st_size)
        except OSError:
            _cache = None
            return _default_payload()
        if _cache is not None and _cache[0] == sig:
            return deepcopy(_cache[1])
        try:
            parsed = json.loads(path.read_text(encoding="utf-8"))
            data = _normalize_payload(parsed)
        except (OSError, ValueError) as exc:
            log.warning("agy_models.json unreadable, using defaults: %s", exc)
            data = _default_payload()
        _cache = (sig, data)
        return deepcopy(data)


def _save_unlocked(cfg: dict[str, Any]) -> dict[str, Any]:
    global _cache
    normalized = _normalize_payload(cfg)
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(normalized, ensure_ascii=False, indent=2), encoding="utf-8")
    for attempt in range(6):
        try:
            tmp.replace(path)
            break
        except PermissionError as exc:
            if getattr(exc, "winerror", None) not in {5, 32, 33} or attempt == 5:
                raise
            time.sleep(0.01 * (2 ** attempt))
    _cache = None
    return deepcopy(normalized)


def update_models_config(mutate: Any) -> dict[str, Any]:
    with _lock:
        cfg = load_models_config()
        mutate(cfg)
        return _save_unlocked(cfg)


def patch_user_config(
    *,
    auto_sync: bool | None = None,
    schedule_hours: list[int] | None = None,
    default_model: str | None = None,
    default_effort: str | None = None,
    allow_auto_fallback: bool | None = None,
    aliases: dict[str, str] | None = None,
    quota_rules: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    def mutate(cfg: dict[str, Any]) -> None:
        if auto_sync is not None:
            cfg["sync"]["auto_sync"] = bool(auto_sync)
        if schedule_hours is not None:
            cfg["sync"]["schedule_hours"] = normalize_schedule_hours(schedule_hours)
        if default_model is not None and default_model.strip():
            cfg["defaults"]["model"] = default_model.strip()
        if default_effort is not None and default_effort.strip():
            cfg["defaults"]["effort"] = default_effort.strip()
        if allow_auto_fallback is not None:
            cfg["defaults"]["allow_auto_fallback"] = bool(allow_auto_fallback)
        if aliases is not None:
            cfg["aliases"] = {
                str(k).strip(): str(v).strip()
                for k, v in aliases.items()
                if str(k).strip() and str(v).strip()
            }
        if quota_rules is not None:
            cfg["quota_rules"] = quota_rules

    return update_models_config(mutate)


def default_model_and_effort() -> tuple[str, str]:
    cfg = load_models_config()
    defs = cfg["defaults"]
    return str(defs["model"]), str(defs["effort"])


def allow_auto_fallback_enabled() -> bool:
    return bool(load_models_config()["defaults"].get("allow_auto_fallback", True))


def resolve_alias(model: str) -> tuple[str, str | None]:
    """Resolve user/upstream alias chain up to 4 hops; returns `(resolved_id, alias_hit)`."""
    cfg = load_models_config()
    aliases = cfg.get("aliases") or {}
    current = (model or "").strip() or str(cfg["defaults"]["model"])
    seen = {current}
    hop: str | None = None
    for _ in range(4):
        nxt = aliases.get(current)
        if not nxt or nxt in seen:
            break
        hop = current
        seen.add(nxt)
        current = nxt
    return current, (model if hop is not None and current != model else None)


def match_quota_group(model: str) -> str | None:
    lower = (model or "").lower()
    cfg = load_models_config()
    for rule in cfg.get("quota_rules") or []:
        pattern = rule.get("pattern")
        group = rule.get("group")
        if not pattern or not group:
            continue
        try:
            if re.search(pattern, lower, re.I):
                return str(group)
        except re.error:
            continue
    return None


def merge_catalog_items(existing: list[dict[str, Any]], incoming: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Merge upstream model entries, enriching display names and effort capabilities."""
    merged: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for src in (existing, incoming):
        for raw in src:
            norm = _normalize_item(raw)
            if not norm:
                continue
            mid = norm["id"]
            if mid not in merged:
                merged[mid] = dict(norm)
                order.append(mid)
                continue
            cur = merged[mid]
            if norm.get("display_name") and (norm["display_name"] != mid or cur["display_name"] == mid):
                cur["display_name"] = norm["display_name"]
            if norm.get("is_orchestrator"):
                cur["is_orchestrator"] = True
                cur.pop("efforts", None)
                cur.pop("default_effort", None)
            else:
                if norm.get("efforts"):
                    cur["efforts"] = list(norm["efforts"])
                if norm.get("default_effort"):
                    cur["default_effort"] = norm["default_effort"]
            if norm.get("is_default"):
                cur["is_default"] = True
    return [merged[mid] for mid in order]


def save_profile_catalog(
    profile_id: str,
    items: list[dict[str, Any]],
    *,
    source: str,
    merge_existing: bool = False,
    now: datetime | None = None,
) -> list[dict[str, Any]]:
    pid = profile_id or agy_profile.DEFAULT
    stamp = _local_now(now).isoformat()
    cleaned_incoming = [norm for raw in items if (norm := _normalize_item(raw)) is not None]
    if not cleaned_incoming:
        return []

    stored_items: list[dict[str, Any]] = []

    def mutate(cfg: dict[str, Any]) -> None:
        nonlocal stored_items
        prev = cfg["profiles"].get(pid, {}).get("items", []) if merge_existing else []
        merged = merge_catalog_items(prev, cleaned_incoming) if merge_existing else cleaned_incoming
        stored_items = merged
        cfg["profiles"][pid] = {
            "updated_at": stamp,
            "source": source,
            "items": merged,
        }
        cfg["sync"]["last_synced_at"] = stamp
        cfg["sync"]["last_error"] = None

    update_models_config(mutate)
    return stored_items


def record_sync_error(detail: str) -> None:
    def mutate(cfg: dict[str, Any]) -> None:
        cfg["sync"]["last_error"] = detail

    update_models_config(mutate)


def is_profile_catalog_stale(profile_id: str, *, now: datetime | None = None) -> bool:
    cfg = load_models_config()
    pid = profile_id or agy_profile.DEFAULT
    entry = cfg["profiles"].get(pid)
    if not entry or not entry.get("items"):
        return True
    updated = _parse_iso(entry.get("updated_at"))
    if updated is None:
        return True
    if not cfg["sync"].get("auto_sync", True):
        return False
    slot = latest_scheduled_slot(now, cfg["sync"].get("schedule_hours"))
    return updated < slot


def profile_catalog(profile_id: str, *, now: datetime | None = None) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    cfg = load_models_config()
    pid = profile_id or agy_profile.DEFAULT
    entry = cfg["profiles"].get(pid) or {}
    items = [dict(i) for i in (entry.get("items") or [])]
    hours = cfg["sync"].get("schedule_hours") or list(DEFAULT_SCHEDULE_HOURS)
    updated_at = entry.get("updated_at")
    parsed = _parse_iso(updated_at)
    stale = True if not items or parsed is None else (bool(cfg["sync"].get("auto_sync", True)) and parsed < latest_scheduled_slot(now, hours))
    meta = {
        "synced_at": updated_at or cfg["sync"].get("last_synced_at"),
        "next_sync_at": next_scheduled_slot(now, hours).isoformat() if cfg["sync"].get("auto_sync", True) else None,
        "stale": stale,
        "source": entry.get("source"),
        "default_model": cfg["defaults"]["model"],
        "default_effort": cfg["defaults"]["effort"],
        "allow_auto_fallback": bool(cfg["defaults"].get("allow_auto_fallback", True)),
        "schedule_hours": hours,
        "auto_sync": bool(cfg["sync"].get("auto_sync", True)),
        "last_error": cfg["sync"].get("last_error"),
    }
    return items, meta


def clear_profile_catalog(profile_id: str | None = None) -> None:
    def mutate(cfg: dict[str, Any]) -> None:
        if profile_id is None:
            cfg["profiles"].clear()
        else:
            cfg["profiles"].pop(profile_id, None)

    update_models_config(mutate)


def public_config_view(*, now: datetime | None = None) -> dict[str, Any]:
    cfg = load_models_config()
    hours = cfg["sync"].get("schedule_hours") or list(DEFAULT_SCHEDULE_HOURS)
    return {
        "config_path": str(config_path()),
        "auto_sync": bool(cfg["sync"].get("auto_sync", True)),
        "schedule_hours": hours,
        "last_synced_at": cfg["sync"].get("last_synced_at"),
        "next_sync_at": next_scheduled_slot(now, hours).isoformat() if cfg["sync"].get("auto_sync", True) else None,
        "last_error": cfg["sync"].get("last_error"),
        "default_model": cfg["defaults"]["model"],
        "default_effort": cfg["defaults"]["effort"],
        "allow_auto_fallback": bool(cfg["defaults"].get("allow_auto_fallback", True)),
        "aliases": dict(cfg.get("aliases") or {}),
        "quota_rules": [dict(r) for r in (cfg.get("quota_rules") or [])],
    }
