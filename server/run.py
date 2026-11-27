"""Entrypoint: ``python -m server.run`` or ``python server/run.py``.

Starts the FastAPI app via uvicorn, defaulting to 127.0.0.1:8765.
Reads optional config from mykey.py: ``webui_port``, ``webui_host``.
"""
from __future__ import annotations

import logging
import os
import socket
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "frontends"))

# When the parent launcher is started via .pyw (Windows pythonw.exe — no
# console) and spawns us with CREATE_NO_WINDOW, sys.stdout/sys.stderr inherit
# as None. uvicorn's default ColourizedFormatter calls sys.stdout.isatty()
# during logging config and crashes. Patch before importing uvicorn.
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w", encoding="utf-8")

from pathlib import Path

from server.constants import DEFAULT_WEBUI_PORT
from server.instance_lock import (
    AdminDataLockBusyError,
    acquire_admin_data_lock,
    release_admin_data_lock,
)


def _read_config() -> tuple[str, int]:
    host, port = "127.0.0.1", DEFAULT_WEBUI_PORT
    try:
        import mykey  # type: ignore
        host = getattr(mykey, "webui_host", host) or host
        port = int(getattr(mykey, "webui_port", port) or port)
    except Exception:
        pass
    return host, port


def _ensure_single_instance(admin_data: Path):
    """Acquire an OS file lock on ADMIN_DATA so CLI and desktop modes never collide."""
    try:
        handle = acquire_admin_data_lock(admin_data)
    except AdminDataLockBusyError as exc:
        print(f"[server] {exc}", file=sys.stderr)
        sys.exit(1)
    globals()["_lock_handle"] = handle
    return handle


def main():
    from server import _paths
    from server.logging_config import configure_application_logging
    from server.process_utils import install_silent_subprocess_default

    install_silent_subprocess_default()

    log_path = configure_application_logging(_paths.ADMIN_DATA / "logs")
    logging.getLogger(__name__).info("backend log file: %s", log_path)
    host, port = _read_config()
    lock_handle = _ensure_single_instance(_paths.ADMIN_DATA)
    from server.runtime_endpoint import configure_runtime_endpoint
    configure_runtime_endpoint(host, port)

    try:
        import uvicorn  # noqa
    except ImportError:
        release_admin_data_lock(lock_handle)
        print("[server] uvicorn not installed. Run: pip install -r requirements.txt", file=sys.stderr)
        sys.exit(1)

    print(f"[server] starting GenericAgent admin API on http://{host}:{port}")
    print(f"[server]   docs: http://{host}:{port}/docs")
    import uvicorn
    try:
        uvicorn.run(
            "server.main:app",
            host=host,
            port=port,
            reload=False,
            log_level="info",
            ws_ping_interval=20,
            ws_ping_timeout=20,
        )
    finally:
        release_admin_data_lock(lock_handle)


if __name__ == "__main__":
    main()
