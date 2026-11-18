"""Manually start the local AntiCLI daemon, using GA-Hub's child registry."""
from __future__ import annotations

import logging
import socket
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from typing import Literal, get_args

from ..process_utils import hidden_process_kwargs
from . import anti_component, child_job
from .anti_engine import AntiAdapter, AntiError, daemon_port

log = logging.getLogger(__name__)


AntiDaemonState = Literal["stopped", "starting", "ready", "unavailable"]
AntiAuthState = Literal["checking", "authenticated", "login_required", "unverified"]


@dataclass(frozen=True)
class AntiDaemonStatus:
    state: AntiDaemonState
    detail: str | None = None
    agy_available: bool | None = None
    active_count: int | None = None
    auth_state: AntiAuthState | None = None


class AntiDaemon:
    def __init__(self):
        self._lock = threading.Lock()
        self._process: subprocess.Popen | None = None
        self._deadline = 0.0
        self._failure: str | None = None

    @staticmethod
    def _auth_status() -> AntiAuthState:
        try:
            result = AntiAdapter().request("GET", "/v1/auth", read_timeout=0.6,
                                           headers={"X-AntiCLI-Action": "verify-auth"})
        except AntiError:
            # Older external daemons may not have the auth endpoint.
            return "unverified"
        state = result.get("state") if isinstance(result, dict) else None
        return state if state in get_args(AntiAuthState) else "unverified"

    def _status(self, port: int, *, verify_auth: bool = False) -> AntiDaemonStatus:
        try:
            health = AntiAdapter().request("GET", "/health", read_timeout=0.6)
        except AntiError:
            health = None
        if (isinstance(health, dict) and health.get("status") == "ok"
                and isinstance(health.get("version"), str) and "agy_binary" in health
                and type(health.get("active_count")) is int):
            self._failure = None
            agy = bool(health["agy_binary"])
            return AntiDaemonStatus(state="ready", agy_available=agy, active_count=health["active_count"],
                                    detail=None if agy else "AntiCLI 已启动，但找不到官方 agy CLI",
                                    auth_state=self._auth_status() if agy and verify_auth else None)
        if self._process is not None:
            code = self._process.poll()
            if code is None:
                if time.monotonic() < self._deadline:
                    return AntiDaemonStatus(state="starting")
                return AntiDaemonStatus(state="unavailable", detail="AntiCLI 已启动，但健康检查超时")
            child_job.forget(self._process.pid)
            self._process = None
            self._failure = f"AntiCLI 已退出（退出码 {code}）"
        try:
            # Winsock can take around two seconds to report a refused loopback connection.
            connect_timeout = 3.0 if sys.platform == "win32" else 0.25
            with socket.create_connection(("127.0.0.1", port), timeout=connect_timeout):
                return AntiDaemonStatus(state="unavailable", detail=f"本机端口 {port} 有响应，但 AntiCLI 健康检查未通过")
        except ConnectionRefusedError:
            return AntiDaemonStatus(state="stopped", detail=self._failure)
        except OSError:
            return AntiDaemonStatus(state="unavailable", detail=f"无法确认本机端口 {port} 的状态")

    def status(self, *, verify_auth: bool = False) -> AntiDaemonStatus:
        with self._lock:
            return self._status(daemon_port(), verify_auth=verify_auth)

    def start(self) -> AntiDaemonStatus:
        with self._lock:
            port = daemon_port()
            status = self._status(port)
            if status.state != "stopped":
                return status
            executable = anti_component.executable()
            if not executable:
                raise AntiError(503, "此版本未附带 AntiCLI，请安装 anticli 并加入 PATH")
            try:
                self._process = child_job.spawn(
                    [executable, "serve", "--host", "127.0.0.1", "--port", str(port)],
                    kind="anticli", marker=executable,
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    **hidden_process_kwargs(), **anti_component.child_options(executable),
                )
            except OSError as exc:
                log.warning("Failed to start AntiCLI", exc_info=True)
                raise AntiError(503, "无法启动 AntiCLI，请检查安装与执行权限") from exc
            self._failure = None
            self._deadline = time.monotonic() + 15
            return AntiDaemonStatus(state="starting")


daemon = AntiDaemon()
