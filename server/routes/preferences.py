"""Persistent user-interface preferences for GA-Hub."""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import _paths

router = APIRouter(prefix="/api/preferences", tags=["preferences"])

_PREFERENCES_FILE = _paths.ADMIN_DATA / "ui_preferences.json"
_LOCK = threading.RLock()
_ALLOWED_NAV_IDS = {
    "dashboard", "chat", "feishu", "conversations", "memory", "conductor",
    "goal-hive", "mykey", "tasks", "autonomous", "tokens",
}


class NavPreference(BaseModel):
    id: str
    visible: bool


class NavPreferencesReq(BaseModel):
    preferences: list[NavPreference]


def _read_preferences() -> dict:
    if not _PREFERENCES_FILE.exists():
        return {"version": 1}
    try:
        data = json.loads(_PREFERENCES_FILE.read_text("utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500, detail=f"unable to read UI preferences: {exc}") from exc
    if not isinstance(data, dict) or data.get("version") != 1:
        raise HTTPException(status_code=500, detail="unsupported UI preferences format")
    return data


def _write_preferences(data: dict) -> None:
    _PREFERENCES_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = _PREFERENCES_FILE.with_suffix(f".{uuid4().hex}.tmp")
    try:
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, _PREFERENCES_FILE)
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass


def _validate_navigation(preferences: list[NavPreference]) -> list[dict]:
    ids = [entry.id for entry in preferences]
    if len(ids) != len(_ALLOWED_NAV_IDS) or set(ids) != _ALLOWED_NAV_IDS:
        raise HTTPException(status_code=422, detail="navigation preferences must contain every known item exactly once")
    return [{"id": entry.id, "visible": entry.visible} for entry in preferences]


@router.get("/navigation")
def get_navigation_preferences():
    with _LOCK:
        preferences = _read_preferences().get("navigation")
    return {"configured": isinstance(preferences, list), "preferences": preferences or []}


@router.put("/navigation")
def put_navigation_preferences(request: NavPreferencesReq):
    normalized = _validate_navigation(request.preferences)
    with _LOCK:
        data = _read_preferences()
        data["navigation"] = normalized
        _write_preferences(data)
    return {"configured": True, "preferences": normalized}
