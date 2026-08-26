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
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, AsyncIterator

from .. import _paths

if _paths.GA_ROOT is None:
    raise RuntimeError("AgentService imported before GA_ROOT is configured")

from agentmain import GeneraticAgent  # noqa: E402  (resolved via _paths sys.path)
from frontends.continue_cmd import install as install_continue, reset_conversation  # noqa: E402

from .chat_retry import SCHEDULED_RETRY_SOURCES, ChatRetryConfig, classify_recoverable_error, compute_backoff_delay, load_chat_retry_config  # noqa: E402
from .chat_stream_projection import ChatSnapshot, ChatStreamProjection  # noqa: E402
from .event_bus import bus  # noqa: E402
from .llm_preference_store import LlmPreferenceStore  # noqa: E402
from .llm_registry import LlmRegistry, LlmUnavailableError  # noqa: E402
from .legacy_chat_history_store import LegacyChatHistoryStore  # noqa: E402
from .rewind_adapter import RewindAdapter  # noqa: E402

log = logging.getLogger(__name__)

_AUTO_CONTINUE_MAX = 2
_STREAM_MIRROR_QUEUE_CAPACITY = 2
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
# Implementation lives in ``ga_subprocess_patch`` so the IPC plumbing is testable
# in isolation. Re-exported here for backwards-compatible debugging.
from .ga_subprocess_patch import _patch_ga_subprocess  # noqa: E402

_patch_ga_subprocess()


# ── External Python worker for GA browser tools ──────────────────────────────
# The worker script and the synchronous ``call`` wrapper live in
# ``ga_external_worker``. ``_patch_ga_web_tools`` stays here because tests
# (``tests/test_paths_python.py``) override ``_ExternalGaWebTools`` via
# ``mock.patch.object(agent_service, "_ExternalGaWebTools", ...)``; that lookup
# only works if the name is bound on this module.
from .ga_external_worker import _ExternalGaWebTools, _WEB_TOOL_WORKER_SCRIPT  # noqa: E402,F401


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
    """A live agent task stream with one legacy queue consumer.

    WebSocket clients receive the bus/snapshot projection; ``display_queue``
    remains a compatibility channel for the synchronous WeChat consumer.
    """
    stream_id: str
    display_queue: "_q.Queue"
    started_at: float = field(default_factory=time.time)
    finished: bool = False
    last_chunk: str = ""
    final_text: str = ""
    logical_id: str = ""
    auto_continue_count: int = 0
    error_retry_count: int = 0
    error_retry_origin: str = ""
    session_id: str = ""
    run_id: str = ""


# ── chat replay snapshot (so a /ws/chat client that reconnects after a tab
#    switch can rebuild the running conversation) ───────────────────────
def _llm_membership_metadata(backends: list[object | None]) -> list[dict]:
    """Return read-only Mixin membership/runtime metadata for LLM clients."""
    all_mixin_members: set[str] = set()
    rows: list[dict] = []
    for backend in backends:
        is_mixin = type(backend).__name__ == "MixinSession"
        members: list[str] = []
        if is_mixin:
            for session in (getattr(backend, "_sessions", None) or []):
                member_name = str(getattr(session, "name", "") or "")
                if member_name and member_name not in members:
                    members.append(member_name)
                    all_mixin_members.add(member_name)
        rows.append({
            "kind": "mixin" if is_mixin else "single",
            "members": members,
            "active_member": str(getattr(backend, "current_name", "") or "") if is_mixin else "",
            "backend_name": str(getattr(backend, "name", "") or "") if not is_mixin else "",
        })
    for row in rows:
        row["in_mixin"] = bool(row["backend_name"] in all_mixin_members) if row["kind"] == "single" else False
        row.pop("backend_name", None)
    return rows


class AgentService:
    _instance: "AgentService | None" = None
    _SNAPSHOT_CAP = 20  # keep last N submissions for /ws/chat replay

    def __init__(
        self,
        *,
        agent: object | None = None,
        session_id: str = "",
        manage_global_preference: bool = True,
    ) -> None:
        # Patch /continue and /new before instantiating
        install_continue(GeneraticAgent)
        self.agent = agent if agent is not None else GeneraticAgent()
        LlmRegistry.mark_agent_current(self.agent)
        self.session_id = session_id
        self._manage_global_preference = manage_global_preference
        # Default to incremental output for WS streaming
        self.agent.inc_out = False
        self.agent.verbose = False
        self._streams: dict[str, StreamHandle] = {}
        # Per-stream UI snapshot (LRU-capped) for replay on reconnect
        self._snapshots = ChatStreamProjection(capacity=self._SNAPSHOT_CAP)
        self._lock = threading.Lock()
        self._submit_admission_lock = threading.Lock()
        self._fanout_stop_event = threading.Event()
        self._fanout_threads: set[threading.Thread] = set()
        self._rewind_lock = threading.RLock()
        self._rewind_store = None
        self._rewind_adapter: RewindAdapter | None = None
        self._legacy_chat_history = LegacyChatHistoryStore()
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
        self._llm_preferences = LlmPreferenceStore()
        if self._manage_global_preference:
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
        # GA's official cost tracker keys usage by the agent thread name.
        # Use the same stable per-session convention as desktop_bridge.
        self._run_thread = threading.Thread(
            target=self.agent.run,
            daemon=True,
            name=f"GA-{self.session_id}",
        )
        self._run_thread.start()
        log.info("agent run thread started for session %s", self.session_id)

    def shutdown(self, timeout: float = 5.0) -> bool:
        """Stop the GA run loop and fanout workers before releasing singleton."""
        deadline = time.monotonic() + max(0.0, timeout)
        fanout_stop = getattr(self, "_fanout_stop_event", None)
        if fanout_stop is not None:
            fanout_stop.set()
        submit_lock = getattr(self, "_submit_admission_lock", None)
        submission_stopped = True
        if submit_lock is not None:
            submission_stopped = submit_lock.acquire(
                timeout=max(0.0, deadline - time.monotonic())
            )
            if submission_stopped:
                submit_lock.release()
        thread = getattr(self, "_run_thread", None)
        if thread is not None and thread.is_alive():
            if getattr(self.agent, "is_running", False):
                self.agent.abort()
            self.agent.task_queue.put("__shutdown__")
            thread.join(timeout=max(0.0, deadline - time.monotonic()))

        fanout_threads = getattr(self, "_fanout_threads", None)
        if fanout_threads is None:
            fanouts_stopped = True
        else:
            with self._lock:
                current = tuple(fanout_threads)
            current_thread = threading.current_thread()
            for worker in current:
                if worker is not current_thread:
                    worker.join(timeout=max(0.0, deadline - time.monotonic()))
            with self._lock:
                alive = {worker for worker in fanout_threads if worker.is_alive()}
                fanout_threads.intersection_update(alive)
                fanouts_stopped = not fanout_threads

        run_stopped = thread is None or not thread.is_alive()
        stopped = submission_stopped and run_stopped and fanouts_stopped
        if stopped:
            self._run_thread = None
            if type(self)._instance is self:
                type(self)._instance = None
            # Release the archive lock only after the run loop truly stopped:
            # GA's lock liveness is heartbeat-based, so an unreleased lock keeps
            # "occupying" its session for 30s after this process exits and the
            # next launch's first restore would be refused. Imported lazily so
            # stubbed continue_cmd test doubles keep working.
            try:
                from frontends.continue_cmd import release_current

                release_current(self.agent)
            except Exception:
                log.debug("archive lock release on shutdown failed", exc_info=True)
        return stopped

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
        entries = LlmRegistry.reload_and_snapshot(self.agent)
        keys = {index: key for key, index in entries}
        preferred_key = self._llm_preferences.get_key()
        out = []
        clients = getattr(self.agent, "llmclients", []) or []
        backends = [getattr(client, "backend", None) for client in clients]
        membership = _llm_membership_metadata(backends)
        for i, name, current in self.agent.list_llms():
            client = clients[i] if i < len(clients) else None
            backend = getattr(client, "backend", None)
            meta = membership[i] if i < len(membership) else {
                "kind": "single", "members": [], "active_member": "", "in_mixin": False,
            }
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
                "key": keys.get(i, ""),
                "name": name,
                "current": bool(current),
                "preferred": bool(preferred_key and keys.get(i) == preferred_key),
                "kind": meta["kind"],
                "members": meta["members"],
                "active_member": meta["active_member"],
                "in_mixin": meta["in_mixin"],
                "model": model,
                "api_base": api_base,
                "api_key_masked": api_key_masked,
            })
        return out

    def _select_llm_for_key(self, key: str) -> None:
        """Resolve and select one MyKey assignment without persisting preference."""
        LlmRegistry.switch_by_key(self.agent, key)

    def _select_llm_for_task(self, n: int) -> None:
        """Transiently select an LLM for one submission without persisting preference."""
        LlmRegistry.switch_by_index(self.agent, int(n))

    def switch_llm(self, n: int) -> dict:
        if bool(getattr(self.agent, "is_running", False)):
            raise RuntimeError("agent is running; wait for the current reply or stop it before switching LLM")
        selected, key = LlmRegistry.switch_by_index(self.agent, int(n))
        # Mark this as the user's explicit preference (separate from the
        # transient agent.llm_no which any code path can mutate).
        self._llm_preferences.set_selection(key, selected)
        return {"llm_no": selected, "key": key, "name": self.agent.get_llm_name()}

    # ── llm preference persistence ───────────────────────────────
    def _save_preferred_llm(self, n: int) -> None:
        try:
            self._llm_preferences.set(n)
        except Exception as e:
            log.warning("failed to persist preferred_llm_no=%s: %s", n, e)

    def _get_preferred_llm_no(self):
        """Return the persisted preferred LLM index (int or None).

        Kept as a compatibility facade over LlmPreferenceStore.
        """
        return self._llm_preferences.get()

    def _restore_preferred_llm(self) -> None:
        try:
            saved, legacy_index = self._llm_preferences.get_selection()
            if saved is None:
                if legacy_index is None:
                    return
                entries = LlmRegistry.reload_and_snapshot(self.agent)
                saved = {
                    index: assignment for assignment, index in entries
                }.get(int(legacy_index))
                if saved is None:
                    log.warning(
                        "legacy preferred llm index is unavailable: %s",
                        legacy_index,
                    )
                    return
                self._llm_preferences.set_selection(saved, int(legacy_index))
                log.info("migrated preferred_llm_no=%s to key=%s", legacy_index, saved)
            if saved is None:
                return
            n = LlmRegistry.resolve(self.agent, saved)
            if int(getattr(self.agent, "llm_no", -1)) == n:
                return
            self.agent.next_llm(n)
            log.info("restored preferred_llm_key=%s (%s)", n, self.agent.get_llm_name())
        except LlmUnavailableError as e:
            log.warning("preferred llm is unavailable: %s", e)
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
        # Immediately publish chat:aborted to unblock the UI.
        # The agent's run loop may still emit a final {'done': ...} if it
        # manages to break out, but when LLM is stuck we can't wait for that.
        bus.publish("chat:aborted", {"ts": time.time()})

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

    def submit(self, query: str, **kwargs: Any) -> StreamHandle:
        """Admit one task while shutdown is excluded from the submit path."""
        with self._submit_admission_lock:
            if self._fanout_stop_event.is_set():
                raise RuntimeError("agent service is shutting down")
            return self._submit_impl(query, **kwargs)

    def _submit_impl(
        self,
        query: str,
        *,
        source: str = "user",
        images: list[str] | None = None,
        logical_id: str | None = None,
        auto_continue_count: int = 0,
        error_retry_count: int = 0,
        error_retry_origin: str = "",
        retry_of: str = "",
        retry_reason: str = "",
        retry_max: int = 0,
        llm_index: int | None = None,
        llm_key: str | None = None,
        session_id: str | None = None,
        run_id: str = "",
    ) -> StreamHandle:
        """Enqueue a task; spawn a single fan-out drainer that publishes
        chat:* events to the bus AND keeps the StreamHandle's display_queue
        full for legacy sync consumers (wechat_service)."""
        # User-initiated submissions use an explicit page-scoped override when
        # provided; otherwise they reassert the persisted/global preference.
        # Other sources (autonomous, wechat, reflect) keep whatever llm_no is
        # currently active unless an explicit override is supplied.
        if llm_key is not None:
            self._select_llm_for_key(llm_key)
        elif llm_index is not None:
            self._select_llm_for_task(llm_index)
        elif self._manage_global_preference and source in ("user", "webui"):
            self._restore_preferred_llm()
        effective_session_id = self.session_id if session_id is None else session_id
        with self._lock:
            self._next_id += 1
            sid = f"s{self._next_id:08d}"
        if logical_id is None:
            logical_id = sid
        # The agent's own queue (drained by our fan-out below).
        src_q = self.agent.put_task(query, source=source, images=images or [])
        # The handle queue we hand to callers (kept in sync by the drainer).
        # ``next`` payloads are cumulative, so retaining every intermediate
        # version only duplicates the reply for callers that do not consume
        # this legacy queue (the normal Web UI uses bus events). Keep enough
        # room for the latest progress plus the terminal item instead.
        out_q: "_q.Queue" = _q.Queue(maxsize=_STREAM_MIRROR_QUEUE_CAPACITY)
        h = StreamHandle(
            stream_id=sid,
            display_queue=out_q,
            logical_id=logical_id,
            auto_continue_count=auto_continue_count,
            error_retry_count=error_retry_count,
            error_retry_origin=str(error_retry_origin or ""),
            session_id=effective_session_id,
            run_id=run_id,
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
            session_id=effective_session_id,
            run_id=run_id,
        )
        with self._lock:
            self._streams[sid] = h
            self._snapshots.add(snap)
        submit_payload = {
            "stream_id": sid,
            "source": source,
            "query_preview": (query or "")[:120],
            "logical_id": logical_id,
            "session_id": effective_session_id,
            "run_id": run_id,
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
            "session_id": effective_session_id,
            "run_id": run_id,
        }
        if error_retry_count:
            started_payload.update({
                "retry_attempt": error_retry_count,
                "retry_max": retry_max,
                "retry_of": retry_of,
                "retry_reason": retry_reason,
            })
        bus.publish("chat:started", started_payload)
        fanout_thread = threading.Thread(
            target=self._fanout, args=(src_q, out_q, h, snap),
            daemon=True, name=f"agent-fanout-{sid}",
        )
        with self._lock:
            self._fanout_threads.add(fanout_thread)
        try:
            fanout_thread.start()
        except BaseException:
            with self._lock:
                self._fanout_threads.discard(fanout_thread)
            raise
        return h

    def _fanout(self, src_q: "_q.Queue", out_q: "_q.Queue", h: StreamHandle, snap: ChatSnapshot) -> None:
        """Drain the agent's display_queue. For each item:
          - mirror to the StreamHandle's queue (for legacy sync consumers).
          - update the snapshot.
          - publish chat:next / chat:done to the bus.
        """
        terminal_committed = False
        fanout_stop = getattr(self, "_fanout_stop_event", None)
        heartbeat_deadline = time.monotonic() + 300
        try:
            while True:
                try:
                    item = src_q.get(timeout=1 if fanout_stop is not None else 300)
                except _q.Empty:
                    if fanout_stop is not None and fanout_stop.is_set():
                        content = h.last_chunk or snap.content or ""
                        error_content = (
                            f"{content}\n[stream aborted: service shutdown]"
                            if content else "[stream aborted: service shutdown]"
                        )
                        with self._lock:
                            snap.content = error_content
                            snap.done = True
                            snap.aborted = True
                            snap.finished_at = time.time()
                        h.finished = True
                        h.final_text = error_content
                        self._mirror_stream_item(out_q, {"done": error_content, "source": snap.source})
                        terminal_committed = True
                        bus.publish("chat:done", {
                            "stream_id": h.stream_id,
                            "source": snap.source,
                            "content": error_content,
                            "logical_id": h.logical_id,
                            "retry_attempt": snap.retry_attempt,
                            "retry_max": snap.retry_max,
                            "retry_of": snap.retry_of,
                            "retry_reason": snap.retry_reason,
                            "session_id": h.session_id,
                            "run_id": h.run_id,
                        })
                        return
                    if time.monotonic() >= heartbeat_deadline:
                        # Liveness ping so subscribers know we're still here.
                        bus.publish("chat:heartbeat", {"stream_id": h.stream_id})
                        heartbeat_deadline = time.monotonic() + 300
                    continue
                if fanout_stop is not None and fanout_stop.is_set() and "done" not in item:
                    continue
                if "next" in item:
                    # Mirror without back-pressuring the sole GA queue drainer.
                    # Slow/absent legacy consumers only need the newest cumulative
                    # progress item.
                    self._mirror_stream_item(out_q, item)
                    content = item["next"]
                    h.last_chunk = content
                    with self._lock:
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
                        "session_id": h.session_id,
                        "run_id": h.run_id,
                    })
                if "done" in item:
                    content = item["done"]
                    h.final_text = content
                    with self._lock:
                        snap.content = content
                        snap.done = True
                        snap.finished_at = time.time()
                    # Keep the coordinator's session reservation until the
                    # durable worldline checkpoint has observed the completed
                    # native archive. Rewind must not restore a stale tree.
                    self._sync_rewind_store()
                    h.finished = True
                    self.agent.last_reply_time = int(time.time())
                    # Commit exactly one terminal item only after durable
                    # completion work succeeds. If that work raises, the
                    # outer error path emits the sole error terminal instead.
                    self._mirror_stream_item(out_q, {"done": content, "source": snap.source})
                    terminal_committed = True
                    bus.publish("chat:done", {
                        "stream_id": h.stream_id,
                        "source": snap.source,
                        "content": content,
                        "logical_id": h.logical_id,
                        "retry_attempt": snap.retry_attempt,
                        "retry_max": snap.retry_max,
                        "retry_of": snap.retry_of,
                        "retry_reason": snap.retry_reason,
                        "session_id": h.session_id,
                        "run_id": h.run_id,
                    })
                    bus.publish("agent:done", {"stream_id": h.stream_id, "len": len(content)})
                    try:
                        handled_recoverable_error = self._maybe_retry_recoverable_error(h, snap, content)
                        if not handled_recoverable_error:
                            self._maybe_auto_continue(h, snap, content)
                    except Exception:
                        # The current turn is already terminal. A retry or
                        # continuation failure must not rewrite that terminal.
                        log.exception("post-terminal continuation failed for %s", h.stream_id)
                    return
        except Exception as e:
            if terminal_committed:
                log.exception("post-terminal fanout failed for %s: %s", h.stream_id, e)
                return
            log.exception("fanout crashed for %s: %s", h.stream_id, e)
            # Keep the cleanup path usable for lightweight/test instances created
            # without __init__; normal service instances always have _lock.
            lock = getattr(self, "_lock", None)
            if lock is None:
                lock = threading.Lock()
                self._lock = lock
            with lock:
                error_content = snap.content + f"\n[stream error: {e}]"
                snap.content = error_content
                snap.done = True
                snap.aborted = True
                snap.finished_at = time.time()
            h.finished = True
            h.final_text = error_content
            self._mirror_stream_item(out_q, {"done": error_content, "source": snap.source})
            bus.publish("chat:done", {
                "stream_id": h.stream_id,
                "source": snap.source,
                "content": error_content,
                "logical_id": h.logical_id,
                "retry_attempt": snap.retry_attempt,
                "retry_max": snap.retry_max,
                "retry_of": snap.retry_of,
                "retry_reason": snap.retry_reason,
                "session_id": h.session_id,
                "run_id": h.run_id,
            })
        finally:
            lock = getattr(self, "_lock", None)
            streams = getattr(self, "_streams", None)
            fanout_threads = getattr(self, "_fanout_threads", None)
            if lock is not None:
                with lock:
                    if streams is not None and streams.get(h.stream_id) is h:
                        streams.pop(h.stream_id, None)
                    if fanout_threads is not None:
                        fanout_threads.discard(threading.current_thread())

    @staticmethod
    def _mirror_stream_item(out_q: "_q.Queue", item: dict) -> None:
        """Keep the mirror bounded while ensuring the newest item is visible."""
        while True:
            try:
                out_q.put_nowait(item)
                return
            except _q.Full:
                try:
                    out_q.get_nowait()
                except _q.Empty:
                    # A concurrent consumer freed the slot between operations.
                    continue

    def _maybe_retry_recoverable_error(self, h: StreamHandle, snap: ChatSnapshot, content: str) -> bool:
        if snap.source not in ("user", "webui", "chat_error_retry", "auto_continue", "scheduled_task", "scheduled", "autonomous", "reflect"):
            return False
        match = classify_recoverable_error(content)
        if match is None:
            return False
        cfg = self._load_chat_retry_config()
        # Scheduled/autonomous chats run unattended and get a deeper budget;
        # the original trigger source rides along on the handle so retries
        # (which re-source as "chat_error_retry") keep that identity.
        origin = h.error_retry_origin or snap.source
        is_scheduled = origin in SCHEDULED_RETRY_SOURCES
        eff_max = cfg.scheduled_max_attempts if is_scheduled else cfg.max_attempts
        if not cfg.enabled or eff_max <= 0:
            return False
        if h.error_retry_count >= eff_max:
            log.info(
                "recoverable chat error retry exhausted for %s (%s/%s, %s)",
                h.stream_id,
                h.error_retry_count,
                eff_max,
                match.label,
            )
            bus.publish("chat:retry_exhausted", {
                "stream_id": h.stream_id,
                "source": snap.source,
                "logical_id": h.logical_id,
                "attempt": h.error_retry_count,
                "max_attempts": eff_max,
                "reason": match.to_dict(),
            })
            return True
        next_count = h.error_retry_count + 1
        prompt = _ERROR_RETRY_PROMPT_TEMPLATE.format(label=match.label)
        delay_seconds = compute_backoff_delay(
            h.error_retry_count, cfg, match.delay_scale, jitter=True, scheduled=is_scheduled
        )
        if delay_seconds > 0:
            # The stream is already terminal here, so the coordinator has
            # released its session slot; waiting on this fanout thread does
            # not hold any admission capacity. Back off before resubmitting
            # so transient upstream failures are spaced out exponentially.
            bus.publish("chat:retry_scheduled", {
                "stream_id": h.stream_id,
                "source": snap.source,
                "logical_id": h.logical_id,
                "attempt": next_count,
                "max_attempts": eff_max,
                "delay_seconds": delay_seconds,
                "reason": match.to_dict(),
            })
            log.info(
                "backing off %.1fs before recoverable chat error retry for %s (%d/%d, %s)",
                delay_seconds,
                h.stream_id,
                next_count,
                eff_max,
                match.label,
            )
            if not self._wait_for_error_retry_slot(h, snap, delay_seconds):
                return False
            if snap.aborted:
                return False
            # Policy may have changed while waiting; honor the freshest one.
            cfg = self._load_chat_retry_config()
            eff_max = cfg.scheduled_max_attempts if is_scheduled else cfg.max_attempts
            if not cfg.enabled or eff_max <= 0:
                return False
            if h.error_retry_count >= eff_max:
                return False
            if not self._error_retry_still_alone(h):
                log.info(
                    "skipping recoverable chat error retry for %s: newer stream active",
                    h.stream_id,
                )
                return False
        log.info(
            "retrying recoverable chat error for %s (%d/%d, %s)",
            h.stream_id,
            next_count,
            eff_max,
            match.label,
        )
        bus.publish("chat:retry", {
            "stream_id": h.stream_id,
            "source": snap.source,
            "logical_id": h.logical_id,
            "attempt": next_count,
            "max_attempts": eff_max,
            "reason": match.to_dict(),
        })
        self.submit(
            prompt,
            source="chat_error_retry",
            logical_id=h.logical_id,
            auto_continue_count=h.auto_continue_count,
            error_retry_count=next_count,
            error_retry_origin=origin,
            retry_of=h.stream_id,
            retry_reason=match.label,
            retry_max=eff_max,
            session_id=h.session_id,
            run_id=h.run_id,
        )
        return True

    def _wait_for_error_retry_slot(self, h: StreamHandle, snap: ChatSnapshot, delay_seconds: float) -> bool:
        """Wait out the error-retry backoff, abortably.

        Returns True once ``delay_seconds`` elapsed; False when the user
        aborted this snapshot or the service fanout is shutting down.
        """
        stop_event = getattr(self, "_fanout_stop_event", None)
        deadline = time.monotonic() + max(0.0, float(delay_seconds))
        while True:
            if getattr(snap, "aborted", False):
                return False
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return True
            step = min(0.25, remaining)
            if stop_event is not None and stop_event.wait(step):
                return False

    def _error_retry_still_alone(self, h: StreamHandle) -> bool:
        """True when no newer live stream took over during the backoff wait."""
        lock = getattr(self, "_lock", None)
        streams = getattr(self, "_streams", None)
        if lock is None or streams is None:
            return True
        with lock:
            for other_id, other in list(streams.items()):
                if other_id == h.stream_id or other is h:
                    continue
                if getattr(other, "finished", True):
                    continue
                other_session = getattr(other, "session_id", None)
                if other_session in (None, h.session_id):
                    return False
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
            session_id=h.session_id,
            run_id=h.run_id,
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
            for snap in self._snapshots.values():
                item = {
                    "stream_id": snap.stream_id,
                    "source": snap.source,
                    "query": snap.query,
                    "content": snap.content,
                    "done": snap.done,
                    "started_at": snap.started_at,
                    "finished_at": snap.finished_at,
                    "logical_id": snap.logical_id,
                    "retry_attempt": snap.retry_attempt,
                    "retry_max": snap.retry_max,
                    "retry_of": snap.retry_of,
                    "retry_reason": snap.retry_reason,
                    "session_id": snap.session_id,
                    "run_id": snap.run_id,
                }
                out.append(item)
        return out

    def active_message_snapshot(
        self, stream_id: str, *, session_id: str, run_id: str
    ) -> dict | None:
        """Copy one stream only when all ownership identities match."""
        with self._lock:
            snap = self._snapshots.get(stream_id)
            if (
                snap is None
                or snap.session_id != session_id
                or snap.run_id != run_id
                or snap.stream_id != stream_id
            ):
                return None
            return {
                "stream_id": snap.stream_id,
                "content": snap.content,
                "done": snap.done,
            }

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
        # Archive-to-chat_history.json disabled: GA-Hub now reads GA's raw
        # session archives (temp/model_responses/*.txt) directly for the
        # "对话管理" view, so writing back to memory/chat_history.json is no
        # longer needed — and writing GA's file would violate the "don't
        # mutate GA" boundary. _archive_snapshots_to_chat_history is kept as
        # dead code for reference but intentionally not called here.
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

        self._legacy_chat_history.append(entry)
        log.info("archived webui conversation %s (%d msgs) to chat_history.json",
                 entry["id"], len(messages))

    def get_history(self) -> list[str]:
        return list(getattr(self.agent, "history", []))

    def _rewind_guard(self):
        """Return the per-runtime lock used by checkpoint sync and rewind."""
        lock = getattr(self, "_rewind_lock", None)
        if lock is None:
            lock = threading.RLock()
            self._rewind_lock = lock
        return lock

    def _rewind(self) -> RewindAdapter:
        adapter = getattr(self, "_rewind_adapter", None)
        if adapter is None:
            adapter = RewindAdapter(
                agent=self.agent,
                session_id=str(getattr(self, "session_id", "") or ""),
                snapshots=self._snapshots,
                lock=getattr(self, "_lock", None) or threading.RLock(),
                checkpoint_lock=getattr(self, "_rewind_lock", None),
                event_bus=bus,
            )
            adapter.store = getattr(self, "_rewind_store", None)
            self._rewind_adapter = adapter
        else:
            adapter.session_id = str(getattr(self, "session_id", "") or "")
            if adapter.store is None:
                adapter.store = getattr(self, "_rewind_store", None)
        return adapter

    def bind_rewind_store(self):
        """Bind a session runtime to GA's durable archive worldline."""
        adapter = self._rewind()
        store = adapter.bind_store()
        self._rewind_store = adapter.store
        return store

    def _sync_rewind_store(self, *, strict: bool = False):
        """Reconcile the complete native archive into the worldline tree."""
        adapter = self._rewind()
        store = adapter.sync_store(strict=strict)
        self._rewind_store = adapter.store
        return store

    def _sync_rewind_working_memory(self, result: dict) -> None:
        """Compatibility facade for the extracted rewind adapter."""
        self._rewind().sync_working_memory(result)

    def _apply_durable_rewind(self, store, n_eff: int) -> dict:
        """Compatibility facade for durable archive rewind."""
        return self._rewind().apply_durable(store, n_eff)

    def _rewind_session_turns(
        self, *, sid: str | None = None, n: int | None = None
    ) -> dict:
        """Durably rewind one Hub session without trusting UI snapshots."""
        return self._rewind().rewind_session_turns(sid=sid, n=n)

    # ── rewind ───────────────────────────────────────────────────
    def rewind_turns(self, *, sid: str | None = None, n: int | None = None) -> dict:
        """Drop the most-recent completed turn(s) from the live LLM history.

        If ``sid`` is given, that turn AND all later turns are removed.
        Else ``n`` last done turns are removed (1 = undo last).

        Mirrors GA TUI ``/rewind`` (frontends/tuiapp.py:_cmd_rewind) but
        operates on GA-Hub's per-stream snapshots so the frontend can sync
        precisely by stream_id. Refuses while the agent is running.
        """
        return self._rewind().rewind_turns(sid=sid, n=n)

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
