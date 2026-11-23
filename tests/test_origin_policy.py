from __future__ import annotations

import pytest

from server.origin_policy import is_allowed_mutating_http_origin, is_allowed_ui_origin


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


def test_mutating_http_origin_enforces_exact_port_and_frozen_dev_gate() -> None:
    # Same-port loopback and packaged Tauri origins are always allowed.
    assert is_allowed_mutating_http_origin(None, "127.0.0.1:43123", frozen=True)
    assert is_allowed_mutating_http_origin("https://tauri.localhost", "127.0.0.1:43123", frozen=True)
    assert is_allowed_mutating_http_origin("http://127.0.0.1:43123", "127.0.0.1:43123", frozen=True)
    assert is_allowed_mutating_http_origin("http://localhost:8765", "127.0.0.1:8765", frozen=True)

    # Vite dev port is allowed in source mode, but rejected in frozen production builds.
    assert is_allowed_mutating_http_origin("http://localhost:5173", "127.0.0.1:8765", frozen=False)
    assert not is_allowed_mutating_http_origin("http://localhost:5173", "127.0.0.1:43123", frozen=True)

    # Arbitrary local ports and external/null origins are always rejected on mutations.
    for untrusted in (
        "https://evil.example",
        "null",
        "file://localhost",
        "http://localhost:3000",
        "http://127.0.0.1:8888",
    ):
        assert not is_allowed_mutating_http_origin(untrusted, "127.0.0.1:8765", frozen=False)
        assert not is_allowed_mutating_http_origin(untrusted, "127.0.0.1:43123", frozen=True)


def test_app_middleware_blocks_cross_origin_and_cross_port_mutations() -> None:
    from fastapi.testclient import TestClient
    from server.main import app

    with TestClient(app, base_url="http://127.0.0.1:8765") as client:
        for bad_origin in ("https://evil.example", "null", "http://localhost:3000"):
            resp = client.delete("/api/file-transfer", headers={"Origin": bad_origin})
            assert resp.status_code == 403, (bad_origin, resp.text)
            assert resp.text == "Forbidden origin"
