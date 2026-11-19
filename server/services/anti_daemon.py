"""Manually start the local AntiCLI daemon, using GA-Hub's child registry."""
from __future__ import annotations

import logging
import os
import socket
import subprocess
import sys
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, get_args

from ..process_utils import hidden_process_kwargs
from . import anti_component, anti_profiles, child_job
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
        self._profile_id = anti_profiles.DEFAULT
        self._login: subprocess.Popen | None = None
        self._login_profile: str | None = None
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
            profile_id = anti_profiles.snapshot()[0]
            self._require_login_closed(profile_id)
            return self._start(port, profile_id)

    def _options(self, profile_id: str) -> tuple[str, dict]:
        executable = anti_component.executable()
        if not executable:
            raise AntiError(503, "此版本未附带 AntiCLI，请安装 anticli 并加入 PATH")
        options = anti_component.child_options(executable)
        if profile_id != anti_profiles.DEFAULT:
            env = options.get("env", os.environ.copy())
            if env.get("ANTICLI_DATA_DIR"):
                env = {**env, "ANTICLI_DATA_DIR": str(Path(env["ANTICLI_DATA_DIR"]).expanduser().resolve())}
            options["env"] = anti_profiles.profile_env(profile_id, env)
        return executable, options

    def _start(self, port: int, profile_id: str, prepared: tuple[str, dict] | None = None) -> AntiDaemonStatus:
        executable, options = prepared if prepared is not None else self._options(profile_id)
        try:
            self._process = child_job.spawn(
                [executable, "serve", "--host", "127.0.0.1", "--port", str(port)],
                kind="anticli", marker=executable,
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                **hidden_process_kwargs(), **options,
            )
        except OSError as exc:
            log.warning("Failed to start AntiCLI", exc_info=True)
            raise AntiError(503, "无法启动 AntiCLI，请检查安装与执行权限") from exc
        self._profile_id = profile_id
        self._failure = None
        self._deadline = time.monotonic() + 15
        return AntiDaemonStatus(state="starting")

    def _require_login_closed(self, *profiles: str) -> None:
        if self._login is not None and self._login.poll() is None and self._login_profile in profiles:
            raise AntiError(409, "请完成官方 agy 登录并关闭登录窗口后再操作")

    @contextmanager
    def submission(self):
        with self._lock:
            profile_id = anti_profiles.snapshot()[0]
            self._require_login_closed(profile_id)
            if profile_id != anti_profiles.DEFAULT and (
                self._process is None or self._process.poll() is not None or self._profile_id != profile_id
            ):
                raise AntiError(409, "请先启动当前 Agy 账号的托管网关")
            yield profile_id

    def add_profile(self, name: str):
        with self._lock:
            return anti_profiles.add(name)

    def _await_ready(self, port: int) -> None:
        process = self._process
        assert process is not None
        while time.monotonic() < self._deadline:
            if process.poll() is not None:
                break
            if self._status(port).state == "ready" and process.poll() is None:
                return
            time.sleep(0.2)
        raise AntiError(503, "切换后的 AntiCLI 网关未能就绪")

    def _restore_gateway(self, port: int, profile_id: str, options: tuple[str, dict]) -> None:
        process = self._process
        if process is not None:
            if process.poll() is not None:
                child_job.forget(process.pid)
            elif not child_job.terminate_tree(process.pid):
                raise AntiError(503, "无法停止切换后的网关")
            self._process = None
        if self._status(port).state != "stopped":
            raise AntiError(503, "AntiCLI 端口仍被占用")
        self._start(port, profile_id, options)
        self._await_ready(port)

    def switch_profile(self, profile_id: str) -> None:
        with self._lock:
            active, profiles = anti_profiles.snapshot()
            if not any(p.id == profile_id for p in profiles):
                raise AntiError(404, "找不到 Agy 账号")
            if active == profile_id:
                return
            self._require_login_closed(active, profile_id)
            port = daemon_port()
            status = self._status(port)
            if status.state == "stopped":
                anti_profiles.select(profile_id)
                return
            process = self._process
            if process is None or process.poll() is not None:
                raise AntiError(409, "请先停止外部 AntiCLI；GA-Hub 不会重启外部网关")
            if status.state != "ready" or status.active_count != 0:
                raise AntiError(409, "请等 Agy 网关就绪且任务全部结束后再切换")
            prepared = self._options(profile_id)
            previous = self._options(active)
            if not child_job.terminate_tree(process.pid):
                raise AntiError(503, "无法停止托管 AntiCLI，未切换账号")
            self._process = None
            if self._status(port).state != "stopped":
                raise AntiError(409, "AntiCLI 端口仍被占用，未切换账号")
            try:
                self._start(port, profile_id, prepared)
                self._await_ready(port)
                anti_profiles.select(profile_id)
            except AntiError as exc:
                try:
                    self._restore_gateway(port, active, previous)
                except AntiError:
                    log.warning("Failed to restore previous AntiCLI gateway", exc_info=True)
                    raise AntiError(503, f"未切换账号：{exc}；原网关未能恢复，请检查网关状态") from exc
                raise AntiError(exc.status, f"未切换账号：{exc}；已恢复原网关") from exc

    def login_profile(self, profile_id: str) -> None:
        with self._lock:
            if os.name != "nt":
                raise AntiError(501, "从 GA-Hub 打开 agy 登录窗口目前仅支持 Windows")
            active, profiles = anti_profiles.snapshot()
            if not any(p.id == profile_id for p in profiles):
                raise AntiError(404, "找不到 Agy 账号")
            if self._login is not None:
                if self._login.poll() is None:
                    raise AntiError(409, "请先关闭上一个 agy 登录窗口")
                child_job.forget(self._login.pid)
                self._login = None
            if active == profile_id:
                status = self._status(daemon_port())
                if status.state != "stopped" and (status.state != "ready" or status.active_count != 0):
                    raise AntiError(409, "请等 Agy 网关就绪且任务全部结束后再登录")
            executable = anti_profiles.agy_executable()
            env = anti_profiles.profile_env(profile_id, os.environ.copy())
            cwd = Path(env.get("USERPROFILE") or Path.home())
            try:
                self._login = child_job.spawn([executable], kind="agy-login", marker=executable,
                                              cwd=cwd, env=env, creationflags=subprocess.CREATE_NEW_CONSOLE)
                self._login_profile = profile_id
            except OSError as exc:
                raise AntiError(503, "无法打开官方 agy 登录窗口") from exc


daemon = AntiDaemon()
