"""Persistent user-interface preferences for GA-Hub."""
from __future__ import annotations

import threading

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..services.ui_preferences_store import PreferencesFormatError, UiPreferencesStore

router = APIRouter(prefix="/api/preferences", tags=["preferences"])

_LOCK = threading.RLock()
_STORE = UiPreferencesStore()
_ALLOWED_NAV_IDS = {
    "dashboard", "chat", "conversations", "memory", "conductor",
    "goal-hive", "mykey", "tasks", "autonomous", "tokens",
}


class NavPreference(BaseModel):
    id: str
    visible: bool


class NavPreferencesReq(BaseModel):
    preferences: list[NavPreference]


class NavPreferencesResp(BaseModel):
    configured: bool
    preferences: list[NavPreference]


def _validate_navigation(preferences: list[NavPreference]) -> list[dict]:
    ids = [entry.id for entry in preferences]
    if len(ids) != len(_ALLOWED_NAV_IDS) or set(ids) != _ALLOWED_NAV_IDS:
        raise HTTPException(status_code=422, detail="navigation preferences must contain every known item exactly once")
    return [{"id": entry.id, "visible": entry.visible} for entry in preferences]


@router.get("/navigation")
def get_navigation_preferences() -> NavPreferencesResp:
    with _LOCK:
        try:
            preferences = _STORE.read().get("navigation")
        except PreferencesFormatError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc
    raw_preferences = preferences if isinstance(preferences, list) else []
    return NavPreferencesResp(
        configured=isinstance(preferences, list),
        preferences=[NavPreference.model_validate(entry) for entry in raw_preferences],
    )


@router.put("/navigation")
def put_navigation_preferences(request: NavPreferencesReq) -> NavPreferencesResp:
    normalized = _validate_navigation(request.preferences)
    with _LOCK:
        try:
            _STORE.update({"navigation": normalized})
        except PreferencesFormatError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc
    return NavPreferencesResp(configured=True, preferences=normalized)
