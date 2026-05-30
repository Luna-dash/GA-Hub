"""External-Python worker for GA browser tools.

Bridges GA's in-process ``web_scan`` / ``web_execute_js`` calls to a
long-lived child interpreter resolved by ``_paths.discover_user_python``.
This is the only safe way to run GA's TMWebDriver from a packaged Admin
host where the embedded Python lacks user-installed automation deps.
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)


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
        log.info(
            "GA web worker spawned pid=%s python=%s ga_root=%s",
            self._proc.pid,
            self.python,
            self.ga_root,
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
        first = True
        for line in proc.stderr:
            text = line.rstrip()
            if not text:
                continue
            # First line of worker stderr almost always carries init-failure
            # context (missing GA deps, ga import errors). Surface it once at
            # WARNING so packaged Admin operators can see it without DEBUG.
            if first:
                log.warning("GA web worker stderr (first line): %s", text)
                first = False
            else:
                log.debug("GA web worker: %s", text)
