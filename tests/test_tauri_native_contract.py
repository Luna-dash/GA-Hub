"""Static source contracts for Tauri-native desktop capabilities.

Cargo is a developer prerequisite, not a Python-test prerequisite.  These
checks keep the shell capability boundary observable even when Rust is not
installed locally.
"""
from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def test_native_plugins_are_declared_and_initialized() -> None:
    cargo = _read("src-tauri/Cargo.toml")
    rust = _read("src-tauri/src/main.rs")

    for plugin in ("dialog", "notification", "opener"):
        assert f'tauri-plugin-{plugin} = "2"' in cargo
        assert f"tauri_plugin_{plugin}::init()" in rust


def test_capability_remains_minimal_and_local() -> None:
    capability = json.loads(_read("src-tauri/capabilities/default.json"))

    assert capability["windows"] == ["main"]
    assert capability.get("remote") is None
    assert capability.get("urls", []) == []
    assert set(capability["permissions"]) == {
        "core:default",
        "core:window:allow-show",
        "core:window:allow-set-focus",
        "core:window:allow-maximize",
        "core:window:allow-unmaximize",
        "dialog:default",
        "notification:default",
        "opener:default",
    }


def test_frontend_uses_one_desktop_capability_facade() -> None:
    desktop = _read("webui/src/utils/desktop.ts")

    assert "from '@tauri-apps/plugin-opener'" in desktop
    assert "window.pywebview?.api" in desktop
    assert "source-checkout recovery path" in desktop

    for page in ("webui/src/pages/Conversations.tsx", "webui/src/pages/LiveChat.tsx"):
        source = _read(page)
        assert "pywebview.api.save_export" not in source
        assert "pywebview.api.select_directory" not in source
        assert "from '@/utils/desktop'" in source


def test_tauri_notifications_do_not_fall_back_to_backend() -> None:
    source = _read("webui/src/utils/notify.ts")

    assert "isTauriDesktop()" in source
    assert "sendNotification" in source
    assert "api.notify(title, opts.body || '')" in source
