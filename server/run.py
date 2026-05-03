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


def _read_config() -> tuple[str, int]:
    host, port = "127.0.0.1", 8765
    try:
        import mykey  # type: ignore
        host = getattr(mykey, "webui_host", host) or host
        port = int(getattr(mykey, "webui_port", port) or port)
    except Exception:
        pass
    return host, port


def _ensure_single_instance(port: int) -> None:
    """Bind a tiny lock socket on port+1 to prevent two backends fighting over the agent."""
    lock_port = port + 1
    lock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    lock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        lock.bind(("127.0.0.1", lock_port))
        lock.listen(1)
    except OSError as e:
        print(
            f"[server] another GenericAgent backend appears to hold lock port {lock_port}: {e}\n"
            f"         If this is a stale process, find & kill it:\n"
            f"         macOS/Linux:  lsof -iTCP:{lock_port} -sTCP:LISTEN  →  kill -9 <PID>\n"
            f"         Windows:      netstat -ano | findstr :{lock_port}  →  taskkill /PID <PID> /F",
            file=sys.stderr,
        )
        sys.exit(1)
    # keep ref alive
    globals()["_lock_sock"] = lock


def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-5s %(name)s :: %(message)s",
    )
    host, port = _read_config()
    _ensure_single_instance(port)

    try:
        import uvicorn  # noqa
    except ImportError:
        print("[server] uvicorn not installed. Run: pip install -e \".[webui]\"", file=sys.stderr)
        sys.exit(1)

    print(f"[server] starting GenericAgent admin API on http://{host}:{port}")
    print(f"[server]   docs: http://{host}:{port}/docs")
    import uvicorn
    uvicorn.run(
        "server.main:app",
        host=host,
        port=port,
        reload=False,
        log_level="info",
        ws_ping_interval=20,
        ws_ping_timeout=20,
    )


if __name__ == "__main__":
    main()
