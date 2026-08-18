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
from collections.abc import Callable
from pathlib import Path


OWNER_EXIT_WATCHDOG_SECONDS = 12.0
OWNER_HARD_EXIT_CODE = 5


def _emit(event: str, **fields: object) -> None:
    print(json.dumps({"event": event, **fields}, separators=(",", ":")), flush=True)


def _diagnostic(message: str) -> None:
    """Best-effort startup diagnostic even when a windowed build has no stream."""
    stderr = getattr(sys, "stderr", None)
    if stderr is not None:
        try:
            print(message, file=stderr, flush=True)
            return
        except (AttributeError, OSError, TypeError, ValueError):
            pass
    try:
        os.write(2, f"{message}\n".encode("utf-8", errors="replace"))
    except OSError:
        pass


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
    parser.add_argument(
        "--owned-stdin",
        action="store_true",
        help="treat stdin as the owning shell's lifecycle pipe",
    )
    parser.add_argument("--admin-data", type=Path)
    parser.add_argument("--ga-root", type=Path)
    return parser.parse_args(argv)


def _owner_stdin_fd() -> int:
    """Return a validated owner-pipe descriptor or fail before startup."""
    stdin = getattr(sys, "stdin", None)
    if stdin is None:
        raise RuntimeError("stdin is unavailable")
    try:
        fd = os.dup(stdin.fileno())
    except (AttributeError, OSError, TypeError, ValueError) as exc:
        raise RuntimeError(f"stdin has no valid file descriptor: {exc}") from exc
    return fd


def _hard_exit_owned_process_group() -> None:
    """Hard-stop only the process group reserved for this owned sidecar."""
    if os.name == "posix":
        pid = os.getpid()
        try:
            group = os.getpgrp()
            if group == pid:
                os.killpg(group, signal.SIGKILL)
                return
        except OSError:
            pass
    # Windows normally reaches this only if the shell's kill-on-close Job did
    # not fire. On POSIX this is also the safe fallback when the process is not
    # an isolated group leader: never kill a group shared with the caller.
    os._exit(OWNER_HARD_EXIT_CODE)


def _start_owner_exit_watchdog(
    timeout_seconds: float = OWNER_EXIT_WATCHDOG_SECONDS,
    hard_exit: Callable[[], None] | None = None,
) -> threading.Thread:
    """Arm a daemon deadline that survives a stuck application shutdown."""
    exit_now = hard_exit or _hard_exit_owned_process_group

    def enforce_deadline() -> None:
        threading.Event().wait(max(0.0, timeout_seconds))
        exit_now()

    watchdog = threading.Thread(
        target=enforce_deadline,
        daemon=True,
        name="desktop-owner-exit-watchdog",
    )
    watchdog.start()
    return watchdog


def _stdin_shutdown(
    server: object,
    fd: int,
    arm_hard_exit: Callable[[], object] | None = None,
) -> None:
    """Stop when the owner writes a request or closes its lifecycle pipe.

    This reader is started only for explicit ``--owned-stdin`` launches. Any
    byte is a normal shutdown request; EOF means the owning shell disappeared.
    Manual/debug launches never start this reader and therefore remain
    independent of whatever stdin their terminal or launcher provides.
    """
    # Keep this private control channel below Python's buffered stdin layer.
    # The owner deliberately holds the pipe open for the whole desktop
    # lifetime, so a blocking BufferedReader call would monopolise its lock
    # while libraries and child-process probes inspect standard I/O.
    try:
        data = os.read(fd, 1)
    except OSError as exc:
        setattr(server, "should_exit", True)
        if arm_hard_exit is not None:
            arm_hard_exit()
        _emit("shutdown_requested", reason="owner_stdin_error", detail=str(exc))
        return
    finally:
        try:
            os.close(fd)
        except OSError:
            pass
    setattr(server, "should_exit", True)
    if data:
        _emit("shutdown_requested", reason="owner_stdin")
        return
    if arm_hard_exit is not None:
        arm_hard_exit()
    _emit("shutdown_requested", reason="owner_eof")


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    if not 0 <= args.port <= 65535:
        _diagnostic("port must be between 0 and 65535")
        return 2
    owner_stdin_fd: int | None = None
    if args.owned_stdin:
        try:
            owner_stdin_fd = _owner_stdin_fd()
        except RuntimeError as exc:
            _diagnostic(f"owned stdin unavailable: {exc}")
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
    stop_thread = (
        threading.Thread(
            target=_stdin_shutdown,
            args=(server, owner_stdin_fd, _start_owner_exit_watchdog),
            daemon=True,
            name="desktop-owner-stdin",
        )
        if owner_stdin_fd is not None
        else None
    )

    def request_stop(signum: int, _frame: object) -> None:
        server.should_exit = True
        _emit("shutdown_requested", reason=f"signal_{signum}")

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, request_stop)
        except (ValueError, OSError):
            pass

    _emit("starting", host=args.host, port=port, instance_token=token, pid=os.getpid())
    if stop_thread is not None:
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
