"""Trusted browser origins for the loopback GA-Hub backend.

HTTP CORS and WebSocket handshakes must use the same policy.  Browser pages
served by the backend/Vite run on loopback HTTP origins, while packaged Tauri
assets use a fixed application origin.  Clients without an ``Origin`` header
remain supported for local CLI and test tooling.
"""
from __future__ import annotations

import re
import sys
from urllib.parse import urlsplit

from .constants import VITE_DEV_PORT


TAURI_UI_ORIGINS: tuple[str, ...] = (
    "http://tauri.localhost",
    "https://tauri.localhost",
    "tauri://localhost",
)
DEV_VITE_PORTS: frozenset[int] = frozenset({VITE_DEV_PORT, 4173})

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


def _authority_port(authority: str, default_port: int = 80) -> int | None:
    raw = (authority or "").strip()
    if not raw:
        return None
    if raw.startswith("["):
        end = raw.find("]")
        if end == -1:
            return None
        rest = raw[end + 1 :]
        if not rest:
            return default_port
        if not rest.startswith(":"):
            return None
        port_str = rest[1:]
    elif ":" in raw:
        _, _, port_str = raw.rpartition(":")
    else:
        return default_port
    if not port_str.isdigit():
        return None
    port = int(port_str)
    return port if 0 <= port <= 65535 else None


def is_allowed_mutating_http_origin(
    origin: str | None,
    host_header: str | None,
    *,
    frozen: bool | None = None,
) -> bool:
    """Validate ``Origin`` on mutating HTTP requests (POST/PUT/PATCH/DELETE).

    Rejects cross-site browser requests (e.g. ``https://evil.example``, ``null``)
    and unrelated local ports (e.g. ``http://localhost:3000``), while allowing:
      * non-browser local clients with no ``Origin`` header
      * packaged Tauri WebView origins (``TAURI_UI_ORIGINS``)
      * same-port loopback browser UI / Nova local gateway (``Origin`` port == ``Host`` port)
      * Vite dev ports (5173/4173) and ``http://testserver`` in non-frozen dev/test runs
    """
    if origin is None:
        return True
    if origin in TAURI_UI_ORIGINS:
        return True
    is_frozen = getattr(sys, "frozen", False) if frozen is None else frozen
    allow_dev = not is_frozen
    if allow_dev and origin in {"http://testserver", "https://testserver"}:
        return True
    if re.fullmatch(LOOPBACK_HTTP_ORIGIN_REGEX, origin) is None:
        return False
    parsed = urlsplit(origin)
    default_origin_port = 443 if parsed.scheme == "https" else 80
    origin_port = parsed.port if parsed.port is not None else default_origin_port
    host_port = _authority_port(host_header or "", default_origin_port)
    if host_port is not None and origin_port == host_port:
        return True
    if allow_dev and origin_port in DEV_VITE_PORTS:
        return True
    return False
