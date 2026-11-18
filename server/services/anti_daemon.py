"""Manually start the local AntiCLI daemon, using GA-Hub's child registry."""
from __future__ import annotations

import logging
import shutil
import socket
import subprocess
import sys
import threading
import time
from typing import Literal

from pydantic import BaseModel

from ..process_utils import hidden_process_kwargs
from . import child_job
from .anti_engine import AntiAdapter, AntiError, daemon_port

log = logging.getLogger(__name__)


class AntiDaemonStatus(BaseModel):
    state: Literal["stopped", "starting", "ready", "unavailable"]
    detail: str | None = None
    agy_available: bool | None = None
    active_count: int | None = None


class AntiDaemon:
    def __init__(self):
        self._lock = threading.Lock()
        self._process: subprocess.Popen | None = None
        self._deadline = 0.0
        self._failure: str | None = None

    def _status(self, port: int) -> AntiDaemonStatus:
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
                                    detail=None if agy else "AntiCLI 已启动，但找不到官方 agy CLI")
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

    def status(self) -> AntiDaemonStatus:
        with self._lock:
            return self._status(daemon_port())

    def start(self) -> AntiDaemonStatus:
        with self._lock:
            port = daemon_port()
            status = self._status(port)
            if status.state != "stopped":
                return status
            executable = shutil.which("anticli")
            if not executable:
                raise AntiError(503, "找不到 anticli，请先安装并将它添加到 GA Hub 的 PATH")
            try:
                self._process = child_job.spawn(
                    [executable, "serve", "--host", "127.0.0.1", "--port", str(port)],
                    kind="anticli", marker=executable,
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    **hidden_process_kwargs(),
                )
            except OSError as exc:
                log.warning("Failed to start AntiCLI", exc_info=True)
                raise AntiError(503, "无法启动 AntiCLI，请检查安装与执行权限") from exc
            self._failure = None
            self._deadline = time.monotonic() + 15
            return AntiDaemonStatus(state="starting")


daemon = AntiDaemon()
