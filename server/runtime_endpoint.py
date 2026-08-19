"""Process-local callback address for services that call the Hub API."""
from __future__ import annotations

import os


RUNTIME_HOST_ENV = "GA_HUB_RUNTIME_HOST"
RUNTIME_PORT_ENV = "GA_HUB_RUNTIME_PORT"


def _callback_host(bind_host: str) -> str:
    host = str(bind_host or "").strip().strip("[]")
    if host == "0.0.0.0":
        return "127.0.0.1"
    if host == "::":
        return "::1"
    return host or "127.0.0.1"


def configure_runtime_endpoint(bind_host: str, port: int) -> None:
    """Publish the listener selected by the current launcher process."""
    selected_port = int(port)
    if not 1 <= selected_port <= 65535:
        raise ValueError("Hub runtime port must be between 1 and 65535")
    os.environ[RUNTIME_HOST_ENV] = _callback_host(bind_host)
    os.environ[RUNTIME_PORT_ENV] = str(selected_port)


def runtime_http_origin(default_host: str, default_port: int) -> str:
    """Return the current Hub origin, falling back to launcher configuration."""
    host = _callback_host(os.environ.get(RUNTIME_HOST_ENV, default_host))
    try:
        port = int(os.environ.get(RUNTIME_PORT_ENV, str(default_port)))
    except (TypeError, ValueError):
        port = int(default_port)
    if not 1 <= port <= 65535:
        port = int(default_port)
    authority_host = f"[{host}]" if ":" in host else host
    return f"http://{authority_host}:{port}"
