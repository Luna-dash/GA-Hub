"""AgentService — singleton wrapper around GeneraticAgent.

Owns one GeneraticAgent instance for the whole web backend. Bridges its
blocking ``put_task → display_queue.get()`` flow to async consumers via
asyncio.to_thread polling.

Imports `agentmain` and `frontends.continue_cmd` from the GenericAgent
project at the path resolved by ``_paths.GA_ROOT``. This module fails
fast if GA_ROOT is not configured — the backend should run in setup mode
in that case (see server.main).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import queue as _q
import re as _re
import subprocess
import sys
import threading
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, AsyncIterator

from .. import _paths

if _paths.GA_ROOT is None:
    raise RuntimeError("AgentService imported before GA_ROOT is configured")

from agentmain import GeneraticAgent  # noqa: E402  (resolved via _paths sys.path)
from frontends.continue_cmd import install as install_continue, reset_conversation  # noqa: E402

from .chat_retry import ChatRetryConfig, classify_recoverable_error, load_chat_retry_config  # noqa: E402
from .event_bus import bus  # noqa: E402

log = logging.getLogger(__name__)

_AUTO_CONTINUE_MAX = 2
_AUTO_CONTINUE_MARKERS = ("[!!! 流异常中断", "[!!! Response truncated: max_tokens")
_AUTO_CONTINUE_PROMPT = "继续上一条回复，从中断处继续，不要重复已经完成的内容。"
_ERROR_RETRY_PROMPT_TEMPLATE = (
    "上一条回复因可恢复的传输/网络错误（{label}）中断。"
    "请自动重试并从中断处继续，不要重复已经完成的内容。"
)


def _mask_secret(s: str) -> str:
    """Return a short, non-recoverable preview of a secret.

    Keeps only the first/last few characters so the UI can show that the
    key changed (visual diff after mykey reload) without exposing it.
    """
    if not isinstance(s, str):
        return ""
    s = s.strip()
    n = len(s)
    if n == 0:
        return ""
    if n <= 8:
        return "*" * n
    return f"{s[:4]}…{s[-4:]}"


# ── Suppress GA-spawned subprocess UI side-effects (per-platform) ────────────
def _patch_ga_subprocess() -> None:
    """Patch ``ga.subprocess.Popen`` so ``code_run`` doesn't pollute the UI.

    Two distinct problems on two platforms, same patch site (GA's module-
    level ``import subprocess``, see ``ga.py:4`` and the ``subprocess.Popen``
    call at ``ga.py:52``):

    **Windows** — ``ga.py:code_run`` builds Popen with only
    ``startupinfo.wShowWindow = SW_HIDE``. SW_HIDE is read by the child
    *after* conhost has already attached a console. When the parent
    (this server, started by pythonw / a no-console frozen exe) lacks a
    console of its own, Windows allocates a fresh one for the child and
    the user sees a black window flash on every code_run. Adding
    ``CREATE_NO_WINDOW`` (0x08000000) tells the OS not to allocate the
    console at all, which is the actual fix.

    **macOS frozen .app** — ``ga.py:27`` builds
    ``[sys.executable, "-X", "utf8", "-u", tmp]`` to run user Python.
    In a PyInstaller-frozen ``.app`` build, ``sys.executable`` points at
    the bundle's Mach-O launcher, not Python. The launcher inherits the
    GUI ``Info.plist`` so each spawn shows up as a fresh Dock icon, and
    ``-X``/``-u`` aren't understood — argv just gets fed back into
    ``launch_webui.pyw:main`` which fails to run the user's code. Fix:
    rewrite ``argv[0]`` to a real ``python3`` interpreter discovered by
    ``_paths.discover_user_python()``. We don't touch the helper-app
    path because user code routinely imports user-pip-installed packages
    (numpy, requests, …) that the frozen interpreter doesn't have.

    Patching strategy is the same on all platforms: override the ``Popen``
    reference inside ``ga``'s module namespace at admin-startup time. The
    wrapper rewrites GA ``code_run`` commands away from Admin's runtime and
    toward the configured / GA-local / system Python interpreter, while also
    preserving Windows no-console behavior. The GA repo stays untouched on
    disk and ``git pull`` on GA never conflicts with admin.
    """
    try:
        import ga as _ga  # type: ignore  # resolved via GA sys.path
        import subprocess as _sp
    except Exception:
        log.exception("could not import ga/subprocess for code_run patch")
        return

    if getattr(_ga.subprocess.Popen, "_admin_wrapped", False):
        return

    real_python = _paths.discover_user_python()
    if not real_python:
        log.warning(
            "no external Python found for GA code_run; falling back to current executable: %s",
            sys.executable,
        )

    _orig_popen = _sp.Popen
    _current_exe = os.path.abspath(sys.executable)
    CREATE_NO_WINDOW = 0x08000000

    def _admin_popen(*args, **kwargs):
        cmd = args[0] if args else kwargs.get("args")
        if real_python and isinstance(cmd, (list, tuple)) and cmd:
            env = kwargs.get("env")
            if env is None:
                env = os.environ.copy()
            else:
                env = dict(env)
            python_dir = os.path.dirname(real_python)
            path = env.get("PATH") or ""
            path_parts = path.split(os.pathsep) if path else []
            if python_dir and python_dir not in path_parts:
                env["PATH"] = python_dir + (os.pathsep + path if path else "")
            env.setdefault("GA_PYTHON", real_python)
            kwargs["env"] = env

            try:
                cmd0 = os.path.abspath(str(cmd[0]))
            except Exception:
                cmd0 = ""
            if cmd0 == _current_exe:
                new_cmd = [real_python, *cmd[1:]]
                if args:
                    args = (new_cmd, *args[1:])
                else:
                    kwargs["args"] = new_cmd

        if os.name == "nt":
            cf = kwargs.get("creationflags") or 0
            kwargs["creationflags"] = cf | CREATE_NO_WINDOW
        return _orig_popen(*args, **kwargs)

    _admin_popen._admin_wrapped = True  # type: ignore[attr-defined]
    _ga.subprocess.Popen = _admin_popen
    log.info(
        "patched ga.subprocess.Popen for code_run python=%s no_window=%s",
        real_python or sys.executable,
        os.name == "nt",
    )


_patch_ga_subprocess()


_WEB_TOOL_WORKER_SCRIPT = r"""
import importlib
import json
import os
import sys
import traceback

protocol_out = sys.stdout
sys.stdout = sys.stderr

ga_root = os.environ.get("GA_ROOT", "")
if ga_root:
    sys.path.insert(0, ga_root)
    sys.path.insert(0, os.path.join(ga_root, "frontends"))

init_error = None
try:
    ga = importlib.import_module("ga")
except Exception as exc:
    init_error = "".join(traceback.format_exception_only(type(exc), exc)).strip()
    ga = None


def send(payload):
    protocol_out.write(json.dumps(payload, ensure_ascii=False, default=str) + "\n")
    protocol_out.flush()


def call_tool(tool, args):
    if init_error:
        return {"status": "error", "msg": f"External GA worker init failed: {init_error}"}
    if tool == "web_scan":
        return ga.web_scan(
            tabs_only=bool(args.get("tabs_only", False)),
            switch_tab_id=args.get("switch_tab_id"),
            text_only=bool(args.get("text_only", False)),
            maxlen=int(args.get("maxlen", 35000)),
        )
    if tool == "web_execute_js":
        return ga.web_execute_js(
            args.get("script", ""),
            switch_tab_id=args.get("switch_tab_id"),
            no_monitor=bool(args.get("no_monitor", False)),
        )
    return {"status": "error", "msg": f"Unknown GA web tool: {tool}"}


for line in sys.stdin:
    try:
        req = json.loads(line)
        result = call_tool(req.get("tool"), req.get("args") or {})
        send({"id": req.get("id"), "ok": True, "result": result})
    except Exception as exc:
        send({
            "id": req.get("id") if "req" in locals() else None,
            "ok": False,
            "error": "".join(traceback.format_exception_only(type(exc), exc)).strip(),
        })
"""


class _ExternalGaWebTools:
    """Stateful proxy for GA browser tools, running under the resolved Python."""

    def __init__(self, python: str, ga_root: Path, timeout: float = 120.0) -> None:
        self.python = python
        self.ga_root = ga_root
        self.timeout = timeout
        self._proc: subprocess.Popen[str] | None = None
        self._responses: dict[str, dict[str, Any]] = {}
        self._cond = threading.Condition()
        self._lock = threading.Lock()

    def call(self, tool: str, args: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            req_id = uuid.uuid4().hex
            try:
                self._start_locked()
                assert self._proc is not None and self._proc.stdin is not None
                self._proc.stdin.write(json.dumps({"id": req_id, "tool": tool, "args": args}, ensure_ascii=False) + "\n")
                self._proc.stdin.flush()
            except Exception as exc:
                self._stop_locked()
                return self._error(f"failed to start external GA web worker with {self.python}: {exc}")

            deadline = time.time() + self.timeout
            with self._cond:
                while req_id not in self._responses:
                    remaining = deadline - time.time()
                    if remaining <= 0:
                        self._stop_locked()
                        return self._error(f"external GA web worker timed out after {int(self.timeout)}s")
                    if self._proc and self._proc.poll() is not None:
                        code = self._proc.returncode
                        self._stop_locked()
                        return self._error(f"external GA web worker exited before responding: {code}")
                    self._cond.wait(min(remaining, 0.2))
                response = self._responses.pop(req_id)

            if not response.get("ok"):
                return self._error(str(response.get("error") or "external GA web worker failed"))
            result = response.get("result")
            return result if isinstance(result, dict) else {"status": "success", "data": result}

    @staticmethod
    def _error(msg: str) -> dict[str, Any]:
        return {"status": "error", "msg": msg}

    def _start_locked(self) -> None:
        if self._proc and self._proc.poll() is None:
            return

        env = os.environ.copy()
        env["GA_ROOT"] = str(self.ga_root)
        env["GA_PYTHON"] = self.python
        python_dir = os.path.dirname(self.python)
        if python_dir:
            path = env.get("PATH") or ""
            parts = path.split(os.pathsep) if path else []
            if python_dir not in parts:
                env["PATH"] = python_dir + (os.pathsep + path if path else "")

        self._responses.clear()
        popen_kwargs: dict = dict(
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            cwd=str(self.ga_root),
            env=env,
        )
        if sys.platform == "win32":
            popen_kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        self._proc = subprocess.Popen(
            [self.python, "-u", "-c", _WEB_TOOL_WORKER_SCRIPT],
            **popen_kwargs,
        )
        threading.Thread(target=self._read_stdout, args=(self._proc,), daemon=True, name="ga-web-worker-out").start()
        threading.Thread(target=self._read_stderr, args=(self._proc,), daemon=True, name="ga-web-worker-err").start()

    def _stop_locked(self) -> None:
        proc = self._proc
        self._proc = None
        if proc and proc.poll() is None:
            try:
                proc.kill()
            except Exception:
                pass

    def _read_stdout(self, proc: subprocess.Popen[str]) -> None:
        if proc.stdout is None:
            return
        for line in proc.stdout:
            try:
                msg = json.loads(line)
            except Exception:
                log.debug("GA web worker non-json stdout: %s", line.rstrip())
                continue
            req_id = msg.get("id")
            if not req_id:
                continue
            with self._cond:
                self._responses[str(req_id)] = msg
                self._cond.notify_all()

    def _read_stderr(self, proc: subprocess.Popen[str]) -> None:
        if proc.stderr is None:
            return
        for line in proc.stderr:
            text = line.rstrip()
            if text:
                log.debug("GA web worker: %s", text)


def _patch_ga_web_tools() -> None:
    """Run GA's browser tools in the external Python environment.

    ``web_scan`` and ``web_execute_js`` import ``TMWebDriver`` directly in the
    GA module. When GA is imported by packaged Admin, that import otherwise
    happens inside Admin's embedded Python and misses user-installed packages.
    Keeping a small external worker preserves TMWebDriver state while moving
    those imports and calls into the resolved GA/user Python.
    """
    try:
        import ga as _ga  # type: ignore
    except Exception:
        log.exception("could not import ga for web tool patch")
        return

    if getattr(_ga.web_scan, "_admin_external_wrapped", False):
        return

    real_python = _paths.discover_user_python()
    if not real_python:
        log.warning("no external Python found for GA web tools; leaving in-process web_scan")
        return

    worker = _ExternalGaWebTools(real_python, _paths.GA_ROOT)

    def _admin_web_scan(tabs_only=False, switch_tab_id=None, text_only=False, maxlen=35000):
        return worker.call("web_scan", {
            "tabs_only": tabs_only,
            "switch_tab_id": switch_tab_id,
            "text_only": text_only,
            "maxlen": maxlen,
        })

    def _admin_web_execute_js(script, switch_tab_id=None, no_monitor=False):
        return worker.call("web_execute_js", {
            "script": script,
            "switch_tab_id": switch_tab_id,
            "no_monitor": no_monitor,
        })

    _admin_web_scan._admin_external_wrapped = True  # type: ignore[attr-defined]
    _admin_web_execute_js._admin_external_wrapped = True  # type: ignore[attr-defined]
    _ga.web_scan = _admin_web_scan
    _ga.web_execute_js = _admin_web_execute_js
    log.info("patched GA web tools to external Python worker: %s", real_python)


_patch_ga_web_tools()


@dataclass
class AgentStatus:
    is_running: bool
    llm_no: int
    llm_name: str
    llm_model: str
    last_reply_time: int
    queued_tasks: int
    history_lines: int
    current_title: str


@dataclass
class StreamHandle:
    """A live agent task stream. Multiple WS clients may attach to the same stream."""
    stream_id: str
    display_queue: "_q.Queue"
    started_at: float = field(default_factory=time.time)
    finished: bool = False
    last_chunk: str = ""
    final_text: str = ""
    logical_id: str = ""
    auto_continue_count: int = 0
    error_retry_count: int = 0


# ── chat replay snapshot (so a /ws/chat client that reconnects after a tab
#    switch can rebuild the running conversation) ───────────────────────
@dataclass
class ChatSnapshot:
    stream_id: str
    source: str
    query: str
    started_at: float
    content: str = ""           # latest cumulative assistant text
    done: bool = False
    finished_at: float = 0.0
    aborted: bool = False
    logical_id: str = ""
    retry_attempt: int = 0
    retry_max: int = 0
    retry_of: str = ""
    retry_reason: str = ""


class AgentService:
    _instance: "AgentService | None" = None
    _SNAPSHOT_CAP = 20  # keep last N submissions for /ws/chat replay

    def __init__(self) -> None:
        # Patch /continue and /new before instantiating
        install_continue(GeneraticAgent)
        self.agent = GeneraticAgent()
        # Default to incremental output for WS streaming
        self.agent.inc_out = False
        self.agent.verbose = False
        self._streams: dict[str, StreamHandle] = {}
        # Per-stream UI snapshot (LRU-capped) for replay on reconnect
        self._snapshots: "OrderedDict[str, ChatSnapshot]" = OrderedDict()
        self._lock = threading.Lock()
        self._next_id = 0
        self._run_thread: threading.Thread | None = None
        # ── conversation title ────────────────────────────────────
        self._current_title: str = ""

        # last_reply_time may be missing on older agentmain.py — patch defensively.
        if not hasattr(self.agent, "last_reply_time"):
            self.agent.last_reply_time = int(time.time())

        # Wire turn_end_hook to broadcast events
        if not hasattr(self.agent, "_turn_end_hooks"):
            self.agent._turn_end_hooks = {}
        self.agent._turn_end_hooks["webui"] = self._on_turn_end

        # User-preferred LLM. Persisted to admin config so it survives restarts;
        # also used to detect (and log) drift caused by other call sites
        # (autonomous tasks, /llm wechat command, code_run inline_eval, etc.)
        self._wrap_next_llm_with_persistence()
        self._restore_preferred_llm()

    # ── lifecycle ────────────────────────────────────────────────
    @classmethod
    def instance(cls) -> "AgentService":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def start_run_thread(self) -> None:
        if self._run_thread and self._run_thread.is_alive():
            return
        self._run_thread = threading.Thread(target=self.agent.run, daemon=True, name="agent-run")
        self._run_thread.start()
        log.info("agent run thread started")

    # ── status ───────────────────────────────────────────────────
    def status(self) -> AgentStatus:
        a = self.agent
        try:
            llm_name = a.get_llm_name()
            llm_model = a.get_llm_name(model=True)
        except Exception:
            llm_name = "unknown"
            llm_model = "unknown"
        return AgentStatus(
            is_running=bool(a.is_running),
            llm_no=int(a.llm_no),
            llm_name=llm_name,
            llm_model=llm_model,
            last_reply_time=int(getattr(a, "last_reply_time", 0)),
            queued_tasks=a.task_queue.qsize() if hasattr(a, "task_queue") else 0,
            history_lines=len(a.history) if hasattr(a, "history") else 0,
            current_title=self._current_title,
        )

    def set_title(self, title: str) -> str:
        """Set the current WebUI conversation title used by archive/history."""
        title = (title or "").strip()
        if len(title) > 120:
            title = title[:120]
        self._current_title = title
        bus.publish("agent:title", {"title": title})
        return title

    def list_llms(self) -> list[dict]:
        try:
            self.agent.load_llm_sessions()
        except Exception as e:
            log.warning("list_llms hot reload failed: %s", e)
        out = []
        clients = getattr(self.agent, "llmclients", []) or []
        for i, name, current in self.agent.list_llms():
            client = clients[i] if i < len(clients) else None
            backend = getattr(client, "backend", None)
            model = ""
            api_base = ""
            api_key_masked = ""
            try:
                if backend is not None:
                    model = str(getattr(backend, "model", "") or "").lower()
                    # MixinSession proxies attribute access to its current
                    # session via __getattr__; plain BaseSession holds these
                    # directly.
                    api_base = str(getattr(backend, "api_base", "") or "")
                    raw_key = getattr(backend, "api_key", "") or ""
                    if isinstance(raw_key, str) and raw_key:
                        api_key_masked = _mask_secret(raw_key)
            except Exception:
                pass
            out.append({
                "index": int(i),
                "name": name,
                "current": bool(current),
                "model": model,
                "api_base": api_base,
                "api_key_masked": api_key_masked,
            })
        return out

    def switch_llm(self, n: int) -> dict:
        if bool(getattr(self.agent, "is_running", False)):
            raise RuntimeError("agent is running; wait for the current reply or stop it before switching LLM")
        self.agent.next_llm(int(n))
        # Mark this as the user's explicit preference (separate from the
        # transient agent.llm_no which any code path can mutate).
        self._save_preferred_llm(int(self.agent.llm_no))
        return {"llm_no": self.agent.llm_no, "name": self.agent.get_llm_name()}

    # ── llm preference persistence ───────────────────────────────
    def _save_preferred_llm(self, n: int) -> None:
        try:
            cfg = _paths.load_config()
            if cfg.get("preferred_llm_no") == n:
                return
            cfg["preferred_llm_no"] = int(n)
            _paths.save_config(cfg)
            log.info("preferred_llm_no persisted: %s", n)
        except Exception as e:
            log.warning("failed to persist preferred_llm_no=%s: %s", n, e)

    def _restore_preferred_llm(self) -> None:
        try:
            saved = _paths.load_config().get("preferred_llm_no")
            if saved is None:
                return
            n = int(saved)
            clients = getattr(self.agent, "llmclients", None) or []
            if n < 0 or n >= len(clients):
                log.info("preferred_llm_no=%s out of range (have %d), skipping", saved, len(clients))
                return
            if int(self.agent.llm_no) == n:
                return
            self.agent.next_llm(n)
            log.info("restored preferred_llm_no=%s (%s)", n, self.agent.get_llm_name())
        except Exception as e:
            log.warning("failed to restore preferred llm: %s", e)

    def _wrap_next_llm_with_persistence(self) -> None:
        """Monkey-patch ``agent.next_llm`` so any caller — admin, wechat slash
        command, autonomous SOP via code_run inline_eval, etc. — surfaces the
        change in admin logs and (optionally) updates the user-preferred slot.

        We only persist on USER-initiated changes (``switch_llm`` calls this
        helper directly via ``_save_preferred_llm``). For other sources we
        just log so the user can spot unexpected drift.
        """
        import inspect, traceback
        original = self.agent.next_llm
        # Already wrapped (singleton may be re-init'd in tests)
        if getattr(original, "_admin_wrapped", False):
            return

        def _wrapped(n: int = -1):
            before = int(getattr(self.agent, "llm_no", 0))
            ret = original(n)
            after = int(self.agent.llm_no)
            if before != after:
                # Capture caller frame for diagnostic — skip our own frames.
                stack = traceback.extract_stack(limit=8)[:-1]
                tail = " <- ".join(f"{os.path.basename(f.filename)}:{f.lineno}" for f in stack[-4:])
                try: name = self.agent.get_llm_name()
                except Exception: name = "?"
                log.info("agent.llm_no %s → %s (%s)  caller: %s", before, after, name, tail)
            return ret

        _wrapped._admin_wrapped = True  # type: ignore[attr-defined]
        self.agent.next_llm = _wrapped  # type: ignore[assignment]

    def abort(self) -> None:
        self.agent.abort()
        bus.publish("agent:abort", {"ts": time.time()})
        # The agent's run loop will emit a final {'done': ...} which our
        # fan-out drainer turns into a chat:done — we deliberately don't
        # publish a parallel chat:aborted to keep the event stream simple.

    # ── tasks ────────────────────────────────────────────────────
    def btw(self, question: str) -> str:
        """Run /btw as an isolated side question and return its text.

        This intentionally bypasses ``put_task``/bus fan-out so the answer stays
        inside the small BTW dialog instead of being appended to the main chat.
        """
        q = (question or "").strip()
        if not q:
            return ""
        if q == "/btw" or q.startswith("/btw ") or q.startswith("/btw\t"):
            raw = q
        else:
            raw = "/btw " + q
        from frontends.btw_cmd import handle_frontend_command  # type: ignore
        return handle_frontend_command(self.agent, raw) or ""

    def submit(
        self,
        query: str,
        *,
        source: str = "user",
        images: list[str] | None = None,
        logical_id: str | None = None,
        auto_continue_count: int = 0,
        error_retry_count: int = 0,
        retry_of: str = "",
        retry_reason: str = "",
        retry_max: int = 0,
    ) -> StreamHandle:
        """Enqueue a task; spawn a single fan-out drainer that publishes
        chat:* events to the bus AND keeps the StreamHandle's display_queue
        full for legacy sync consumers (wechat_service)."""
        # User-initiated submissions reassert the persisted preference so that
        # autonomous tasks (or other call sites) can't strand the user on a
        # different LLM than they picked. Other sources (autonomous, wechat,
        # reflect) keep whatever llm_no is currently active.
        if source in ("user", "webui"):
            self._restore_preferred_llm()
        with self._lock:
            self._next_id += 1
            sid = f"s{self._next_id:08d}"
        if logical_id is None:
            logical_id = sid
        # The agent's own queue (drained by our fan-out below).
        src_q = self.agent.put_task(query, source=source, images=images or [])
        # The handle queue we hand to callers (kept in sync by the drainer).
        out_q: "_q.Queue" = _q.Queue()
        h = StreamHandle(
            stream_id=sid,
            display_queue=out_q,
            logical_id=logical_id,
            auto_continue_count=auto_continue_count,
            error_retry_count=error_retry_count,
        )
        snap = ChatSnapshot(
            stream_id=sid,
            source=source,
            query=query or "",
            started_at=time.time(),
            logical_id=logical_id,
            retry_attempt=error_retry_count,
            retry_max=retry_max,
            retry_of=retry_of,
            retry_reason=retry_reason,
        )
        with self._lock:
            self._streams[sid] = h
            self._snapshots[sid] = snap
            # LRU eviction
            while len(self._snapshots) > self._SNAPSHOT_CAP:
                self._snapshots.popitem(last=False)
        submit_payload = {
            "stream_id": sid,
            "source": source,
            "query_preview": (query or "")[:120],
            "logical_id": logical_id,
        }
        if error_retry_count:
            submit_payload.update({
                "retry_attempt": error_retry_count,
                "retry_max": retry_max,
                "retry_of": retry_of,
                "retry_reason": retry_reason,
            })
        bus.publish("agent:submit", submit_payload)
        started_payload = {
            "stream_id": sid,
            "source": source,
            "query": query or "",
            "ts": snap.started_at,
            "logical_id": logical_id,
        }
        if error_retry_count:
            started_payload.update({
                "retry_attempt": error_retry_count,
                "retry_max": retry_max,
                "retry_of": retry_of,
                "retry_reason": retry_reason,
            })
        bus.publish("chat:started", started_payload)
        threading.Thread(
            target=self._fanout, args=(src_q, out_q, h, snap),
            daemon=True, name=f"agent-fanout-{sid}",
        ).start()
        return h

    def _fanout(self, src_q: "_q.Queue", out_q: "_q.Queue", h: StreamHandle, snap: ChatSnapshot) -> None:
        """Drain the agent's display_queue. For each item:
          - mirror to the StreamHandle's queue (for legacy sync consumers).
          - update the snapshot.
          - publish chat:next / chat:done to the bus.
        """
        try:
            while True:
                try:
                    item = src_q.get(timeout=300)
                except _q.Empty:
                    # Liveness ping so subscribers know we're still here.
                    bus.publish("chat:heartbeat", {"stream_id": h.stream_id})
                    continue
                # mirror first so wechat_service keeps working
                out_q.put(item)
                if "next" in item:
                    content = item["next"]
                    h.last_chunk = content
                    snap.content = content
                    bus.publish("chat:next", {
                        "stream_id": h.stream_id,
                        "source": snap.source,
                        "content": content,
                        "logical_id": h.logical_id,
                        "retry_attempt": snap.retry_attempt,
                        "retry_max": snap.retry_max,
                        "retry_of": snap.retry_of,
                        "retry_reason": snap.retry_reason,
                    })
                if "done" in item:
                    content = item["done"]
                    h.final_text = content
                    h.finished = True
                    snap.content = content
                    snap.done = True
                    snap.finished_at = time.time()
                    self.agent.last_reply_time = int(time.time())
                    bus.publish("chat:done", {
                        "stream_id": h.stream_id,
                        "source": snap.source,
                        "content": content,
                        "logical_id": h.logical_id,
                        "retry_attempt": snap.retry_attempt,
                        "retry_max": snap.retry_max,
                        "retry_of": snap.retry_of,
                        "retry_reason": snap.retry_reason,
                    })
                    bus.publish("agent:done", {"stream_id": h.stream_id, "len": len(content)})
                    handled_recoverable_error = self._maybe_retry_recoverable_error(h, snap, content)
                    if not handled_recoverable_error:
                        self._maybe_auto_continue(h, snap, content)
                    return
        except Exception as e:
            log.exception("fanout crashed for %s: %s", h.stream_id, e)
            snap.done = True
            snap.aborted = True
            snap.finished_at = time.time()
            bus.publish("chat:done", {
                "stream_id": h.stream_id,
                "source": snap.source,
                "content": snap.content + f"\n[stream error: {e}]",
                "logical_id": h.logical_id,
                "retry_attempt": snap.retry_attempt,
                "retry_max": snap.retry_max,
                "retry_of": snap.retry_of,
                "retry_reason": snap.retry_reason,
            })

    def _maybe_retry_recoverable_error(self, h: StreamHandle, snap: ChatSnapshot, content: str) -> bool:
        if snap.source not in ("user", "webui", "chat_error_retry", "auto_continue", "scheduled_task", "autonomous", "reflect"):
            return False
        match = classify_recoverable_error(content)
        if match is None:
            return False
        cfg = self._load_chat_retry_config()
        if not cfg.enabled or cfg.max_attempts <= 0:
            return False
        if h.error_retry_count >= cfg.max_attempts:
            log.info(
                "recoverable chat error retry exhausted for %s (%s/%s, %s)",
                h.stream_id,
                h.error_retry_count,
                cfg.max_attempts,
                match.label,
            )
            bus.publish("chat:retry_exhausted", {
                "stream_id": h.stream_id,
                "source": snap.source,
                "logical_id": h.logical_id,
                "attempt": h.error_retry_count,
                "max_attempts": cfg.max_attempts,
                "reason": match.to_dict(),
            })
            return True
        next_count = h.error_retry_count + 1
        prompt = _ERROR_RETRY_PROMPT_TEMPLATE.format(label=match.label)
        log.info(
            "retrying recoverable chat error for %s (%d/%d, %s)",
            h.stream_id,
            next_count,
            cfg.max_attempts,
            match.label,
        )
        bus.publish("chat:retry", {
            "stream_id": h.stream_id,
            "source": snap.source,
            "logical_id": h.logical_id,
            "attempt": next_count,
            "max_attempts": cfg.max_attempts,
            "reason": match.to_dict(),
        })
        self.submit(
            prompt,
            source="chat_error_retry",
            logical_id=h.logical_id,
            auto_continue_count=h.auto_continue_count,
            error_retry_count=next_count,
            retry_of=h.stream_id,
            retry_reason=match.label,
            retry_max=cfg.max_attempts,
        )
        return True

    def _load_chat_retry_config(self) -> ChatRetryConfig:
        try:
            return load_chat_retry_config()
        except Exception as e:
            log.warning("failed to load chat retry config, using defaults: %s", e)
            return ChatRetryConfig()

    def _maybe_auto_continue(self, h: StreamHandle, snap: ChatSnapshot, content: str) -> None:
        if snap.source not in ("user", "webui", "auto_continue", "chat_error_retry", "scheduled_task", "autonomous", "reflect"):
            return
        if h.auto_continue_count >= _AUTO_CONTINUE_MAX:
            return
        tail = (content or "")[-300:]
        if not any(marker in tail for marker in _AUTO_CONTINUE_MARKERS):
            return
        next_count = h.auto_continue_count + 1
        log.info("auto-continuing interrupted stream %s (%d/%d)", h.stream_id, next_count, _AUTO_CONTINUE_MAX)
        self.submit(
            _AUTO_CONTINUE_PROMPT,
            source="auto_continue",
            logical_id=h.logical_id,
            auto_continue_count=next_count,
            error_retry_count=h.error_retry_count,
            retry_of=snap.retry_of,
            retry_reason=snap.retry_reason,
            retry_max=snap.retry_max,
        )

    # ── replay (used by /ws/chat on connect) ────────────────────
    def chat_state_snapshot(self) -> list[dict]:
        """Return a flat list of recent / in-flight chat streams so a
        reconnecting WS client can rebuild its UI atomically.

        Order is insertion order (oldest → newest). Each entry is a single
        stream's full state — frontend replaces its message list with this.
        """
        out: list[dict] = []
        with self._lock:
            snaps = list(self._snapshots.values())
        for snap in snaps:
            content = snap.content
            item = {
                "stream_id": snap.stream_id,
                "source": snap.source,
                "query": snap.query,
                "content": content,
                "done": snap.done,
                "started_at": snap.started_at,
                "finished_at": snap.finished_at,
                "logical_id": snap.logical_id,
                "retry_attempt": snap.retry_attempt,
                "retry_max": snap.retry_max,
                "retry_of": snap.retry_of,
                "retry_reason": snap.retry_reason,
            }
            out.append(item)
        return out

    async def stream(self, h: StreamHandle, *, poll_interval: float = 0.4) -> AsyncIterator[dict]:
        """Async generator that yields {next:...} chunks then a final {done:...}."""
        while True:
            try:
                item = await asyncio.to_thread(h.display_queue.get, True, poll_interval)
            except _q.Empty:
                # heartbeat
                yield {"type": "heartbeat", "stream_id": h.stream_id}
                continue
            if "next" in item:
                h.last_chunk = item["next"]
                yield {"type": "next", "stream_id": h.stream_id, "content": item["next"], "source": item.get("source")}
            if "done" in item:
                h.final_text = item["done"]
                h.finished = True
                self.agent.last_reply_time = int(time.time())
                bus.publish("agent:done", {"stream_id": h.stream_id, "len": len(item["done"])})
                yield {"type": "done", "stream_id": h.stream_id, "content": item["done"], "source": item.get("source")}
                return

    # ── conversation control ────────────────────────────────────
    def new_conversation(self) -> str:
        # Persist the soon-to-be-discarded WebUI conversation into
        # memory/chat_history.json so it shows up under "对话管理".
        # Without this hook chat_history.json is only ever written by the
        # Qt desktop app (frontends/qtapp.py), and Web sessions stay invisible
        # in the management view forever.
        try:
            self._archive_snapshots_to_chat_history()
        except Exception as e:
            log.warning("archive snapshots to chat_history.json failed: %s", e)
        # Wipe per-stream UI snapshots so a reconnecting WS doesn't replay
        # stale bubbles from the previous conversation.
        with self._lock:
            self._snapshots.clear()
        self.set_title("")
        bus.publish("chat:reset", {"reason": "new_conversation"})
        return reset_conversation(self.agent)

    # ---- helpers for archive on /new ----
    @staticmethod
    def _strip_webui_prompt_artifacts(s: str) -> str:
        """Remove the file-marker scaffolding LiveChat appends to user prompts
        so saved messages read like what the user actually typed."""
        if not s:
            return ""
        # Drop the 'If you need to show files...' preamble injected by LiveChat
        s = _re.sub(
            r"^If you need to show files to user, use \[FILE:filepath\] in your response\.\s*",
            "",
            s,
        )
        # Drop trailing "[用户发送文件: <path>]" markers, possibly multiple
        s = _re.sub(r"(?:\n|^)\[用户发送文件:[^\]]*\]\s*", "", s)
        return s.strip()

    def _archive_snapshots_to_chat_history(self) -> None:
        """Dump the current chat snapshots as one new entry in chat_history.json.

        Schema matches what frontends/qtapp.py writes (so the same file is
        readable by the Qt app and by /api/conversations):

            {"id", "title", "messages": [{role, content}, ...], "updatedAt"}
        """
        with self._lock:
            snaps = [s for s in self._snapshots.values() if s.done and (s.query or s.content)]
        if not snaps:
            return  # nothing meaningful to save

        messages: list[dict] = []
        first_user_text = ""
        for snap in snaps:
            user_text = self._strip_webui_prompt_artifacts(snap.query)
            if user_text:
                messages.append({"role": "user", "content": user_text})
                if not first_user_text:
                    first_user_text = user_text
            if snap.content:
                messages.append({"role": "assistant", "content": snap.content})
        if not messages:
            return

        explicit_title = (self._current_title or "").strip()
        if explicit_title:
            title = explicit_title
        else:
            title = (first_user_text[:30].replace("\n", " ") or "Web 对话")
            if len(first_user_text) > 30:
                title += "…"
        entry = {
            "id": datetime.now().strftime("%Y%m%d_%H%M%S_%f"),
            "title": title,
            "messages": messages,
            "updatedAt": datetime.now().isoformat(),
            "source": "webui",
        }

        hf = str(_paths.memory_dir() / "chat_history.json")
        all_: list[dict] = []
        if os.path.isfile(hf):
            try:
                with open(hf, encoding="utf-8") as f:
                    loaded = json.load(f)
                if isinstance(loaded, list):
                    all_ = loaded
            except Exception as e:
                log.warning("chat_history.json unreadable, starting fresh: %s", e)
        all_.append(entry)

        os.makedirs(os.path.dirname(hf), exist_ok=True)
        tmp = hf + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(all_, f, ensure_ascii=False, indent=2)
        os.replace(tmp, hf)
        log.info("archived webui conversation %s (%d msgs) to chat_history.json",
                 entry["id"], len(messages))

    def get_history(self) -> list[str]:
        return list(getattr(self.agent, "history", []))

    # ── rewind ───────────────────────────────────────────────────
    def rewind_turns(self, *, sid: str | None = None, n: int | None = None) -> dict:
        """Drop the most-recent completed turn(s) from the live LLM history.

        If ``sid`` is given, that turn AND all later turns are removed.
        Else ``n`` last done turns are removed (1 = undo last).

        Mirrors GA TUI ``/rewind`` (frontends/tuiapp.py:_cmd_rewind) but
        operates on GA-Hub's per-stream snapshots so the frontend can sync
        precisely by stream_id. Refuses while the agent is running.
        """
        with self._lock:
            if bool(getattr(self.agent, "is_running", False)):
                raise RuntimeError(
                    "cannot rewind while agent is running; abort first"
                )

            all_items = list(self._snapshots.items())
            done_items = [(s, snap) for s, snap in all_items if snap.done]
            if not done_items:
                raise ValueError("no completed turns to rewind")

            # 1. Resolve how many turns to drop.
            if sid:
                idxs = [i for i, (s, _) in enumerate(done_items) if s == sid]
                if not idxs:
                    raise ValueError(f"sid {sid!r} not found among done turns")
                n_eff = len(done_items) - idxs[0]
            elif n is not None:
                if n < 1 or n > len(done_items):
                    raise ValueError(
                        f"n out of range 1..{len(done_items)}"
                    )
                n_eff = n
            else:
                raise ValueError("either sid or n required")

            # 2. Locate cut position in real LLM history.
            #    Logic mirrors GA frontends/tuiapp.py:_cmd_rewind (453-511):
            #    a "real" user turn = role==user AND content is not a pure
            #    tool_result block.
            try:
                backend_history = self.agent.llmclient.backend.history
            except AttributeError as e:
                raise RuntimeError(
                    f"agent has no llmclient.backend.history: {e}"
                ) from e

            user_turn_idxs: list[int] = []
            for i, msg in enumerate(backend_history):
                if msg.get("role") != "user":
                    continue
                content = msg.get("content")
                if isinstance(content, str):
                    user_turn_idxs.append(i)
                    continue
                if isinstance(content, list):
                    has_tool_result = any(
                        isinstance(b, dict) and b.get("type") == "tool_result"
                        for b in content
                    )
                    if has_tool_result:
                        continue
                    if any(
                        isinstance(b, dict)
                        and b.get("type") == "text"
                        and (b.get("text") or "").strip()
                        for b in content
                    ):
                        user_turn_idxs.append(i)

            if n_eff > len(user_turn_idxs):
                raise RuntimeError(
                    f"_snapshots/backend.history mismatch: want -{n_eff} turns "
                    f"but only {len(user_turn_idxs)} user-turns in history"
                )
            cut_at = user_turn_idxs[-n_eff]
            removed_lines = len(backend_history) - cut_at
            backend_history[:] = backend_history[:cut_at]

            # 3. Drop snapshots from first_removed onwards (insertion order).
            #    This also discards any non-done tail snapshots created after
            #    the cut point (defensive).
            first_removed_sid = done_items[-n_eff][0]
            removed_sids: list[str] = []
            hit = False
            for s, _snap in all_items:
                if s == first_removed_sid:
                    hit = True
                if hit:
                    removed_sids.append(s)
            for s in removed_sids:
                self._snapshots.pop(s, None)

            # 4. Mark in GA working-memory log (TUI parity).
            try:
                self.agent.history.append(f"[USER]: /rewind {n_eff}")
            except Exception:
                pass

            result = {
                "removed_sids": removed_sids,
                "kept": len(self._snapshots),
                "history_lines": len(backend_history),
                "removed_history_entries": removed_lines,
            }

        # 5. Broadcast outside the lock — multi-tab sync via EventBus prefix
        #    "chat:" already fans out through /api/events (routes/events.py).
        bus.publish("chat:rewound", {
            "removed_sids": removed_sids,
            "kept": result["kept"],
            "history_lines": result["history_lines"],
        })
        log.info(
            "rewind: dropped %d turn(s), removed %d history entries, sids=%s",
            n_eff, removed_lines, removed_sids,
        )
        return result

    # ── hooks ────────────────────────────────────────────────────
    def _on_turn_end(self, ctx: dict) -> None:
        bus.publish("agent:turn", {
            "turn": ctx.get("turn"),
            "summary": ctx.get("summary"),
            "exit_reason": ctx.get("exit_reason"),
        })


# convenience accessor
def get_agent_service() -> AgentService:
    return AgentService.instance()
