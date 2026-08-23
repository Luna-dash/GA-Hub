"""HTTP/SSE client for the GA-side gahub_app conductor frontend.

GA-Hub no longer imports GA Python symbols on the conductor path. It talks
to ``frontends/gahub_app.py`` — spawned and supervised here as a managed
subprocess — over HTTP, and consumes its SSE event stream. This module owns
transport only: request calls, subprocess supervision, and the SSE reader
loop. Product logic (workflow tracking, chat admission, model policy)
stays in conductor_service.
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import tempfile
import threading
import time
from typing import Callable, Optional

import requests

from .. import _paths
from ..process_utils import hidden_process_kwargs

log = logging.getLogger(__name__)

DEFAULT_PORT = 18770
# Never route loopback traffic through HTTP_PROXY: the desktop sidecar's
# environment may lack NO_PROXY, which blackholes every health check.
NO_PROXY_KWARGS = {"proxies": {"http": None, "https": None}}


class GahubProcessError(RuntimeError):
    """The gahub_app subprocess could not be started or became unhealthy."""


def _config_int(key: str, default: int) -> int:
    try:
        cfg = _paths.load_config()
        value = cfg.get(key)
        if value is not None:
            return int(value)
    except Exception:
        pass
    env = os.environ.get(f"GAHUB_{key.upper()}")
    if env and env.isdigit():
        return int(env)
    return default


def _config_str(key: str) -> Optional[str]:
    try:
        cfg = _paths.load_config()
        value = cfg.get(key)
        if value:
            return str(value)
    except Exception:
        pass
    return os.environ.get(f"GAHUB_{key.upper()}") or None


def _resolve_python_exe(ga_root: Optional[str]) -> str:
    """Find a real interpreter for gahub_app.py.

    In the frozen sidecar ``sys.executable`` is the bundle launcher, not a
    Python; reuse the project's discovery chain (config python_path, GA
    virtualenvs, PATH) instead of relaunching ourselves.
    """
    explicit = _config_str("gahub_python")
    if explicit and os.path.isfile(explicit):
        return explicit
    try:
        discovered = _paths.discover_user_python(ga_root)
        if discovered:
            return discovered
    except Exception:
        log.debug("user python discovery failed", exc_info=True)
    return sys.executable


class GahubProcessManager:
    """Supervise the GA-side gahub_app.py subprocess (sidecar pattern)."""

    def __init__(
        self,
        ga_root: Optional[str] = None,
        port: Optional[int] = None,
        token: Optional[str] = None,
        python_exe: Optional[str] = None,
        spawn_enabled: bool = True,
    ):
        self.ga_root = ga_root or _paths.GA_ROOT
        self.port = port if port is not None else _config_int("gahub_port", DEFAULT_PORT)
        self.token = token if token is not None else _config_str("gahub_token")
        self.python_exe = python_exe or _resolve_python_exe(self.ga_root)
        self.spawn_enabled = spawn_enabled
        self._proc: Optional[subprocess.Popen] = None
        self._lock = threading.Lock()

    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def is_healthy(self, timeout: float = 1.0) -> bool:
        try:
            resp = requests.get(f"{self.base_url()}/health", timeout=timeout,
                                headers=self._headers(), **NO_PROXY_KWARGS)
            return resp.status_code == 200
        except requests.RequestException:
            return False

    def _headers(self) -> dict:
        return {"X-GAHub-Token": self.token} if self.token else {}

    def ensure_running(self, startup_timeout: float = 60.0) -> None:
        """Spawn gahub_app when unhealthy and wait for /health."""
        if self.is_healthy():
            return
        with self._lock:
            if self.is_healthy():
                return
            script = os.path.join(self.ga_root or "", "frontends", "gahub_app.py")
            if not os.path.isfile(script):
                raise GahubProcessError(
                    f"gahub_app.py not found under {self.ga_root}; "
                    "point GA_ROOT at a GenericAgent checkout"
                )
            if not self.spawn_enabled:
                raise GahubProcessError(
                    "gahub_app is not running and subprocess spawning is disabled"
                )
            if getattr(sys, "frozen", False) and os.path.abspath(
                self.python_exe
            ) == os.path.abspath(sys.executable):
                raise GahubProcessError(
                    "refusing to respawn the frozen sidecar as the gahub_app "
                    "interpreter; set gahub_python in config"
                )
            cmd = [self.python_exe, "-u", script, "--host", "127.0.0.1",
                   "--port", str(self.port)]
            if self.token:
                cmd += ["--token", self.token]
            log.info("Spawning gahub_app: %s", " ".join(cmd))
            log_path = os.path.join(
                os.environ.get("GAHUB_TEMP_DIR") or tempfile.gettempdir(),
                "gahub_app.log",
            )
            log_file = open(log_path, "ab")
            self._proc = subprocess.Popen(
                cmd, cwd=self.ga_root,
                stdout=log_file, stderr=subprocess.STDOUT,
                **hidden_process_kwargs(),
            )
            deadline = time.monotonic() + startup_timeout
            while time.monotonic() < deadline:
                if self.is_healthy():
                    return
                if self._proc.poll() is not None:
                    raise GahubProcessError(
                        f"gahub_app exited with code {self._proc.returncode} during startup"
                    )
                time.sleep(0.25)
        detail = f"python={self.python_exe} poll={self._proc.poll() if self._proc else 'n/a'}"
        try:
            with open(log_path, "rb") as f:
                tail = f.read()[-400:].decode("utf-8", "replace").replace("\n", " | ")
            detail += f" log_tail={tail}"
        except Exception:
            pass
        raise GahubProcessError(
            f"gahub_app did not become healthy within {startup_timeout}s ({detail})"
        )

    def stop(self, timeout: float = 5.0) -> bool:
        with self._lock:
            proc, self._proc = self._proc, None
        if proc is None:
            return True
        try:
            proc.terminate()
            try:
                proc.wait(timeout=timeout)
                return True
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=2.0)
                return True
        except Exception:
            log.exception("Failed to stop the gahub_app subprocess")
            return False


class GaConductorClient:
    """Thin HTTP wrapper around gahub_app; transport errors raise."""

    def __init__(self, process_manager: GahubProcessManager, timeout: float = 10.0):
        self.pm = process_manager
        self.timeout = timeout

    # -- plumbing -----------------------------------------------------------
    def _url(self, path: str) -> str:
        return f"{self.pm.base_url()}{path}"

    def _request(self, method: str, path: str, *, json_body=None,
                 params=None, timeout: Optional[float] = None) -> dict:
        try:
            resp = requests.request(
                method, self._url(path), json=json_body, params=params,
                headers=self.pm._headers(), timeout=timeout or self.timeout,
                **NO_PROXY_KWARGS,
            )
        except requests.RequestException as exc:
            raise GahubProcessError(f"gahub_app request failed ({path}): {exc}") from exc
        if resp.status_code >= 400:
            detail = ""
            try:
                detail = resp.json().get("error", "") or resp.text[:200]
            except Exception:
                detail = resp.text[:200]
            raise GahubProcessError(f"gahub_app {path} -> {resp.status_code}: {detail}")
        return resp.json() if resp.content else {}

    # -- lifecycle ------------------------------------------------------------
    def status(self) -> dict:
        return self._request("GET", "/status")

    def start(self, llm_index: Optional[int] = None) -> dict:
        return self._request("POST", "/start", json_body={"llm_index": llm_index})

    def stop(self, timeout: float = 5.0) -> dict:
        return self._request("POST", "/stop", json_body={"timeout": timeout},
                             timeout=timeout + 10.0)

    # -- models ----------------------------------------------------------------
    def llms(self) -> list[dict]:
        return self._request("GET", "/llms").get("llms", [])

    def set_conductor_llm(self, index: int) -> dict:
        return self._request("PUT", "/conductor/llm", json_body={"index": int(index)})

    def push_models(self, *, conductor_llm_index=None, subagent_llm_index=None,
                    subagent_model_policy=None, preferred_llm_index=None) -> dict:
        return self._request("POST", "/models", json_body={
            "conductor_llm_index": conductor_llm_index,
            "subagent_llm_index": subagent_llm_index,
            "subagent_model_policy": subagent_model_policy,
            "preferred_llm_index": preferred_llm_index,
        })

    # -- chat -------------------------------------------------------------------
    def post_chat(self, msg: str, role: str, request_id: Optional[str] = None,
                  final: bool = False) -> dict:
        return self._request("POST", "/chat", json_body={
            "msg": msg, "role": role, "request_id": request_id, "final": final,
        })

    def get_chat(self, last: int = 20) -> list[dict]:
        return self._request("GET", "/chat", params={"last": last}).get("items", [])

    # -- subagents -----------------------------------------------------------------
    def start_subagent(self, prompt: str, request_id: Optional[str],
                       llm_index: Optional[int]) -> dict:
        return self._request("POST", "/subagent", json_body={
            "prompt": prompt, "request_id": request_id, "llm_index": llm_index,
        })

    def subagent_action(self, sid: str, action: str, msg: str = "",
                        request_id: Optional[str] = None,
                        llm_index: Optional[int] = None) -> dict:
        return self._request("POST", f"/subagent/{sid}", json_body={
            "action": action, "msg": msg, "request_id": request_id,
            "llm_index": llm_index,
        })

    def get_subagents(self) -> list[dict]:
        return self._request("GET", "/subagent").get("items", [])

    def get_subagent(self, sid: str, max_len: int = 5000) -> dict:
        return self._request("GET", f"/subagent/{sid}", params={"max_len": max_len})

    # -- observability -----------------------------------------------------------
    def get_log(self, last: int = 50) -> list[dict]:
        return self._request("GET", "/log", params={"last": last}).get("items", [])

    def get_request_usage(self, request_id: str) -> dict:
        return self._request("GET", f"/requests/{request_id}/usage")

    # -- SSE ----------------------------------------------------------------------
    def stream_events(self, on_event: Callable[[dict], None],
                      should_stop: Callable[[], bool],
                      idle_reconnect_after: float = 60.0) -> None:
        """Blocking SSE reader with reconnect-until-stopped semantics."""
        while not should_stop():
            try:
                self.pm.ensure_running()
                resp = requests.get(
                    self._url("/events"), stream=True,
                    headers=self.pm._headers(), timeout=(5.0, idle_reconnect_after),
                    **NO_PROXY_KWARGS,
                )
                with resp:
                    if resp.status_code != 200:
                        raise GahubProcessError(f"/events -> {resp.status_code}")
                    for raw in resp.iter_lines(decode_unicode=True):
                        if should_stop():
                            return
                        if not raw or not raw.startswith("data: "):
                            continue  # heartbeats/comments
                        try:
                            event = json.loads(raw[len("data: "):])
                        except json.JSONDecodeError:
                            log.debug("Ignoring malformed SSE frame: %r", raw[:120])
                            continue
                        on_event(event)
            except requests.RequestException as exc:
                log.warning("gahub_app SSE stream dropped: %s", exc)
            except GahubProcessError as exc:
                log.warning("gahub_app SSE unavailable: %s", exc)
            if should_stop():
                return
            time.sleep(2.0)
