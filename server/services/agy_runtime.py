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
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Literal, get_args
from uuid import uuid4

from .. import _paths
from ..process_utils import hidden_process_kwargs
from . import agy_models, agy_pricing, agy_profile, agy_usage, child_job
from .agy_profile import AgyProfileError, CodeLoginFlow
from .agy_protocol import (
    AgyModelSelectionError,
    PROMPT_ACTIVITY_UPDATES,
    RuntimeGrants,
    ReadRepair,
    SessionUpdateNormalizer,
    build_prompt_blocks,
    classify_poisoned_thread_error,
    client_info_for_version,
    default_permission_mode,
    evaluate_permission,
    extract_enriched_model_catalog_from_setup,
    extract_model_catalog_from_setup,
    extract_permission_prompt,
    extract_usage_fields,
    find_model_config_option,
    handle_read_text_file,
    has_pending_reply_on_disk,
    normalize_usage_payload,
    parse_version,
    PromptOutcomeWatcher,
    read_detached_children_at_work,
    read_pre_edit_file,
    resolve_model_target,
    select_effort_call_for_config,
    select_model_and_effort_calls,
    session_mode_for_policy,
    supports_prompt_steering,
    supports_system_prompt_append,
)

log = logging.getLogger(__name__)

AntiDaemonState = Literal["stopped", "starting", "ready", "unavailable"]
AntiAuthState = Literal["checking", "authenticated", "login_required", "unverified"]

INACTIVITY_TIMEOUT = 900.0
ACTIVE_TOOL_SILENT_TIMEOUT = 1800.0
POST_SETTLE_DEBOUNCE = 3.0
POST_SETTLE_REPLY_QUIET_LIMIT = 120.0
POST_SETTLE_COMMAND_HOLD_TIMEOUT = 1800.0
APPROVAL_TIMEOUT = 900.0
INIT_TIMEOUT = 120.0
IDLE_SESSION_TTL = 600.0
MAX_IDLE_WORKERS = 2
CANCEL_GRACE_TIMEOUT = 2.0
INACTIVITY_SLICE = 60.0
HOST_SLEEP_TOLERANCE = 30.0

_SYSTEM_PROMPT_APPEND = (
    "You are running inside GA-Hub via Antigravity ACP. "
    "Use workspace tools cleanly and respect user permission confirmations."
)


def _merge_prompt_usage(acc: dict[str, int], payload: Any) -> None:
    delta = normalize_usage_payload(payload)
    for key, val in delta.items():
        acc[key] = acc.get(key, 0) + val


def _merge_subagent_usage(
    usage: dict[str, Any],
    subagent_step_usages: list[dict[str, Any]],
    *,
    parent_step_usages: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Fold subagent transcript step tokens/calls into `usage`, omitting parallel `generation_ms`."""
    merged = dict(usage)
    if not subagent_step_usages:
        return merged

    p_total_in, _, p_cr, p_cw = agy_pricing.split_inclusive_input(
        max(0, int(merged.get("input_tokens") or 0)),
        max(0, int(merged.get("cache_read_tokens") or 0)),
        max(0, int(merged.get("cache_write_tokens") or 0)),
    )
    p_out = max(0, int(merged.get("output_tokens") or 0))
    p_think = max(0, int(merged.get("thinking_tokens") or 0))
    p_billable_out = max(p_out, p_think)

    sub_uncached_in = 0
    sub_cr = 0
    sub_cw = 0
    sub_out_total = 0
    sub_think = 0
    for step in subagent_step_usages:
        if not isinstance(step, dict):
            continue
        s_in = max(0, int(step.get("input_tokens") or 0))
        s_cr = max(0, int(step.get("cache_read_tokens") or 0))
        s_cw = max(0, int(step.get("cache_write_tokens") or 0))
        s_out = max(0, int(step.get("output_tokens") or 0))
        s_th = max(0, int(step.get("thinking_tokens") or 0))
        sub_uncached_in += s_in
        sub_cr += s_cr
        sub_cw += s_cw
        sub_out_total += max(s_out, s_th)
        sub_think += s_th

    sub_total_in = sub_uncached_in + sub_cr + sub_cw
    merged["input_tokens"] = p_total_in + sub_total_in
    merged["cache_read_tokens"] = p_cr + sub_cr
    merged["cache_write_tokens"] = p_cw + sub_cw
    merged["output_tokens"] = p_billable_out + sub_out_total
    merged["thinking_tokens"] = p_think + sub_think

    parent_calls = max(0, int(merged.get("model_calls") or 0))
    if parent_calls <= 0:
        if parent_step_usages:
            parent_calls = len(parent_step_usages)
        elif p_total_in > 0 or p_billable_out > 0:
            parent_calls = 1
    merged["model_calls"] = parent_calls + len(subagent_step_usages)
    # Parallel descendant turns share wall-clock generation time; keeping parent-only ms inflates tok/s.
    merged.pop("generation_ms", None)
    return merged


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
    supports_steering: bool | None = None


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
        now = time.monotonic()
        self.last_activity = now
        self.last_progress_at = now
        self.cancelled = False
        self.force_cancelled = False
        self.cancel_event = threading.Event()
        self.wake_event = threading.Event()
        self.prompt_dispatching = threading.Event()
        self.prompt_queued = threading.Event()
        self.event_lock = threading.Lock()
        self.prompt_lock = threading.Lock()
        self.prompt_seq = 0
        self.current_prompt_req_id: int | None = None
        self.current_prompt_event: threading.Event | None = None
        self.current_prompt_box: dict[str, Any] = {}
        self.superseded_prompts: list[tuple[int, threading.Event, dict[str, Any]]] = []
        self._perm_lock = threading.Lock()
        self._open_incoming_requests = 0
        self.pending_permission: _PendingPermission | None = None
        self.done_event = threading.Event()

    def touch(self) -> None:
        now = time.monotonic()
        self.last_activity = now
        self.last_progress_at = now
        self.wake_event.set()

    def touch_progress(self) -> None:
        self.last_progress_at = time.monotonic()

    def begin_incoming_request(self) -> None:
        with self._perm_lock:
            self._open_incoming_requests += 1
            self.last_progress_at = time.monotonic()
        self.wake_event.set()

    def end_incoming_request(self) -> None:
        with self._perm_lock:
            if self._open_incoming_requests > 0:
                self._open_incoming_requests -= 1
            self.last_progress_at = time.monotonic()
        self.wake_event.set()

    def inactivity_paused(self) -> bool:
        with self._perm_lock:
            has_pending = self.pending_permission is not None
            has_open_req = self._open_incoming_requests > 0
        return has_pending or has_open_req or self.normalizer.has_active_tools()

    def has_post_settle_work(self) -> bool:
        with self._perm_lock:
            has_pending = self.pending_permission is not None
            has_open_req = self._open_incoming_requests > 0
        return has_pending or has_open_req or self.normalizer.has_outliving_background_work()

    def current_prompt_state(self) -> tuple[int | None, threading.Event | None, dict[str, Any], int]:
        with self.prompt_lock:
            return (
                self.current_prompt_req_id,
                self.current_prompt_event,
                self.current_prompt_box,
                self.prompt_seq,
            )

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

    def cancel_pending(self, *, force: bool = False) -> None:
        self.cancelled = True
        if force:
            self.force_cancelled = True
        with self._perm_lock:
            pending = self.pending_permission
            if pending is not None:
                pending.decision = "cancel"
                self.pending_permission = None
                pending.event.set()
        self.cancel_event.set()
        self.wake_event.set()

    def wake_on_disconnect(self) -> None:
        with self._perm_lock:
            pending = self.pending_permission
            if pending is not None:
                pending.decision = "cancel"
                self.pending_permission = None
                pending.event.set()
        self.wake_event.set()


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
        grants: RuntimeGrants | None = None,
        on_models: Callable[[list[dict[str, str]]], None] | None = None,
        on_commands: Callable[[list[dict[str, Any]]], None] | None = None,
        on_retire: Callable[["AgySessionWorker"], None] | None = None,
    ):
        self.profile_id = profile_id
        self.session_id = session_id
        self.workspace = workspace
        self.executable = executable
        self.version = version
        self._on_models = on_models
        self._on_commands = on_commands
        self._on_retire = on_retire

        self._lock = threading.Lock()
        self._proc_lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._rpc_lock = threading.Lock()
        self._next_id = 1
        self._pending_rpcs: dict[int, tuple[threading.Event, dict[str, Any], threading.Event | None]] = {}

        self.proc: subprocess.Popen | None = None
        self._process_group: child_job.ProcessGroupHandle | None = None
        self.temp_dir: Path | None = None
        self._lock_id: str = profile_id
        self._profile_lock_held = False
        self.acp_session_id: str | None = None
        self.init_result: dict[str, Any] = {}
        self.setup_result: dict[str, Any] = {}
        self.grants = grants if grants is not None else RuntimeGrants()
        self.active_turn: _ActiveTurn | None = None
        self.add_dirs: tuple[str, ...] = ()
        self.last_used = time.monotonic()
        self._closed = False
        self._retired = False
        self._dirty = False
        self.resumed_fallback = False
        self._resume_fallback_reason: str | None = None
        self.loaded_orchestrator: tuple[str | None, str | None] | None = None
        self._abort_event = threading.Event()
        self._exit_pending: threading.Event | None = None
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

    def _wake_pending_rpcs(self, message: str) -> None:
        with self._rpc_lock:
            items = list(self._pending_rpcs.values())
            self._pending_rpcs.clear()
        for entry in items:
            ev, box = entry[0], entry[1]
            wake_ev = entry[2] if len(entry) > 2 else None
            box.setdefault("error", {"code": -32000, "message": message})
            ev.set()
            if wake_ev is not None:
                wake_ev.set()

    def _rpc(
        self,
        method: str,
        params: dict[str, Any],
        timeout: float = INIT_TIMEOUT,
        *,
        cancel_event: threading.Event | None = None,
    ) -> dict[str, Any]:
        if self._abort_event.is_set() or (cancel_event is not None and cancel_event.is_set()):
            self._dirty = True
            raise AgyProfileError(499, "Agy 任务已取消")
        wake_ev = threading.Event()
        with self._rpc_lock:
            req_id = self._next_id
            self._next_id += 1
            ev = threading.Event()
            box: dict[str, Any] = {}
            self._pending_rpcs[req_id] = (ev, box, wake_ev)
        try:
            self._send_frame({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params})
        except BaseException:
            with self._rpc_lock:
                self._pending_rpcs.pop(req_id, None)
            raise
        deadline = time.monotonic() + timeout
        while not ev.is_set():
            if self._abort_event.is_set() or (cancel_event is not None and cancel_event.is_set()):
                with self._rpc_lock:
                    self._pending_rpcs.pop(req_id, None)
                self._dirty = True
                raise AgyProfileError(499, "Agy 任务已取消")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                with self._rpc_lock:
                    self._pending_rpcs.pop(req_id, None)
                raise AgyProfileError(504, f"Agy ACP {method} 超时")
            step = min(remaining, 0.05 if cancel_event is not None else 0.2)
            ev.wait(step)
        if "error" in box:
            err = box["error"]
            msg = err.get("message") if isinstance(err, dict) else str(err)
            code = err.get("code") if isinstance(err, dict) else None
            if self._abort_event.is_set() or (cancel_event is not None and cancel_event.is_set()):
                self._dirty = True
                raise AgyProfileError(499, "Agy 任务已取消")
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
                        ev, box = entry[0], entry[1]
                        wake_ev = entry[2] if len(entry) > 2 else None
                        if "error" in frame:
                            box["error"] = frame["error"]
                        else:
                            box["result"] = frame.get("result")
                        ev.set()
                        if wake_ev is not None:
                            wake_ev.set()
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
            self._wake_pending_rpcs("Agy ACP 连接已关闭")
            turn = self.active_turn
            if turn is not None:
                if self._abort_event.is_set():
                    turn.cancel_pending(force=True)
                else:
                    turn.wake_on_disconnect()

    def _handle_session_update(self, params: dict[str, Any]) -> None:
        update = params.get("update")
        if not isinstance(update, dict):
            return
        # Command snapshots may arrive before, during, or between active turns.
        update_kind = update.get("sessionUpdate")
        if update_kind == "available_commands_update":
            cmds = update.get("availableCommands")
            if isinstance(cmds, list) and self._on_commands:
                self._on_commands(cmds)
        turn = self.active_turn
        if turn is None:
            return
        if update_kind in PROMPT_ACTIVITY_UPDATES:
            turn.touch()
        lock = getattr(turn, "event_lock", None)
        if lock is not None:
            with lock:
                repaired = turn.read_repair.track_update(update)
                for evt in turn.normalizer.normalize(repaired):
                    try:
                        turn.on_event(evt)
                    except Exception:
                        log.debug("Failed to deliver ACP session update", exc_info=True)
        else:
            repaired = turn.read_repair.track_update(update)
            for evt in turn.normalizer.normalize(repaired):
                try:
                    turn.on_event(evt)
                except Exception:
                    log.debug("Failed to deliver ACP session update", exc_info=True)
        if update_kind == "usage_update" and getattr(turn.normalizer, "prompt_settled", False):
            wake_ev = getattr(turn, "wake_event", None)
            if wake_ev is not None:
                wake_ev.set()

    def _handle_incoming_request(self, req_id: Any, method: Any, params: dict[str, Any]) -> None:
        turn = self.active_turn
        if method == "fs/read_text_file":
            if turn is not None:
                turn.begin_incoming_request()
            try:
                roots = turn.allowed_roots if turn else [self.workspace]
                res, err = handle_read_text_file(params, roots)
                target_path = str(params.get("path") or "")
                if turn is not None and target_path:
                    lock = getattr(turn, "event_lock", None)
                    if lock is not None:
                        with lock:
                            completed_tid = turn.read_repair.attempted(target_path, err is None)
                            if completed_tid:
                                for evt in turn.normalizer.normalize({
                                    "sessionUpdate": "tool_call_update",
                                    "toolCallId": completed_tid,
                                    "status": "completed",
                                }):
                                    turn.on_event(evt)
                    else:
                        completed_tid = turn.read_repair.attempted(target_path, err is None)
                        if completed_tid:
                            for evt in turn.normalizer.normalize({
                                "sessionUpdate": "tool_call_update",
                                "toolCallId": completed_tid,
                                "status": "completed",
                            }):
                                turn.on_event(evt)
                self._reply(req_id, result=res, error=err)
            finally:
                if turn is not None:
                    turn.end_incoming_request()
            return

        if method == "session/request_permission":
            if turn is None or turn.cancelled or self._closed:
                if not self._closed:
                    self._reply(req_id, result={"outcome": {"outcome": "cancelled"}})
                return

            turn.begin_incoming_request()
            try:
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

                if pending.decision == "cancel" or turn.cancelled or self._closed:
                    if not self._closed:
                        self._reply(req_id, result={"outcome": {"outcome": "cancelled"}})
                    return

                chosen_oid: str | None = None
                if pending.option_id and pending.option_id in option_map:
                    chosen_oid = option_map[pending.option_id]
                elif pending.decision == "allow_always":
                    chosen_oid = option_map.get("allow_always") or option_map.get("allow")
                    if chosen_oid:
                        self.grants.record(str(prompt_info.get("tool_kind") or "other"))
                elif pending.decision == "allow":
                    chosen_oid = option_map.get("allow") or option_map.get("allow_always")
                elif pending.decision is None and not pending.option_id:
                    if not self._closed:
                        self._reply(req_id, result={"outcome": {"outcome": "cancelled"}})
                    return
                if not chosen_oid:
                    chosen_oid = prompt_info.get("default_option") or "reject"

                self._reply(req_id, result={"outcome": {"outcome": "selected", "optionId": chosen_oid}})
            finally:
                turn.end_incoming_request()
            return

        self._reply(req_id, error={"code": -32601, "message": f"Method not implemented: {method}"})

    def ensure_started(self, *, resume_conversation: str | None, add_dirs: tuple[str, ...]) -> str:
        """Start (or reuse) the persistent ACP process and return the native sessionId."""
        with self._lock:
            if self._abort_event.is_set():
                self._dirty = True
                raise AgyProfileError(499, "Agy 任务已取消")
            if self._retired or self.exit_pending() or self._closed:
                raise AgyProfileError(409, "Agy 正在关闭旧会话，请稍后重试")
            if self.is_alive() and set(add_dirs).issubset(set(self.add_dirs)):
                self.last_used = time.monotonic()
                assert self.acp_session_id is not None
                return self.acp_session_id
            if self.proc is not None:
                self._teardown_locked()
                if self.exit_pending():
                    raise AgyProfileError(409, "Agy 正在关闭旧会话，请稍后重试")

            self.resumed_fallback = False
            self._resume_fallback_reason = None
            agy_profile.claim_workspace_lock()
            self._lock_id = agy_profile.WORKSPACE_LOCK_ID
            self._profile_lock_held = True
            try:
                agy_profile.prepare_workspace(self.profile_id)
                if self._abort_event.is_set():
                    self._dirty = True
                    raise AgyProfileError(499, "Agy 任务已取消")
                try:
                    orch = agy_profile.get_orchestrator_settings(self.profile_id)
                    self.loaded_orchestrator = (orch.get("planner"), orch.get("executor"))
                except AgyProfileError:
                    self.loaded_orchestrator = (None, None)
                self.temp_dir = agy_profile.make_runtime_temp_dir(agy_profile.WORKSPACE_LOCK_ID)
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
                    proc = child_job.spawn(
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
                    group = child_job.create_process_group(proc)
                    with self._proc_lock:
                        self.proc = proc
                        self._process_group = group
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
                    if exc.status == 499 or self._abort_event.is_set():
                        raise
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
                        if exc.status == 499 or self._abort_event.is_set():
                            raise
                        caps = self.init_result.get("agentCapabilities") if isinstance(self.init_result, dict) else None
                        if isinstance(caps, dict) and caps.get("loadSession") is True:
                            try:
                                started = self._rpc(
                                    "session/load",
                                    {**base_session, "sessionId": resume_conversation},
                                    timeout=60.0,
                                )
                                if not isinstance(started.get("sessionId"), str) or not started["sessionId"]:
                                    started = {"sessionId": resume_conversation, **started}
                                _append_log(f"session/resume recovered via session/load ({resume_conversation})")
                            except AgyProfileError as load_exc:
                                if load_exc.status == 499 or self._abort_event.is_set():
                                    raise
                                started = None
                                self.resumed_fallback = True
                                self._resume_fallback_reason = str(exc)
                                _append_log(f"session/resume+load fallback to session/new ({resume_conversation}): {exc}; load={load_exc}")
                        else:
                            self.resumed_fallback = True
                            self._resume_fallback_reason = str(exc)
                            _append_log(f"session/resume fallback to session/new ({resume_conversation}): {exc}")
                            started = None

                if started is None:
                    started = self._rpc("session/new", base_session, timeout=60.0)

                sid = started.get("sessionId")
                if not isinstance(sid, str) or not sid:
                    raise AgyProfileError(502, "Agy ACP 未返回有效的 sessionId")
                self.acp_session_id = sid
                self.setup_result = started
                models = extract_enriched_model_catalog_from_setup(started)
                if models and self._on_models:
                    self._on_models(models)
                self.last_used = time.monotonic()
                return sid
            except BaseException:
                self._teardown_locked(force=self._abort_event.is_set())
                raise


    def _retire(self, *, force: bool = True) -> None:
        if self._on_retire is not None:
            self._on_retire(self)
        else:
            self.close(force=force)

    def _dispatch_prompt(
        self,
        turn: _ActiveTurn,
        acp_sid: str,
        blocks: list[dict[str, Any]],
    ) -> tuple[int, threading.Event, dict[str, Any]]:
        with self._rpc_lock:
            req_id = self._next_id
            self._next_id += 1
            ev = threading.Event()
            box: dict[str, Any] = {}
            self._pending_rpcs[req_id] = (ev, box, turn.wake_event)

        with turn.prompt_lock:
            prev = (
                (turn.current_prompt_req_id, turn.current_prompt_event, turn.current_prompt_box)
                if turn.current_prompt_req_id is not None and turn.current_prompt_event is not None
                else None
            )
            if prev is not None:
                turn.superseded_prompts.append(prev)
            prev_seq = turn.prompt_seq
            prev_settled = turn.normalizer.prompt_settled
            prev_reply_open = turn.normalizer.reply_open
            turn.prompt_seq += 1
            turn.current_prompt_req_id = req_id
            turn.current_prompt_event = ev
            turn.current_prompt_box = box
            turn.normalizer.prompt_settled = False
            turn.normalizer.reply_open = False

        turn.prompt_dispatching.set()
        try:
            self._send_frame({
                "jsonrpc": "2.0",
                "id": req_id,
                "method": "session/prompt",
                "params": {"sessionId": acp_sid, "prompt": blocks},
            })
        except BaseException:
            turn.prompt_dispatching.clear()
            with self._rpc_lock:
                self._pending_rpcs.pop(req_id, None)
            with turn.prompt_lock:
                if turn.current_prompt_req_id == req_id:
                    if prev is not None:
                        if turn.superseded_prompts and turn.superseded_prompts[-1][0] == prev[0]:
                            turn.superseded_prompts.pop()
                        turn.current_prompt_req_id, turn.current_prompt_event, turn.current_prompt_box = prev
                    else:
                        turn.current_prompt_req_id = None
                        turn.current_prompt_event = None
                        turn.current_prompt_box = {}
                    turn.prompt_seq = prev_seq
                    turn.normalizer.prompt_settled = prev_settled
                    turn.normalizer.reply_open = prev_reply_open
            raise

        turn.prompt_queued.set()
        turn.prompt_dispatching.clear()
        turn.touch()
        return req_id, ev, box

    def steer_turn(
        self,
        *,
        prompt_text: str,
        staged_paths: list[Path],
        attachments: list[dict[str, Any]],
        allowed_roots: list[Path],
    ) -> dict[str, Any]:
        """Steer the active ACP turn via a new `session/prompt` (`agy >= 1.5.0`)."""
        if self._closed or self._abort_event.is_set() or not self.is_alive() or not self.acp_session_id:
            raise AgyProfileError(409, "当前会话进程未运行，请重试或重连会话。")
        turn = self.active_turn
        if turn is None or turn.cancelled or not turn.prompt_queued.is_set():
            raise AgyProfileError(409, "当前任务尚未就绪或已结束，请直接发送新消息。")

        init_info = self.init_result.get("agentInfo") if isinstance(self.init_result, dict) else None
        probe_init = (
            self.init_result
            if isinstance(init_info, dict) and isinstance(init_info.get("version"), str) and init_info.get("version")
            else {"agentInfo": {"version": self.version}}
        )
        if not supports_prompt_steering(probe_init):
            raise AgyProfileError(409, "当前 agy 版本不支持运行中插话纠偏，请加入排队等待本轮结束。")

        with turn._perm_lock:
            for root in allowed_roots:
                if root not in turn.allowed_roots:
                    turn.allowed_roots.append(root)

        caps = self.init_result.get("agentCapabilities") if isinstance(self.init_result, dict) else {}
        prompt_caps = caps.get("promptCapabilities") if isinstance(caps, dict) else {}
        blocks = build_prompt_blocks(prompt_text, staged_paths, attachments, prompt_caps)

        lock = getattr(turn, "event_lock", None)
        if lock is not None:
            with lock:
                for evt in turn.normalizer.emit_steer(prompt_text):
                    turn.on_event(evt)
        else:
            for evt in turn.normalizer.emit_steer(prompt_text):
                turn.on_event(evt)

        self._dispatch_prompt(turn, self.acp_session_id, blocks)
        return {"steered": True, "prompt_seq": turn.prompt_seq}

    def _switch_model_rpc(
        self,
        acp_sid: str,
        model_id: str,
        config_option_id: str | None,
        turn: _ActiveTurn,
    ) -> None:
        if config_option_id:
            res = self._rpc(
                "session/set_config_option",
                {"sessionId": acp_sid, "configId": config_option_id, "value": model_id},
                timeout=20.0,
                cancel_event=turn.cancel_event,
            )
            if isinstance(res, dict) and isinstance(res.get("configOptions"), list):
                self.setup_result = {**self.setup_result, "configOptions": res["configOptions"]}
                with turn.event_lock:
                    turn.normalizer.config_options = res["configOptions"]
        else:
            res = self._rpc(
                "session/set_model",
                {"sessionId": acp_sid, "modelId": model_id},
                timeout=20.0,
                cancel_event=turn.cancel_event,
            )
            if isinstance(res, dict) and isinstance(res.get("configOptions"), list):
                self.setup_result = {**self.setup_result, "configOptions": res["configOptions"]}
                with turn.event_lock:
                    turn.normalizer.config_options = res["configOptions"]

    def _apply_model_and_effort(
        self,
        turn: _ActiveTurn,
        acp_sid: str,
        model: str,
        effort: str,
        allow_auto_fallback: bool | None,
        notices: list[str],
    ) -> tuple[str | None, dict[str, Any] | None]:
        cfg = agy_models.load_models_config()
        defs = cfg.get("defaults") or {}
        auto_fb = bool(defs.get("allow_auto_fallback", True)) if allow_auto_fallback is None else bool(allow_auto_fallback)
        default_model = str(defs.get("model") or agy_models.DEFAULT_MODEL_ID)
        aliases = cfg.get("aliases") or {}

        try:
            plan = resolve_model_target(
                self.setup_result,
                model,
                effort,
                default_model=default_model,
                aliases=aliases,
                allow_auto_fallback=auto_fb,
            )
        except AgyModelSelectionError as exc:
            _append_log(f"model selection rejected ({model}): {exc}")
            with turn.event_lock:
                for evt in turn.normalizer.finish_turn():
                    turn.on_event(evt)
            return None, {
                "status": "rejected",
                "conversation_id": acp_sid,
                "answer": None,
                "progress_messages": [],
                "error": str(exc),
                "effective_model": model,
                "fallback_notice": None,
                "usage": {},
            }

        target_model = str(plan["target_model"])
        resolved_effort = str(plan["resolved_effort"])
        use_cfg_id: str | None = plan["use_config_option_id"]
        if plan["alias_from"]:
            msg = f"模型「{plan['alias_from']}」已按本地映射切换为「{target_model}」"
            notices.append(msg)
            evt = turn.normalizer.emit_notice("runtime_notice", msg)
            with turn.event_lock:
                turn.on_event(evt)
        if plan["fallback_reason"]:
            msg = f"{plan['fallback_reason']}，已自动回退至「{target_model}」执行"
            notices.append(msg)
            _append_log(f"model auto-fallback: {model} -> {target_model} ({plan['fallback_reason']})")
            evt = turn.normalizer.emit_notice("runtime_notice", msg)
            with turn.event_lock:
                turn.on_event(evt)

        if turn.cancelled or self._abort_event.is_set():
            return None, {
                "status": "cancelled",
                "conversation_id": acp_sid,
                "answer": None,
                "progress_messages": [],
                "effective_model": target_model,
                "fallback_notice": "；".join(notices) if notices else None,
                "usage": {},
            }

        effective_model = target_model
        try:
            self._switch_model_rpc(acp_sid, target_model, use_cfg_id, turn)
        except AgyProfileError as exc:
            if exc.status == 499 or turn.cancelled or self._abort_event.is_set():
                self._dirty = True
                return None, {
                    "status": "cancelled",
                    "conversation_id": acp_sid,
                    "answer": None,
                    "progress_messages": [],
                    "effective_model": effective_model,
                    "fallback_notice": "；".join(notices) if notices else None,
                    "usage": {},
                }
            switched_fb = False
            model_opt = find_model_config_option(turn.normalizer.config_options or self.setup_result.get("configOptions"))
            if use_cfg_id is None and isinstance(model_opt, dict) and isinstance(model_opt.get("id"), str):
                try:
                    self._switch_model_rpc(acp_sid, target_model, str(model_opt["id"]), turn)
                    switched_fb = True
                except AgyProfileError as cfg_exc:
                    if cfg_exc.status == 499 or turn.cancelled or self._abort_event.is_set():
                        self._dirty = True
                        return None, {
                            "status": "cancelled",
                            "conversation_id": acp_sid,
                            "answer": None,
                            "progress_messages": [],
                            "effective_model": effective_model,
                            "fallback_notice": "；".join(notices) if notices else None,
                            "usage": {},
                        }
            if auto_fb and not switched_fb:
                for fb in plan["fallback_candidates"]:
                    if turn.cancelled or self._abort_event.is_set():
                        break
                    try:
                        self._switch_model_rpc(acp_sid, fb, use_cfg_id, turn)
                    except AgyProfileError as fb_exc:
                        if fb_exc.status == 499 or turn.cancelled or self._abort_event.is_set():
                            self._dirty = True
                            return None, {
                                "status": "cancelled",
                                "conversation_id": acp_sid,
                                "answer": None,
                                "progress_messages": [],
                                "effective_model": fb,
                                "fallback_notice": "；".join(notices) if notices else None,
                                "usage": {},
                            }
                        continue
                    effective_model = fb
                    switched_fb = True
                    msg = f"模型「{target_model}」切换失败，已自动回退至「{fb}」执行（{exc}）"
                    notices.append(msg)
                    _append_log(f"session/set_model fallback {target_model} -> {fb}: {exc}")
                    evt = turn.normalizer.emit_notice("runtime_notice", msg)
                    with turn.event_lock:
                        turn.on_event(evt)
                    break
            if not switched_fb:
                _append_log(f"session/set_model({target_model}) rejected: {exc}")
                with turn.event_lock:
                    for evt in turn.normalizer.finish_turn():
                        turn.on_event(evt)
                return None, {
                    "status": "rejected",
                    "conversation_id": acp_sid,
                    "answer": None,
                    "progress_messages": [],
                    "error": f"当前账号拒绝使用模型「{model}」：{exc}。请切换其他可用模型后重试。",
                    "effective_model": model,
                    "fallback_notice": None,
                    "usage": {},
                }

        live_config = turn.normalizer.config_options or self.setup_result.get("configOptions")
        effort_call, effort_notice = select_effort_call_for_config(live_config, effective_model, resolved_effort)
        if effort_notice:
            notices.append(effort_notice)
            _append_log(effort_notice)
            evt = turn.normalizer.emit_notice("runtime_notice", effort_notice)
            with turn.event_lock:
                turn.on_event(evt)
        if effort_call is not None:
            if turn.cancelled or self._abort_event.is_set():
                return None, {
                    "status": "cancelled",
                    "conversation_id": acp_sid,
                    "answer": None,
                    "progress_messages": [],
                    "effective_model": effective_model,
                    "fallback_notice": "；".join(notices) if notices else None,
                    "usage": {},
                }
            rpc_method, rpc_params = effort_call
            try:
                self._rpc(
                    rpc_method,
                    {"sessionId": acp_sid, **rpc_params},
                    timeout=20.0,
                    cancel_event=turn.cancel_event,
                )
            except AgyProfileError as exc:
                if exc.status == 499 or turn.cancelled or self._abort_event.is_set():
                    self._dirty = True
                    return None, {
                        "status": "cancelled",
                        "conversation_id": acp_sid,
                        "answer": None,
                        "progress_messages": [],
                        "effective_model": effective_model,
                        "fallback_notice": "；".join(notices) if notices else None,
                        "usage": {},
                    }
                msg = f"模型「{effective_model}」不支持思考档位「{resolved_effort}」，已沿用模型默认档位（{exc}）"
                notices.append(msg)
                _append_log(f"{rpc_method} skipped: {exc}")
                evt = turn.normalizer.emit_notice("runtime_notice", msg)
                with turn.event_lock:
                    turn.on_event(evt)
        return effective_model, None

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
        allow_auto_fallback: bool | None = None,
        fallback_handoff_context: str | None = None,
        orchestrator_planner: str | None = None,
        orchestrator_executor: str | None = None,
    ) -> dict[str, Any]:
        """Execute a complete conversational/editing turn inside the persistent ACP session."""
        if self._abort_event.is_set() or self._closed:
            self._dirty = True
            self._retire(force=True)
            return {
                "status": "cancelled",
                "conversation_id": resume_conversation,
                "answer": None,
                "progress_messages": [],
                "effective_model": model,
                "fallback_notice": None,
                "usage": {},
            }
        pre_tok_fp = agy_usage.workspace_token_fingerprint()
        try:
            acp_sid = self.ensure_started(resume_conversation=resume_conversation, add_dirs=add_dirs)
        except AgyProfileError as exc:
            if exc.status == 499 or self._abort_event.is_set():
                self._dirty = True
                self._retire(force=True)
                return {
                    "status": "cancelled",
                    "conversation_id": resume_conversation,
                    "answer": None,
                    "progress_messages": [],
                    "effective_model": model,
                    "fallback_notice": None,
                    "usage": {},
                }
            raise
        resumed_fb = self.resumed_fallback
        fb_reason = self._resume_fallback_reason
        self.resumed_fallback = False
        self._resume_fallback_reason = None

        turn = _ActiveTurn(
            run_id=run_id,
            mode=mode,
            permission_mode=permission_mode,
            workspace=self.workspace,
            allowed_roots=allowed_roots,
            on_event=on_event,
        )
        self.active_turn = turn
        notices: list[str] = []
        effective_model = model
        try:
            if self._abort_event.is_set() or self._closed:
                turn.cancel_pending(force=True)
                self._dirty = True
                return {
                    "status": "cancelled",
                    "conversation_id": acp_sid,
                    "answer": None,
                    "progress_messages": [],
                    "effective_model": effective_model,
                    "fallback_notice": None,
                    "usage": {},
                }

            effective_prompt = prompt_text
            if resumed_fb:
                if fallback_handoff_context:
                    effective_prompt = f"{fallback_handoff_context}\n\n{prompt_text}"
                    fb_msg = "原生上下文续接失败，已自动附带前文摘要继续对话"
                else:
                    fb_msg = (
                        f"原生上下文续接失败，已重建对话上下文（{fb_reason}）"
                        if fb_reason
                        else "原生上下文续接失败，已重建对话上下文"
                    )
                notices.append(fb_msg)
                evt = turn.normalizer.emit_notice("runtime_notice", fb_msg)
                with turn.event_lock:
                    turn.on_event(evt)
            elif fallback_handoff_context and not resume_conversation:
                effective_prompt = f"{fallback_handoff_context}\n\n{prompt_text}"
                fb_msg = "已自动附带前文摘要开启新会话"
                notices.append(fb_msg)
                evt = turn.normalizer.emit_notice("runtime_notice", fb_msg)
                with turn.event_lock:
                    turn.on_event(evt)

            avail_modes = (
                self.setup_result.get("modes", {}).get("availableModes")
                if isinstance(self.setup_result.get("modes"), dict)
                else None
            )
            wire_mode = session_mode_for_policy(mode, permission_mode, avail_modes)
            try:
                self._rpc(
                    "session/set_mode",
                    {"sessionId": acp_sid, "modeId": wire_mode},
                    timeout=20.0,
                    cancel_event=turn.cancel_event,
                )
            except AgyProfileError as exc:
                if exc.status == 499 or turn.cancelled or self._abort_event.is_set():
                    self._dirty = True
                    return {
                        "status": "cancelled",
                        "conversation_id": acp_sid,
                        "answer": None,
                        "progress_messages": [],
                        "effective_model": effective_model,
                        "fallback_notice": None,
                        "usage": {},
                    }
                _append_log(f"session/set_mode({wire_mode}) skipped: {exc}")
                mode_msg = f"上游未接受模式「{wire_mode}」，已沿用默认模式（工具权限仍由 GA-Hub 策略拦截控制）"
                notices.append(mode_msg)
                notice_evt = turn.normalizer.emit_notice("runtime_notice", mode_msg)
                with turn.event_lock:
                    turn.on_event(notice_evt)

            resolved_model, early_result = self._apply_model_and_effort(
                turn, acp_sid, model, effort, allow_auto_fallback, notices,
            )
            if early_result is not None:
                return early_result
            assert resolved_model is not None
            effective_model = resolved_model

            caps = self.init_result.get("agentCapabilities") if isinstance(self.init_result, dict) else {}
            prompt_caps = caps.get("promptCapabilities") if isinstance(caps, dict) else {}
            blocks = build_prompt_blocks(effective_prompt, staged_paths, attachments, prompt_caps)

            if turn.cancelled or self._abort_event.is_set():
                return {
                    "status": "cancelled",
                    "conversation_id": acp_sid,
                    "answer": None,
                    "progress_messages": [],
                    "effective_model": effective_model,
                    "fallback_notice": "；".join(notices) if notices else None,
                    "usage": {},
                }

            app_data_dir = agy_profile.workspace_app_data_dir()
            outcome_watcher = PromptOutcomeWatcher(app_data_dir, acp_sid)
            outcome_watcher.prepare()
            outcome_resumed = False
            hidden_outcome: dict[str, Any] | None = None

            def _disk_post_settle_state() -> tuple[bool, bool]:
                sub_ids = turn.normalizer.collect_subagent_tool_ids()
                child_working = bool(sub_ids and read_detached_children_at_work(app_data_dir, acp_sid, sub_ids))
                pending_reply = has_pending_reply_on_disk(app_data_dir, acp_sid)
                return child_working, pending_reply

            self._dispatch_prompt(turn, acp_sid, blocks)

            timed_out = False
            wall_mono_gap = time.time() - time.monotonic()
            while True:
                req_id, ev, box, cur_seq = turn.current_prompt_state()
                assert req_id is not None and ev is not None
                while not ev.is_set():
                    if turn.cancelled or self._abort_event.is_set():
                        break
                    _, _, _, latest_seq = turn.current_prompt_state()
                    if latest_seq != cur_seq:
                        break
                    turn.wake_event.clear()
                    if ev.is_set() or turn.cancelled or self._abort_event.is_set():
                        break
                    _, _, _, latest_seq = turn.current_prompt_state()
                    if latest_seq != cur_seq:
                        break
                    # Pause inactivity countdown while waiting for user approval / question input.
                    if turn.current_approval() is not None:
                        turn.touch()
                        turn.wake_event.wait(min(1.0, INACTIVITY_SLICE))
                        wall_mono_gap = time.time() - time.monotonic()
                        continue
                    now_wall = time.time()
                    now_mono = time.monotonic()
                    cur_gap = now_wall - now_mono
                    if abs(cur_gap - wall_mono_gap) > HOST_SLEEP_TOLERANCE:
                        turn.touch()
                    wall_mono_gap = cur_gap
                    if turn.inactivity_paused():
                        turn.last_activity = now_mono
                        silent_tool = now_mono - turn.last_progress_at
                        if silent_tool > ACTIVE_TOOL_SILENT_TIMEOUT:
                            timed_out = True
                            self._dirty = True
                            turn.cancel_pending(force=True)
                            break
                        remaining = ACTIVE_TOOL_SILENT_TIMEOUT - silent_tool
                        turn.wake_event.wait(min(1.0, max(0.05, remaining)))
                        continue
                    elapsed = now_mono - turn.last_activity
                    if elapsed > INACTIVITY_TIMEOUT:
                        timed_out = True
                        self._dirty = True
                        turn.cancel_pending(force=True)
                        break
                    remaining = INACTIVITY_TIMEOUT - elapsed
                    turn.wake_event.wait(min(1.0, max(0.05, remaining)))

                _, _, _, latest_seq = turn.current_prompt_state()
                if not timed_out and not turn.cancelled and not self._abort_event.is_set() and latest_seq != cur_seq:
                    outcome_watcher.prepare(reset_turn=False)
                    continue

                if timed_out or turn.cancelled or self._abort_event.is_set() or "error" in box:
                    break

                hidden_outcome = outcome_watcher.check(box.get("result"))
                if hidden_outcome is not None:
                    resume_with = hidden_outcome.get("resume_with")
                    init_info = self.init_result.get("agentInfo") if isinstance(self.init_result, dict) else None
                    probe_init = (
                        self.init_result
                        if isinstance(init_info, dict) and isinstance(init_info.get("version"), str) and init_info.get("version")
                        else {"agentInfo": {"version": self.version}}
                    )
                    if resume_with and not outcome_resumed and supports_prompt_steering(probe_init):
                        outcome_resumed = True
                        hidden_outcome = None
                        msg = "遇到上游瞬态 404，已自动发送 continue 恢复执行"
                        notices.append(msg)
                        _append_log(f"transient 404 recovery steer: {acp_sid}")
                        evt = turn.normalizer.emit_notice("runtime_notice", msg)
                        with turn.event_lock:
                            turn.on_event(evt)
                        outcome_watcher.prepare(reset_turn=False)
                        self._dispatch_prompt(turn, acp_sid, [{"type": "text", "text": str(resume_with)}])
                        continue
                    break

                disk_child_working, disk_pending_reply = _disk_post_settle_state()
                if not turn.has_post_settle_work() and not disk_child_working and not disk_pending_reply:
                    break

                turn.normalizer.prompt_settled = True
                if disk_pending_reply:
                    turn.normalizer.reply_open = True
                settled_seq = cur_seq
                turn.touch_progress()
                last_disk_check = time.monotonic()
                steered_during_hold = False
                while not turn.cancelled and not self._abort_event.is_set() and not self._closed:
                    _, _, _, seq_now = turn.current_prompt_state()
                    if seq_now > settled_seq:
                        turn.normalizer.prompt_settled = False
                        steered_during_hold = True
                        break
                    now_wall = time.time()
                    now_mono = time.monotonic()
                    cur_gap = now_wall - now_mono
                    if abs(cur_gap - wall_mono_gap) > HOST_SLEEP_TOLERANCE:
                        turn.touch()
                    wall_mono_gap = cur_gap

                    if now_mono - last_disk_check >= 0.4:
                        disk_child_working, disk_pending_reply = _disk_post_settle_state()
                        if disk_pending_reply:
                            turn.normalizer.reply_open = True
                        last_disk_check = now_mono

                    with turn._perm_lock:
                        has_open_req = turn.pending_permission is not None or turn._open_incoming_requests > 0
                    if has_open_req:
                        turn.touch_progress()
                        wait_for = 0.25
                    elif turn.normalizer.has_outliving_background_work() or disk_child_working:
                        silent = now_mono - turn.last_progress_at
                        if silent >= POST_SETTLE_COMMAND_HOLD_TIMEOUT:
                            break
                        wait_for = min(0.25, max(0.05, POST_SETTLE_COMMAND_HOLD_TIMEOUT - silent))
                    else:
                        debounce = (
                            POST_SETTLE_REPLY_QUIET_LIMIT
                            if turn.normalizer.reply_open
                            else POST_SETTLE_DEBOUNCE
                        )
                        quiet = now_mono - turn.last_progress_at
                        if quiet >= debounce:
                            break
                        wait_for = min(0.25, max(0.05, debounce - quiet))

                    turn.wake_event.clear()
                    _, _, _, seq_now = turn.current_prompt_state()
                    if seq_now > settled_seq:
                        turn.normalizer.prompt_settled = False
                        steered_during_hold = True
                        break
                    if turn.cancelled or self._abort_event.is_set() or self._closed:
                        break
                    turn.wake_event.wait(wait_for)

                if steered_during_hold:
                    outcome_watcher.prepare(reset_turn=False)
                    continue
                break

            req_id, ev, box, _ = turn.current_prompt_state()
            assert req_id is not None and ev is not None

            if timed_out:
                with self._rpc_lock:
                    self._pending_rpcs.pop(req_id, None)
                    for sup_id, _, _ in turn.superseded_prompts:
                        self._pending_rpcs.pop(sup_id, None)
                with turn.event_lock:
                    for evt in turn.normalizer.finish_turn():
                        turn.on_event(evt)
                self._retire(force=True)
                return {
                    "status": "timeout",
                    "conversation_id": acp_sid,
                    "answer": turn.normalizer.final_answer or None,
                    "progress_messages": list(turn.normalizer.progress_messages),
                    "error": "Agy 任务响应超时，已重置后台进程，可继续发送消息续接上下文",
                    "effective_model": effective_model,
                    "fallback_notice": "；".join(notices) if notices else None,
                    "usage": dict(turn.normalizer.usage),
                }

            if turn.cancelled and not ev.is_set():
                if not turn.force_cancelled and not self._abort_event.is_set():
                    grace_deadline = time.monotonic() + CANCEL_GRACE_TIMEOUT
                    while not ev.is_set() and not turn.force_cancelled and not self._abort_event.is_set():
                        rem = grace_deadline - time.monotonic()
                        if rem <= 0:
                            break
                        turn.wake_event.clear()
                        if ev.is_set() or turn.force_cancelled or self._abort_event.is_set():
                            break
                        turn.wake_event.wait(min(0.25, rem))
                if not ev.is_set():
                    with self._rpc_lock:
                        self._pending_rpcs.pop(req_id, None)
                        for sup_id, _, _ in turn.superseded_prompts:
                            self._pending_rpcs.pop(sup_id, None)
                    self._dirty = True

            with turn.event_lock:
                for evt in turn.normalizer.finish_turn():
                    turn.on_event(evt)

            with turn.prompt_lock:
                superseded_boxes = [b for _, e, b in turn.superseded_prompts if e.is_set()]
            if superseded_boxes:
                prompt_usage: dict[str, int] = {}
                for sb in superseded_boxes:
                    _merge_prompt_usage(prompt_usage, sb.get("result"))
                if ev.is_set() and "result" in box:
                    _merge_prompt_usage(prompt_usage, box.get("result"))
                if prompt_usage:
                    turn.normalizer.usage = prompt_usage
            elif ev.is_set():
                prompt_usage = normalize_usage_payload(box.get("result"))
                if prompt_usage:
                    turn.normalizer.usage = prompt_usage

            answer = turn.normalizer.final_answer
            progress_messages = list(turn.normalizer.progress_messages)
            usage = dict(turn.normalizer.usage)
            model_calls, db_gen_ms = outcome_watcher.turn_model_metrics()
            if model_calls > 0:
                usage["model_calls"] = model_calls
            gen_ms = db_gen_ms if db_gen_ms > 0 else (turn.normalizer.generation_ms if model_calls <= 1 else 0)
            if gen_ms > 0:
                usage["generation_ms"] = gen_ms
            eff_planner = orchestrator_planner if orchestrator_planner is not None else (
                self.loaded_orchestrator[0] if self.loaded_orchestrator else None
            )
            eff_executor = orchestrator_executor if orchestrator_executor is not None else (
                self.loaded_orchestrator[1] if self.loaded_orchestrator else None
            )
            step_usages = outcome_watcher.turn_step_usages()
            subagent_step_usages = outcome_watcher.turn_subagent_step_usages()
            if subagent_step_usages:
                usage = _merge_subagent_usage(
                    usage,
                    subagent_step_usages,
                    parent_step_usages=step_usages,
                )
                step_usages = [*step_usages, *subagent_step_usages]
            cost_info = agy_pricing.calculate_run_cost(
                model=effective_model,
                usage=usage,
                step_usages=step_usages,
                orchestrator_planner=eff_planner,
                orchestrator_executor=eff_executor,
            )
            usage["estimated_cost_usd"] = cost_info["estimated_cost_usd"]
            usage["model_breakdown"] = cost_info["model_breakdown"]
            notice_text = "；".join(notices) if notices else None
            if turn.cancelled:
                return {
                    "status": "cancelled",
                    "conversation_id": acp_sid,
                    "answer": answer or None,
                    "progress_messages": progress_messages,
                    "effective_model": effective_model,
                    "fallback_notice": notice_text,
                    "usage": usage,
                }
            if "error" in box:
                err = box["error"]
                msg = err.get("message") if isinstance(err, dict) else str(err)
                lower = str(msg).lower()
                if "rate" in lower or "429" in lower or "quota" in lower or "resource_exhausted" in lower:
                    return {
                        "status": "rate_limited",
                        "conversation_id": acp_sid,
                        "answer": answer or None,
                        "progress_messages": progress_messages,
                        "error": str(msg),
                        "effective_model": effective_model,
                        "fallback_notice": notice_text,
                        "usage": usage,
                    }
                is_auth_err = any(
                    tok in lower
                    for tok in (
                        "401",
                        "unauthenticated",
                        "invalid_grant",
                        "token expired",
                        "authentication required",
                        "please sign in",
                        "login required",
                    )
                )
                if is_auth_err:
                    self._dirty = True
                    try:
                        agy_profile.sync_workspace_credentials_to_vault(self.profile_id)
                    except Exception:
                        pass
                    post_tok_fp = agy_usage.workspace_token_fingerprint()
                    transient_refreshed = bool(pre_tok_fp and post_tok_fp and post_tok_fp != pre_tok_fp)
                    refresh_outcome = "ok" if transient_refreshed else agy_usage.refresh_profile_token(self.profile_id)
                    if refresh_outcome == "ok":
                        agy_profile.record_auth_state(self.profile_id, "authenticated")
                        return {
                            "status": "cli_error",
                            "conversation_id": acp_sid,
                            "answer": answer or None,
                            "progress_messages": progress_messages,
                            "error": "登录凭据跨 1 小时自动续期时遇到瞬态 401，已自动刷新凭据并重置进程，请直接重试（上下文已保留）。",
                            "auth_transient": True,
                            "effective_model": effective_model,
                            "fallback_notice": notice_text,
                            "usage": usage,
                        }
                    if refresh_outcome == "login_required":
                        agy_profile.record_auth_state(self.profile_id, "login_required")
                poisoned = classify_poisoned_thread_error(str(msg))
                if poisoned is not None:
                    self._dirty = True
                    return {
                        "status": poisoned["status"],
                        "conversation_id": acp_sid,
                        "answer": answer or None,
                        "progress_messages": progress_messages,
                        "error": poisoned["error"],
                        "error_code": poisoned["code"],
                        "thread_broken": True,
                        "effective_model": effective_model,
                        "fallback_notice": notice_text,
                        "usage": usage,
                    }
                return {
                    "status": "cli_error",
                    "conversation_id": acp_sid,
                    "answer": answer or None,
                    "progress_messages": progress_messages,
                    "error": str(msg),
                    "effective_model": effective_model,
                    "fallback_notice": notice_text,
                    "usage": usage,
                }
            if hidden_outcome is not None:
                if hidden_outcome.get("thread_broken") or hidden_outcome.get("status") == "rate_limited":
                    self._dirty = True
                return {
                    "status": hidden_outcome["status"],
                    "conversation_id": acp_sid,
                    "answer": answer or None,
                    "progress_messages": progress_messages,
                    "error": hidden_outcome.get("error"),
                    "error_code": hidden_outcome.get("code"),
                    "thread_broken": bool(hidden_outcome.get("thread_broken")),
                    "reset_seconds": hidden_outcome.get("reset_seconds"),
                    "effective_model": effective_model,
                    "fallback_notice": notice_text,
                    "usage": usage,
                }
            return {
                "status": "success",
                "conversation_id": acp_sid,
                "answer": answer,
                "progress_messages": progress_messages,
                "effective_model": effective_model,
                "fallback_notice": notice_text,
                "usage": usage,
            }
        finally:
            self.active_turn = None
            turn.done_event.set()
            self.last_used = time.monotonic()
            cancelled_or_aborted = turn.cancelled or self._abort_event.is_set()
            if cancelled_or_aborted:
                profile_id = self.profile_id

                def _sync_creds_bg() -> None:
                    try:
                        agy_profile.sync_workspace_credentials_to_vault(profile_id)
                    except Exception:
                        log.debug("Failed syncing workspace credentials after cancelled turn", exc_info=True)

                threading.Thread(target=_sync_creds_bg, name="agy-cred-sync", daemon=True).start()
            else:
                try:
                    agy_profile.sync_workspace_credentials_to_vault(self.profile_id)
                except Exception:
                    log.debug("Failed syncing workspace credentials after turn", exc_info=True)
            if self._dirty or self._abort_event.is_set():
                self._retire(force=True)

    def force_abort(self, reason: str = "Agy 任务已强制终止") -> None:
        """Immediately abort active RPCs, approvals, and child processes without waiting on `_lock`."""
        self._closed = True
        self._retired = True
        self._dirty = True
        self._abort_event.set()
        turn = self.active_turn
        if turn is not None:
            turn.cancel_pending(force=True)
        self._wake_pending_rpcs(reason)
        with self._proc_lock:
            proc = self.proc
            group = self._process_group
            self._process_group = None
        if group is not None:
            group.terminate(getattr(proc, "pid", None))
        elif proc is not None and proc.poll() is None:
            child_job.terminate_tree(getattr(proc, "pid", None))

    def cancel_turn(self, *, force: bool = False) -> None:
        if force:
            self.force_abort("Agy 任务已强制终止")
            return
        turn = self.active_turn
        if turn is None:
            self.force_abort("Agy 启动阶段已取消")
            return
        turn.cancel_pending(force=False)
        if not turn.prompt_queued.is_set() and turn.prompt_dispatching.is_set() and self.is_alive():
            wait_deadline = time.monotonic() + 2.0
            while (
                turn.prompt_dispatching.is_set()
                and not turn.prompt_queued.is_set()
                and not turn.done_event.is_set()
                and not turn.force_cancelled
                and self.is_alive()
                and time.monotonic() < wait_deadline
            ):
                turn.prompt_queued.wait(0.05)
        if turn.prompt_queued.is_set() and self.acp_session_id and self.is_alive():
            try:
                self._send_frame({
                    "jsonrpc": "2.0",
                    "method": "session/cancel",
                    "params": {"sessionId": self.acp_session_id},
                })
            except AgyProfileError:
                pass

    def _teardown_locked(self, *, force: bool = False) -> None:
        try:
            self._closed = True
            if force:
                self._retired = True
                self._abort_event.set()
            turn = self.active_turn
            if turn is not None:
                turn.cancel_pending(force=force)
            self._wake_pending_rpcs("Agy ACP 会话已关闭")
            with self._proc_lock:
                proc = self.proc
                self.proc = None
                group = self._process_group
                self._process_group = None
            sid = self.acp_session_id
            self.acp_session_id = None
            if proc is not None:
                if not force and sid and proc.stdin and proc.poll() is None:
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
                if group is not None:
                    if force or proc.poll() is None:
                        group.terminate(proc.pid)
                        for _ in range(10):
                            if proc.poll() is not None:
                                break
                            time.sleep(0.01)
                    else:
                        group.close()
                elif proc.poll() is None:
                    child_job.terminate_tree(proc.pid)
                if proc.poll() is None:
                    # The worker may already have been evicted. Transfer its
                    # lock reference and temp directory to the exit waiter.
                    lock_id = self._lock_id
                    held = self._profile_lock_held
                    temp_dir = self.temp_dir
                    self._profile_lock_held = False
                    self.temp_dir = None
                    exited = self._exit_pending = threading.Event()
                    for stream in (proc.stdin, proc.stdout):
                        close_fn = getattr(stream, "close", None)
                        if callable(close_fn):
                            try:
                                close_fn()
                            except OSError:
                                pass

                    def wait_for_exit() -> None:
                        wait_fn = getattr(proc, "wait", None)
                        if callable(wait_fn):
                            wait_fn()
                        child_job.forget(proc.pid)
                        if temp_dir is not None:
                            shutil.rmtree(temp_dir, ignore_errors=True)
                        if held:
                            agy_profile.release_profile_lock(lock_id)
                        exited.set()

                    try:
                        threading.Thread(target=wait_for_exit, name="agy-acp-exit", daemon=True).start()
                    except RuntimeError:
                        log.error("Cannot monitor Agy worker exit; retaining lock for %s", lock_id)
                    return
                for stream in (proc.stdin, proc.stdout):
                    close_fn = getattr(stream, "close", None)
                    if callable(close_fn):
                        try:
                            close_fn()
                        except OSError:
                            pass
                child_job.forget(proc.pid)
            elif group is not None:
                group.close()
            if self.temp_dir is not None:
                shutil.rmtree(self.temp_dir, ignore_errors=True)
                self.temp_dir = None
        finally:
            if self._profile_lock_held:
                self._profile_lock_held = False
                agy_profile.release_profile_lock(self._lock_id)


    def exit_pending(self) -> bool:
        exited = self._exit_pending
        return exited is not None and not exited.is_set()

    def close(self, *, force: bool = False) -> None:
        if force:
            self.force_abort()
        with self._lock:
            self._teardown_locked(force=force)

    def snapshot(self, *, now: float | None = None) -> dict[str, Any]:
        current = time.monotonic() if now is None else now
        with self._proc_lock:
            pid = getattr(self.proc, "pid", None) if self.proc is not None else None
            proc_alive = self.proc is not None and self.proc.poll() is None
        turn = self.active_turn
        exit_pending = self.exit_pending()
        busy = turn is not None
        if self._retired or exit_pending:
            state = "retiring"
        elif busy:
            state = "running"
        elif self.is_alive():
            state = "idle"
        else:
            state = "stopped"
        return {
            "profile_id": self.profile_id,
            "session_id": self.session_id,
            "workspace": str(self.workspace),
            "pid": int(pid) if isinstance(pid, int) and not isinstance(pid, bool) else None,
            "alive": bool(proc_alive and not self._closed),
            "busy": busy,
            "state": state,
            "active_run_id": turn.run_id if turn is not None else None,
            "idle_seconds": max(0, int(current - self.last_used)) if not busy else 0,
            "dirty": bool(self._dirty),
            "retired": bool(self._retired),
            "exit_pending": bool(exit_pending),
        }


class AgyRuntimeManager:
    """Process-wide manager for standalone Agy ACP workers, models, and logins."""

    def __init__(
        self,
        *,
        idle_ttl: float = IDLE_SESSION_TTL,
        max_idle_workers: int = MAX_IDLE_WORKERS,
        reaper_interval: float | None = None,
    ) -> None:
        self._lock = threading.RLock()
        self._workers: dict[tuple[str, str, str], AgySessionWorker] = {}
        # Keep detached sessions reserved until close() and any exit waiter finish.
        self._retiring: dict[tuple[str, str, str], tuple[AgySessionWorker, threading.Event]] = {}
        self._changing_profiles: set[str] = set()
        self._switching_profile = False
        self._session_grants: dict[tuple[str, str], RuntimeGrants] = {}
        self._active_turns: dict[tuple[Path, str], AgySessionWorker] = {}
        self._stopped_manually = False
        self._draining_workers = False
        self._lifecycle_lock = threading.Lock()
        self._cached_version: str | None = None
        self._version_checked = False
        self._version_epoch = 0
        self._cached_models: dict[str, list[dict[str, str]]] = {}
        self._cached_commands: dict[str, list[dict[str, Any]]] = {}
        self._login: subprocess.Popen | None = None
        self._login_profile: str | None = None
        self._code_login: CodeLoginFlow | None = None
        self._idle_ttl = max(0.0, float(idle_ttl))
        self._max_idle_workers = max(0, int(max_idle_workers))
        self._reaper_interval = (
            float(reaper_interval)
            if reaper_interval is not None
            else min(60.0, max(5.0, self._idle_ttl / 6.0 if self._idle_ttl > 0 else 60.0))
        )
        self._shutdown_event = threading.Event()
        self._reaper_thread: threading.Thread | None = None
        self._model_sync_thread: threading.Thread | None = None
        self._storage_gc_thread: threading.Thread | None = None

    def _probe_version_once(self, executable: str) -> str | None:
        with self._lock:
            if self._version_checked:
                return self._cached_version
            self._version_checked = True
            epoch = self._version_epoch
        version = None
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
                    version = m.group(1)
        except (OSError, subprocess.SubprocessError):
            pass
        with self._lock:
            if epoch == self._version_epoch:
                self._cached_version = version
            return self._cached_version

    def _active_turn_count(self) -> int:
        with self._lock:
            return sum(1 for w in self._active_turns.values() if w.active_turn is not None)

    def _auth_state_fast(self, profile_id: str) -> AntiAuthState:
        if not agy_profile.has_local_credentials(profile_id):
            return "login_required"
        return "login_required" if agy_profile.effective_auth_state(profile_id) == "login_required" else "authenticated"

    @staticmethod
    def _supports_steering_for_version(version: str | None) -> bool | None:
        parsed = parse_version(version)
        return parsed >= (1, 5, 0) if parsed is not None else None

    def status(self, *, verify_auth: bool = False) -> AntiDaemonStatus:
        """Fast, non-spawning runtime snapshot (T3 Code health-check discipline)."""
        executable = agy_profile.agy_executable_or_none()
        if executable is None:
            return AntiDaemonStatus(
                state="unavailable",
                detail="找不到官方 agy CLI，请先安装 agy 并加入 PATH",
                agy_available=False,
                active_count=0,
                auth_state="unverified" if verify_auth else None,
                managed=True,
                supports_steering=None,
            )
        with self._lock:
            stopped = self._stopped_manually
            version = self._cached_version
        if not stopped and version is None:
            version = self._probe_version_once(executable)
        steering = self._supports_steering_for_version(version)
        with self._lock:
            if self._stopped_manually:
                return AntiDaemonStatus(
                    state="stopped",
                    detail="Agy 运行时已手动停止",
                    agy_available=True,
                    active_count=0,
                    auth_state=None,
                    managed=True,
                    version=version,
                    supports_steering=steering,
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
                supports_steering=steering,
            )

    def panel_status(self) -> AntiDaemonStatus:
        return self.status(verify_auth=False)

    def start(self) -> AntiDaemonStatus:
        with self._lock:
            self._require_workers_available_locked()
            executable = agy_profile.agy_executable_or_none()
            if executable is None:
                raise AgyProfileError(503, "找不到官方 agy CLI，请先安装 agy 并加入 PATH")
            self._shutdown_event.clear()
            self._stopped_manually = False
            self._cached_version = None
            self._version_checked = False
            self._version_epoch += 1
            self._ensure_model_sync_locked()
            _append_log("Agy ACP runtime enabled")
        return self.status(verify_auth=True)

    def _require_workers_available_locked(self) -> None:
        if self._draining_workers:
            raise AgyProfileError(409, "Agy 正在关闭旧会话，请稍后重试")
        if self._switching_profile:
            raise AgyProfileError(409, "正在切换 Agy 账号，请稍后重试")

    def stop(self, *, force: bool = False) -> AntiDaemonStatus:
        return self._stop_or_restart(restart=False, force=force)

    def restart(self, *, force: bool = False) -> AntiDaemonStatus:
        return self._stop_or_restart(restart=True, force=force)

    def _stop_or_restart(self, *, restart: bool, force: bool = False) -> AntiDaemonStatus:
        with self._lifecycle_lock:
            with self._lock:
                # Include registered runs that have not entered worker.run yet.
                if self._active_turns and not force:
                    raise AgyProfileError(409, "当前有正在运行的 Anti 任务，请先停止或等待任务结束")
                active_workers = list(dict.fromkeys(self._active_turns.values())) if force else []
                self._draining_workers = True
                workers = self._detach_workers_locked(list(self._workers))
                code_login = self._code_login
                self._code_login = None
            try:
                for active_worker in active_workers:
                    try:
                        active_worker.force_abort("Agy 运行时已强制重置" if restart else "Agy 运行时已强制停止")
                    except Exception:
                        log.debug("Failed to force_abort active worker", exc_info=True)
                try:
                    self._close_detached(workers, force=force)
                finally:
                    try:
                        agy_profile.sync_workspace_credentials_to_vault()
                    except Exception:
                        pass
                    if code_login is not None:
                        code_login.cancel()
            finally:
                with self._lock:
                    self._stopped_manually = not restart
                    if restart:
                        self._shutdown_event.clear()
                        self._cached_models.clear()
                        self._cached_commands.clear()
                        self._cached_version = None
                        self._version_checked = False
                        self._version_epoch += 1
                    self._draining_workers = False
            _append_log("Agy ACP runtime restarted" if restart else "Agy ACP runtime stopped")
        return self.status(verify_auth=restart)

    def _prune_retiring_locked(self) -> None:
        for key, (worker, closed) in list(self._retiring.items()):
            if closed.is_set() and not worker.exit_pending():
                del self._retiring[key]

    def _detach_workers_locked(self, keys: list[tuple[str, str, str]]) -> list[tuple[AgySessionWorker, threading.Event]]:
        detached = []
        for key in keys:
            worker = self._workers.pop(key)
            # Do not acquire the worker lock here: startup may call back into us.
            worker._retired = True
            entry = self._retiring[key] = (worker, threading.Event())
            detached.append(entry)
        return detached

    def _close_detached(
        self,
        workers: list[tuple[AgySessionWorker, threading.Event]],
        *,
        force: bool = False,
    ) -> None:
        first_error = None
        for worker, closed in workers:
            try:
                if force:
                    try:
                        worker.close(force=True)
                    except TypeError:
                        worker.force_abort()
                        worker.close()
                else:
                    worker.close()
            except Exception as exc:
                # Fail closed for this key, but still attempt to close the rest.
                log.exception("Failed to close Agy session %s", worker.session_id)
                if first_error is None:
                    first_error = exc
            else:
                closed.set()
        with self._lock:
            self._prune_retiring_locked()
        if first_error is not None:
            raise first_error

    def _evict_excess_idle_keys_locked(
        self,
        *,
        exclude: set[tuple[str, str, str]] | None = None,
    ) -> list[tuple[str, str, str]]:
        protected = exclude or set()
        registered = set(self._active_turns.values())
        idle = [
            (worker.last_used, key)
            for key, worker in self._workers.items()
            if key not in protected
            and worker not in registered
            and worker.active_turn is None
            and not worker._closed
        ]
        if len(idle) <= self._max_idle_workers:
            return []
        idle.sort(key=lambda item: item[0])
        overflow = len(idle) - self._max_idle_workers
        return [key for _, key in idle[:overflow]]

    def reap_idle_workers(self, *, now: float | None = None) -> int:
        """Close idle ACP child workers exceeding IDLE_SESSION_TTL or MAX_IDLE_WORKERS."""
        current = time.monotonic() if now is None else now
        with self._lock:
            self._prune_retiring_locked()
            registered = set(self._active_turns.values())
            stale_keys: list[tuple[str, str, str]] = []
            remaining_idle: list[tuple[float, tuple[str, str, str]]] = []
            for key, worker in self._workers.items():
                if worker in registered or worker.active_turn is not None:
                    continue
                if worker._closed or (self._idle_ttl > 0 and (current - worker.last_used) >= self._idle_ttl):
                    stale_keys.append(key)
                else:
                    remaining_idle.append((worker.last_used, key))
            if len(remaining_idle) > self._max_idle_workers:
                remaining_idle.sort(key=lambda item: item[0])
                overflow = len(remaining_idle) - self._max_idle_workers
                stale_keys.extend(key for _, key in remaining_idle[:overflow])
            stale = self._detach_workers_locked(stale_keys)
        self._close_detached(stale)
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
        self._ensure_model_sync_locked()

    def _sync_models_if_due(self) -> None:
        with self._lock:
            if self._stopped_manually:
                return
            active_id, _ = agy_profile.snapshot()
        if agy_profile.agy_executable_or_none() is None:
            return
        if not agy_models.is_profile_catalog_stale(active_id):
            return
        try:
            self.sync_models(active_id)
        except Exception:
            log.debug("Scheduled Agy upstream model sync failed", exc_info=True)

    def _model_sync_loop(self) -> None:
        while not self._shutdown_event.is_set():
            cfg = agy_models.load_models_config()
            if not cfg.get("sync", {}).get("auto_sync", True):
                if self._shutdown_event.wait(60.0):
                    return
                continue
            now = agy_models._local_now()
            hours = cfg.get("sync", {}).get("schedule_hours")
            target = agy_models.next_scheduled_slot(now, hours)
            wait_sec = max(1.0, (target - now).total_seconds())
            while wait_sec > 0 and not self._shutdown_event.is_set():
                step = min(60.0, wait_sec)
                if self._shutdown_event.wait(step):
                    return
                now = agy_models._local_now()
                wait_sec = (target - now).total_seconds()
            if self._shutdown_event.is_set():
                return
            self._sync_models_if_due()

    def _storage_gc_loop(self) -> None:
        # Delay initial check so app startup is never slowed down.
        if self._shutdown_event.wait(60.0):
            return
        from . import agy_storage_gc

        while not self._shutdown_event.is_set():
            wait_sec = 1800.0
            try:
                if agy_storage_gc.is_scheduled_gc_due():
                    with self._lock:
                        busy = (
                            self._active_turn_count() > 0
                            or self._switching_profile
                            or self._draining_workers
                        )
                    if busy:
                        wait_sec = 900.0
                    else:
                        res = agy_storage_gc.run_scheduled_gc(runtime=self)
                        if isinstance(res, dict) and res.get("reclaimed_bytes", 0) > 0:
                            mb = res["reclaimed_bytes"] / (1024 * 1024)
                            _append_log(
                                f"Scheduled Agy storage GC reclaimed {mb:.1f} MB "
                                f"({res.get('removed_entries', 0)} entries)"
                            )
            except Exception:
                log.debug("Scheduled Agy storage GC iteration failed", exc_info=True)
            if self._shutdown_event.wait(wait_sec):
                return

    def _ensure_storage_gc_locked(self) -> None:
        if self._idle_ttl <= 0 or self._shutdown_event.is_set():
            return
        if self._storage_gc_thread is not None and self._storage_gc_thread.is_alive():
            return
        self._storage_gc_thread = threading.Thread(
            target=self._storage_gc_loop,
            name="agy-storage-gc",
            daemon=True,
        )
        self._storage_gc_thread.start()

    def start_background_maintenance(self) -> None:
        """Start lightweight background storage GC loop on app startup."""
        with self._lock:
            self._ensure_storage_gc_locked()

    def _ensure_model_sync_locked(self) -> None:
        if self._idle_ttl <= 0 or self._shutdown_event.is_set():
            return
        self._ensure_storage_gc_locked()
        if self._model_sync_thread is not None and self._model_sync_thread.is_alive():
            return
        self._model_sync_thread = threading.Thread(
            target=self._model_sync_loop,
            name="agy-model-sync",
            daemon=True,
        )
        self._model_sync_thread.start()

    def shutdown(self) -> None:
        with self._lifecycle_lock:
            self._shutdown()

    def _shutdown(self) -> None:
        self._shutdown_event.set()
        with self._lock:
            self._draining_workers = True
            workers = self._detach_workers_locked(list(self._workers))
            self._active_turns.clear()
            login, code_login = self._login, self._code_login
            self._login = self._code_login = None
            self._login_profile = None
            reaper = self._reaper_thread
            self._reaper_thread = None
            sync_thread = self._model_sync_thread
            self._model_sync_thread = None
            gc_thread = self._storage_gc_thread
            self._storage_gc_thread = None
        try:
            try:
                self._close_detached(workers)
            finally:
                try:
                    agy_profile.sync_workspace_credentials_to_vault()
                except Exception:
                    pass
                if code_login is not None:
                    code_login.cancel()
                if login is not None and login.poll() is None:
                    child_job.terminate_tree(login.pid)
                    child_job.forget(login.pid)
                if reaper is not None and reaper.is_alive() and threading.current_thread() is not reaper:
                    reaper.join(timeout=1.0)
                if sync_thread is not None and sync_thread.is_alive() and threading.current_thread() is not sync_thread:
                    sync_thread.join(timeout=1.0)
                if gc_thread is not None and gc_thread.is_alive() and threading.current_thread() is not gc_thread:
                    gc_thread.join(timeout=1.0)
        finally:
            with self._lock:
                self._stopped_manually = True
                self._draining_workers = False

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
        self._require_workers_available_locked()
        if any(profile in self._changing_profiles for profile in profiles):
            raise AgyProfileError(409, "Agy 账号正在更新，请稍后重试")
        # No profile filter when starting a new login: only one flow is tracked.
        if self._login is not None:
            if self._login.poll() is None:
                if not profiles or self._login_profile in profiles:
                    raise AgyProfileError(409, "请完成官方 agy 登录并关闭登录窗口后再操作")
            else:
                child_job.forget(self._login.pid)
                self._login = None
                self._login_profile = None
        if self._code_login is not None:
            st = self._code_login.public_state()
            if st["phase"] in ("starting", "waiting_code") and (not profiles or st["profile_id"] in profiles):
                raise AgyProfileError(409, "请先完成当前 Agy 授权码登录")

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
    def submission(self, profile_id: str | None = None):
        with self._lock:
            active, profiles = agy_profile.snapshot()
            if profile_id is not None and not any(p.id == profile_id for p in profiles):
                raise AgyProfileError(404, "找不到指定的 Agy 账号")
            target = active
            self._require_login_closed(target)
            if self._stopped_manually:
                raise AgyProfileError(409, "Agy 运行时已停止，请先在顶部状态栏重新启用")
            agy_profile.agy_executable()
            yield target

    _retire_wait_timeout: float = 1.2

    def _wait_session_retiring(self, db_key: str, profile_id: str, session_id: str) -> None:
        timeout = max(0.0, float(self._retire_wait_timeout))
        deadline = time.monotonic() + timeout
        while True:
            with self._lock:
                if (
                    self._stopped_manually
                    or self._draining_workers
                    or self._switching_profile
                    or profile_id in self._changing_profiles
                ):
                    return
                self._prune_retiring_locked()
                pending = [
                    (worker, closed)
                    for key, (worker, closed) in self._retiring.items()
                    if key[0] == db_key
                    and key[2] == session_id
                    and (worker._dirty or worker._abort_event.is_set())
                ]
            if not pending:
                return
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            for worker, closed in pending:
                rem = deadline - time.monotonic()
                if rem <= 0:
                    return
                if not closed.is_set():
                    closed.wait(min(0.05, rem))
                exited = worker._exit_pending
                if exited is not None and not exited.is_set():
                    rem = deadline - time.monotonic()
                    if rem <= 0:
                        return
                    exited.wait(min(0.05, rem))

    def _require_session_available_locked(self, db_key: str, profile_id: str, session_id: str) -> None:
        self._require_login_closed(profile_id)
        if self._stopped_manually:
            raise AgyProfileError(409, "Agy 运行时已停止，请先在顶部状态栏重新启用")
        self._prune_retiring_locked()
        if any(key[0] == db_key and key[2] == session_id for key in self._retiring):
            raise AgyProfileError(409, "Agy 正在关闭旧会话，请稍后重试")

    def get_worker(self, db_key: str, profile_id: str, session_id: str, workspace: Path) -> AgySessionWorker:
        key = (db_key, profile_id, session_id)
        self._wait_session_retiring(db_key, profile_id, session_id)
        with self._lock:
            self._require_session_available_locked(*key)
            grants = self._session_grants.setdefault((db_key, session_id), RuntimeGrants())
            worker = self._workers.get(key)
            if (
                worker is not None
                and worker.workspace == workspace
                and not worker._closed
                and not worker._dirty
                and not worker._retired
                and not worker._abort_event.is_set()
            ):
                return worker
        executable = agy_profile.agy_executable()
        version = self._probe_version_once(executable)
        while True:
            self._wait_session_retiring(db_key, profile_id, session_id)
            with self._lock:
                self._require_session_available_locked(*key)
                grants = self._session_grants.setdefault((db_key, session_id), RuntimeGrants())
                worker = self._workers.get(key)
                if worker is None:
                    worker = AgySessionWorker(
                        profile_id=profile_id,
                        session_id=session_id,
                        workspace=workspace,
                        executable=executable,
                        version=version,
                        grants=grants,
                        on_models=lambda models, pid=profile_id: self._record_models(pid, models),
                        on_commands=lambda cmds, pid=profile_id: self._record_commands(pid, cmds),
                        on_retire=lambda w, key_db=db_key: self.retire_worker(key_db, w),
                    )
                    self._workers[key] = worker
                    self._ensure_reaper_locked()
                    evict_keys = self._evict_excess_idle_keys_locked(exclude={key})
                    evicted = self._detach_workers_locked(evict_keys) if evict_keys else []
                    break
                if (
                    worker.workspace == workspace
                    and not worker._closed
                    and not worker._dirty
                    and not worker._retired
                    and not worker._abort_event.is_set()
                ):
                    worker.last_used = time.monotonic()
                    return worker
                if worker in self._active_turns.values():
                    raise AgyProfileError(409, "Agy 会话仍有任务运行，请稍后重试")
                detached = self._detach_workers_locked([key])
            self._close_detached(detached)
        if evicted:
            try:
                self._close_detached(evicted)
                _append_log(f"Evicted {len(evicted)} excess idle Agy ACP worker(s)")
            except Exception:
                log.debug("Failed closing evicted idle Agy ACP worker(s)", exc_info=True)
        return worker

    def _record_models(self, profile_id: str, items: list[dict[str, Any]]) -> None:
        if not items:
            return
        try:
            saved = agy_models.save_profile_catalog(profile_id, items, source="acp", prune_missing=True)
        except OSError:
            saved = [dict(i) for i in items]
        with self._lock:
            if saved:
                self._cached_models[profile_id] = saved

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
        with self._lock:
            self._cached_commands[profile_id] = cleaned

    def has_cached_commands(self, profile_id: str | None = None) -> bool:
        pid = profile_id or agy_profile.snapshot()[0]
        with self._lock:
            return pid in self._cached_commands

    def commands(self, profile_id: str | None = None) -> list[dict[str, Any]]:
        pid = profile_id or agy_profile.snapshot()[0]
        with self._lock:
            cached = self._cached_commands.get(pid)
            if cached is not None:
                return list(cached)
        return [
            {"name": "plan", "description": "先进行调研并生成结构化方案", "hint": "<目标>"},
            {"name": "compact", "description": "压缩当前对话上下文以节省额度"},
        ]

    def session_connected(self, db_key: str, session_id: str) -> bool:
        with self._lock:
            return any(
                k[0] == db_key and k[2] == session_id and w.is_alive()
                for k, w in self._workers.items()
            )

    def session_grants(self, db_key: str, session_id: str) -> list[str]:
        grants: set[str] = set()
        with self._lock:
            stored = self._session_grants.get((db_key, session_id))
            if stored is not None:
                snap = stored.snapshot()
                if "*" in snap:
                    return ["*"]
                grants.update(snap)
            for (w_db, _, w_sid), worker in self._workers.items():
                if w_db == db_key and w_sid == session_id:
                    snap = worker.grants.snapshot()
                    if "*" in snap:
                        return ["*"]
                    grants.update(snap)
        return sorted(grants)

    def clear_session_grants(self, db_key: str, session_id: str, kind: str | None = None) -> list[str]:
        with self._lock:
            stored = self._session_grants.get((db_key, session_id))
            if stored is not None:
                stored.clear(kind)
            for (w_db, _, w_sid), worker in self._workers.items():
                if w_db == db_key and w_sid == session_id:
                    worker.grants.clear(kind)
        return self.session_grants(db_key, session_id)

    def forget_session_grants(self, db_key: str, session_id: str) -> None:
        with self._lock:
            self._session_grants.pop((db_key, session_id), None)

    def register_turn(self, db_path: Path, run_id: str, worker: AgySessionWorker) -> None:
        with self._lock:
            self._require_workers_available_locked()
            if self._workers.get((str(db_path), worker.profile_id, worker.session_id)) is not worker:
                raise AgyProfileError(409, "Agy 会话已关闭，请重试")
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

    def retire_worker(self, db_key: str, worker: AgySessionWorker, *, force: bool = True) -> None:
        key = (db_key, worker.profile_id, worker.session_id)
        with self._lock:
            detached = self._detach_workers_locked([key]) if self._workers.get(key) is worker else []
        if detached:
            self._close_detached(detached, force=force)
        else:
            if force:
                try:
                    worker.close(force=True)
                except TypeError:
                    worker.force_abort()
                    worker.close()
            else:
                worker.close()

    def cancel_turn(self, db_path: Path, run_id: str, *, force: bool = False) -> bool:
        with self._lock:
            worker = self._active_turns.get((db_path, run_id))
            if worker is None:
                return False
            key = (str(db_path), worker.profile_id, worker.session_id)
            detached = (
                self._detach_workers_locked([key])
                if force and self._workers.get(key) is worker
                else []
            )
        if force:
            worker.force_abort("Agy 任务已强制终止")
            if detached:
                self._close_detached(detached, force=True)
            else:
                self.retire_worker(str(db_path), worker, force=True)
            return True
        worker.cancel_turn(force=False)
        if worker._dirty:
            threading.Thread(
                target=self.retire_worker,
                args=(str(db_path), worker),
                kwargs={"force": True},
                daemon=True,
            ).start()
        return True

    def close_session(self, db_key: str, session_id: str, *, force: bool = False) -> None:
        with self._lock:
            keys = [k for k in self._workers if k[0] == db_key and k[2] == session_id]
            active_workers = [
                self._workers[k]
                for k in keys
                if self._workers[k] in self._active_turns.values()
            ]
            if active_workers and not force:
                raise AgyProfileError(409, "当前有正在运行的任务，请先停止后再重连会话。")
            workers = self._detach_workers_locked(keys)
        if force:
            for active_worker in active_workers:
                active_worker.force_abort("Agy 会话已强制重连")
        self._close_detached(workers, force=force)

    def steer_turn(
        self,
        db_path: Path,
        run_id: str,
        *,
        prompt_text: str,
        staged_paths: list[Path],
        attachments: list[dict[str, Any]],
        allowed_roots: list[Path],
    ) -> dict[str, Any]:
        with self._lock:
            worker = self._active_turns.get((db_path, run_id))
        if worker is None:
            raise AgyProfileError(409, "当前任务已结束，请直接发送新消息。")
        return worker.steer_turn(
            prompt_text=prompt_text,
            staged_paths=staged_paths,
            attachments=attachments,
            allowed_roots=allowed_roots,
        )

    def list_workers(self, db_key: str | None = None, *, now: float | None = None) -> list[dict[str, Any]]:
        current = time.monotonic() if now is None else now
        items: list[dict[str, Any]] = []
        seen_workers: set[int] = set()
        with self._lock:
            self._prune_retiring_locked()
            for (w_db, _, _), worker in list(self._workers.items()):
                if db_key is not None and w_db != db_key:
                    continue
                seen_workers.add(id(worker))
                snap = worker.snapshot(now=current)
                snap["idle_ttl"] = int(self._idle_ttl)
                items.append(snap)
            for (w_db, _, _), (worker, _) in list(self._retiring.items()):
                if db_key is not None and w_db != db_key:
                    continue
                if id(worker) in seen_workers:
                    continue
                snap = worker.snapshot(now=current)
                snap["state"] = "retiring"
                snap["idle_ttl"] = int(self._idle_ttl)
                items.append(snap)
        order = {"running": 0, "retiring": 1, "idle": 2, "stopped": 3}
        items.sort(key=lambda item: (order.get(item["state"], 9), -item["idle_seconds"]))
        return items

    @staticmethod
    def _parse_models_output(stdout: str) -> list[dict[str, Any]]:
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
        items: list[dict[str, Any]] = []
        seen: set[str] = set()
        for mid, label in rows:
            if mid not in seen:
                seen.add(mid)
                entry: dict[str, Any] = {"id": mid, "display_name": label}
                if agy_models.is_orchestrator_model(mid):
                    entry["is_orchestrator"] = True
                items.append(entry)
        return items

    def _fetch_acp_models(self, pid: str) -> list[dict[str, Any]]:
        """Probe official `agy acp` `session/new` for the curated runtime model catalog."""
        executable = agy_profile.agy_executable()
        if pid == agy_profile.DEFAULT:
            agy_profile._seed_default_vault_if_empty()
        agy_profile.prepare_profile(pid)
        temp_dir = agy_profile.make_runtime_temp_dir(pid)
        probe_ws = temp_dir / "ws"
        probe_ws.mkdir(parents=True, exist_ok=True)
        proc: subprocess.Popen | None = None
        group: child_job.ProcessGroupHandle | None = None
        incoming: queue.Queue[dict[str, Any] | None] = queue.Queue()
        stderr_lines: list[str] = []
        with self._lock:
            known_version = self._cached_version
        try:
            env = agy_profile.clean_agy_env(pid, temp_dir=temp_dir, vault_only=True)
            cmd = [
                executable,
                "acp",
                "--gemini-dir",
                str(agy_profile.profile_vault_gemini_dir(pid)),
                "--app-data-dir",
                agy_profile.APP_DATA_DIR_NAME,
            ]
            proc = child_job.spawn(
                cmd,
                kind="agy-acp-probe",
                marker=executable,
                cwd=str(probe_ws),
                env=env,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                **hidden_process_kwargs(),
            )
            group = child_job.create_process_group(proc)

            def _read_stdout() -> None:
                try:
                    if proc is None or proc.stdout is None:
                        return
                    for raw_line in proc.stdout:
                        line = raw_line.strip()
                        if not line:
                            continue
                        try:
                            frame = json.loads(line)
                        except ValueError:
                            continue
                        if isinstance(frame, dict):
                            incoming.put(frame)
                except OSError:
                    pass
                finally:
                    incoming.put(None)

            def _read_stderr() -> None:
                try:
                    if proc is None or proc.stderr is None:
                        return
                    for raw_line in proc.stderr:
                        text = raw_line.strip()
                        if text and len(stderr_lines) < 32:
                            stderr_lines.append(text)
                except OSError:
                    pass

            t_out = threading.Thread(target=_read_stdout, name="agy-acp-probe-out", daemon=True)
            t_err = threading.Thread(target=_read_stderr, name="agy-acp-probe-err", daemon=True)
            t_out.start()
            t_err.start()

            def _rpc_once(req_id: int, method: str, params: dict[str, Any], *, timeout: float) -> dict[str, Any]:
                if proc is None or proc.stdin is None:
                    raise AgyProfileError(503, "Agy ACP 探测通道不可用")
                frame = json.dumps({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params}, ensure_ascii=False)
                try:
                    proc.stdin.write(frame + "\n")
                    proc.stdin.flush()
                except OSError as exc:
                    raise AgyProfileError(503, f"发送 Agy ACP 探测请求失败: {exc}") from exc
                deadline = time.monotonic() + timeout
                while True:
                    rem = deadline - time.monotonic()
                    if rem <= 0:
                        raise AgyProfileError(503, f"Agy ACP {method} 探测超时")
                    try:
                        msg = incoming.get(timeout=rem)
                    except queue.Empty as exc:
                        raise AgyProfileError(503, f"Agy ACP {method} 探测超时") from exc
                    if msg is None:
                        detail = "；".join(stderr_lines[-3:]) if stderr_lines else "ACP 进程提前退出"
                        if re.search(r"please sign in|not logged in|login required|authentication required", detail, re.I):
                            raise AgyProfileError(409, "Agy 账号尚未登录，请先完成官方登录后重试")
                        raise AgyProfileError(503, f"Agy ACP 模型探测失败: {detail}")
                    if msg.get("id") != req_id:
                        continue
                    err = msg.get("error")
                    if isinstance(err, dict):
                        err_msg = str(err.get("message") or err)
                        err_code = err.get("code")
                        if err_code in (-32000, -32603) or re.search(r"login|auth|sign in", err_msg, re.I):
                            raise AgyProfileError(409, "Agy 账号尚未登录，请先完成官方登录后重试")
                        raise AgyProfileError(503, f"Agy ACP {method} 返回错误: {err_msg}")
                    res = msg.get("result")
                    return res if isinstance(res, dict) else {}

            _rpc_once(
                1,
                "initialize",
                {
                    "protocolVersion": 1,
                    "clientCapabilities": {
                        "fs": {"readTextFile": False, "writeTextFile": False},
                        "terminal": False,
                    },
                    "clientInfo": client_info_for_version(known_version),
                },
                timeout=8.0,
            )
            try:
                _rpc_once(2, "authenticate", {"methodId": "oauth-personal"}, timeout=10.0)
            except AgyProfileError as exc:
                if exc.status == 409:
                    raise
            started = _rpc_once(
                3,
                "session/new",
                {"cwd": str(probe_ws), "mcpServers": []},
                timeout=12.0,
            )
            items = extract_enriched_model_catalog_from_setup(started)
        except AgyProfileError:
            raise
        except (OSError, subprocess.SubprocessError, ValueError) as exc:
            raise AgyProfileError(503, f"Agy ACP 模型探测失败: {exc}") from exc
        finally:
            if proc is not None:
                if proc.stdin is not None:
                    try:
                        proc.stdin.close()
                    except OSError:
                        pass
                if group is not None:
                    group.terminate(proc.pid)
                    group.close()
                else:
                    child_job.terminate_tree(proc.pid)
                for stream in (proc.stdout, proc.stderr):
                    if stream is not None:
                        try:
                            stream.close()
                        except OSError:
                            pass
                child_job.forget(proc.pid)
            elif group is not None:
                group.close()
            shutil.rmtree(temp_dir, ignore_errors=True)
        if not items:
            raise AgyProfileError(502, "Agy ACP 未返回模型目录")
        return items

    def _fetch_cli_models(self, pid: str) -> list[dict[str, Any]]:
        executable = agy_profile.agy_executable()
        if pid == agy_profile.DEFAULT:
            agy_profile._seed_default_vault_if_empty()
        agy_profile.prepare_profile(pid)
        temp_dir = agy_profile.make_runtime_temp_dir(pid)
        try:
            env = agy_profile.clean_agy_env(pid, temp_dir=temp_dir, vault_only=True)
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
        return items

    def models(
        self,
        profile_id: str | None = None,
        *,
        force_refresh: bool = False,
    ) -> list[dict[str, Any]]:
        pid = profile_id or agy_profile.snapshot()[0]
        with self._lock:
            self._require_login_closed(pid)
            self._ensure_model_sync_locked()
            cached = self._cached_models.get(pid)
        disk_items, meta = agy_models.profile_catalog(pid)
        if not force_refresh:
            if disk_items and not meta["stale"]:
                with self._lock:
                    self._cached_models[pid] = list(agy_models.profile_catalog(pid, apply_legacy_filter=False)[0])
                return list(disk_items)
            if cached and not disk_items:
                filtered_cached, _ = agy_models.filter_legacy_catalog_items(cached)
                return filtered_cached

        acp_items: list[dict[str, Any]] = []
        acp_error: AgyProfileError | None = None
        try:
            acp_items = self._fetch_acp_models(pid)
        except AgyProfileError as exc:
            acp_error = exc

        if acp_items:
            try:
                saved = agy_models.save_profile_catalog(pid, acp_items, source="acp", prune_missing=True)
            except OSError:
                saved = list(acp_items)
            with self._lock:
                self._cached_models[pid] = list(saved)
            filtered, _ = agy_models.filter_legacy_catalog_items(saved)
            return filtered

        cli_items: list[dict[str, Any]] = []
        cli_error: AgyProfileError | None = None
        try:
            cli_items = self._fetch_cli_models(pid)
        except AgyProfileError as exc:
            cli_error = exc

        if cli_items:
            try:
                saved = agy_models.save_profile_catalog(pid, cli_items, source="cli", prune_missing=True)
            except OSError:
                saved = list(cli_items)
            with self._lock:
                self._cached_models[pid] = list(saved)
            filtered, _ = agy_models.filter_legacy_catalog_items(saved)
            return filtered

        chosen_error = (
            acp_error
            if (acp_error is not None and acp_error.status == 409)
            else (cli_error or acp_error)
        )
        if chosen_error is not None:
            try:
                agy_models.record_sync_error(str(chosen_error))
            except OSError:
                pass
            if not force_refresh and disk_items:
                with self._lock:
                    self._cached_models[pid] = list(agy_models.profile_catalog(pid, apply_legacy_filter=False)[0])
                return list(disk_items)
            raise chosen_error
        raise AgyProfileError(502, "Agy 返回了空的模型目录")

    def models_catalog_info(
        self,
        profile_id: str | None = None,
        *,
        force_refresh: bool = False,
    ) -> dict[str, Any]:
        pid = profile_id or agy_profile.snapshot()[0]
        items = self.models(pid, force_refresh=force_refresh)
        _, meta = agy_models.profile_catalog(pid)
        return {
            "items": items,
            "synced_at": meta.get("synced_at"),
            "next_sync_at": meta.get("next_sync_at"),
            "stale": bool(meta.get("stale")),
            "source": meta.get("source"),
            "filtered_legacy_count": int(meta.get("filtered_legacy_count") or 0),
            "default_model": meta.get("default_model"),
            "default_effort": meta.get("default_effort"),
        }

    def sync_models(self, profile_id: str | None = None) -> dict[str, Any]:
        pid = profile_id or agy_profile.snapshot()[0]
        return self.models_catalog_info(pid, force_refresh=True)

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

    def set_profile_tier(self, profile_id: str, account_tier: str | None) -> dict[str, Any]:
        with self._lock:
            return agy_profile.set_account_tier(profile_id, account_tier)

    @contextmanager
    def _profile_change(self, profile_id: str):
        with self._lock:
            self._require_login_closed(profile_id)
            if any(key[1] == profile_id and worker in self._active_turns.values()
                   for key, worker in self._workers.items()):
                raise AgyProfileError(409, "请先等待该 Agy 账号的任务结束")
            self._changing_profiles.add(profile_id)
            workers = self._detach_workers_locked([k for k in self._workers if k[1] == profile_id])
        try:
            self._close_detached(workers)
            with self._lock:
                self._require_workers_available_locked()
                self._require_profile_exited_locked(profile_id)
                self._cached_models.pop(profile_id, None)
                self._cached_commands.pop(profile_id, None)
                yield
        finally:
            with self._lock:
                self._changing_profiles.discard(profile_id)

    def _require_profile_exited_locked(self, profile_id: str) -> None:
        self._prune_retiring_locked()
        if any(key[1] == profile_id for key in self._retiring):
            raise AgyProfileError(409, "Agy 账号的旧进程仍在退出，请稍后重试")

    def delete_profile(self, profile_id: str) -> None:
        with self._profile_change(profile_id):
            agy_profile.delete(profile_id)
        try:
            agy_models.clear_profile_catalog(profile_id)
        except OSError:
            pass

    def set_profile_orchestrator(
        self,
        profile_id: str,
        *,
        planner: str | None = None,
        executor: str | None = None,
    ) -> dict[str, str | None]:
        saved = agy_profile.set_orchestrator_settings(profile_id, planner=planner, executor=executor)
        with self._lock:
            registered = set(self._active_turns.values())
            idle_keys = [
                k for k, w in self._workers.items()
                if w not in registered and w.active_turn is None
            ]
            workers = self._detach_workers_locked(idle_keys)
        self._close_detached(workers)
        return saved

    def ensure_orchestrator_roles(
        self,
        db_key: str,
        profile_id: str,
        session_id: str,
        *,
        planner: str | None,
        executor: str | None,
    ) -> None:
        clean_planner = planner.strip() if isinstance(planner, str) and planner.strip() else None
        clean_executor = executor.strip() if isinstance(executor, str) and executor.strip() else None
        target = (clean_planner, clean_executor)
        current = agy_profile.get_orchestrator_settings(profile_id)
        current_roles = (current.get("planner"), current.get("executor"))
        changed = current_roles != target
        if changed:
            agy_profile.set_orchestrator_settings(profile_id, planner=clean_planner, executor=clean_executor)
        with self._lock:
            registered = set(self._active_turns.values())
            stale_keys = [
                k for k, w in self._workers.items()
                if w not in registered
                and w.active_turn is None
                and getattr(w, "proc", None) is not None
                and getattr(w, "loaded_orchestrator", None) != target
                and (changed or (k[0] == db_key and k[1] == profile_id and k[2] == session_id))
            ]
            workers = self._detach_workers_locked(stale_keys)
        self._close_detached(workers)

    def clear_profile_credentials(self, profile_id: str) -> dict[str, Any]:
        with self._profile_change(profile_id):
            return agy_profile.clear_credentials(profile_id)

    def switch_profile(self, profile_id: str) -> None:
        with self._lock:
            active, profiles = agy_profile.snapshot()
            if not any(p.id == profile_id for p in profiles):
                raise AgyProfileError(404, "找不到 Agy 账号")
            if active == profile_id:
                return
            self._require_login_closed(active, profile_id)
            if self._active_turns or any(w.active_turn is not None for w in self._workers.values()):
                raise AgyProfileError(409, "当前有正在运行的任务，请等待结束或先停止后再切换账号")
            self._switching_profile = True
            workers = self._detach_workers_locked(list(self._workers))
        try:
            self._close_detached(workers)
            with self._lock:
                self._prune_retiring_locked()
                if self._retiring:
                    raise AgyProfileError(409, "Agy 旧会话进程仍在退出，请稍后重试")
                try:
                    agy_profile.sync_workspace_credentials_to_vault(active)
                except Exception:
                    log.debug("Failed syncing previous account credentials before switch", exc_info=True)
                agy_profile.select(profile_id)
                agy_profile.activate_profile_in_workspace(profile_id)
                self._cached_models.pop(profile_id, None)
                self._cached_commands.clear()
        finally:
            with self._lock:
                self._switching_profile = False
        _append_log(f"Switched active Agy account to {profile_id}")

    @staticmethod
    def _watch_login_process(
        profile_id: str,
        proc: subprocess.Popen,
        flow: CodeLoginFlow | None = None,
        on_exit: Callable[[], None] | None = None,
    ) -> None:
        # Do not tie lock ownership to manager bookkeeping: cancellation and
        # shutdown may clear their references before the child actually exits.
        def watch() -> None:
            try:
                if flow is not None:
                    flow.watch()
            finally:
                proc.wait()
                child_job.forget(proc.pid)
                try:
                    if on_exit is not None:
                        on_exit()
                except Exception:
                    log.debug("Login post-exit workspace sync skipped", exc_info=True)
                finally:
                    agy_profile.release_profile_lock(profile_id)

        try:
            threading.Thread(target=watch, daemon=True).start()
        except RuntimeError:
            child_job.terminate_tree(proc.pid)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                log.error("Agy login did not exit; retaining profile lock for %s", profile_id)
            else:
                child_job.forget(proc.pid)
                if flow is not None and flow.temp_dir is not None:
                    shutil.rmtree(flow.temp_dir, ignore_errors=True)
                agy_profile.release_profile_lock(profile_id)
            raise

    def _on_profile_login_finished(self, profile_id: str) -> None:
        if not agy_profile.has_local_credentials(profile_id):
            return
        agy_profile.record_auth_state(profile_id, "authenticated")
        with self._lock:
            active, _ = agy_profile.snapshot()
            can_activate = active == profile_id and self._active_turn_count() == 0
        if can_activate:
            agy_profile.activate_profile_in_workspace(profile_id, force_reload=True)

    def login_profile(self, profile_id: str) -> None:
        with self._lock:
            if os.name != "nt":
                raise AgyProfileError(501, "从 GA-Hub 打开独立窗口仅支持 Windows，请使用应用内 Google 授权码登录")
            _, profiles = agy_profile.snapshot()
            if not any(p.id == profile_id for p in profiles):
                raise AgyProfileError(404, "找不到 Agy 账号")
            self._require_login_closed()
            self._require_login_closed(profile_id)
            self._require_profile_exited_locked(profile_id)
            if self._active_turn_count() > 0:
                raise AgyProfileError(409, "请等当前任务结束后再打开官方登录窗口")
            executable = agy_profile.agy_executable()
            agy_profile.clear_host_import_disabled(profile_id)
            agy_profile.claim_profile_lock(profile_id)
            try:
                agy_profile.prepare_profile(profile_id)
                env = agy_profile.clean_agy_env(profile_id, vault_only=True)
                cwd = agy_profile.profile_vault_home(profile_id)
                proc = child_job.spawn(
                    [executable],
                    kind="agy-login",
                    marker=executable,
                    cwd=str(cwd),
                    env=env,
                    creationflags=subprocess.CREATE_NEW_CONSOLE,
                )
            except BaseException as exc:
                agy_profile.release_profile_lock(profile_id)
                if isinstance(exc, OSError):
                    raise AgyProfileError(503, "无法打开官方 agy 登录窗口") from exc
                raise
            self._watch_login_process(
                profile_id,
                proc,
                on_exit=lambda pid=profile_id: self._on_profile_login_finished(pid),
            )
            self._login = proc
            self._login_profile = profile_id

    def start_code_login(self, profile_id: str) -> dict[str, Any]:
        """Start T3 Code's cross-platform `agy acp --login` flow."""
        with self._lock:
            active, profiles = agy_profile.snapshot()
            if not any(p.id == profile_id for p in profiles):
                raise AgyProfileError(404, "找不到 Agy 账号")
            if active == profile_id and self._active_turn_count() > 0:
                raise AgyProfileError(409, "请先等待当前任务结束后再重新登录当前账号")
            self._require_login_closed()
            self._require_login_closed(profile_id)
            self._require_profile_exited_locked(profile_id)
            executable = agy_profile.agy_executable()
            agy_profile.clear_host_import_disabled(profile_id)
            agy_profile.claim_profile_lock(profile_id)
            temp_dir = None
            try:
                agy_profile.prepare_profile(profile_id)
                temp_dir = agy_profile.make_runtime_temp_dir(profile_id)
                env = agy_profile.clean_agy_env(profile_id, temp_dir=temp_dir, headless_login=True)
                cmd = agy_profile.acp_spawn_command(executable, profile_id, login=True)
                proc = child_job.spawn(
                    cmd,
                    kind="agy-code-login",
                    marker=executable,
                    cwd=str(agy_profile.profile_vault_gemini_dir(profile_id)),
                    env=env,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    encoding="utf-8",
                    errors="replace",
                    bufsize=1,
                    **hidden_process_kwargs(),
                )
            except BaseException as exc:
                if temp_dir is not None:
                    shutil.rmtree(temp_dir, ignore_errors=True)
                agy_profile.release_profile_lock(profile_id)
                if isinstance(exc, OSError):
                    raise AgyProfileError(503, "无法启动 agy 登录流程") from exc
                raise
            flow = CodeLoginFlow(flow_id=uuid4().hex, profile_id=profile_id, process=proc, temp_dir=temp_dir)
            self._watch_login_process(
                profile_id,
                proc,
                flow,
                on_exit=lambda pid=profile_id: self._on_profile_login_finished(pid),
            )
            self._code_login = flow

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

    def cancel_code_login(self, flow_id: str) -> dict[str, Any]:
        with self._lock:
            flow = self._code_login
            if flow is None or flow.flow_id != flow_id:
                raise AgyProfileError(404, "登录流程不存在或已失效")
            self._code_login = None
        flow.cancel(reason="已取消 Google 授权码登录")
        return flow.public_state()


runtime = AgyRuntimeManager()
