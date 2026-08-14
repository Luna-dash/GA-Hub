from __future__ import annotations

import json

from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.routes import preferences
from server.services.ui_preferences_store import UiPreferencesStore


NAV = [
    {"id": "tokens", "visible": True},
    {"id": "dashboard", "visible": True},
    {"id": "chat", "visible": False},
    {"id": "feishu", "visible": True},
    {"id": "conversations", "visible": True},
    {"id": "memory", "visible": True},
    {"id": "conductor", "visible": True},
    {"id": "goal-hive", "visible": True},
    {"id": "mykey", "visible": True},
    {"id": "tasks", "visible": True},
    {"id": "autonomous", "visible": True},
]


def _client(tmp_path, monkeypatch):
    target = tmp_path / "ui_preferences.json"
    monkeypatch.setattr(preferences, "_STORE", UiPreferencesStore(target))
    app = FastAPI()
    app.include_router(preferences.router)
    return TestClient(app), target


def test_navigation_preferences_persist_and_reload(tmp_path, monkeypatch):
    client, target = _client(tmp_path, monkeypatch)

    empty = client.get("/api/preferences/navigation")
    assert empty.status_code == 200
    assert empty.json() == {"configured": False, "preferences": []}

    saved = client.put("/api/preferences/navigation", json={"preferences": NAV})
    assert saved.status_code == 200
    assert saved.json() == {"configured": True, "preferences": NAV}
    assert json.loads(target.read_text("utf-8"))["navigation"] == NAV

    # A fresh HTTP client still reads the server-side file rather than browser state.
    app = FastAPI()
    app.include_router(preferences.router)
    with TestClient(app) as restarted:
        restored = restarted.get("/api/preferences/navigation")
    assert restored.json() == {"configured": True, "preferences": NAV}


def test_navigation_preferences_reject_incomplete_or_duplicate_items(tmp_path, monkeypatch):
    client, target = _client(tmp_path, monkeypatch)

    incomplete = client.put("/api/preferences/navigation", json={"preferences": NAV[:-1]})
    duplicate = client.put(
        "/api/preferences/navigation",
        json={"preferences": [*NAV[:-1], NAV[0]]},
    )

    assert incomplete.status_code == 422
    assert duplicate.status_code == 422
    assert not target.exists()
