"""HTTP/SSE client for the GA-side gahub_app conductor frontend.

GA-Hub no longer imports GA Python symbols on the conductor path. It talks
to ``frontends/gahub_app.py`` — spawned and supervised here as a managed
subprocess — over HTTP, and consumes its SSE event stream. This module owns
transport only: request calls, subprocess supervision, and the SSE reader
loop. Product logic (workflow tracking, chat admission, model policy)
stays in conductor_service.

On Windows the engine is started *through* ``cmd.exe`` rather than directly
(``_shell_launch``): a frozen sidecar's spawn of an unsigned interpreter hangs
before the child's first line of output, a signed system parent does not.
Everything that follows from that — the cage adoption of cmd's child and the
tree-wide reap — is handled here and in ``child_job``.
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
from typing import Any, Callable, Optional

import requests

from .. import _paths
from ..constants import (
    CONDUCTOR_ENGINE_PORT,
    ENV_GAHUB_DELIVERABLE_ROOTS,
    ENV_GAHUB_JOURNAL_PATH,
    ENV_GAHUB_MULTI_REQUEST_TURNS,
    ENV_GAHUB_PATH_POLICY,
    ENV_GAHUB_TEMP_DIR,
)
from ..process_utils import hidden_process_kwargs
from . import child_job

log = logging.getLogger(__name__)

DEFAULT_PORT = CONDUCTOR_ENGINE_PORT
# Never route loopback traffic through HTTP_PROXY: the desktop sidecar's
# environment may lack NO_PROXY, which blackholes every health check.
NO_PROXY_KWARGS = {"proxies": {"http": None, "https": None}}


def _open_engine_log() -> tuple:
    """Open the engine log for a fresh spawn.

    The canonical path is shared across every hub instance and engine on the
    machine. A live holder — typically an orphaned engine whose parent
    backend died — must not block spawning a new engine, so fall back to a
    unique per-process file when the canonical path refuses the open.
    Returns ``(handle, path)``.
    """
    base = os.environ.get(ENV_GAHUB_TEMP_DIR) or tempfile.gettempdir()
    log_path = os.path.join(base, "gahub_app.log")
    try:
        return open(log_path, "ab"), log_path
    except OSError:
        # Windows locks held by a live holder surface as PermissionError; a
        # stray directory at the canonical path surfaces as IsADirectoryError.
        # Either way a unique per-process file keeps the spawn alive.
        fallback = os.path.join(
            base, f"gahub_app-{os.getpid()}-{int(time.time())}.log")
        log.warning("engine log %s is locked by another process; using %s",
                    log_path, fallback)
        return open(fallback, "ab"), fallback


def _clean_child_env() -> dict:
    """Strip PyInstaller's _MEI temp dirs from PATH for spawned children.

    The frozen sidecar prepends its extraction dir (bundled runtime DLLs) to
    PATH; a spawned conda/venv python then resolves incompatible DLLs from
    there and hangs before producing any output. Children get a PATH without
    _MEI entries and no PyInstaller bookkeeping variables.
    """
    env = dict(os.environ)
    path = env.get("PATH", "")
    kept = [item for item in path.split(os.pathsep)
            if item and "_MEI" not in item]
    env["PATH"] = os.pathsep.join(kept)
    for key in list(env):
        if key.startswith("_PYI") or key.upper().startswith("PYINSTALLER"):
            env.pop(key, None)
    return env


def _engine_spawn_env() -> dict:
    """Child env for the engine process, plus hub-side journal enablement.

    GAHUB_JOURNAL_PATH points the engine's durable run journal (P2-A,
    append-only JSONL truth stream) at a hub-owned file under ADMIN_DATA.
    An operator-provided GAHUB_DELIVERABLE_ROOTS value is passed through as an
    optional allow-list. When it is absent, the engine accepts explicit
    absolute user paths on any drive; the supervisor prompt still uses
    ``<GA_ROOT>\\temp`` as the default delivery location.

    GAHUB_MULTI_REQUEST_TURNS is forced to "off": the hub's task model is
    one task (= one request_id = one archive) per turn, so a coalesced
    multi-request wake has no archive to belong to. Unlike the journal and
    path settings above this is an invariant the hub owns, not an operator
    default — an inherited value must not silently re-enable batching.
    """
    env = _clean_child_env()
    env.setdefault(ENV_GAHUB_JOURNAL_PATH, str(_paths.gahub_journal_file()))
    env.setdefault(ENV_GAHUB_PATH_POLICY, "allowed_roots" if
                   env.get(ENV_GAHUB_DELIVERABLE_ROOTS, "").strip()
                   else "explicit_absolute")
    env[ENV_GAHUB_MULTI_REQUEST_TURNS] = "off"
    return env


class GahubProcessError(RuntimeError):
    """The gahub_app subprocess could not be started or became unhealthy."""

    def __init__(self, message: str, *, status_code: Optional[int] = None,
                 detail: Any = None):
        super().__init__(message)
        # HTTP status returned by the engine, when the failure is an engine
        # response rather than a transport/startup failure.
        self.status_code = status_code
        # Complete engine error body, separate from the printable message.
        self.detail = detail


def _config_int(key: str, default: int) -> int:
    try:
        cfg = _paths.load_config()
        value = cfg.get(key)
        if value is not None:
            return int(value)
    except Exception:
        pass
    # Env override GAHUB_<KEY.upper()> — the doubled-prefix result names are
    # hand-registered in constants.py (dynamic build beats the scan).
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


# Characters cmd.exe parses as syntax even in the middle of an argument; the
# quoting in _cmd_quote is what keeps them literal.
_CMD_METACHARACTERS = "&|<>^"


def _cmd_quote(part: str) -> str:
    """Quote one argv element so cmd.exe passes it to the engine verbatim.

    Started directly, an argument is just a string. Through ``cmd.exe /c`` it
    is parsed as shell text first, so anything cmd reads as syntax (whitespace,
    ``&|<>^``) has to be neutralized — inside double quotes cmd keeps those
    literal. The C-runtime escaping :func:`subprocess.list2cmdline` adds
    (backslashes, embedded quotes) is layered on top because that is what the
    engine's own argv parse expects to see.
    """
    part = str(part)
    if part and not any(ch in part for ch in " \t" + _CMD_METACHARACTERS):
        return part
    quoted = subprocess.list2cmdline([part])
    if quoted.startswith('"') and quoted.endswith('"'):
        return quoted
    # list2cmdline quotes for the C runtime only (whitespace/empty); a part
    # whose sole offense is a cmd metacharacter is quoted here instead.
    #
    # One value class does not round-trip: an argument that itself contains a
    # double quote (cmd has no escape for it — the C-runtime `\"` is not one).
    # Nothing on this command line can carry one today: paths may not contain a
    # quote on Windows, and host/port are fixed — the operator's token would
    # have to spell one out to hit it.
    return f'"{quoted}"'


def _shell_launch(cmd: list) -> tuple:
    """Route a spawn through the signed system shell; returns ``(args, kwargs)``.

    Spawning the engine straight from the *frozen* sidecar is what hangs: three
    attempts out of three produced a child with no output, no CPU and no
    listener, while the very same command from a non-frozen parent is up in
    seconds (see ``_log_spawn_context`` for the AV-suspension history this
    repeats). Making ``cmd.exe`` the direct parent puts a signed system binary
    between the unsigned bundle and the engine, which the reputation scan does
    not hold up.

    Quoting is the delicate part, and the reason this returns a *string*: cmd
    strips the first and last quote of a ``/c`` command line, so the engine
    command is wrapped in one extra pair — the classic ``cmd /c ""prog" args"``
    form. A list cannot express that, because ``Popen`` escapes an element's
    quotes as ``\"`` and cmd does not read that escape. ``executable`` pins the
    interpreter so the launcher does not depend on how cmd's path is parsed off
    the command line.

    POSIX keeps the direct exec: no shell parses an argv there.
    """
    if os.name != "nt":
        return cmd, {}
    comspec = os.environ.get("ComSpec") or os.path.join(
        os.environ.get("SystemRoot", r"C:\Windows"), "System32", "cmd.exe")
    inner = " ".join(_cmd_quote(part) for part in cmd)
    return f'{comspec} /c "{inner}"', {"executable": comspec}


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

    def _terminate_child(self, proc: subprocess.Popen, timeout: float = 3.0) -> None:
        """Best-effort teardown of a child this manager spawned.

        The spawn-failure paths must not leak the child: one that never became
        healthy (e.g. AV-suspended at birth) keeps running indefinitely and —
        if it got as far as binding — holds the engine's singleton lock, so
        every later start attempt would stack another process on top of it
        (2026-09-08 zombie-farm diagnosis: 8 leaked children in one morning).
        """
        self._reap_process_tree(proc, timeout)

    def _reap_process_tree(self, proc: subprocess.Popen, timeout: float = 3.0) -> bool:
        """Stop a spawned child **and its descendants**; ``True`` when it is gone.

        ``self._proc`` is the ``cmd.exe`` intermediary (see
        :func:`_shell_launch`), and Windows' ``TerminateProcess`` stops at the
        process it is handed: terminating cmd alone would leave the engine
        running with the port and the singleton lock. The pid is therefore
        reaped as a tree, which also covers the engine's own children.

        The pid route is taken only while the child is demonstrably alive — a
        pid that outlived its process may already belong to somebody else, and
        the Popen handle (which survives pid reuse) is the safe lever then.
        """
        pid = getattr(proc, "pid", None)
        try:
            live = proc.poll() is None
        except Exception:
            live = True
        try:
            if live and child_job.terminate_tree(pid, timeout):
                try:
                    # Release the Popen handle; nothing is behind it now.
                    proc.wait(timeout=2.0)
                except Exception:
                    pass
                return True
            if live:
                # The tree walk could not describe the child (no psutil, or a
                # pid it refuses): the handle still stops the intermediary, but
                # anything below it may survive this reap.
                log.warning("gahub_app tree reap failed pid=%r; reaping the "
                            "handle only", pid)
            proc.terminate()
            try:
                proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=2.0)
            return True
        except Exception:
            log.exception("gahub_app_child_reap_failed pid=%r", pid)
            return False
        finally:
            # The registry row exists to heal a leak; this child is gone. This
            # is an error path, so it must not raise on a partial process
            # object in the way a bare ``proc.pid`` would.
            child_job.forget(pid)

    def ensure_running(self, startup_timeout: float = 60.0) -> None:
        """Spawn gahub_app when unhealthy and wait for /health."""
        if self.is_healthy():
            return
        with self._lock:
            if self.is_healthy():
                return
            if self._proc is not None:
                # A child we spawned earlier and never reaped (unhealthy or
                # hung). Reap it first so the fresh spawn starts clean; a
                # recovered child would have been adopted by the health
                # checks above instead of reaching this point.
                self._terminate_child(self._proc)
                self._proc = None
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
            log_file, log_path = _open_engine_log()
            engine_cmd = [self.python_exe, "-u", script, "--host", "127.0.0.1",
                          "--port", str(self.port)]
            if self.token:
                engine_cmd += ["--token", self.token]
            # Through the signed system shell on Windows — see _shell_launch.
            spawn_cmd, spawn_kwargs = _shell_launch(engine_cmd)
            self._log_spawn_context(
                log_file, launch="cmd.exe" if isinstance(spawn_cmd, str) else "direct"
            )
            log.info("gahub_app_spawn cmd=%s",
                     spawn_cmd if isinstance(spawn_cmd, str) else " ".join(spawn_cmd))
            self._proc = child_job.spawn(
                spawn_cmd, kind="engine", marker=script, cwd=self.ga_root,
                stdout=log_file, stderr=subprocess.STDOUT,
                # Inheriting the sidecar's stdin would hand the engine the
                # owner pipe whose EOF is the app's shutdown signal.
                stdin=subprocess.DEVNULL,
                env=_engine_spawn_env(), **spawn_kwargs, **hidden_process_kwargs(),
            )
            # The engine is cmd's child, and cmd may have started it before
            # joining the cage (child_job §8.4 window): adopt it explicitly.
            child_job.cage_descendants(getattr(self._proc, "pid", None))
            deadline = time.monotonic() + startup_timeout
            while time.monotonic() < deadline:
                if self.is_healthy():
                    # The engine is up, so it is findable now even when the
                    # call above ran before cmd had started it.
                    child_job.cage_descendants(getattr(self._proc, "pid", None))
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
        if self._proc is not None:
            # Do not leak the child that failed to become healthy: reap it
            # before reporting so the next start attempt begins from a clean
            # slate (TerminateProcess also works on AV-suspended children).
            self._terminate_child(self._proc)
            self._proc = None
        raise GahubProcessError(
            f"gahub_app did not become healthy within {startup_timeout}s ({detail}); "
            "if the log tail is empty, security software may be suspending "
            "children of this unsigned exe — add an AV exclusion or start "
            "gahub_app as a scheduled task"
        )

    def _log_spawn_context(self, log_file, *, launch: str = "direct") -> None:
        """Record the spawn context in the engine log before spawning.

        History (2026-09-07, three live rounds): the frozen sidecar's AV
        suspends every *short-lived* child for a reputation scan — pipe or
        file stdout, ``-c`` or script file, it makes no difference — and a
        child that finishes inside the scan deadlocks with it forever.
        Long-lived children (the engine itself, fsapp) are always released.
        A pre-flight probe child is therefore the disease it tries to
        diagnose: it hung 3/3, 4/4 and 12/12 across sessions while the real
        engine spawn succeeded right beside it. The engine spawn is its own
        probe — the health-wait loop below reports exactly how it failed.

        ``launch`` names the route the spawn took (``cmd.exe`` when the engine
        is started through the system shell), so a hung child can be told apart
        from a route that was never taken.
        """
        log_file.write(
            f"\n[spawn] python={self.python_exe} frozen={bool(getattr(sys, 'frozen', False))} "
            f"launch={launch} PATH_head={os.environ.get('PATH', '')[:120]}\n".encode("utf-8", "replace")
        )
        log_file.flush()

    def stop(self, timeout: float = 5.0) -> bool:
        """Reap the engine process this manager spawned.

        Second half of app teardown (``ConductorService.shutdown`` stops the
        supervisor first): whatever the engine session did on the way out, the
        child process must not outlive the app — the desktop sidecar's owner
        pipe and ``server.run``'s Ctrl-C both land here through the lifespan.
        The reap covers the whole tree, because the handle here is the
        ``cmd.exe`` intermediary and not the engine itself.
        """
        with self._lock:
            proc, self._proc = self._proc, None
        if proc is None:
            return True
        return self._reap_process_tree(proc, timeout)


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
            try:
                detail = resp.json()
            except ValueError:
                detail = resp.text[:200]
            message = detail
            if isinstance(message, dict):
                message = message.get("error") or message.get("detail") or message
            if isinstance(message, list):
                message = "; ".join(
                    str(item["msg"]) for item in message
                    if isinstance(item, dict) and item.get("msg")
                ) or message
            raise GahubProcessError(
                f"gahub_app {path} -> {resp.status_code}: {message}",
                status_code=resp.status_code,
                detail=detail,
            )
        return resp.json() if resp.content else {}

    # -- lifecycle ------------------------------------------------------------
    def status(self) -> dict:
        return self._request("GET", "/status")

    def recovery(self) -> dict:
        return self._request("GET", "/recovery")

    def get_subagents(self) -> dict:
        return self._request("GET", "/subagent")

    def operation(self, operation_id: str, scope: str = "worker_action") -> dict:
        return self._request("GET", f"/operations/{operation_id}", params={"scope": scope})

    def start(self, llm_index: Optional[int] = None) -> dict:
        return self._request("POST", "/start", json_body={
            "llm_index": llm_index,
        })

    def stop(self, timeout: float = 5.0) -> dict:
        return self._request("POST", "/stop", json_body={"timeout": timeout},
                             timeout=timeout + 10.0)

    def journal(self, after_seq: int = 0, limit: int = 500) -> dict:
        """Catch-up read of the engine's durable journal (P2-A)."""
        return self._request("GET", "/journal",
                             params={"after_seq": int(after_seq),
                                     "limit": int(limit)})

    # -- models ----------------------------------------------------------------
    def push_models(self, *, conductor_llm_index=None, subagent_llm_index=None,
                    subagent_model_policy=None, preferred_llm_index=None,
                    clear_subagent_llm: bool = False) -> dict:
        return self._request("POST", "/models", json_body={
            "conductor_llm_index": conductor_llm_index,
            "subagent_llm_index": subagent_llm_index,
            "subagent_model_policy": subagent_model_policy,
            "preferred_llm_index": preferred_llm_index,
            "clear_subagent_llm": clear_subagent_llm,
        })

    # -- chat -------------------------------------------------------------------
    def post_chat(self, msg: str, role: str, request_id: Optional[str] = None,
                  final: bool = False,
                  operation_id: Optional[str] = None,
                  expected_boot_id: Optional[str] = None) -> dict:
        body: dict = {
            "msg": msg, "role": role, "request_id": request_id, "final": final,
        }
        if operation_id:
            # P0 idempotency: one id per logical admission; the engine
            # replays the first terminal response on retry.
            body["operation_id"] = operation_id
        if expected_boot_id is not None:
            body["expected_boot_id"] = expected_boot_id
        return self._request("POST", "/chat", json_body=body)

    def get_chat(self, last: int = 20) -> list[dict]:
        return self._request("GET", "/chat", params={"last": last}).get("items", [])

    # -- subagents -----------------------------------------------------------------
    def start_subagent(self, prompt: str, request_id: Optional[str],
                       llm_index: Optional[int], *,
                       goal: Optional[str] = None,
                       boundaries: Optional[list] = None,
                       deliverables: Optional[list] = None,
                       done_when: Optional[str] = None,
                       checks: Optional[list] = None,
                       operation_id: Optional[str] = None,
                       expected_boot_id: Optional[str] = None) -> dict:
        """Dispatch one worker; the engine requires the Contract B manifest.

        ``goal`` plus at least one absolute ``deliverables`` entry are
        mandatory on the engine side — omitting them here means the engine
        answers 422, which the hub maps onto the caller instead of a
        generic 500.
        """
        body: dict = {
            "prompt": prompt, "request_id": request_id, "llm_index": llm_index,
        }
        if operation_id:
            # P0 idempotency: a retried dispatch with the same id replays
            # the first answer instead of spawning a second worker.
            body["operation_id"] = operation_id
        if expected_boot_id is not None:
            body["expected_boot_id"] = expected_boot_id
        if goal is not None:
            body["goal"] = goal
        if boundaries:
            body["boundaries"] = list(boundaries)
        if deliverables:
            body["deliverables"] = list(deliverables)
        if done_when:
            body["done_when"] = done_when
        if checks:
            body["checks"] = list(checks)
        return self._request("POST", "/subagent", json_body=body)

    def subagent_action(self, sid: str, action: str, msg: str = "",
                        request_id: Optional[str] = None,
                        llm_index: Optional[int] = None,
                        origin: Optional[str] = None,
                        force: bool = False, operation_id: Optional[str] = None,
                        expected_boot_id: Optional[str] = None,
                        expected_generation: Optional[int] = None,
                        expected_command_revision: Optional[int] = None) -> dict:
        """One worker action; ``origin="hub"`` marks user/UI-initiated aborts.

        The engine treats a hub-originated abort as a terminal user cancel,
        while a supervisor self-API abort (no origin) stays a recoverable
        worker failure so the supervisor can re-dispatch under the same
        request_id instead of dead-ending the workflow.

        ``force=True`` is the audited accept escape hatch the engine applies
        when its deterministic verification verdict is not clean.
        """
        body: dict = {
            "action": action, "msg": msg, "request_id": request_id,
            "llm_index": llm_index,
        }
        if origin is not None:
            body["origin"] = origin
        if force:
            body["force"] = True
        for key, value in (("operation_id", operation_id), ("expected_boot_id", expected_boot_id),
                           ("expected_generation", expected_generation),
                           ("expected_command_revision", expected_command_revision)):
            if value is not None:
                body[key] = value
        return self._request("POST", f"/subagent/{sid}", json_body=body)

    def get_subagent(self, sid: str, max_len: int = 5000) -> dict:
        return self._request("GET", f"/subagent/{sid}", params={"max_len": max_len})

    # -- observability -----------------------------------------------------------
    def get_log(self, last: int = 50) -> list[dict]:
        return self._request("GET", "/log", params={"last": last}).get("items", [])

    # -- SSE ----------------------------------------------------------------------
    def stream_events(self, on_event: Callable[[dict], None],
                      should_stop: Callable[[], bool],
                      idle_reconnect_after: float = 60.0,
                      on_reconnect: Optional[Callable[[], None]] = None) -> None:
        """Blocking SSE reader with reconnect-until-stopped semantics.

        ``on_reconnect`` runs after every successful (re)connection, before
        any live frame is read — the hook where the durable-journal catch-up
        replay happens, so events dropped between the live hint and the
        reconnect are fed through ``on_event`` in order first.
        """
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
                    if on_reconnect is not None:
                        try:
                            on_reconnect()
                        except Exception:
                            # Reconciliation must never kill the relay.
                            log.exception("on_reconnect hook failed")
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
                        try:
                            on_event(event)
                        except Exception:
                            # A handler bug must never kill the relay thread —
                            # it is the only live event path, and its death
                            # silences the conductor UI until the next user
                            # action restarts it. Losing ONE frame is strictly
                            # better than losing all subsequent ones.
                            log.exception(
                                "gahub_app SSE on_event handler failed; frame dropped: %r",
                                str(event)[:200],
                            )
            except requests.RequestException as exc:
                log.warning("gahub_app SSE stream dropped: %s", exc)
            except GahubProcessError as exc:
                log.warning("gahub_app SSE unavailable: %s", exc)
            if should_stop():
                return
            time.sleep(2.0)
