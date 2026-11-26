"""Persistent user-interface preferences for GA-Hub."""
from __future__ import annotations

import threading

from fastapi import APIRouter, HTTPException

from ..schemas import (
    NavPreference,
    NavPreferencesReq,
    NavPreferencesResp,
    UiSettingsReq,
    UiSettingsResp,
)

from ..services.ui_preferences_store import PreferencesFormatError, UiPreferencesStore

router = APIRouter(prefix="/api/preferences", tags=["preferences"])

_LOCK = threading.RLock()
_STORE = UiPreferencesStore()
_ALLOWED_NAV_IDS = {
    "dashboard", "chat", "anti", "theme-tasks", "conversations",
    "memory", "conductor", "goal-hive", "mykey", "tasks",
    "autonomous", "tokens",
}
_ALLOWED_SETTING_KEYS = {
    "gahub.sidebar.collapsed",
    "gahub.conversationIndexCollapsed",
    "gahub.conductor.subagentModelLocked.v1",
    "gahub.modelSelection.mainLlmKey.v1",
    "gahub.modelSelection.subagentLlmKey.v1",
    "gahub.chat-font-scale.relative.v2",
    "gahub.rail-title-scale.relative.v2",
    "gahub.mykey-show-upload",
    "gahub.chatPerformance",
    "ga.desktopNotifications.v1",
    "gahub.uiTheme.v1",
    "gahub.uiPaperTexture.v1",
}
_MAX_SETTING_VALUE_LEN = 512


def _validate_navigation(preferences: list[NavPreference]) -> list[dict]:
    ids = [entry.id for entry in preferences]
    if len(ids) != len(_ALLOWED_NAV_IDS) or set(ids) != _ALLOWED_NAV_IDS:
        raise HTTPException(status_code=422, detail="navigation preferences must contain every known item exactly once")
    return [{"id": entry.id, "visible": entry.visible} for entry in preferences]


def _validate_settings_patch(settings: dict[str, str | None]) -> dict[str, str | None]:
    validated: dict[str, str | None] = {}
    for key, value in settings.items():
        if key not in _ALLOWED_SETTING_KEYS:
            raise HTTPException(status_code=422, detail=f"unknown UI setting key: {key}")
        if value is not None and len(value) > _MAX_SETTING_VALUE_LEN:
            raise HTTPException(status_code=422, detail=f"UI setting value too long for key: {key}")
        validated[key] = value
    return validated


def _read_settings_dict(raw: object) -> dict[str, str]:
    if not isinstance(raw, dict):
        return {}
    return {
        key: value
        for key, value in raw.items()
        if key in _ALLOWED_SETTING_KEYS and isinstance(value, str) and len(value) <= _MAX_SETTING_VALUE_LEN
    }


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


@router.get("/ui")
def get_ui_settings() -> UiSettingsResp:
    with _LOCK:
        try:
            raw = _STORE.read().get("settings")
        except PreferencesFormatError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc
    return UiSettingsResp(configured=isinstance(raw, dict), settings=_read_settings_dict(raw))


@router.put("/ui")
def put_ui_settings(request: UiSettingsReq) -> UiSettingsResp:
    patch = _validate_settings_patch(request.settings)
    with _LOCK:
        try:
            current = _read_settings_dict(_STORE.read().get("settings"))
            for key, value in patch.items():
                if value is None:
                    current.pop(key, None)
                else:
                    current[key] = value
            _STORE.update({"settings": current})
        except PreferencesFormatError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc
    return UiSettingsResp(configured=True, settings=current)
