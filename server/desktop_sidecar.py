"""Tauri-owned FastAPI sidecar with a machine-readable lifecycle protocol.

This is deliberately separate from ``server.run``: pywebview keeps its existing
launcher and port behaviour, while Tauri owns exactly the process it starts.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import secrets
import signal
import socket
import sys
import threading
from pathlib import Path


def _emit(event: str, **fields: object) -> None:
    print(json.dumps({"event": event, **fields}, separators=(",", ":")), flush=True)


def _loopback(value: str) -> str:
    if value not in {"127.0.0.1", "::1"}:
        raise argparse.ArgumentTypeError("desktop sidecar only accepts a loopback host")
    return value


def _available_port(host: str) -> int:
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    with socket.socket(family, socket.SOCK_STREAM) as probe:
        probe.bind((host, 0))
        return int(probe.getsockname()[1])


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="GA-Hub Tauri backend sidecar")
    parser.add_argument("--host", type=_loopback, default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--instance-token", default="")
    parser.add_argument("--admin-data", type=Path)
    parser.add_argument("--ga-root", type=Path)
    return parser.parse_args(argv)


def _stdin_shutdown(server: object) -> None:
    """Treat a newline/EOF from the owning shell as a graceful stop request."""
    try:
        sys.stdin.buffer.readline()
    except (AttributeError, OSError):
        pass
    setattr(server, "should_exit", True)
    _emit("shutdown_requested", reason="owner_stdin")


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    if not 0 <= args.port <= 65535:
        print("port must be between 0 and 65535", file=sys.stderr)
        return 2
    if args.admin_data:
        os.environ["GA_ADMIN_DATA"] = str(args.admin_data.resolve())
    if args.ga_root:
        os.environ["GA_ROOT"] = str(args.ga_root.resolve())

    # Import only after isolation paths have been applied.
    import uvicorn
    from fastapi.routing import APIRoute
    from server.main import app

    port = args.port or _available_port(args.host)
    token = args.instance_token or secrets.token_urlsafe(24)

    async def desktop_ready() -> dict[str, object]:
        return {"ok": True, "instance_token": token, "pid": os.getpid(), "port": port}

    # server.main ends with an SPA catch-all when webui/dist exists.  Insert the
    # shell identity route first so production builds cannot shadow it.
    app.router.routes.insert(
        0,
        APIRoute(
            "/api/desktop/ready",
            desktop_ready,
            methods=["GET"],
            include_in_schema=False,
        ),
    )
    config = uvicorn.Config(
        app, host=args.host, port=port, log_level="info", ws_ping_interval=20,
        ws_ping_timeout=20, access_log=False,
    )
    server = uvicorn.Server(config)
    stop_thread = threading.Thread(target=_stdin_shutdown, args=(server,), daemon=True)

    def request_stop(signum: int, _frame: object) -> None:
        server.should_exit = True
        _emit("shutdown_requested", reason=f"signal_{signum}")

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, request_stop)
        except (ValueError, OSError):
            pass

    _emit("starting", host=args.host, port=port, instance_token=token, pid=os.getpid())
    stop_thread.start()
    try:
        asyncio.run(server.serve())
    except OSError as exc:
        _emit("failed", reason="bind", detail=str(exc), port=port)
        return 4
    code = 0 if server.started else 4
    _emit("stopped", graceful=True, code=code, port=port)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
