"""Trusted browser origins for the loopback GA-Hub backend.

HTTP CORS and WebSocket handshakes must use the same policy.  Browser pages
served by the backend/Vite run on loopback HTTP origins, while packaged Tauri
assets use a fixed application origin.  Clients without an ``Origin`` header
remain supported for local CLI and test tooling.
"""
from __future__ import annotations

import re


TAURI_UI_ORIGINS: tuple[str, ...] = (
    "http://tauri.localhost",
    "https://tauri.localhost",
    "tauri://localhost",
)

# Keep this deliberately narrower than arbitrary ``*.localhost`` origins.
# It covers the backend-served SPA and the Vite development server.
# Accept canonical decimal ports only, including the full URL port range.  The
# same expression is consumed by Starlette CORS and the WebSocket guard so the
# two transports cannot drift at syntax edge cases.
_VALID_PORT_PATTERN = (
    r"(?:[0-9]|[1-9][0-9]{1,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|"
    r"65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])"
)
LOOPBACK_HTTP_ORIGIN_REGEX = (
    rf"^https?://(?:localhost|127\.0\.0\.1|\[::1\])"
    rf"(?::{_VALID_PORT_PATTERN})?$"
)


def is_allowed_ui_origin(origin: str | None) -> bool:
    """Return whether a browser Origin may access GA-Hub WebSockets.

    ``None`` identifies non-browser clients, which are allowed.  Opaque
    origins (``null``), file pages, credential-bearing URLs, and origins with
    paths/query strings/fragments are rejected.
    """
    if origin is None:
        return True
    if origin in TAURI_UI_ORIGINS:
        return True
    return re.fullmatch(LOOPBACK_HTTP_ORIGIN_REGEX, origin) is not None
