"""ConductorService — multi-agent orchestration with supervisor pattern.

GA-Hub product layer for the Conductor: chat admission, request-scoped
workflows, model policies, and the EventBus surface consumed by routes and
the webui. The engine itself now lives in the GA repo's
``frontends/gahub_app.py``; this service talks to it over HTTP (spawned and
supervised by ``conductor_client.GahubProcessManager``) and relays its SSE
event stream onto the EventBus. No GA Python symbols are imported here.

Architecture notes:
- The supervisor's self-API is gahub_app itself; conductor-role chat and
  dispatch/review actions arrive as SSE events mirrored into hub state.
- The workflow tracker, usage store, and model policy validation remain
  hub-owned; gahub_app executes dispatches and auto-yields the supervisor
  turn on dispatch/resume/rework.
"""
from __future__ import annotations

import logging
import threading
import time
import uuid
from collections import OrderedDict
from types import SimpleNamespace
from typing import Any, Dict, Literal, Optional

from .. import _paths

from .conductor_client import GaConductorClient, GahubProcessManager
from .conductor_ext_timeout import TimeoutMonitor
from .conductor_vocabulary import (
    SUBAGENT_RUNNING,
    subagent_stage,
    TERMINAL_WORKFLOW_STATES,
    WORKER_EVENT_PENDING_REVIEW,
    WORKER_EVENT_RUNNING,
)
from .conductor_workflow import WorkflowTracker
from .event_bus import bus
from ..event_topics import (
    CONDUCTOR_CHAT,
    CONDUCTOR_CHAT_READ,
    CONDUCTOR_LOG,
    CONDUCTOR_REQUEST_OUTCOME,
    CONDUCTOR_REQUEST_YIELD_REQUESTED,
    CONDUCTOR_SUBAGENTS,
    CONDUCTOR_WORKFLOW_COMPLETED,
    CONDUCTOR_WORKFLOW_FAILED,
)

log = logging.getLogger(__name__)

SubagentModelPolicy = Literal["follow_main", "default", "locked"]
SUBAGENT_MODEL_POLICIES = frozenset({"follow_main", "default", "locked"})

# Instruction lines the hub appends to subagent action responses; the webui
# renders them as the conductor's acknowledgment.
INSTR_DISPATCHED = (
    "Task received. I'll handle THIS TASK from here. "
    "You MUST to do other task or end your reply."
)
INSTR_KEYINFO = (
    "Received. I'll incorporate this. "
    "You MUST to do other task or end your reply."
)

# Idempotency-cache placeholder: the operation_id is claimed while its engine
# call is in flight, so a concurrent duplicate is refused instead of
# double-fired. Replaced by the recorded response on completion.
_ACTION_OPERATION_IN_FLIGHT = object()

# Verbs served by apply_subagent_action (the single dispatcher behind
# POST /api/conductor/subagent/{sid}).
SUBAGENT_VERBS = frozenset({
    "keyinfo", "accept", "rework", "input", "reply", "append",
    "message", "msg", "abort", "stop",
})

# Dossier fields the hub list snapshot mirrors; the engine detail may omit
# any of them and the mirror fills in what it has.
SUBAGENT_MIRROR_FIELDS = (
    "prompt", "created_at", "updated_at", "review_note",
    "completed_at", "accepted_at", "deliverables_missing",
    "deliverables_stale", "done_marker", "quality_checks",
    "manifest", "forced_accept", "force_reason", "forced_at",
    "plan_milestones",
)


def _get_preferred_llm() -> Optional[int]:
    """Read user's preferred LLM index from config."""
    try:
        cfg = _paths.load_config()
        preferred = cfg.get("preferred_llm_no")
        if preferred is not None:
            return int(preferred)
    except Exception as e:
        log.debug("Failed to read preferred_llm_no: %s", e)
    return None


def now_ms() -> int:
    return int(time.time() * 1000)


def short_id() -> str:
    return uuid.uuid4().hex[:8]


def add_chat(
    msg: str,
    role: str,
    chat_messages: list,
    request_id: str | None = None,
    kind: str | None = None,
    item_id: str | None = None,
) -> dict:
    """Add message to the local mirror. Returns the stored item.

    Callers publish the ``conductor:chat`` bus event themselves: the engine
    id is the authoritative identity (D4), so a relayed message is mirrored
    under its engine id and only published once that id is known.
    """
    item = {
        "id": item_id or short_id(),
        "role": role,
        "msg": msg,
        "ts": now_ms(),
        "read": role != "user",
        "final": kind == "final",
    }
    if request_id:
        item["request_id"] = request_id
    if kind:
        item["kind"] = kind
    chat_messages.append(item)
    if len(chat_messages) > 200:
        del chat_messages[:-200]
    return item


def push_subagent_cards(snapshot: list):
    """Publish subagent pool snapshot to event bus."""
    bus.publish(CONDUCTOR_SUBAGENTS, {"items": snapshot})


def _event_name(event: Any) -> str:
    """Coerce a subagent event (enum or SSE string) to its stable value."""
    return getattr(event, "value", None) or str(event)


READMES = {
    "api": """Conductor API (integrated into GA-Hub)

POST /api/conductor/chat
  用户提交任务的唯一页面入口: {"msg": "...", "role": "user", "llm_index": 1,
         "subagent_llm_index": 5, "subagent_model_policy": "default"}
  Conductor 写入计划: {"msg": "...", "role": "conductor", "request_id": "..."}
  Conductor 最终报告: {"msg": "...", "role": "conductor", "request_id": "...", "final": true}
  role=user 会创建新的用户任务并唤醒 Conductor；Supervisor 自己写消息时
  必须使用 role=conductor，不能把计划或报告作为用户任务重新入队。
  Supervisor 始终沿用所选 LLM 条目的 mykey 配置（包括 reasoning_effort）。

POST /api/conductor/subagent   (supervisor 专用；页面不做手动派单)
  body: {"prompt": "...", "request_id": "...", "llm_index": 3}
  启动一个子代理；llm_index 是 Conductor 对本次派单的显式模型请求。
  解析优先级：页面锁定 > 本次显式请求 > 默认子代理模型 > 主模型 > 全局首选。
  派单必须携带完整任务清单（goal / deliverables / done_when），这是
  Conductor 对用户任务的改写产物；页面与外部脚本不经 Conductor 直接派单
  会被引擎以 422 拒绝。prompt 是 UTF-8 JSON 文本；必须原样保留中文、emoji
  和路径。调用本机 API 时直接使用 requests 的 json= 参数，不要让任务文字
  经过 shell 代码页转换。

模型策略：
  follow_main  未显式指定时跟随 Conductor 主模型。
  default      未显式指定时用页面默认模型；允许本次派单覆盖。
  locked       始终使用页面锁定模型；忽略本次派单的其他模型。

POST /api/conductor/subagent/{id}  body: {"action": "keyinfo", "msg": "..."}
POST /api/conductor/subagent/{id}  body: {"action": "input", "msg": "...", "llm_index": 3}
POST /api/conductor/subagent/{id}  body: {"action": "accept", "request_id": "..."}
POST /api/conductor/subagent/{id}  body: {"action": "rework", "msg": "...", "request_id": "..."}
POST /api/conductor/subagent/{id}  body: {"action": "stop"}
GET  /api/conductor/chat?last=N
GET  /api/conductor/subagent
GET  /api/conductor/subagent/{id}?max_len=N
""",
    "usermsg": """用户消息流程：
1. 结合记忆、上下文和用户偏好判断真实需求；不清楚时用精简checklist一次性问用户。
2. 判断是新任务还是延续现有任务；优先复用已有stopped subagent（用input追加）。
3. 从 wake_events 读取 request_id；计划、派发、验收/返工和最终报告必须原样回传。
4. 分派前必须POST /api/conductor/chat并使用 role=conductor 告知用户：改写后的prompt + 分派方案。
5. 派发后立即结束本轮；不要轮询运行中的子代理，完成事件会自动唤醒你。
6. 派发时可用 llm_index 指定本次子代理模型；locked 策略下页面锁定值优先。
7. 危险操作必须改成先让subagent出方案；验收后请用户确认。""",
    "subagent": """subagent完成流程：
1. 读subagent输出；若最后一条不足以判断，GET /api/conductor/subagent/{id}?max_len=3000 补足信息。
2. 不满意时调用 rework 并立即结束本轮，等待下一次完成事件；不要轮询。
3. 满意时必须先调用 accept。所有关联子代理 accepted 后，再用 role=conductor 提交 final=true 的简洁交付报告。
4. accept/rework/final 均必须携带完成事件中的 request_id。""",
}


# ===== SSE-fed mirror of the GA-side subagent pool ======================

class _MirrorState:
    """Attribute-access view over one snapshot item (SubAgentState-shaped)."""

    def __init__(self, data: dict):
        self.__dict__.update(data)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"_MirrorState({self.__dict__!r})"


class PoolMirror:
    """Snapshot-fed stand-in for the in-process subagent pool.

    Provides the attribute surface the routes and TimeoutMonitor used on
    the GA core pool (``lock``/``subagents``/``counts``/``get``/``snapshot``);
    keyinfo/abort actions round-trip to gahub_app over HTTP.
    """

    def __init__(self, client: GaConductorClient):
        self.client = client
        self.lock = threading.Lock()
        self.subagents: Dict[str, _MirrorState] = {}
        self._items: list[dict] = []

    def update(self, items: list) -> None:
        with self.lock:
            self._items = [dict(item) for item in items if isinstance(item, dict)]
            self.subagents = {
                item["id"]: _MirrorState(item)
                for item in self._items if item.get("id")
            }

    def counts(self) -> tuple[int, int]:
        with self.lock:
            items = list(self._items)
        running = sum(1 for item in items if item.get("status") == SUBAGENT_RUNNING)
        return running, max(0, len(items) - running)

    def get(self, sid: str) -> Optional[_MirrorState]:
        with self.lock:
            return self.subagents.get(sid)

    # Core fields the response model backfills with compat defaults.  A
    # missing entry means the engine snapshot drifted from the Contract B
    # shape: tolerable for one render (the UI must not crash), but it must
    # be visible in the hub log instead of silently showing blanks.
    _REQUIRED_SNAPSHOT_FIELDS = ("prompt", "created_at", "updated_at")

    def snapshot(self) -> list[dict]:
        with self.lock:
            items = [dict(item) for item in self._items]
        for item in items:
            missing = [field for field in self._REQUIRED_SNAPSHOT_FIELDS
                       if item.get(field) in (None, "")]
            if missing:
                log.warning(
                    "subagent snapshot %s missing %s; response backfills "
                    "compat defaults (engine protocol drift?)",
                    item.get("id") or "<unknown>", ", ".join(missing))
            # UI stage decided hub-side (vocabulary); the page only renders it.
            item["stage"] = subagent_stage(
                status=str(item.get("status") or ""),
                attempt=int(item.get("attempt") or 1),
                review_status=str(item.get("review_status") or ""),
            )
        return items

    def keyinfo_subagent(self, sid: str, msg: str,
                         request_id: Optional[str] = None) -> dict:
        # request_id, when resolved by the caller (workflow tracker), lets the
        # engine enforce worker ownership on every verb, not just accept/rework.
        return self.client.subagent_action(sid, "keyinfo", msg,
                                           request_id=request_id)

    def abort_subagent(self, sid: str,
                       request_id: Optional[str] = None) -> dict:
        # Hub-originated (user/UI) cancel: stamped so the engine records a
        # terminal CANCELLED; supervisor self-API aborts stay recoverable.
        return self.client.subagent_action(sid, "abort", origin="hub",
                                           request_id=request_id)


class HubConductorCallbacks:
    """Translate gahub_app SSE lifecycle events into GA-Hub EventBus events.

    Method shapes intentionally mirror the former in-process callbacks so
    focused tests can drive them directly; outcomes are namespace objects
    with ``status``/``phase``/``error`` attributes.
    """

    def __init__(self, service: "ConductorService"):
        self.service = service
        self._snapshot_publish_lock = threading.Lock()
        self._last_subagent_snapshot: list | None = None

    def publish_subagent_snapshot(self) -> None:
        """Publish changed pool state without allowing concurrent reordering."""
        with self._snapshot_publish_lock:
            try:
                snapshot = self.service.get_subagent_snapshot()
                if snapshot == self._last_subagent_snapshot:
                    return
                push_subagent_cards(snapshot)
                # Keep the old value when publishing fails so a later event retries.
                self._last_subagent_snapshot = snapshot
            except Exception:
                # Observer failures must not change an already committed pool action.
                log.exception("conductor_subagent_snapshot_publish_failed")

    # request lifecycle ------------------------------------------------------
    def _publish_request_outcome(
        self,
        request_id: str,
        *,
        status: str,
        phase: str,
        error: str = "",
    ) -> None:
        payload = {
            "request_id": request_id,
            "status": status,
            "phase": phase,
        }
        if error:
            payload["error"] = error
        # Scanning a list that writers truncate (>200) under _chat_lock:
        # an unlocked reversed() iteration can hit the resize and IndexError.
        with self.service._chat_lock:
            latest = next(
                (
                    item
                    for item in reversed(self.service.chat_messages)
                    if item.get("role") == "conductor"
                    and item.get("request_id") == request_id
                    and item.get("kind") == ("final" if status == "ok" else "error")
                ),
                None,
            )
        if latest is not None:
            payload["item"] = latest
        bus.publish(CONDUCTOR_REQUEST_OUTCOME, payload)

    def on_conductor_request_finished(self, request_id: str) -> None:
        try:
            self._fail_unhandled_request(request_id)
            self._publish_request_outcome(
                request_id,
                status="ok",
                phase="finish",
            )
        except Exception:
            log.exception("request finished handling failed")

    def _fail_unhandled_request(self, request_id: str) -> None:
        """Close the false-success window for requests the turn never touched.

        The engine reports ``ok`` when a supervisor turn ends naturally, even
        when one request of a coalesced batch was never dispatched and never
        answered — left alone, that request strands in ``admitted`` forever
        while the UI shows a successful turn. If nothing trackable happened
        (no worker, no conductor chat, no final), record a visible workflow
        failure instead of an implicit success.
        """
        if not request_id:
            return
        tracker = self.service.workflow_tracker
        snapshot = tracker.snapshot(request_id)
        if snapshot is None or snapshot.get("status") in TERMINAL_WORKFLOW_STATES:
            return
        if snapshot.get("subagents") or snapshot.get("item"):
            return
        with self.service._chat_lock:
            answered = any(
                item.get("role") == "conductor"
                and item.get("request_id") == request_id
                for item in self.service.chat_messages
            )
        if answered:
            return
        transition = tracker.fail_supervisor(
            request_id,
            phase="finish",
            error="supervisor turn finished without dispatching a worker "
                  "or answering this request",
        )
        if transition is not None:
            self.service._publish_workflow_transition(transition)

    def on_conductor_request_yielded(self, request_id: str,
                                     outcome=None) -> None:
        """Close only this supervisor turn; the workflow remains active."""
        try:
            self._publish_request_outcome(
                request_id,
                status="yielded",
                phase=getattr(outcome, "phase", "yield") or "yield",
            )
        except Exception:
            log.exception("request yielded handling failed")

    def on_conductor_request_outcome(self, request_id: str,
                                     outcome=None) -> None:
        status = getattr(outcome, "status", "failed") or "failed"
        phase = getattr(outcome, "phase", "finish") or "finish"
        error = getattr(outcome, "error", "") or ""
        try:
            if status != "ok":
                tracker = self.service.workflow_tracker
                transition = tracker.fail_supervisor(
                    request_id,
                    phase=phase,
                    error=error,
                )
                if transition is not None:
                    self.service._publish_workflow_transition(transition)
            self._publish_request_outcome(
                request_id, status=status, phase=phase, error=error
            )
        except Exception:
            log.exception("request outcome handling failed")

    # subagent lifecycle ------------------------------------------------------
    def on_subagent_event(self, agent_id: str, event, payload) -> None:
        name = _event_name(event)
        if name == WORKER_EVENT_RUNNING:
            return
        if not isinstance(payload, dict):
            payload = dict(getattr(payload, "__dict__", {}) or {})
        service = self.service
        tracker = service.workflow_tracker
        state = service.pool.get(agent_id)
        if state is not None and "generation" not in payload:
            payload["generation"] = int(getattr(state, "active_generation", 0) or 0)
        if not payload.get("request_id"):
            request_id = tracker.request_for_subagent(agent_id)
            if request_id:
                payload["request_id"] = request_id
        owner, transition = tracker.record_subagent_event(
            agent_id,
            name,
            generation=int(payload.get("generation", 0) or 0),
            request_id=payload.get("request_id"),
        )
        try:
            bus.publish(f"conductor:subagent_{name}", {"id": agent_id, **payload})
            if transition is not None:
                service._publish_workflow_transition(transition)
        except Exception:
            # Observer failures must not block the authoritative snapshot push.
            log.exception("subagent event publish failed for %s", name)
        if name == WORKER_EVENT_PENDING_REVIEW:
            self._maybe_auto_accept(agent_id, payload)
        self.publish_subagent_snapshot()

    def _maybe_auto_accept(self, agent_id: str, payload: dict) -> None:
        """Accept a clean delivery automatically; escalate only problems.

        The engine stays the single verification authority: an accept without
        ``force`` succeeds only when its deterministic checks pass, so a
        ``completion_unverified`` rejection simply leaves the worker pending
        for a human verdict. Runs off the SSE reader thread so a slow accept
        never delays lifecycle event processing.
        """
        service = self.service
        if not service.auto_accept:
            return
        request_id = payload.get("request_id")
        if not request_id:
            return

        def _accept() -> None:
            try:
                state = service.pool.get(agent_id)
                stale = list(getattr(state, "deliverables_stale", None) or [])
                missing = list(getattr(state, "deliverables_missing", None) or [])
            except Exception:
                log.exception("auto-accept staleness lookup failed for %s", agent_id)
                return
            if stale or missing:
                # Never auto-accept on the strength of deliverables that did
                # not come from this attempt: path_exists/file_contains pass
                # for any pre-existing file (live 2026-09-05 case — a 9-day-
                # old pelican SVG from an earlier test satisfied both checks
                # and got "accepted" after a timeout rework). Leave the worker
                # pending for a human; force-accept stays the escape hatch.
                log.warning(
                    "auto-accept withheld for %s: deliverables not produced "
                    "by this attempt (stale=%s missing=%s)",
                    agent_id, stale, missing,
                )
                return
            try:
                result = service.accept_subagent(
                    agent_id,
                    "自动验收：机器检查全部通过。",
                    request_id=request_id,
                )
            except Exception:
                # The worker stays pending; the reviewer sees it as before.
                log.exception("auto-accept failed for %s", agent_id)
                return
            if isinstance(result, dict) and result.get("error"):
                log.info(
                    "auto-accept left %s for human review: %s",
                    agent_id, result.get("error"),
                )

        thread = threading.Thread(
            target=_accept,
            daemon=True,
            name=f"conductor-auto-accept-{agent_id[:8]}",
        )
        # Registered so shutdown can wait them out instead of letting them
        # race a closing engine client with unattributable exceptions.
        self.service._auto_accept_threads.add(thread)
        thread.start()

    def on_conductor_log_frame(self, frame: object) -> None:
        """Bridge gahub_app log frames to the Hub event bus.

        Accepts either the SSE item directly or the legacy ``{"type": "log",
        "item": ...}`` frame shape; items must keep the stable field types.
        """
        try:
            if isinstance(frame, dict) and frame.get("type") == "log":
                frame = frame.get("item")
            if not isinstance(frame, dict):
                return
            if not (
                isinstance(frame.get("id"), str)
                and isinstance(frame.get("ts"), int)
                and isinstance(frame.get("event"), str)
                and isinstance(frame.get("text"), str)
                and (frame.get("turn") is None or isinstance(frame.get("turn"), int))
            ):
                return
            bus.publish(CONDUCTOR_LOG, {"item": dict(frame)})
        except Exception:
            # Logging is an observer path and must not fail a conductor request.
            log.exception("conductor_log_frame_publish_failed")

    def on_conductor_event(self, event_type: str, payload) -> None:
        try:
            payload = dict(payload or {})
            if event_type == "error":
                detail = str(payload.get("error", "")).strip()
                if not detail:
                    return
                # The relay thread lands here while route threads append via
                # add_chat_message — read+append under the same chat lock
                # those writers hold.
                with self.service._chat_lock:
                    latest = next(
                        (
                            item
                            for item in reversed(self.service.chat_messages)
                            if item.get("kind") == "error"
                        ),
                        None,
                    )
                    added = None
                    if latest is None or detail not in latest.get("msg", ""):
                        added = add_chat(
                            f"Conductor reply failed: {detail}",
                            "error",
                            self.service.chat_messages,
                            kind="error",
                        )
                if added is not None:
                    bus.publish(CONDUCTOR_CHAT, {"item": added})
                    latest = added
                payload = {**payload, "item": latest}
            bus.publish(f"conductor:{event_type}", payload)
        except Exception:
            log.exception("conductor event handling failed")


class ConductorNotRunning(RuntimeError):
    """A subagent operation needs a LIVE supervisor and none is running.

    Chat admission is the only cold-start entry (it re-adopts stranded
    work); dispatch/input/accept/rework refuse loudly instead, so a stopped
    conductor can never spawn supervisor-less orphan workers (2026-09
    audit P1: unified lifecycle admission)."""


class ConductorService:
    """Singleton GA-Hub product layer around the gahub_app engine."""
    _instance: Optional["ConductorService"] = None
    _lock = threading.Lock()
    # Journal catch-up page size; the engine clamps /journal at 5000.
    _JOURNAL_REPLAY_BATCH = 5000
    # Hub-side operation replay for worker actions: the engine's operation
    # cache covers chat/dispatch only, so accept/rework/input retries are
    # deduplicated here (a replayed action must not wake the worker twice).
    _ACTION_OPERATION_CACHE_SIZE = 512

    def __init__(self):
        self._init_fields()
        self.timeout_monitor.start()

    @classmethod
    def for_tests(cls) -> "ConductorService":
        """Fully initialized instance without threads or engine side effects.

        The unit-test constructor that replaces ``object.__new__`` plus the
        old ``_ensure_*`` backfills: every production field exists, and
        nothing runs.
        """
        obj = cls.__new__(cls)
        obj._init_fields()
        return obj

    def _init_fields(self) -> None:
        # Application shutdown is a terminal lifecycle separate from the
        # user-facing ``stop`` route.  Keep the singleton alive while a close
        # is in progress (or after a timeout) so a late request cannot create
        # a second engine/session pair beside the one still being reaped.
        self._shutdown_lock = threading.RLock()
        self._shutdown_in_progress = False
        self._shutdown_complete = False
        self._shutdown_event = threading.Event()
        self._shutdown_event.set()
        self._shutdown_core_stopped = False
        self._shutdown_monitor_stopped = False
        self._closed = False
        self.chat_messages: list = []
        self._chat_lock = threading.RLock()
        self.workflow_tracker = WorkflowTracker()
        self._dispatch_context = threading.local()
        self._started = False
        self._conductor_llm_index = None
        self._subagent_llm_index = None
        self._subagent_model_policy: SubagentModelPolicy = "follow_main"
        # Automation-first review policy (user decision 2026-09): clean
        # deliveries are accepted automatically and only real problems
        # (verification not clean) wait for a human verdict.
        self._auto_accept = True
        self._model_lock = threading.RLock()
        self.callbacks = HubConductorCallbacks(self)
        self._process_manager = GahubProcessManager()
        self.client = GaConductorClient(self._process_manager)
        self.pool = PoolMirror(self.client)
        self.timeout_monitor = TimeoutMonitor(self.pool, publish=bus.publish)
        self._relay_stop = threading.Event()
        self._relay_thread: Optional[threading.Thread] = None
        # Serializes the engine cold start: two concurrent admissions must
        # not both observe "not started" and both re-relay the stranded set
        # (each redispatch carries a fresh operation_id, so only this lock
        # can keep the double relay from reaching the engine).
        self._cold_start_lock = threading.Lock()
        # Serializes relay startup: chat admission and subagent verbs race
        # here on cold start, and two relays double-process every event.
        self._relay_lock = threading.Lock()
        self._auto_accept_threads: set[threading.Thread] = set()
        self._relayed_chat_ids: set[str] = set()
        self._relayed_ids_lock = threading.Lock()
        self._lifecycle_cache: dict = {}
        # Journal replay cursor (P2-A reconcile): seq of the last journal
        # event this relay processed.  ``seq=None`` means "never connected" —
        # the first connect baselines to the engine's current last_seq
        # instead of replaying the whole history (hello already re-syncs
        # state; replaying full history through the transition handlers
        # could only manufacture spurious transitions).
        self._journal_cursor: dict = {"seq": None, "epoch": None}
        # Idempotency cache for retried worker actions (operation_id →
        # recorded response); bounded, oldest entries evicted first.
        self._action_operation_lock = threading.Lock()
        self._action_operations: OrderedDict[str, dict] = OrderedDict()


    @classmethod
    def instance(cls) -> "ConductorService":
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    @property
    def auto_accept(self) -> bool:
        """Whether clean worker deliveries are accepted without a human."""
        return bool(self._auto_accept)

    @auto_accept.setter
    def auto_accept(self, value: bool) -> None:
        self._auto_accept = bool(value)

    def shutdown(self, timeout: float = 2.0) -> bool:
        """Terminally close the engine session and monitor under one deadline."""
        self._relay_stop.set()
        deadline = time.monotonic() + max(0.0, float(timeout))

        with self._shutdown_lock:
            if self._shutdown_complete:
                return True
            if self._shutdown_in_progress:
                event = self._shutdown_event
                remaining = max(0.0, deadline - time.monotonic())
                owner = False
            else:
                self._shutdown_in_progress = True
                self._closed = True
                event = threading.Event()
                self._shutdown_event = event
                owner = True

        if not owner:
            event.wait(max(0.0, remaining))
            with self._shutdown_lock:
                return bool(self._shutdown_complete)

        core_ok = self._shutdown_core_stopped
        monitor_ok = self._shutdown_monitor_stopped
        try:
            if not core_ok:
                try:
                    result = self.client.stop(
                        timeout=min(
                            float(timeout),
                            max(0.0, deadline - time.monotonic()),
                        )
                    )
                    core_ok = bool(result.get("stopped", True)) if result else True
                except Exception:
                    core_ok = False
                    log.exception("gahub_app engine shutdown failed")
                finally:
                    try:
                        self._process_manager.stop(timeout=2.0)
                    except Exception:
                        log.exception("gahub_app process stop failed")
                self._shutdown_core_stopped = core_ok

            # Always attempt the monitor, even when the engine raised or used
            # up the whole deadline; one atomic time envelope for both.
            monitor = self.timeout_monitor
            if not monitor_ok:
                try:
                    # ``is not False`` keeps dict/None stub returns truthy the
                    # way the old best-effort helper did.
                    monitor_ok = monitor.stop(
                        timeout=min(
                            float(timeout),
                            max(0.0, deadline - time.monotonic()),
                        )
                    ) is not False
                except Exception:
                    monitor_ok = False
                    log.exception("conductor timeout monitor shutdown failed")
                self._shutdown_monitor_stopped = monitor_ok

            # Background helpers must not outlive the closing engine client:
            # the relay would keep publishing into a retired loop, and
            # auto-accept threads would race _assert_open with noise.
            helpers: list[threading.Thread] = []
            if self._relay_thread is not None:
                helpers.append(self._relay_thread)
            helpers.extend(list(self._auto_accept_threads))
            for helper in helpers:
                if helper.is_alive():
                    helper.join(timeout=max(0.0, deadline - time.monotonic()))
        finally:
            with self._shutdown_lock:
                self._shutdown_core_stopped = bool(core_ok)
                self._shutdown_monitor_stopped = bool(monitor_ok)
                complete = bool(core_ok and monitor_ok)
                self._shutdown_complete = complete
                self._shutdown_in_progress = False
                event.set()

        # Every shutdown path is terminal (`_assert_open` refuses all later
        # calls), so keeping the class singleton would poison the next app
        # lifecycle with a closed instance. Release it like AgentService does.
        if type(self)._instance is self:
            type(self)._instance = None

        if not complete:
            log.warning(
                "Conductor shutdown did not finish before deadline "
                "(core=%s monitor=%s)",
                core_ok,
                monitor_ok,
            )
        return complete

    def _assert_open(self) -> None:
        with self._shutdown_lock:
            if self._closed:
                raise RuntimeError("Conductor service is closed")

    def _assert_engine_ready(self) -> None:
        """Subagent operations require a running supervisor — refuse loudly.

        Mirrors ``ensure_started`` at the process level (engine respawn +
        relay), but unlike chat admission it never cold-starts the
        supervisor: a stopped conductor must not gain workers it cannot
        supervise (2026-09 audit P1)."""
        self._assert_open()
        manager = self._process_manager
        if manager is not None:
            try:
                manager.ensure_running()
            except Exception as exc:
                raise RuntimeError(
                    rf"gahub_app unavailable (see %TEMP%\gahub_app.log): {exc}"
                ) from exc
        status = self.client.status()
        if not status.get("started"):
            # Refuse BEFORE _ensure_relay: the relay thread spawns gahub_app
            # asynchronously, so starting it for a refused operation would
            # cold-start the very supervisor this path must never start.
            raise ConductorNotRunning(
                "conductor is not running; send a chat message or press "
                "start before subagent operations")
        self._ensure_relay()

    def _publish_workflow_transition(
        self, transition: tuple[str, dict]
    ) -> None:
        """Publish one terminal workflow event and its visible failure report."""
        topic, payload = transition
        request_id = payload["request_id"]
        if topic == CONDUCTOR_WORKFLOW_FAILED:
            item = self._record_workflow_failure_message(
                request_id,
                phase=str(payload.get("phase") or "subagent"),
                error=str(payload.get("error") or ""),
            )
            payload.setdefault("item", item)
        bus.publish(topic, payload)

    def _record_workflow_failure_message(
        self, request_id: str, *, phase: str, error: str
    ) -> dict:
        """Persist one visible failure report per request, even across retries."""
        with self._chat_lock:
            existing = next(
                (
                    item
                    for item in reversed(self.chat_messages)
                    if item.get("request_id") == request_id
                    and item.get("kind") == "error"
                ),
                None,
            )
            if existing is not None:
                return existing
            detail = error.strip() or "unknown error"
            item = add_chat(
                f"Conductor workflow failed during {phase}: {detail}",
                "conductor",
                self.chat_messages,
                request_id=request_id,
                kind="error",
            )
            bus.publish(CONDUCTOR_CHAT, {"item": item})
            return item

    @staticmethod
    def _normalize_model_index(value: Optional[int], label: str) -> Optional[int]:
        if value is None:
            return None
        try:
            selected = int(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{label} must be an integer") from exc
        if selected < 0:
            raise ValueError(f"{label} must be non-negative")
        return selected

    def configure_models(
        self,
        llm_index: Optional[int] = None,
        subagent_llm_index: Optional[int] = None,
        subagent_model_policy: Optional[SubagentModelPolicy] = None,
    ) -> dict:
        """Update model routing without changing the conductor lifecycle.

        Omitted fields preserve the current configuration. Explicit
        ``follow_main`` clears the default worker model. Supplying a worker
        model without a policy keeps backward compatibility by establishing a
        default-model policy when the service was still following the main
        model. The committed snapshot is best-effort pushed to gahub_app so
        its dispatch resolution and supervisor model stay in sync.
        """
        main_index = self._normalize_model_index(llm_index, "llm_index")
        worker_index = self._normalize_model_index(
            subagent_llm_index, "subagent_llm_index"
        )
        if (
            subagent_model_policy is not None
            and subagent_model_policy not in SUBAGENT_MODEL_POLICIES
        ):
            raise ValueError(
                "subagent_model_policy must be follow_main, default, or locked"
            )
        with self._model_lock:
            next_main = (
                main_index if main_index is not None else self._conductor_llm_index
            )
            next_worker = self._subagent_llm_index
            next_policy: SubagentModelPolicy = self._subagent_model_policy

            if worker_index is not None:
                next_worker = worker_index
                if subagent_model_policy is None and next_policy == "follow_main":
                    next_policy = "default"
            if subagent_model_policy is not None:
                next_policy = subagent_model_policy
                if next_policy == "follow_main":
                    next_worker = None

            if next_policy in ("default", "locked") and next_worker is None:
                raise ValueError(
                    f"subagent_llm_index is required for {next_policy} policy"
                )

            self._conductor_llm_index = next_main
            self._subagent_llm_index = next_worker
            self._subagent_model_policy = next_policy
            snapshot = self.model_policy_snapshot()

        self._push_models_to_engine(snapshot)
        return snapshot

    def _push_models_to_engine(self, snapshot: Optional[dict] = None) -> None:
        """Best-effort sync of the policy snapshot to gahub_app."""
        client = self.client
        snapshot = snapshot or self.model_policy_snapshot()
        # follow_main clears the local default worker model; the engine needs
        # the explicit clear signal or its "null = keep" semantics leave the
        # previous value as a residual that resurfaces under "default".
        clear_worker = (
            snapshot["subagent_model_policy"] == "follow_main"
            and snapshot["subagent_llm_index"] is None
        )
        try:
            client.push_models(
                conductor_llm_index=snapshot["llm_index"],
                subagent_llm_index=snapshot["subagent_llm_index"],
                subagent_model_policy=snapshot["subagent_model_policy"],
                preferred_llm_index=_get_preferred_llm(),
                clear_subagent_llm=clear_worker,
            )
        except Exception as exc:
            log.debug("Model policy push to gahub_app deferred: %s", exc)

    def model_policy_snapshot(self) -> dict:
        with self._model_lock:
            return {
                "llm_index": self._conductor_llm_index,
                "subagent_llm_index": self._subagent_llm_index,
                "subagent_model_policy": self._subagent_model_policy,
            }

    def _resolve_subagent_model_from_snapshot(
        self,
        requested_llm_index: Optional[int],
        models: dict,
    ) -> Optional[int]:
        """Resolve against one immutable configuration snapshot."""
        requested = self._normalize_model_index(
            requested_llm_index, "requested llm_index"
        )
        policy = models["subagent_model_policy"]
        default_index = models["subagent_llm_index"]
        main_index = models["llm_index"]

        if policy == "locked" and default_index is not None:
            return default_index
        if requested is not None:
            return requested
        if policy == "default" and default_index is not None:
            return default_index
        if main_index is not None:
            return main_index
        return _get_preferred_llm()

    # ===== engine session (gahub_app over HTTP) =====

    def _ensure_relay(self) -> None:
        # Check-then-start must be atomic: ensure_started (chat admission)
        # and _assert_engine_ready (subagent verbs) race here on cold start,
        # and a second relay thread would double-process every SSE event.
        with self._relay_lock:
            thread = self._relay_thread
            if thread is not None and thread.is_alive():
                return
            self._relay_stop.clear()
            self._relay_thread = threading.Thread(
                target=self.client.stream_events,
                args=(self._on_sse_event, self._relay_stop.is_set),
                # P2-A reconcile: replay missed journal events after every
                # (re)connect, before any live frame is read.
                kwargs={"on_reconnect": self._replay_journal},
                name="conductor-sse-relay",
                daemon=True,
            )
            self._relay_thread.start()

    def ensure_started(self, exclude_request_id: str | None = None) -> bool:
        with self._shutdown_lock:
            if self._closed:
                raise RuntimeError("Conductor service is closed")
        # The SSE relay spawns gahub_app asynchronously; a first message raced
        # that cold start and failed on connection refused. Wait for the
        # process here (idempotent, shared lock with the relay's spawn).
        manager = self._process_manager
        if manager is not None:
            try:
                manager.ensure_running()
            except Exception as exc:
                raise RuntimeError(
                    rf"gahub_app unavailable (see %TEMP%\gahub_app.log): {exc}"
                ) from exc
        self._ensure_relay()
        status = self.client.status()
        if not status.get("started"):
            # Re-check under the cold-start lock: a concurrent admission may
            # have finished the start + redispatch between our status check
            # and this line, and a second start would re-relay the stranded
            # set twice (fresh operation_id each time — no engine dedupe).
            with self._cold_start_lock:
                status = self.client.status()
                if not status.get("started"):
                    self.client.start(llm_index=self._conductor_llm_index)
                    # /start restores only the conductor model; re-push the
                    # full hub-owned snapshot so the subagent policy survives
                    # the engine restart instead of silently resetting to
                    # follow_main.
                    self._push_models_to_engine()
                    # Fresh conductor: nothing is in flight on the engine, so
                    # stranded requests can be re-relayed without
                    # double-processing. On an already-running conductor this
                    # must NOT run — an admitted workflow may be mid-turn
                    # right now. The caller may also exclude the request it
                    # just admitted (it is about to notify the engine itself);
                    # re-relaying it here duplicated the message.
                    self._redispatch_stranded_workflows(
                        exclude_request_id=exclude_request_id)
        self.lifecycle_status()
        return True

    def _redispatch_stranded_workflows(
            self, exclude_request_id: str | None = None) -> None:
        """Re-relay stranded ``admitted`` workflows after a (re)start.

        Stop-drain semantics discard engine-queued user messages without
        touching the already-admitted workflow, so a message that only sat in
        the engine inbox (or whose dispatch 422'd) used to strand forever:
        nothing was supervising and nothing ever would. Re-relaying the
        original user message wakes the supervisor to act on the same
        request_id; the engine has no duplicate guard on the request id, and
        the workflow simply gains workers when the relay lands. Failures are
        logged, never raised — a resume must not break because one stranded
        request cannot be relayed.
        """
        tracker = self.workflow_tracker
        stranded = [
            workflow
            for workflow in tracker.stranded_admitted()
            if workflow["request_id"] != exclude_request_id
        ]
        if not stranded:
            return
        for workflow in stranded:
            request_id = workflow["request_id"]
            original = self._original_user_message(request_id)
            if original is None:
                log.warning(
                    "stranded workflow %s has no original user message; "
                    "leaving it admitted", request_id[:8],
                )
                continue
            try:
                item = self.notify({
                    "type": "user_message",
                    "msg": original,
                    "request_id": request_id,
                })
                if item is None:
                    raise RuntimeError("engine refused redispatch (stopping?)")
            except Exception:
                log.exception(
                    "redispatch of stranded workflow %s failed", request_id[:8],
                )
                continue
            log.info(
                "redispatched stranded workflow %s after conductor (re)start",
                request_id[:8],
            )

    def _original_user_message(self, request_id: str) -> Optional[str]:
        """Latest user message for a request, from engine or local history."""
        try:
            items = self.client.get_chat(last=200)
        except Exception:
            items = []
        for item in reversed(items or []):
            if (item.get("role") == "user"
                    and item.get("request_id") == request_id):
                return item.get("msg", "")
        for item in reversed(self.chat_messages):
            if (item.get("role") == "user"
                    and item.get("request_id") == request_id):
                return item.get("msg", "")
        return None

    def stop(self, timeout: float = 5.0) -> bool:
        try:
            result = self.client.stop(timeout=timeout)
            stopped = bool(result.get("stopped"))
        except Exception:
            log.exception("gahub_app stop failed")
            stopped = False
        if stopped:
            # Manual stop = the user gave up on the in-flight work (2026-09
            # audit, user-confirmed policy). Stranded admitted workflows must
            # NOT be re-relayed by the next cold start: a task abandoned via
            # stop stays abandoned. Crash restarts (no manual stop) keep the
            # redispatch safety net. Only workerless "admitted" workflows are
            # swept here — running workers already got terminal CANCELLED
            # events from the engine stop sweep.
            tracker = self.workflow_tracker
            for topic, payload in tracker.abandon_stranded(
                    reason="conductor stopped by user"):
                self._publish_workflow_transition((topic, payload))
        self.lifecycle_status()
        return stopped

    def lifecycle_status(self) -> dict:
        try:
            status = self.client.status()
        except Exception:
            # A stale started=True cache is actively misleading: the engine
            # may have exited after the last successful probe. Report a
            # degraded, stopped state so the UI exposes recovery controls.
            status = dict(self._lifecycle_cache or {})
            status["started"] = False
            status.setdefault("stopping", False)
            status.setdefault("admission_open", True)
            status.setdefault("loop_alive", False)
            status.setdefault("agent_alive", False)
        self._started = bool(status.get("started"))
        self._lifecycle_cache = status
        return status

    def _remember_relayed(self, ga_id) -> None:
        if not ga_id:
            return
        # The relay thread and route threads race here; keep the dedupe set's
        # check-add cycle single-threaded (membership reads stay advisory).
        with self._relayed_ids_lock:
            self._relayed_chat_ids.add(ga_id)
            if len(self._relayed_chat_ids) > 500:
                self._relayed_chat_ids = set(list(self._relayed_chat_ids)[-250:])

    def notify(self, event: dict) -> Optional[dict]:
        """Admit a user message into the gahub_app conductor inbox.

        Returns the engine-side chat item (its id is the authoritative chat
        identity, D4) or ``None`` when the conductor is stopping. Remembering
        the engine id here also lets ``_on_remote_chat`` recognize our own
        relay instead of duplicating it in the UI.

        P0 idempotency: the event may carry an ``operation_id`` (one per
        logical admission, generated by ``add_chat_message``); when absent a
        fresh one is minted so transport retries cannot double-admit.
        """
        if event.get("type") != "user_message":
            return None
        item = self.client.post_chat(
            event.get("msg", ""), "user", event.get("request_id"),
            operation_id=event.get("operation_id") or uuid.uuid4().hex,
        )
        if isinstance(item, dict):
            self._remember_relayed(item.get("id"))
            return item
        return None

    def get_conductor_log(self) -> list:
        try:
            return self.client.get_log()
        except Exception:
            log.debug("gahub_app log unavailable", exc_info=True)
            return []

    def get_chat_messages(self, last: int = 20) -> list:
        """Bootstrap chat history for the conductor page (GET /chat proxy).

        The live feed arrives over SSE, so a transport failure here must not
        break the page — degrade to an empty list and let the stream fill in,
        mirroring ``get_conductor_log``.
        """
        try:
            return self.client.get_chat(last=last)
        except Exception:
            log.debug("gahub_app chat unavailable", exc_info=True)
            return []


    # ===== SSE relay dispatch =====

    def _advance_journal_cursor(self, seq: int) -> None:
        cursor = self._journal_cursor
        current = cursor.get("seq")
        if current is None or seq > current:
            cursor["seq"] = seq

    def _replay_action_operation(self, operation_id: str | None) -> dict | None:
        """Return the recorded response for a retried worker action, if any."""
        if not operation_id:
            return None
        with self._action_operation_lock:
            recorded = self._action_operations.get(operation_id)
        if recorded is None or recorded is _ACTION_OPERATION_IN_FLIGHT:
            return None
        return recorded

    def _reserve_action_operation(self, operation_id: str | None) -> dict | None:
        """Replay a completed operation, or claim the id for execution.

        Returns the recorded response when this operation_id already
        completed (caller returns it as-is). Raises when the same id is
        still executing in another thread — the "completed-then-registered"
        cache alone let two concurrent duplicates both miss and double-fire
        the engine. Claims are released on failure (see
        _release_action_operation) so a genuine retry is not poisoned.
        """
        if not operation_id:
            return None
        with self._action_operation_lock:
            recorded = self._action_operations.get(operation_id)
            if recorded is not None and recorded is not _ACTION_OPERATION_IN_FLIGHT:
                return recorded
            if recorded is _ACTION_OPERATION_IN_FLIGHT:
                raise ValueError(
                    f"operation {operation_id} is already executing; wait for it to finish"
                )
            cache = self._action_operations
            cache[operation_id] = _ACTION_OPERATION_IN_FLIGHT
            while len(cache) > self._ACTION_OPERATION_CACHE_SIZE:
                # Evict the oldest COMPLETED entry; a live reservation must
                # survive (losing it would let a duplicate double-fire).
                oldest = next(
                    (k for k, v in cache.items()
                     if v is not _ACTION_OPERATION_IN_FLIGHT),
                    None,
                )
                if oldest is None:
                    break
                del cache[oldest]
            return None

    def _release_action_operation(self, operation_id: str | None) -> None:
        """Drop an in-flight reservation after a failed execution."""
        if not operation_id:
            return
        with self._action_operation_lock:
            if self._action_operations.get(operation_id) is _ACTION_OPERATION_IN_FLIGHT:
                del self._action_operations[operation_id]

    def _record_action_operation(self, operation_id: str | None, result: dict) -> None:
        if not operation_id:
            return
        with self._action_operation_lock:
            cache = self._action_operations
            cache.pop(operation_id, None)
            cache[operation_id] = result
            while len(cache) > self._ACTION_OPERATION_CACHE_SIZE:
                cache.popitem(last=False)

    def _replay_journal(self) -> None:
        """Catch-up replay after an SSE (re)connect (P2-A reconcile).

        The live SSE stream is a hint; the engine journal is the truth.  On
        every reconnect, everything after the last seen seq is fed through
        the same event handler, closing the drop window between the live
        hint and the durable stream.  Replay runs BEFORE any live frame is
        read (the relay calls this hook right after connecting), so events
        are applied in journal order and the cursor stays exact.

        Long disconnects can outgrow one page, so the catch-up fetches in a
        pagination loop until the engine returns a short page.  The cursor
        still advances per event (crash-safe mid-replay progress) and the
        loop breaks defensively if a full page yields no cursor progress.
        """
        try:
            cursor = self._journal_cursor
            if cursor.get("seq") is None:
                resp = self.client.journal(after_seq=0, limit=1)
                info = resp.get("journal") or {}
                if info.get("disabled"):
                    return
                cursor["seq"] = int(info.get("last_seq") or 0)
                cursor["epoch"] = info.get("epoch")
                log.info("journal cursor baselined at seq %s (epoch %s)",
                         cursor["seq"], cursor["epoch"])
                return
            fed = 0
            while True:
                page_floor = int(cursor["seq"] or 0)
                resp = self.client.journal(
                    after_seq=page_floor, limit=self._JOURNAL_REPLAY_BATCH)
                info = resp.get("journal") or {}
                if info.get("disabled"):
                    return
                epoch = info.get("epoch")
                if epoch and cursor.get("epoch") and epoch != cursor["epoch"]:
                    log.warning(
                        "journal epoch changed (%s -> %s): engine restarted "
                        "with a fresh journal; resetting the cursor and "
                        "replaying it",
                        cursor["epoch"], epoch)
                    # A fresh journal renumbers seq from 1, so the old
                    # cursor floor would filter every new event out.
                    # Replay the new epoch from its beginning; the SSE
                    # handlers merge pool/chat state idempotently.
                    cursor["seq"] = 0
                    cursor["epoch"] = epoch
                    continue
                if epoch:
                    cursor["epoch"] = epoch
                events = resp.get("events") or []
                highest = page_floor
                for record in events:
                    seq = record.get("seq")
                    if not isinstance(seq, int) or seq <= page_floor:
                        continue
                    payload = record.get("payload")
                    if isinstance(payload, dict):
                        self._on_sse_event(payload)
                        fed += 1
                    self._advance_journal_cursor(seq)
                    highest = max(highest, seq)
                if (len(events) < self._JOURNAL_REPLAY_BATCH
                        or highest <= page_floor):
                    break
            if fed:
                log.info("journal replay fed %d missed events after reconnect", fed)
        except Exception:
            # Reconciliation is best-effort: a failed replay never kills the
            # live relay; the next reconnect retries from the same cursor.
            log.exception("journal replay after reconnect failed")

    def _on_sse_event(self, event: dict) -> None:
        seq = event.get("jseq")
        if isinstance(seq, int):
            self._advance_journal_cursor(seq)
        if "jseq" in event:
            # Internal cursor field: keep it out of downstream payloads.
            event = {k: v for k, v in event.items() if k != "jseq"}
        kind = event.get("event")
        try:
            if kind == "hello":
                self.pool.update(event.get("subagents") or [])
                for item in (event.get("chat") or [])[-20:]:
                    self._on_remote_chat(item, from_hello=True)
                # The engine forgets its model policy on every cold restart;
                # a fresh SSE hello is the reliable "engine (re)connected"
                # signal, so re-assert the hub-owned policy snapshot. The
                # push is best-effort and idempotent.
                self._push_models_to_engine()
            elif kind == "request_outcome":
                rid = event.get("request_id")
                if not rid:
                    # Unattributed wakes have no workflow to transition;
                    # forwarding them would publish request_id=None noise.
                    log.debug("ignoring unattributed request_outcome event")
                    return
                outcome = SimpleNamespace(
                    status=event.get("status"),
                    phase=event.get("phase"),
                    error=event.get("error", ""),
                )
                if event.get("status") == "ok":
                    self.callbacks.on_conductor_request_finished(rid)
                elif event.get("status") == "yielded":
                    self.callbacks.on_conductor_request_yielded(rid, outcome=outcome)
                else:
                    self.callbacks.on_conductor_request_outcome(rid, outcome=outcome)
            elif kind == "subagents":
                self.pool.update(event.get("items") or [])
                self.callbacks.publish_subagent_snapshot()
            elif isinstance(kind, str) and kind.startswith("subagent_"):
                payload = {k: v for k, v in event.items() if k != "event"}
                self.callbacks.on_subagent_event(
                    event.get("id", ""), kind[len("subagent_"):], payload
                )
            elif kind == "chat":
                self._on_remote_chat(event.get("item") or {})
            elif kind == "chat_read":
                bus.publish(CONDUCTOR_CHAT_READ, {})
            elif kind == "log":
                self.callbacks.on_conductor_log_frame(event.get("item") or {})
            elif kind == "request_yield_requested":
                bus.publish(CONDUCTOR_REQUEST_YIELD_REQUESTED, {
                    "request_id": event.get("request_id"),
                    "reason": event.get("reason", ""),
                })
            elif kind == "error":
                payload = {k: v for k, v in event.items() if k != "event"}
                self.callbacks.on_conductor_event("error", payload)
        except Exception:
            log.exception("SSE relay handler failed for %s", kind)

    def _on_remote_chat(self, item: dict, *, from_hello: bool = False) -> None:
        """Mirror engine-side chat into the hub log.

        ``role=user`` entries only arrive here as echoes of messages the hub
        itself relayed (the engine broadcasts before our post_chat response
        returns, so the id race cannot be fully closed) or inside the hello
        snapshot after a hub restart. Live echoes of user messages are always
        skipped; the hello path keeps them to restore history.
        """
        if not item or item.get("id") in self._relayed_chat_ids:
            return
        if item.get("role") == "user" and not from_hello:
            return
        self._remember_relayed(item.get("id"))
        role = item.get("role") or "conductor"
        final = bool(item.get("final"))
        # D4: the engine id is the authoritative chat identity — the mirror
        # keeps it verbatim so live events and the engine-proxy hydration
        # dedupe against each other instead of duplicating messages.
        with self._chat_lock:
            hub_item = add_chat(
                item.get("msg", ""), role, self.chat_messages,
                request_id=item.get("request_id"),
                kind=("final" if final else None),
                item_id=item.get("id"),
            )
        bus.publish(CONDUCTOR_CHAT, {"item": hub_item})
        if role == "conductor" and final and item.get("request_id"):
            tracker = self.workflow_tracker
            try:
                transition = tracker.record_final(item["request_id"], hub_item)
                if transition is not None:
                    self._publish_workflow_transition(transition)
            except ValueError:
                # Expected after a hub restart: the engine replays chat
                # history whose request_ids this tracker never admitted (and
                # a second hub instance relays finals it does not own). The
                # chat line itself is already mirrored above; only the
                # workflow transition is meaningless here. Degrade to a
                # warning instead of a traceback storm.
                log.info(
                    "ignoring replayed conductor final for untracked "
                    "request_id %s",
                    item.get("request_id"),
                )
            except Exception:
                log.exception(
                    "Conductor final message rejected by workflow: %s",
                    item.get("request_id"),
                )

    # ===== dispatch / review through the engine =====

    def start_subagent(
        self,
        prompt: str,
        llm_index: Optional[int] = None,
        *,
        request_id: str | None = None,
        conductor_llm_index: Optional[int] = None,
        subagent_llm_index: Optional[int] = None,
        subagent_model_policy: Optional[SubagentModelPolicy] = None,
        goal: Optional[str] = None,
        boundaries: Optional[list] = None,
        deliverables: Optional[list] = None,
        done_when: Optional[str] = None,
        checks: Optional[list] = None,
        operation_id: Optional[str] = None,
    ) -> dict:
        """Dispatch through the single Hub model-policy boundary.

        The manifest fields (goal/boundaries/deliverables/done_when/checks)
        are forwarded verbatim: the engine rejects dispatches without a goal
        and at least one absolute deliverable, so the hub must carry them
        instead of silently dropping the contract.

        ``operation_id`` (P0 idempotency): one id per logical dispatch.  The
        hub generates it when absent so a transport-level retry can never
        spawn a second worker for the same logical operation.
        """
        tracker, models, selected = self._admit_action_models(
            llm_index,
            request_id,
            conductor_llm_index,
            subagent_llm_index,
            subagent_model_policy,
        )
        operation_id = operation_id or uuid.uuid4().hex
        result = self.client.start_subagent(
            prompt, request_id, selected,
            goal=goal, boundaries=boundaries, deliverables=deliverables,
            done_when=done_when, checks=checks,
            operation_id=operation_id,
        )
        result.setdefault("operation_id", operation_id)
        sid = result.get("id")
        bound_request_id: str | None = None
        if request_id and sid and "error" not in result:
            generation = int(result.get("active_generation", 0) or 0)
            completed = tracker.bind_subagent(request_id, sid, generation)
            if completed is not None:
                self._publish_workflow_transition(
                    (CONDUCTOR_WORKFLOW_COMPLETED, completed)
                )
            # gahub_app auto-yields the supervisor turn on dispatch.
            bound_request_id = request_id
        self._fill_dispatch_defaults(
            result,
            llm_index=selected,
            model_policy=models["subagent_model_policy"],
            request_id=bound_request_id,
        )
        # Dispatched responses carry the conductor instruction line, like
        # apply_subagent_action does for rework/input — "which responses
        # carry an instruction" stays single-homed in the service.
        result["instruction"] = INSTR_DISPATCHED
        return result

    @staticmethod
    def _fill_dispatch_defaults(
        result: dict,
        *,
        llm_index: Optional[int],
        model_policy: SubagentModelPolicy,
        request_id: str | None = None,
    ) -> None:
        """Fill the resolved model context the UI renders on dispatch results.

        Engine responses omit these hub-resolved fields; the dispatch verbs
        (start/input/rework) fill the same trio here instead of per action.
        accept only fills request_id — its response carries no model
        context, so it forwards the tracker owner without this helper.
        """
        if request_id:
            result.setdefault("request_id", request_id)
        result.setdefault("llm_index", llm_index)
        result.setdefault("model_policy", model_policy)

    def _admit_action_models(
        self,
        llm_index: Optional[int],
        request_id: str | None,
        conductor_llm_index: Optional[int],
        subagent_llm_index: Optional[int],
        subagent_model_policy: Optional[SubagentModelPolicy],
    ) -> tuple["WorkflowTracker", dict, Optional[int]]:
        """共享前置：断言就绪 → 校验 request → 配置模型 → 解析本次派单模型。

        start/input/rework 三个动作动词此前各手抄这四段（多次 debug 已现
        只改一份的漂移）；模型策略优先级链只在此一处实现。
        """
        self._assert_engine_ready()
        tracker = self._assert_action_request(request_id)
        models = self.configure_models(
            llm_index=conductor_llm_index,
            subagent_llm_index=subagent_llm_index,
            subagent_model_policy=subagent_model_policy,
        )
        selected = self._resolve_subagent_model_from_snapshot(llm_index, models)
        return tracker, models, selected

    def _assert_action_request(self, request_id: Optional[str]) -> "WorkflowTracker":
        """Engine-readiness + request validation, shared by every verb.

        accept duplicates none of it: without the model section it still
        must refuse the same way start/input/rework do.
        """
        self._assert_engine_ready()
        tracker = self.workflow_tracker
        if request_id is not None and not tracker.has_request(request_id):
            raise ValueError(f"unknown conductor request_id: {request_id}")
        return tracker

    def _resume_subagent_action(
        self,
        sid: str,
        action: str,
        msg: str,
        llm_index: Optional[int],
        *,
        request_id: str | None = None,
        conductor_llm_index: Optional[int],
        subagent_llm_index: Optional[int],
        subagent_model_policy: Optional[SubagentModelPolicy],
        operation_id: str | None = None,
    ) -> dict:
        """input/rework 共用主体。

        两个动作此前是逐字复制的双胞胎（断言/校验/配置/解析/绑定/setdefault
        六段全同）；动作差异只剩 verb 字符串。
        """
        replayed = self._reserve_action_operation(operation_id)
        if replayed is not None:
            return replayed
        try:
            tracker, models, selected = self._admit_action_models(
                llm_index,
                request_id,
                conductor_llm_index,
                subagent_llm_index,
                subagent_model_policy,
            )
            # Owner parity (P0-B): forward the tracker-resolved owner so the
            # engine's request_mismatch guard applies even when the caller
            # omitted the request (keyinfo/abort already behave this way).
            owner = request_id or tracker.request_for_subagent(sid)
            result = self.client.subagent_action(
                sid, action, msg, request_id=owner, llm_index=selected
            )
            bound_request_id: str | None = None
            if "error" not in result and owner:
                generation = int(result.get("active_generation", 0) or 0)
                tracker.bind_subagent(owner, sid, generation)
                bound_request_id = owner
            # gahub_app auto-yields the supervisor turn on resume/rework.
            self._fill_dispatch_defaults(
                result,
                llm_index=selected,
                model_policy=models["subagent_model_policy"],
                request_id=bound_request_id,
            )
        except BaseException:
            self._release_action_operation(operation_id)
            raise
        self._record_action_operation(operation_id, result)
        return result

    def input_subagent(
        self,
        sid: str,
        msg: str,
        llm_index: Optional[int] = None,
        *,
        request_id: str | None = None,
        conductor_llm_index: Optional[int] = None,
        subagent_llm_index: Optional[int] = None,
        subagent_model_policy: Optional[SubagentModelPolicy] = None,
        operation_id: str | None = None,
    ) -> dict:
        """Resume a stopped worker through the same model-policy boundary."""
        return self._resume_subagent_action(
            sid, "input", msg, llm_index,
            request_id=request_id,
            conductor_llm_index=conductor_llm_index,
            subagent_llm_index=subagent_llm_index,
            subagent_model_policy=subagent_model_policy,
            operation_id=operation_id,
        )

    def accept_subagent(
        self, sid: str, msg: str = "", *, request_id: str | None = None,
        force: bool = False, operation_id: str | None = None,
    ) -> dict:
        """Accept a pending worker and advance its request-scoped workflow.

        ``force`` is the audited escape hatch the engine applies when the
        deterministic verification verdict is not clean (the UI surfaces the
        evidence before offering it).
        """
        replayed = self._reserve_action_operation(operation_id)
        if replayed is not None:
            return replayed
        try:
            tracker = self._assert_action_request(request_id)
            if request_id is None:
                # Owner parity (P0-B): keyinfo/abort already forward the
                # tracker-resolved owner so the engine's request_mismatch guard
                # applies; plain accepts must not be the loophole.
                request_id = tracker.request_for_subagent(sid)
            result = self.client.subagent_action(
                sid, "accept", msg, request_id=request_id, force=force)
            if "error" not in result:
                generation = int(result.get("active_generation", 0) or 0)
                owner, transition = tracker.record_subagent_event(
                    sid,
                    "accepted",
                    generation=generation,
                    request_id=request_id,
                )
                if owner:
                    result.setdefault("request_id", owner)
                if transition is not None:
                    self._publish_workflow_transition(transition)
        except BaseException:
            self._release_action_operation(operation_id)
            raise
        self._record_action_operation(operation_id, result)
        return result

    def rework_subagent(
        self,
        sid: str,
        msg: str,
        llm_index: Optional[int] = None,
        *,
        request_id: str | None = None,
        conductor_llm_index: Optional[int] = None,
        subagent_llm_index: Optional[int] = None,
        subagent_model_policy: Optional[SubagentModelPolicy] = None,
        operation_id: str | None = None,
    ) -> dict:
        """Rework a pending worker through the model-policy boundary."""
        return self._resume_subagent_action(
            sid, "rework", msg, llm_index,
            request_id=request_id,
            conductor_llm_index=conductor_llm_index,
            subagent_llm_index=subagent_llm_index,
            subagent_model_policy=subagent_model_policy,
            operation_id=operation_id,
        )

    def subagent_dossier(self, sid: str, max_len: int) -> dict:
        """Full worker dossier for human review.

        The engine GET /subagent/{id} is the source of the cleaned reply; the
        hub list snapshot carries prompt/manifest/verification and fills in
        any field the engine omits, so the UI can show what was asked, what
        landed, and what the machine thinks.
        """
        detail = self.client.get_subagent(sid, max_len)
        mirrored = self.pool.get(sid)
        if mirrored is not None:
            for key in SUBAGENT_MIRROR_FIELDS:
                if key in detail and detail[key] not in (None, "", [], {}):
                    continue
                value = getattr(mirrored, key, None)
                if value is not None:
                    detail[key] = value
        if "generation" not in detail:
            detail["generation"] = int(detail.get("active_generation") or 0)
        if not detail.get("request_id"):
            detail["request_id"] = self.workflow_tracker.request_for_subagent(sid)
        return detail

    def apply_subagent_action(
        self,
        sid: str,
        action: str,
        msg: str = "",
        *,
        request_id: str | None = None,
        force: bool = False,
        llm_index: Optional[int] = None,
        conductor_llm_index: Optional[int] = None,
        subagent_llm_index: Optional[int] = None,
        subagent_model_policy: Optional[SubagentModelPolicy] = None,
        operation_id: str | None = None,
    ) -> dict:
        """Dispatch one POST /api/conductor/subagent/{sid} verb.

        Single home for the verb matrix: which method serves each action and
        which responses carry a conductor instruction line. Accept/rework/
        input resolve the tracker owner inside their own methods; keyinfo/
        abort round-trip through the pool mirror, so their owner resolution
        lives here.
        """
        action = action.lower().strip()
        if action == "keyinfo":
            # Controlled idempotency exception: keyinfo/abort carry no
            # operation_id replay (the engine's once-per-attempt budget 409
            # bounds retries instead of a cached 200 replay).
            result = self.pool.keyinfo_subagent(
                sid, msg,
                request_id=self.workflow_tracker.request_for_subagent(sid))
            result["instruction"] = INSTR_KEYINFO
            return result
        if action == "accept":
            return self.accept_subagent(
                sid, msg, request_id=request_id, force=force,
                operation_id=operation_id)
        if action == "rework":
            result = self.rework_subagent(
                sid, msg, llm_index,
                request_id=request_id,
                conductor_llm_index=conductor_llm_index,
                subagent_llm_index=subagent_llm_index,
                subagent_model_policy=subagent_model_policy,
                operation_id=operation_id,
            )
            if "error" not in result:
                result["instruction"] = INSTR_DISPATCHED
            return result
        if action in ("input", "reply", "append", "message", "msg"):
            result = self.input_subagent(
                sid, msg, llm_index,
                request_id=request_id,
                conductor_llm_index=conductor_llm_index,
                subagent_llm_index=subagent_llm_index,
                subagent_model_policy=subagent_model_policy,
                operation_id=operation_id,
            )
            result["instruction"] = INSTR_DISPATCHED
            return result
        if action in ("abort", "stop"):
            return self.pool.abort_subagent(
                sid, request_id=self.workflow_tracker.request_for_subagent(sid))
        raise ValueError(f"unknown conductor action: {action}")

    # ===== snapshots & chat product surface =====

    def get_subagent_snapshot(self) -> list[dict]:
        """Pool snapshot (gahub_app enriches generation/request attribution)."""
        return self.pool.snapshot()

    def get_workflow_snapshot(self, limit: int = 20) -> list[dict]:
        """Expose the Hub-owned workflow projection for page reloads."""
        return self.workflow_tracker.snapshots(limit=limit)

    def add_chat_message(
        self,
        msg: str,
        role: str = "conductor",
        request_id: str | None = None,
        kind: str | None = None,
        llm_index: Optional[int] = None,
        subagent_llm_index: Optional[int] = None,
        subagent_model_policy: Optional[SubagentModelPolicy] = None,
        operation_id: Optional[str] = None,
    ) -> dict:
        self._assert_open()
        tracker = self.workflow_tracker
        if kind is not None and role != "conductor":
            raise ValueError("kind is only valid for conductor messages")
        if kind == "final" and not request_id:
            raise ValueError("request_id is required for a final conductor message")
        if role != "user" and request_id and not tracker.has_request(request_id):
            raise ValueError(f"unknown conductor request_id: {request_id}")
        reserve_final = kind == "final" and request_id is not None
        if reserve_final:
            # Reserve-first: a retried final replays the recorded item (no
            # 422 from assert_ready_for_final), and a concurrent duplicate
            # with the same id is refused instead of double-committing.
            replayed = self._reserve_action_operation(operation_id)
            if replayed is not None:
                return replayed
        try:
            if reserve_final:
                tracker.assert_ready_for_final(request_id)
            admitted_request_id = uuid.uuid4().hex if role == "user" else request_id
            # The SSE relay thread appends engine mirrors concurrently; every
            # add_chat caller holds the chat lock (RLock, so nested use is fine).
            with self._chat_lock:
                item = add_chat(
                    msg,
                    role,
                    self.chat_messages,
                    request_id=admitted_request_id,
                    kind=kind,
                )
            if role == "user" and admitted_request_id:
                tracker.admit(admitted_request_id)
                try:
                    self.configure_models(
                        llm_index=llm_index,
                        subagent_llm_index=subagent_llm_index,
                        subagent_model_policy=subagent_model_policy,
                    )
                    # Exclude the just-admitted request: it is admitted but
                    # workerless right now (the supervisor has not even woken),
                    # which is exactly the "stranded" shape. Re-relaying it here
                    # delivered the user's message to the engine twice (live
                    # 2026-09-01: duplicated user_message batch, same request_id).
                    self.ensure_started(exclude_request_id=admitted_request_id)
                except Exception as exc:
                    transition = tracker.fail_supervisor(
                        admitted_request_id,
                        phase="start",
                        error=f"conductor start failed: {str(exc)[:200]}",
                    )
                    if transition is not None:
                        self._publish_workflow_transition(transition)
                    raise
                try:
                    engine_item = self.notify({
                        "type": "user_message",
                        "msg": msg,
                        "request_id": admitted_request_id,
                        # One id per logical admission (P0): a retried POST /chat
                        # replays the first engine answer instead of double-admitting.
                        "operation_id": operation_id or uuid.uuid4().hex,
                    })
                    if engine_item is None:
                        raise RuntimeError("conductor stopped before event admission")
                    engine_id = (
                        engine_item.get("id")
                        if isinstance(engine_item, dict) else None
                    )
                    if engine_id and engine_id != item["id"]:
                        # D4: adopt the engine id as the authoritative identity so
                        # the page's optimistic add and the later hydration merge.
                        item["id"] = engine_id
                except Exception:
                    transition = tracker.fail_supervisor(
                        admitted_request_id,
                        phase="admission",
                        error="conductor event admission failed",
                    )
                    if transition is not None:
                        self._publish_workflow_transition(transition)
                    raise
                bus.publish(CONDUCTOR_CHAT, {"item": item})
            elif role == "conductor" and kind == "final" and admitted_request_id:
                bus.publish(CONDUCTOR_CHAT, {"item": item})
                transition = tracker.record_final(admitted_request_id, item)
                if transition is not None:
                    self._publish_workflow_transition(transition)
                # Recorded only after the final fully commits (no minting: a
                # fresh id per call could never replay) so an engine retry of a
                # delivered final gets the recorded item back.
                self._record_action_operation(operation_id, item)
        except BaseException:
            # Release the final's reservation so a genuine retry is not
            # poisoned; no-op for callers that never reserved.
            self._release_action_operation(operation_id)
            raise
        return item

    def get_readmes(self) -> dict:
        return READMES

    def get_readme(self, topic: str) -> Optional[str]:
        return READMES.get(topic)
