"""Unified Antigravity ACP runtime manager and per-session stdio worker.

Replaces both the external AntiCLI HTTP daemon (`anti_daemon.py`) and the
ephemeral per-turn `anti_acp.py` thread with T3 Code's persistent, resumable
`agy acp` architecture directly inside GA-Hub.
"""
from __future__ import annotations

import json
import logging
import os
import queue
import re
import shutil
import subprocess
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Literal, get_args
from uuid import uuid4

from .. import _paths
from ..process_utils import hidden_process_kwargs
from . import agy_profile, child_job
from .agy_profile import AgyProfileError, CodeLoginFlow
from .agy_protocol import (
    RuntimeGrants,
    ReadRepair,
    SessionUpdateNormalizer,
    build_prompt_blocks,
    client_info_for_version,
    default_permission_mode,
    evaluate_permission,
    extract_model_catalog_from_setup,
    extract_permission_prompt,
    handle_read_text_file,
    read_pre_edit_file,
    select_model_and_effort_calls,
    session_mode_for_policy,
    supports_system_prompt_append,
)

log = logging.getLogger(__name__)

AntiDaemonState = Literal["stopped", "starting", "ready", "unavailable"]
AntiAuthState = Literal["checking", "authenticated", "login_required", "unverified"]

INACTIVITY_TIMEOUT = 900.0
APPROVAL_TIMEOUT = 900.0
INIT_TIMEOUT = 120.0
IDLE_SESSION_TTL = 1800.0

_SYSTEM_PROMPT_APPEND = (
    "You are running inside GA-Hub via Antigravity ACP. "
    "Use workspace tools cleanly and respect user permission confirmations."
)


@dataclass(frozen=True)
class AntiDaemonStatus:
    state: AntiDaemonState
    detail: str | None = None
    agy_available: bool | None = None
    active_count: int | None = None
    auth_state: AntiAuthState | None = None
    managed: bool | None = None
    port: int | None = None
    version: str | None = None
    max_concurrency: int | None = None


def _log_path() -> Path:
    return _paths.ADMIN_DATA / "logs" / "agy-acp.log"


def _append_log(line: str) -> None:
    try:
        path = _log_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists() and path.stat().st_size > 2 * 1024 * 1024:
            backup = path.with_suffix(".log.1")
            try:
                path.replace(backup)
            except OSError:
                pass
        stamp = time.strftime("%Y-%m-%d %H:%M:%S")
        with path.open("a", encoding="utf-8", errors="replace") as fp:
            fp.write(f"[{stamp}] {line}\n")
    except OSError:
        pass


class _PendingPermission:
    def __init__(self, prompt: dict[str, Any]):
        self.id = uuid4().hex
        self.prompt = prompt
        self.event = threading.Event()
        self.decision: str | None = None
        self.option_id: str | None = None

    def public_view(self) -> dict[str, Any]:
        view: dict[str, Any] = {
            "id": self.id,
            "title": self.prompt["title"],
            "details": self.prompt["details"],
            "prompt_type": self.prompt.get("prompt_type", "approval"),
            "tool_kind": self.prompt.get("tool_kind", "other"),
            "allow_always": bool(self.prompt.get("allow_always")),
        }
        if self.prompt.get("security_warning"):
            view["security_warning"] = self.prompt["security_warning"]
        if self.prompt.get("command"):
            view["command"] = self.prompt["command"]
        if self.prompt.get("diff"):
            view["diff"] = self.prompt["diff"]
        if self.prompt.get("question"):
            view["question"] = self.prompt["question"]
        return view


class _ActiveTurn:
    def __init__(
        self,
        run_id: str,
        mode: str,
        permission_mode: str,
        workspace: Path,
        allowed_roots: list[Path],
        on_event: Callable[[dict[str, Any]], None],
    ):
        self.run_id = run_id
        self.mode = mode
        self.permission_mode = permission_mode
        self.workspace = workspace
        self.allowed_roots = allowed_roots
        self.on_event = on_event
        self.normalizer = SessionUpdateNormalizer(read_pre_edit_file)
        self.read_repair = ReadRepair()
        self.last_activity = time.monotonic()
        self.cancelled = False
        self._perm_lock = threading.Lock()
        self.pending_permission: _PendingPermission | None = None
        self.done_event = threading.Event()

    def touch(self) -> None:
        self.last_activity = time.monotonic()

    def current_approval(self) -> dict[str, Any] | None:
        with self._perm_lock:
            return self.pending_permission.public_view() if self.pending_permission else None

    def decide(self, approval_id: str, decision: str, option_id: str | None = None) -> bool:
        with self._perm_lock:
            pending = self.pending_permission
            if pending is None or pending.id != approval_id:
                return False
            pending.decision = decision
            pending.option_id = option_id
            self.pending_permission = None
            pending.event.set()
            return True

    def cancel_pending(self) -> None:
        self.cancelled = True
        with self._perm_lock:
            pending = self.pending_permission
            if pending is not None:
                pending.decision = "reject"
                self.pending_permission = None
                pending.event.set()


class AgySessionWorker:
    """Long-lived JSON-RPC over stdio worker bound to one `(profile_id, session_id)`."""

    def __init__(
        self,
        *,
        profile_id: str,
        session_id: str,
        workspace: Path,
        executable: str,
        version: str | None,
        on_models: Callable[[list[dict[str, str]]], None] | None = None,
        on_commands: Callable[[list[dict[str, Any]]], None] | None = None,
    ):
        self.profile_id = profile_id
        self.session_id = session_id
        self.workspace = workspace
        self.executable = executable
        self.version = version
        self._on_models = on_models
        self._on_commands = on_commands

        self._lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._rpc_lock = threading.Lock()
        self._next_id = 1
        self._pending_rpcs: dict[int, tuple[threading.Event, dict[str, Any]]] = {}

        self.proc: subprocess.Popen | None = None
        self.temp_dir: Path | None = None
        self.acp_session_id: str | None = None
        self.init_result: dict[str, Any] = {}
        self.setup_result: dict[str, Any] = {}
        self.grants = RuntimeGrants()
        self.active_turn: _ActiveTurn | None = None
        self.add_dirs: tuple[str, ...] = ()
        self.last_used = time.monotonic()
        self._closed = False
        self._reader_thread: threading.Thread | None = None

    def is_alive(self) -> bool:
        return not self._closed and self.proc is not None and self.proc.poll() is None and bool(self.acp_session_id)

    def _send_frame(self, frame: dict[str, Any]) -> None:
        proc = self.proc
        if proc is None or proc.stdin is None:
            raise AgyProfileError(503, "Agy ACP 进程未运行")
        line = json.dumps(frame, ensure_ascii=False) + "\n"
        with self._write_lock:
            try:
                proc.stdin.write(line)
                proc.stdin.flush()
            except OSError as exc:
                raise AgyProfileError(503, "Agy ACP 输入通道已断开") from exc

    def _rpc(self, method: str, params: dict[str, Any], timeout: float = INIT_TIMEOUT) -> dict[str, Any]:
        with self._rpc_lock:
            req_id = self._next_id
            self._next_id += 1
            ev = threading.Event()
            box: dict[str, Any] = {}
            self._pending_rpcs[req_id] = (ev, box)
        self._send_frame({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params})
        if not ev.wait(timeout):
            with self._rpc_lock:
                self._pending_rpcs.pop(req_id, None)
            raise AgyProfileError(504, f"Agy ACP {method} 超时")
        if "error" in box:
            err = box["error"]
            msg = err.get("message") if isinstance(err, dict) else str(err)
            code = err.get("code") if isinstance(err, dict) else None
            raise AgyProfileError(502, f"Agy ACP {method} 失败 ({code}): {msg}")
        return box.get("result") or {}

    def _reply(self, req_id: Any, *, result: Any = None, error: dict[str, Any] | None = None) -> None:
        frame: dict[str, Any] = {"jsonrpc": "2.0", "id": req_id}
        if error is not None:
            frame["error"] = error
        else:
            frame["result"] = result
        try:
            self._send_frame(frame)
        except AgyProfileError:
            pass

    def _read_loop(self, proc: subprocess.Popen) -> None:
        assert proc.stdout is not None
        try:
            for raw in proc.stdout:
                if self._closed:
                    break
                line = raw.strip()
                if not line:
                    continue
                try:
                    frame = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(frame, dict):
                    continue
                if "id" in frame and "method" not in frame:
                    rid = frame["id"]
                    with self._rpc_lock:
                        entry = self._pending_rpcs.pop(rid, None)
                    if entry is not None:
                        ev, box = entry
                        if "error" in frame:
                            box["error"] = frame["error"]
                        else:
                            box["result"] = frame.get("result")
                        ev.set()
                    continue

                method = frame.get("method")
                params = frame.get("params") if isinstance(frame.get("params"), dict) else {}
                if "id" in frame:
                    # Handle incoming requests in daemon threads so stdout never blocks on approvals.
                    threading.Thread(
                        target=self._handle_incoming_request,
                        args=(frame["id"], method, params),
                        daemon=True,
                    ).start()
                elif method == "session/update":
                    self._handle_session_update(params)
        except OSError:
            pass
        finally:
            # Wake any pending RPC callers on unexpected exit.
            with self._rpc_lock:
                items = list(self._pending_rpcs.values())
                self._pending_rpcs.clear()
            for ev, box in items:
                box.setdefault("error", {"code": -32000, "message": "Agy ACP 连接已关闭"})
                ev.set()
            turn = self.active_turn
            if turn is not None:
                turn.cancel_pending()

    def _handle_session_update(self, params: dict[str, Any]) -> None:
        update = params.get("update")
        if not isinstance(update, dict):
            return
        turn = self.active_turn
        if turn is None:
            return
        turn.touch()
        repaired = turn.read_repair.track_update(update)
        for evt in turn.normalizer.normalize(repaired):
            try:
                turn.on_event(evt)
            except Exception:
                log.debug("Failed to deliver ACP session update", exc_info=True)
        if update.get("sessionUpdate") == "available_commands_update" and turn.normalizer.available_commands:
            if self._on_commands:
                self._on_commands(turn.normalizer.available_commands)

    def _handle_incoming_request(self, req_id: Any, method: Any, params: dict[str, Any]) -> None:
        turn = self.active_turn
        if method == "fs/read_text_file":
            roots = turn.allowed_roots if turn else [self.workspace]
            res, err = handle_read_text_file(params, roots)
            target_path = str(params.get("path") or "")
            if turn is not None and target_path:
                completed_tid = turn.read_repair.attempted(target_path, err is None)
                if completed_tid:
                    for evt in turn.normalizer.normalize({
                        "sessionUpdate": "tool_call_update",
                        "toolCallId": completed_tid,
                        "status": "completed",
                    }):
                        turn.on_event(evt)
            self._reply(req_id, result=res, error=err)
            return

        if method == "session/request_permission":
            if turn is None:
                options = [o for o in (params.get("options") or []) if isinstance(o, dict)]
                reject = next((o["optionId"] for o in options if o.get("kind") == "reject_once"), None)
                fallback = reject or (options[-1]["optionId"] if options else "reject")
                self._reply(req_id, result={"outcome": {"outcome": "selected", "optionId": fallback}})
                return

            disposition = evaluate_permission(
                turn.mode,
                turn.permission_mode,
                params,
                self.grants,
                turn.workspace,
                turn.allowed_roots[1:],
            )
            prompt_info = extract_permission_prompt(params, read_pre_edit_file)
            option_map = prompt_info["option_map"]

            if disposition == "allow" and option_map.get("allow"):
                self._reply(req_id, result={"outcome": {"outcome": "selected", "optionId": option_map["allow"]}})
                return
            if disposition == "deny":
                oid = prompt_info.get("default_option") or "reject"
                self._reply(req_id, result={"outcome": {"outcome": "selected", "optionId": oid}})
                return

            pending = _PendingPermission(prompt_info)
            with turn._perm_lock:
                turn.pending_permission = pending
            turn.touch()
            turn.on_event({"seq": 0, "type": "approval.requested", "approval": pending.public_view()})

            pending.event.wait(APPROVAL_TIMEOUT)
            with turn._perm_lock:
                if turn.pending_permission is pending:
                    turn.pending_permission = None
            turn.touch()

            chosen_oid: str | None = None
            if pending.option_id and pending.option_id in option_map:
                chosen_oid = option_map[pending.option_id]
            elif pending.decision == "allow_always":
                chosen_oid = option_map.get("allow_always") or option_map.get("allow")
                if chosen_oid:
                    self.grants.record(str(prompt_info.get("tool_kind") or "other"))
            elif pending.decision == "allow":
                chosen_oid = option_map.get("allow") or option_map.get("allow_always")
            if not chosen_oid:
                chosen_oid = prompt_info.get("default_option") or "reject"

            self._reply(req_id, result={"outcome": {"outcome": "selected", "optionId": chosen_oid}})
            return

        self._reply(req_id, error={"code": -32601, "message": f"Method not implemented: {method}"})

    def ensure_started(self, *, resume_conversation: str | None, add_dirs: tuple[str, ...]) -> str:
        """Start (or reuse) the persistent ACP process and return the native sessionId."""
        with self._lock:
            if self.is_alive() and set(add_dirs).issubset(set(self.add_dirs)):
                self.last_used = time.monotonic()
                assert self.acp_session_id is not None
                return self.acp_session_id
            if self.proc is not None:
                self._teardown_locked()

            agy_profile.prepare_profile(self.profile_id)
            self.temp_dir = agy_profile.make_runtime_temp_dir(self.profile_id)
            self.add_dirs = tuple(dict.fromkeys(add_dirs))
            cmd = agy_profile.acp_spawn_command(
                self.executable,
                self.profile_id,
                add_dirs=self.add_dirs,
                sandbox=False,
            )
            env = agy_profile.clean_agy_env(self.profile_id, temp_dir=self.temp_dir)
            _append_log(f"spawn acp profile={self.profile_id} session={self.session_id} cwd={self.workspace}")

            log_fp = None
            try:
                log_path = _log_path()
                log_path.parent.mkdir(parents=True, exist_ok=True)
                log_fp = log_path.open("ab")
            except OSError:
                log_fp = None

            try:
                self.proc = child_job.spawn(
                    cmd,
                    kind="agy-acp",
                    marker=self.executable,
                    cwd=str(self.workspace),
                    env=env,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=log_fp if log_fp is not None else subprocess.DEVNULL,
                    encoding="utf-8",
                    errors="replace",
                    bufsize=1,
                    **hidden_process_kwargs(),
                )
            except OSError as exc:
                if self.temp_dir:
                    shutil.rmtree(self.temp_dir, ignore_errors=True)
                    self.temp_dir = None
                raise AgyProfileError(503, f"无法启动 agy acp 进程: {exc}") from exc
            finally:
                if log_fp is not None:
                    try:
                        log_fp.close()
                    except OSError:
                        pass

            self._closed = False
            self._reader_thread = threading.Thread(target=self._read_loop, args=(self.proc,), daemon=True)
            self._reader_thread.start()

            try:
                self.init_result = self._rpc(
                    "initialize",
                    {
                        "protocolVersion": 1,
                        "clientCapabilities": {
                            "fs": {"readTextFile": True, "writeTextFile": False},
                            "terminal": False,
                        },
                        "clientInfo": client_info_for_version(self.version),
                    },
                    timeout=INIT_TIMEOUT,
                )
                try:
                    self._rpc("authenticate", {"methodId": "oauth-personal"}, timeout=60.0)
                except AgyProfileError as exc:
                    msg = str(exc)
                    if "-32000" in msg or "-32603" in msg or "login" in msg.lower() or "auth" in msg.lower():
                        raise AgyProfileError(409, "Agy 账号未登录或凭据已失效，请先完成登录。") from exc
                    # Older builds or already-authenticated setups may return non-fatal auth notices.
                    _append_log(f"authenticate note: {msg}")

                base_session: dict[str, Any] = {
                    "cwd": str(self.workspace),
                    "mcpServers": [],
                }
                if self.add_dirs:
                    base_session["additionalDirectories"] = list(self.add_dirs)
                if supports_system_prompt_append(self.init_result):
                    base_session["_meta"] = {"antigravity": {"systemPrompt": {"append": _SYSTEM_PROMPT_APPEND}}}

                started: dict[str, Any] | None = None
                if resume_conversation:
                    try:
                        started = self._rpc(
                            "session/resume",
                            {**base_session, "sessionId": resume_conversation},
                            timeout=60.0,
                        )
                        if not isinstance(started.get("sessionId"), str) or not started["sessionId"]:
                            started = {"sessionId": resume_conversation, **started}
                    except AgyProfileError as exc:
                        _append_log(f"session/resume fallback to session/new ({resume_conversation}): {exc}")
                        started = None

                if started is None:
                    started = self._rpc("session/new", base_session, timeout=60.0)

                sid = started.get("sessionId")
                if not isinstance(sid, str) or not sid:
                    raise AgyProfileError(502, "Agy ACP 未返回有效的 sessionId")
                self.acp_session_id = sid
                self.setup_result = started
                models = extract_model_catalog_from_setup(started)
                if models and self._on_models:
                    self._on_models(models)
                self.last_used = time.monotonic()
                return sid
            except Exception:
                self._teardown_locked()
                raise

    def run_turn(
        self,
        *,
        run_id: str,
        prompt_text: str,
        model: str,
        effort: str,
        mode: str,
        permission_mode: str,
        resume_conversation: str | None,
        add_dirs: tuple[str, ...],
        staged_paths: list[Path],
        attachments: list[dict[str, Any]],
        allowed_roots: list[Path],
        on_event: Callable[[dict[str, Any]], None],
    ) -> dict[str, Any]:
        """Execute a complete conversational/editing turn inside the persistent ACP session."""
        acp_sid = self.ensure_started(resume_conversation=resume_conversation, add_dirs=add_dirs)
        turn = _ActiveTurn(
            run_id=run_id,
            mode=mode,
            permission_mode=permission_mode,
            workspace=self.workspace,
            allowed_roots=allowed_roots,
            on_event=on_event,
        )
        self.active_turn = turn
        try:
            avail_modes = (
                self.setup_result.get("modes", {}).get("availableModes")
                if isinstance(self.setup_result.get("modes"), dict)
                else None
            )
            wire_mode = session_mode_for_policy(mode, permission_mode, avail_modes)
            try:
                self._rpc("session/set_mode", {"sessionId": acp_sid, "modeId": wire_mode}, timeout=20.0)
            except AgyProfileError as exc:
                _append_log(f"session/set_mode({wire_mode}) skipped: {exc}")
                turn.on_event(
                    turn.normalizer.emit_notice(
                        "runtime_notice",
                        f"上游未接受模式 {wire_mode}，已沿用默认模式（工具权限仍由 GA-Hub 策略拦截控制）",
                    )
                )

            for rpc_method, rpc_params in select_model_and_effort_calls(self.setup_result, model, effort):
                try:
                    self._rpc(rpc_method, {"sessionId": acp_sid, **rpc_params}, timeout=20.0)
                except AgyProfileError as exc:
                    _append_log(f"{rpc_method} skipped: {exc}")
                    turn.on_event(
                        turn.normalizer.emit_notice("runtime_notice", f"参数切换 {rpc_method} 已跳过: {exc}")
                    )

            caps = self.init_result.get("agentCapabilities") if isinstance(self.init_result, dict) else {}
            prompt_caps = caps.get("promptCapabilities") if isinstance(caps, dict) else {}
            blocks = build_prompt_blocks(prompt_text, staged_paths, attachments, prompt_caps)

            with self._rpc_lock:
                req_id = self._next_id
                self._next_id += 1
                ev = threading.Event()
                box: dict[str, Any] = {}
                self._pending_rpcs[req_id] = (ev, box)

            self._send_frame({
                "jsonrpc": "2.0",
                "id": req_id,
                "method": "session/prompt",
                "params": {"sessionId": acp_sid, "prompt": blocks},
            })

            while not ev.wait(1.0):
                if turn.cancelled:
                    break
                # Pause inactivity countdown while waiting for user approval / question input.
                if turn.current_approval() is not None:
                    turn.touch()
                    continue
                if time.monotonic() - turn.last_activity > INACTIVITY_TIMEOUT:
                    self.cancel_turn()
                    return {
                        "status": "timeout",
                        "conversation_id": acp_sid,
                        "answer": "".join(turn.normalizer.answer_chunks) or None,
                        "error": "Agy 任务响应超时",
                        "usage": dict(turn.normalizer.usage),
                    }

            if turn.cancelled and not ev.is_set():
                ev.wait(5.0)
                with self._rpc_lock:
                    self._pending_rpcs.pop(req_id, None)

            for evt in turn.normalizer.finish_turn():
                turn.on_event(evt)

            answer = "".join(turn.normalizer.answer_chunks)
            usage = dict(turn.normalizer.usage)
            if turn.cancelled:
                return {
                    "status": "cancelled",
                    "conversation_id": acp_sid,
                    "answer": answer or None,
                    "usage": usage,
                }
            if "error" in box:
                err = box["error"]
                msg = err.get("message") if isinstance(err, dict) else str(err)
                lower = str(msg).lower()
                if "rate" in lower or "429" in lower or "quota" in lower or "resource_exhausted" in lower:
                    status = "rate_limited"
                else:
                    status = "cli_error"
                return {
                    "status": status,
                    "conversation_id": acp_sid,
                    "answer": answer or None,
                    "error": str(msg),
                    "usage": usage,
                }
            return {
                "status": "success",
                "conversation_id": acp_sid,
                "answer": answer,
                "usage": usage,
            }
        finally:
            self.active_turn = None
            turn.done_event.set()
            self.last_used = time.monotonic()

    def cancel_turn(self) -> None:
        turn = self.active_turn
        if turn is not None:
            turn.cancel_pending()
        if self.acp_session_id and self.is_alive():
            try:
                self._send_frame({
                    "jsonrpc": "2.0",
                    "method": "session/cancel",
                    "params": {"sessionId": self.acp_session_id},
                })
            except AgyProfileError:
                pass

    def _teardown_locked(self) -> None:
        self._closed = True
        turn = self.active_turn
        if turn is not None:
            turn.cancel_pending()
        proc = self.proc
        self.proc = None
        sid = self.acp_session_id
        self.acp_session_id = None
        if proc is not None:
            if sid and proc.stdin and proc.poll() is None:
                try:
                    proc.stdin.write(json.dumps({
                        "jsonrpc": "2.0",
                        "id": 999999,
                        "method": "session/close",
                        "params": {"sessionId": sid},
                    }) + "\n")
                    proc.stdin.flush()
                except OSError:
                    pass
            for stream in (proc.stdin, proc.stdout):
                if stream:
                    try:
                        stream.close()
                    except OSError:
                        pass
            if proc.poll() is None:
                child_job.terminate_tree(proc.pid)
            child_job.forget(proc.pid)
        if self.temp_dir is not None:
            shutil.rmtree(self.temp_dir, ignore_errors=True)
            self.temp_dir = None

    def close(self) -> None:
        with self._lock:
            self._teardown_locked()


class AgyRuntimeManager:
    """Process-wide manager for standalone Agy ACP workers, models, and logins."""

    def __init__(
        self,
        *,
        idle_ttl: float = IDLE_SESSION_TTL,
        reaper_interval: float | None = None,
    ) -> None:
        self._lock = threading.RLock()
        self._workers: dict[tuple[str, str, str], AgySessionWorker] = {}
        self._active_turns: dict[tuple[Path, str], AgySessionWorker] = {}
        self._stopped_manually = False
        self._cached_version: str | None = None
        self._version_checked = False
        self._cached_models: dict[str, list[dict[str, str]]] = {}
        self._cached_commands: dict[str, list[dict[str, Any]]] = {}
        self._login: subprocess.Popen | None = None
        self._login_profile: str | None = None
        self._code_login: CodeLoginFlow | None = None
        self._idle_ttl = max(0.0, float(idle_ttl))
        self._reaper_interval = (
            float(reaper_interval)
            if reaper_interval is not None
            else min(60.0, max(5.0, self._idle_ttl / 6.0 if self._idle_ttl > 0 else 60.0))
        )
        self._shutdown_event = threading.Event()
        self._reaper_thread: threading.Thread | None = None

    def _probe_version_once(self, executable: str) -> str | None:
        if self._version_checked:
            return self._cached_version
        self._version_checked = True
        try:
            res = subprocess.run(
                [executable, "--version"],
                stdin=subprocess.DEVNULL,
                capture_output=True,
                encoding="utf-8",
                errors="replace",
                timeout=8,
                **hidden_process_kwargs(),
            )
            if res.returncode == 0:
                m = re.search(r"(\d+\.\d+\.\d+)", res.stdout or res.stderr or "")
                if m:
                    self._cached_version = m.group(1)
        except (OSError, subprocess.SubprocessError):
            pass
        return self._cached_version

    def _active_turn_count(self) -> int:
        with self._lock:
            return sum(1 for w in self._active_turns.values() if w.active_turn is not None)

    def _auth_state_fast(self, profile_id: str) -> AntiAuthState:
        return "authenticated" if agy_profile.has_local_credentials(profile_id) else "login_required"

    def status(self, *, verify_auth: bool = False) -> AntiDaemonStatus:
        """Fast, non-spawning runtime snapshot (T3 Code health-check discipline)."""
        with self._lock:
            executable = agy_profile.agy_executable_or_none()
            if executable is None:
                return AntiDaemonStatus(
                    state="unavailable",
                    detail="找不到官方 agy CLI，请先安装 agy 并加入 PATH",
                    agy_available=False,
                    active_count=0,
                    auth_state="unverified" if verify_auth else None,
                    managed=True,
                )
            version = self._cached_version or self._probe_version_once(executable)
            if self._stopped_manually:
                return AntiDaemonStatus(
                    state="stopped",
                    detail="Agy 运行时已手动停止",
                    agy_available=True,
                    active_count=0,
                    auth_state=None,
                    managed=True,
                    version=version,
                )
            active_id = agy_profile.snapshot()[0]
            return AntiDaemonStatus(
                state="ready",
                detail=None,
                agy_available=True,
                active_count=self._active_turn_count(),
                auth_state=self._auth_state_fast(active_id) if verify_auth else None,
                managed=True,
                version=version,
            )

    def panel_status(self) -> AntiDaemonStatus:
        return self.status(verify_auth=False)

    def start(self) -> AntiDaemonStatus:
        with self._lock:
            executable = agy_profile.agy_executable_or_none()
            if executable is None:
                raise AgyProfileError(503, "找不到官方 agy CLI，请先安装 agy 并加入 PATH")
            self._shutdown_event.clear()
            self._stopped_manually = False
            self._version_checked = False
            _append_log("Agy ACP runtime enabled")
            return self.status(verify_auth=True)

    def stop(self) -> AntiDaemonStatus:
        with self._lock:
            if self._active_turn_count() > 0:
                raise AgyProfileError(409, "当前有正在运行的 Anti 任务，请先停止或等待任务结束")
            self._close_all_workers_locked()
            self._stopped_manually = True
            _append_log("Agy ACP runtime stopped")
            return self.status(verify_auth=False)

    def restart(self) -> AntiDaemonStatus:
        with self._lock:
            if self._active_turn_count() > 0:
                raise AgyProfileError(409, "当前有正在运行的 Anti 任务，请先停止或等待任务结束")
            self._close_all_workers_locked()
            self._stopped_manually = False
            self._cached_models.clear()
            self._version_checked = False
            _append_log("Agy ACP runtime restarted")
            return self.status(verify_auth=True)

    def _close_all_workers_locked(self) -> None:
        for worker in list(self._workers.values()):
            worker.close()
        self._workers.clear()
        self._active_turns.clear()

    def reap_idle_workers(self, *, now: float | None = None) -> int:
        """Close idle ACP child workers exceeding IDLE_SESSION_TTL while keeping SQLite resume IDs."""
        if self._idle_ttl <= 0:
            return 0
        current = time.monotonic() if now is None else now
        stale: list[AgySessionWorker] = []
        with self._lock:
            for key, worker in list(self._workers.items()):
                if worker.active_turn is not None:
                    continue
                if worker._closed or (current - worker.last_used) >= self._idle_ttl:
                    self._workers.pop(key, None)
                    stale.append(worker)
        for worker in stale:
            worker.close()
        if stale:
            _append_log(f"Reaped {len(stale)} idle Agy ACP worker(s)")
        return len(stale)

    def _reaper_loop(self) -> None:
        while not self._shutdown_event.wait(self._reaper_interval):
            try:
                self.reap_idle_workers()
            except Exception:
                log.debug("Agy idle reaper iteration failed", exc_info=True)
            with self._lock:
                if not self._workers:
                    self._reaper_thread = None
                    return

    def _ensure_reaper_locked(self) -> None:
        if self._idle_ttl <= 0 or self._shutdown_event.is_set():
            return
        if self._reaper_thread is not None and self._reaper_thread.is_alive():
            return
        self._reaper_thread = threading.Thread(
            target=self._reaper_loop,
            name="agy-acp-reaper",
            daemon=True,
        )
        self._reaper_thread.start()

    def shutdown(self) -> None:
        self._shutdown_event.set()
        with self._lock:
            self._close_all_workers_locked()
            if self._code_login is not None:
                self._code_login.cancel()
                self._code_login = None
            if self._login is not None and self._login.poll() is None:
                child_job.terminate_tree(self._login.pid)
                child_job.forget(self._login.pid)
            self._login = None
            self._login_profile = None
            reaper = self._reaper_thread
            self._reaper_thread = None
        if reaper is not None and reaper.is_alive() and threading.current_thread() is not reaper:
            reaper.join(timeout=1.0)

    @staticmethod
    def _log_path() -> Path:
        return _log_path()

    def tail_logs(self, lines: int = 80) -> tuple[list[str], str]:
        path = _log_path()
        try:
            if not path.is_file():
                return [], str(path)
            content = path.read_text(encoding="utf-8", errors="replace").splitlines()
            return content[-max(1, min(lines, 500)) :], str(path)
        except OSError:
            return [], str(path)

    def _require_login_closed(self, *profiles: str) -> None:
        if self._login is not None:
            if self._login.poll() is None:
                if self._login_profile in profiles:
                    raise AgyProfileError(409, "请完成官方 agy 登录并关闭登录窗口后再操作")
                return
            child_job.forget(self._login.pid)
            self._login = None
            self._login_profile = None
        if self._code_login is not None:
            st = self._code_login.public_state()
            if st["phase"] in ("starting", "waiting_code") and st["profile_id"] in profiles:
                raise AgyProfileError(409, "请先完成或取消当前 Agy 授权码登录")

    def active_login_profile(self) -> str | None:
        with self._lock:
            if self._login is not None:
                if self._login.poll() is None:
                    return self._login_profile
                child_job.forget(self._login.pid)
                self._login = None
                self._login_profile = None
            if self._code_login is not None:
                st = self._code_login.public_state()
                if st["phase"] in ("starting", "waiting_code"):
                    return st["profile_id"]
            return None

    @contextmanager
    def submission(self):
        with self._lock:
            profile_id = agy_profile.snapshot()[0]
            self._require_login_closed(profile_id)
            if self._stopped_manually:
                raise AgyProfileError(409, "Agy 运行时已停止，请先在顶部状态栏重新启用")
            agy_profile.agy_executable()
            yield profile_id

    def get_worker(self, db_key: str, profile_id: str, session_id: str, workspace: Path) -> AgySessionWorker:
        with self._lock:
            key = (db_key, profile_id, session_id)
            worker = self._workers.get(key)
            if worker is not None and worker.workspace == workspace and not worker._closed:
                return worker
            if worker is not None:
                worker.close()
            executable = agy_profile.agy_executable()
            version = self._probe_version_once(executable)
            worker = AgySessionWorker(
                profile_id=profile_id,
                session_id=session_id,
                workspace=workspace,
                executable=executable,
                version=version,
                on_models=lambda models, pid=profile_id: self._record_models(pid, models),
                on_commands=lambda cmds, pid=profile_id: self._record_commands(pid, cmds),
            )
            self._workers[key] = worker
            self._ensure_reaper_locked()
            return worker

    def _record_models(self, profile_id: str, items: list[dict[str, str]]) -> None:
        with self._lock:
            if items:
                self._cached_models[profile_id] = items

    def _record_commands(self, profile_id: str, commands: list[dict[str, Any]]) -> None:
        cleaned: list[dict[str, Any]] = []
        seen: set[str] = set()
        for cmd in commands:
            if not isinstance(cmd, dict):
                continue
            name = str(cmd.get("name") or "").strip().lstrip("/")
            if not name or name in seen:
                continue
            seen.add(name)
            entry: dict[str, Any] = {"name": name}
            desc = str(cmd.get("description") or "").strip()
            if desc:
                entry["description"] = desc
            inp = cmd.get("input")
            if isinstance(inp, dict) and str(inp.get("hint") or "").strip():
                entry["hint"] = str(inp["hint"]).strip()
            cleaned.append(entry)
        if cleaned:
            with self._lock:
                self._cached_commands[profile_id] = cleaned

    def commands(self, profile_id: str | None = None) -> list[dict[str, Any]]:
        pid = profile_id or agy_profile.snapshot()[0]
        with self._lock:
            cached = self._cached_commands.get(pid)
            if cached:
                return list(cached)
        return [
            {"name": "plan", "description": "先进行调研并生成结构化方案", "hint": "<目标>"},
            {"name": "compact", "description": "压缩当前对话上下文以节省额度"},
            {"name": "review", "description": "审查工作区改动与潜在问题"},
        ]

    def session_connected(self, db_key: str, session_id: str) -> bool:
        with self._lock:
            return any(
                k[0] == db_key and k[2] == session_id and w.is_alive()
                for k, w in self._workers.items()
            )

    def register_turn(self, db_path: Path, run_id: str, worker: AgySessionWorker) -> None:
        with self._lock:
            self._active_turns[(db_path, run_id)] = worker

    def unregister_turn(self, db_path: Path, run_id: str) -> None:
        with self._lock:
            self._active_turns.pop((db_path, run_id), None)

    def active_turn_approval(self, db_path: Path, run_id: str) -> dict[str, Any] | None:
        with self._lock:
            worker = self._active_turns.get((db_path, run_id))
            turn = worker.active_turn if worker else None
            return turn.current_approval() if turn else None

    def approve_turn(
        self,
        db_path: Path,
        run_id: str,
        approval_id: str,
        decision: str,
        option_id: str | None = None,
    ) -> bool:
        with self._lock:
            worker = self._active_turns.get((db_path, run_id))
            turn = worker.active_turn if worker else None
        if turn is None:
            return False
        return turn.decide(approval_id, decision, option_id=option_id)

    def cancel_turn(self, db_path: Path, run_id: str) -> bool:
        with self._lock:
            worker = self._active_turns.get((db_path, run_id))
        if worker is None:
            return False
        worker.cancel_turn()
        return True

    def close_session(self, db_key: str, session_id: str) -> None:
        with self._lock:
            for key in [k for k in self._workers if k[0] == db_key and k[2] == session_id]:
                self._workers.pop(key).close()

    @staticmethod
    def _parse_models_output(stdout: str) -> list[dict[str, str]]:
        stripped = (stdout or "").strip()
        if not stripped:
            return []
        if stripped.startswith("["):
            upstream = json.loads(stripped)
            if not isinstance(upstream, list):
                raise AgyProfileError(502, "Agy 返回了无效的模型目录")
            rows: list[tuple[str, str]] = []
            for row in upstream:
                if isinstance(row, dict) and isinstance(row.get("id"), str) and row["id"]:
                    rows.append((row["id"], str(row.get("display_name") or row["id"])))
        else:
            rows = []
            for raw_line in stripped.splitlines():
                line = raw_line.strip()
                if not line or line.lower().startswith("fetching available models"):
                    continue
                if "\t" in line:
                    mid, _, label = line.partition("\t")
                else:
                    parts = line.split(None, 1)
                    mid = parts[0]
                    label = parts[1] if len(parts) > 1 else mid
                mid = mid.strip()
                label = label.strip() or mid
                if mid:
                    rows.append((mid, label))
        items: list[dict[str, str]] = []
        seen: set[str] = set()
        for mid, label in rows:
            if mid not in seen:
                seen.add(mid)
                items.append({"id": mid, "display_name": label})
        return items

    def models(self, profile_id: str | None = None) -> list[dict[str, str]]:
        pid = profile_id or agy_profile.snapshot()[0]
        with self._lock:
            self._require_login_closed(pid)
            cached = self._cached_models.get(pid)
            if cached:
                return list(cached)
        executable = agy_profile.agy_executable()
        temp_dir = agy_profile.make_runtime_temp_dir(pid)
        try:
            env = agy_profile.clean_agy_env(pid, temp_dir=temp_dir)
            result = subprocess.run(
                [executable, "models"],
                stdin=subprocess.DEVNULL,
                capture_output=True,
                encoding="utf-8",
                errors="replace",
                timeout=24,
                check=False,
                **hidden_process_kwargs(),
                env=env,
            )
            if result.returncode != 0:
                combined = f"{result.stdout or ''}\n{getattr(result, 'stderr', '') or ''}"
                if re.search(r"please sign in|not logged in|login required|authentication required", combined, re.I):
                    raise AgyProfileError(409, "Agy 账号尚未登录，请先完成官方登录后重试")
                raise AgyProfileError(503, "读取 Agy 模型目录失败，请检查 agy 安装和登录状态")
            items = self._parse_models_output(result.stdout)
        except AgyProfileError:
            raise
        except (OSError, subprocess.SubprocessError, ValueError) as exc:
            raise AgyProfileError(503, "读取 Agy 模型目录失败，请检查 agy 安装和登录状态") from exc
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

        if not items:
            raise AgyProfileError(502, "Agy 返回了空的模型目录")
        self._record_models(pid, items)
        return items

    # ── Profile management operations ──

    def add_profile(self, name: str):
        with self._lock:
            return agy_profile.add(name)

    def capture_profile(self, name: str):
        with self._lock:
            self._require_login_closed(agy_profile.DEFAULT)
            return agy_profile.capture_default(name)

    def rename_profile(self, profile_id: str, name: str):
        with self._lock:
            return agy_profile.rename(profile_id, name)

    def delete_profile(self, profile_id: str) -> None:
        with self._lock:
            self._require_login_closed(profile_id)
            for key in [k for k in self._workers if k[1] == profile_id]:
                self._workers.pop(key).close()
            self._cached_models.pop(profile_id, None)
            self._cached_commands.pop(profile_id, None)
            agy_profile.delete(profile_id)

    def clear_profile_credentials(self, profile_id: str) -> dict[str, Any]:
        with self._lock:
            self._require_login_closed(profile_id)
            active, _ = agy_profile.snapshot()
            if active == profile_id and self._active_turn_count() > 0:
                raise AgyProfileError(409, "请先等待当前任务结束后再清除凭据")
            for key in [k for k in self._workers if k[1] == profile_id]:
                self._workers.pop(key).close()
            self._cached_models.pop(profile_id, None)
            self._cached_commands.pop(profile_id, None)
            return agy_profile.clear_credentials(profile_id)

    def switch_profile(self, profile_id: str) -> None:
        with self._lock:
            active, profiles = agy_profile.snapshot()
            if not any(p.id == profile_id for p in profiles):
                raise AgyProfileError(404, "找不到 Agy 账号")
            if active == profile_id:
                return
            self._require_login_closed(active, profile_id)
            if self._active_turn_count() > 0:
                raise AgyProfileError(409, "请等当前 Agy 任务全部结束后再切换账号")
            # Close existing ACP sessions cleanly so the next turn binds to the newly selected profile.
            self._close_all_workers_locked()
            self._cached_models.clear()
            self._cached_commands.clear()
            agy_profile.select(profile_id)
            _append_log(f"Switched active Agy profile to {profile_id}")

    def login_profile(self, profile_id: str) -> None:
        with self._lock:
            if os.name != "nt":
                raise AgyProfileError(501, "从 GA-Hub 打开独立窗口仅支持 Windows，请使用应用内 Google 授权码登录")
            _, profiles = agy_profile.snapshot()
            if not any(p.id == profile_id for p in profiles):
                raise AgyProfileError(404, "找不到 Agy 账号")
            self._require_login_closed(*(p.id for p in profiles))
            if self._login is not None:
                if self._login.poll() is None:
                    raise AgyProfileError(409, "请先关闭上一个 agy 登录窗口")
                child_job.forget(self._login.pid)
                self._login = None
            if self._active_turn_count() > 0:
                raise AgyProfileError(409, "请等当前任务结束后再打开官方登录窗口")
            executable = agy_profile.agy_executable()
            agy_profile.prepare_profile(profile_id)
            env = agy_profile.clean_agy_env(profile_id)
            cwd = agy_profile.profile_home(profile_id)
            try:
                self._login = child_job.spawn(
                    [executable],
                    kind="agy-login",
                    marker=executable,
                    cwd=str(cwd),
                    env=env,
                    creationflags=subprocess.CREATE_NEW_CONSOLE,
                )
                self._login_profile = profile_id
            except OSError as exc:
                raise AgyProfileError(503, "无法打开官方 agy 登录窗口") from exc

    def start_code_login(self, profile_id: str) -> dict[str, Any]:
        """Start T3 Code's cross-platform `agy acp --login` flow."""
        with self._lock:
            active, profiles = agy_profile.snapshot()
            if not any(p.id == profile_id for p in profiles):
                raise AgyProfileError(404, "找不到 Agy 账号")
            if active == profile_id and self._active_turn_count() > 0:
                raise AgyProfileError(409, "请先等待当前任务结束后再重新登录当前账号")
            if self._code_login is not None:
                self._code_login.cancel()
                self._code_login = None
            self._require_login_closed(*(p.id for p in profiles))
            executable = agy_profile.agy_executable()
            agy_profile.prepare_profile(profile_id)
            temp_dir = agy_profile.make_runtime_temp_dir(profile_id)
            env = agy_profile.clean_agy_env(profile_id, temp_dir=temp_dir, headless_login=True)
            cmd = agy_profile.acp_spawn_command(executable, profile_id, login=True)
            try:
                proc = child_job.spawn(
                    cmd,
                    kind="agy-code-login",
                    marker=executable,
                    cwd=str(agy_profile.profile_gemini_dir(profile_id)),
                    env=env,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    encoding="utf-8",
                    errors="replace",
                    bufsize=1,
                    **hidden_process_kwargs(),
                )
            except OSError as exc:
                shutil.rmtree(temp_dir, ignore_errors=True)
                raise AgyProfileError(503, "无法启动 agy 登录流程") from exc
            flow = CodeLoginFlow(flow_id=uuid4().hex, profile_id=profile_id, process=proc, temp_dir=temp_dir)
            self._code_login = flow
            threading.Thread(target=flow.watch, daemon=True).start()

        deadline = time.monotonic() + 20.0
        while time.monotonic() < deadline:
            state = flow.public_state()
            if state["authorization_url"] or state["phase"] in ("failed", "cancelled", "completed"):
                return state
            time.sleep(0.1)
        return flow.public_state()

    def code_login_status(self, flow_id: str) -> dict[str, Any]:
        with self._lock:
            flow = self._code_login
        if flow is None or flow.flow_id != flow_id:
            raise AgyProfileError(404, "登录流程不存在或已失效")
        return flow.public_state()

    def submit_code_login(self, flow_id: str, code: str) -> dict[str, Any]:
        with self._lock:
            flow = self._code_login
        if flow is None or flow.flow_id != flow_id:
            raise AgyProfileError(404, "登录流程不存在或已失效")
        flow.submit_code(code)
        deadline = time.monotonic() + 20.0
        while time.monotonic() < deadline:
            state = flow.public_state()
            if state["phase"] in ("completed", "failed", "cancelled"):
                return state
            time.sleep(0.15)
        return flow.public_state()


runtime = AgyRuntimeManager()
