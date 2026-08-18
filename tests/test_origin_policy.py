from __future__ import annotations

import pytest

from server.origin_policy import is_allowed_ui_origin


@pytest.mark.parametrize(
    "origin",
    [
        None,
        "http://localhost",
        "http://localhost:5173",
        "http://localhost:0",
        "http://localhost:65535",
        "https://127.0.0.1:8765",
        "http://[::1]:8765",
        "http://tauri.localhost",
        "https://tauri.localhost",
        "tauri://localhost",
    ],
)
def test_allowed_ui_origins(origin: str | None) -> None:
    assert is_allowed_ui_origin(origin)


@pytest.mark.parametrize(
    "origin",
    [
        "",
        "null",
        "file://localhost",
        "https://evil.example",
        "http://localhost.evil.example",
        "HTTP://LOCALHOST:5173",
        "http://tauri.localhost.evil.example",
        "http://localhost.:5173",
        "http://localhost:",
        "http://localhost:01",
        "http://127.0.0.1.:8765",
        "http://127.0.0.2:8765",
        "https://127.255.255.254",
        "http://127.1:8765",
        "http://[::ffff:127.0.0.1]:8765",
        "http://tauri.localhost:80",
        "tauri://localhost/",
        "http://evil@localhost",
        "http://localhost/path",
        "http://localhost/?query",
        "http://localhost/#fragment",
        "http://localhost:99999",
        "http://localhost:65536",
    ],
)
def test_rejected_ui_origins(origin: str) -> None:
    assert not is_allowed_ui_origin(origin)
