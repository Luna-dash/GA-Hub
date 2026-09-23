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
from typing import Dict, Literal, Optional

from .. import _paths

from .conductor_client import (
    GaConductorClient,
    GahubProcessError,
    GahubProcessManager,
)
from .conductor_ext_timeout import TimeoutMonitor
from .conductor_vocabulary import (
    SUBAGENT_RUNNING,
    subagent_stage,
    TERMINAL_WORKFLOW_STATES,
    SUBAGENT_VERBS,
    SUBAGENT_ACTION_ALIASES,
    ConductorNotRunning,
)
from .conductor_workflow import WorkflowTracker
from .conductor_store import ConductorStore, command_fingerprint
from .conductor_recovery import ConductorRecovery
from . import conductor_activity
from .conductor_commands import ConductorCommands
from .event_bus import bus
from ..event_topics import (
    CONDUCTOR_CHAT,
    CONDUCTOR_LOG,
    CONDUCTOR_SUBAGENTS,
    CONDUCTOR_WORKFLOW_FAILED,
)

log = logging.getLogger(__name__)

SubagentModelPolicy = Literal["follow_main", "default", "locked"]
SUBAGENT_MODEL_POLICIES = frozenset({"follow_main", "default", "locked"})


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
    the GA core pool (``lock``/``subagents``/``counts``/``get``/``snapshot``).
    """

    def __init__(self, client: GaConductorClient):
        self.client = client
        self.lock = threading.Lock()
        self.subagents: Dict[str, _MirrorState] = {}
        self._items: list[dict] = []
        self.boot_id: str | None = None
        self.revision = -1

    def select_boot(self, boot_id: str) -> None:
        with self.lock:
            if self.boot_id != boot_id:
                self.boot_id = boot_id
                self.revision = -1
                self._items = []
                self.subagents = {}

    def envelope(self) -> dict:
        with self.lock:
            return {"items": [dict(item) for item in self._items],
                    "boot_id": self.boot_id, "snapshot_revision": self.revision}

    def update(self, items: list, *, boot_id: str | None = None,
               revision: int | None = None) -> bool:
        with self.lock:
            if self.boot_id is not None:
                if boot_id != self.boot_id or type(revision) is not int or revision <= self.revision:
                    return False
                self.revision = revision
            self._items = [dict(item) for item in items if isinstance(item, dict)]
            self.subagents = {
                item["id"]: _MirrorState(item)
                for item in self._items if item.get("id")
            }
            return True

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
                snapshot = self.service.get_subagent_envelope()
                if snapshot == self._last_subagent_snapshot:
                    return
                if isinstance(snapshot, dict):
                    self.service._publish(CONDUCTOR_SUBAGENTS, snapshot)
                else:
                    push_subagent_cards(snapshot)
                # Keep the old value when publishing fails so a later event retries.
                self._last_subagent_snapshot = snapshot
            except Exception:
                # Observer failures must not change an already committed pool action.
                log.exception("conductor_subagent_snapshot_publish_failed")

    # request lifecycle ------------------------------------------------------
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


class ConductorService:
    """Singleton GA-Hub product layer around the gahub_app engine."""
    _instance: Optional["ConductorService"] = None
    _lock = threading.Lock()

    def __init__(self):
        self._init_fields(store_path=_paths.ADMIN_DATA / "conductor" / "state.sqlite3")
        self.timeout_monitor.start()
        self.recovery.start()

    @classmethod
    def for_tests(cls, *, store_path=":memory:") -> "ConductorService":
        """Fully initialized instance without threads or engine side effects.

        Production shape by default: every service carries its SQLite store,
        so verbs always run the guarded command track. Pass a ``tmp_path``
        file when a test needs persistence across instances. There is no
        store-less mode — that legacy in-memory track is gone.
        """
        obj = cls.__new__(cls)
        obj._init_fields(store_path=store_path)
        return obj

    def _init_fields(self, *, store_path=":memory:") -> None:
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
        # not both observe "not started" and both run the start sequence
        # (the second /start would double-run recovery replay and the model
        # push alongside it).
        self._cold_start_lock = threading.Lock()
        # Serializes relay startup: chat admission and subagent verbs race
        # here on cold start, and two relays double-process every event.
        self._relay_lock = threading.Lock()
        self._relayed_chat_ids: set[str] = set()
        self._relayed_ids_lock = threading.Lock()
        self._lifecycle_cache: dict = {}
        self._notifications_dirty = False
        self.store = ConductorStore(store_path, self._process_manager.base_url(), self.workflow_tracker)
        self.recovery = ConductorRecovery(self, self.store)
        self.commands = ConductorCommands(self, self.store, self.recovery)
        self.store.notification_failed = lambda: setattr(self, "_notifications_dirty", True)
        self.chat_messages = self.store.chat_messages()
        self._relayed_chat_ids.update(item["id"] for item in self.chat_messages)


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
        self.recovery.stop_event.set()
        self.recovery.wake.set()
        self.recovery.command_wake.set()
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

        helpers_ok = False
        store_ok = self.store.closed
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
                        if self._process_manager is not None:
                            self._process_manager.stop(timeout=max(0.0, deadline - time.monotonic()))
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
            # the relay would keep publishing into a retired loop, and a
            # command still in flight would race _assert_open with noise.
            helpers: list[threading.Thread] = []
            if self._relay_thread is not None:
                helpers.append(self._relay_thread)
            helpers.extend(self.recovery.threads)
            for helper in helpers:
                if helper.is_alive() and helper is not threading.current_thread():
                    helper.join(timeout=max(0.0, deadline - time.monotonic()))
            helpers_ok = not any(helper.is_alive() for helper in helpers)
            helpers_ok = self.commands.wait_idle(max(0.0, deadline - time.monotonic())) and helpers_ok
            if helpers_ok:
                self.store.close()
                store_ok = True
        finally:
            with self._shutdown_lock:
                self._shutdown_core_stopped = bool(core_ok)
                self._shutdown_monitor_stopped = bool(monitor_ok)
                complete = bool(core_ok and monitor_ok and helpers_ok and store_ok)
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
                "(core=%s monitor=%s helpers=%s store=%s)",
                core_ok,
                monitor_ok,
                helpers_ok,
                store_ok,
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
            except GahubProcessError:
                # Typed passthrough: the route layer maps this to 503 with
                # the probe/health diagnostics; wrapping it here erased the
                # status_code and turned a start attempt into a blind 500.
                raise
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

    def _publish(self, topic: str, payload: dict) -> None:
        def publish():
            try:
                bus.publish(topic, payload)
            except Exception:
                self._notifications_dirty = True
                log.exception("conductor notification failed for %s", topic)
        self.store.defer(publish)

    def _publish_workflow_transition(self, transition: tuple[str, dict]) -> None:
        self.store.defer(lambda: self._publish_workflow_transition_now(transition))

    def _publish_workflow_transition_now(
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
        # The closing row belongs to history too. It is tracker-derived, so no
        # journal record can reproduce it later; recording it at the publish
        # site is the only chance, and it rides the frame so the live page keys
        # it identically to the hydrated one.
        kind = topic.split(":", 1)[1]
        activity = conductor_activity.workflow_activity(
            kind, request_id, event_id=f"wf:{request_id}:{kind}", ts=time.time())
        if activity is not None:
            try:
                self.store.save_activity([activity])
            except Exception:
                log.exception("workflow activity could not be recorded")
        self._publish(topic, payload if activity is None else {**payload, "activity": activity})

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
            self._publish(CONDUCTOR_CHAT, {"item": item})
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
            if self._closed:
                return
            self.recovery.start()
            thread = self._relay_thread
            if thread is not None and thread.is_alive():
                return
            self._relay_stop.clear()
            self._relay_thread = threading.Thread(
                target=self.client.stream_events,
                args=(self._on_sse_event, self._relay_stop.is_set),
                # P0 store-mode: live SSE frames are only a hint; every
                # (re)connect hands reconciliation to the recovery loop,
                # which replays the durable journal before accepting state.
                kwargs={"on_reconnect": self.recovery.reconnect},
                name="conductor-sse-relay",
                daemon=True,
            )
            self._relay_thread.start()

    def start(
        self,
        llm_index: Optional[int] = None,
        subagent_llm_index: Optional[int] = None,
        subagent_model_policy: Optional[SubagentModelPolicy] = None,
    ) -> bool:
        """Compatibility facade behind POST /api/conductor/start: configure
        models, then ensure the lifecycle. da97cf8 dropped it as "dead code"
        and the start button 500'd (AttributeError) for a week — the sweep
        grepped service callers but missed the route's dynamic reference.

        Explicit start is a PURE bring-up (2026-09 user ruling): it must not
        batch-resume any stranded workflow. Resuming is a per-task decision
        (``resume_workflow``); "stopped" means "not necessarily wanted back",
        and a single control silently relaying every open task overreaches.
        The send path keeps the crash-recovery wake because there the user is
        demonstrably asking the conductor to work again: waking recovery
        replays the journal and drains commands already persisted before the
        crash."""
        self.configure_models(
            llm_index=llm_index,
            subagent_llm_index=subagent_llm_index,
            subagent_model_policy=subagent_model_policy,
        )
        return self.ensure_started(wake_recovery=False)

    def resume_workflow(self, request_id: str) -> bool:
        """Bring the supervisor up (if needed) and re-relay exactly ONE task.

        The per-task counterpart of the old batch redispatch: only this
        workflow's original user message is delivered, every other open
        workflow is left untouched. Raises ValueError for unknown or
        already-terminal requests; the route maps it to a clean 422.

        Command track (P0): the relay is persisted before delivery like any
        other chat command, so it carries a guarded receipt, a boot guard
        and a retryable rejection instead of the fire-and-forget direct
        ``client.post_chat`` this used to be. The operation id is derived
        from (engine, request, boot, msg) rather than minted per call: a
        double click or a transport retry replays the stored outcome
        instead of appending a second copy of the original instruction,
        while an engine restart (new boot) legitimately allows a fresh
        relay. The boot in that key is the one the workflow is bound to
        (its snapshot), not ``recovery.boot_id`` — the latter is still None
        until the first sync and would make the id wobble between a first
        and a second click.
        """
        tracker = self.workflow_tracker
        snapshot = tracker.snapshot(request_id)
        if snapshot is None:
            raise ValueError(f"unknown conductor request_id: {request_id}")
        if (snapshot.get("terminal_event")
                or snapshot.get("status") in TERMINAL_WORKFLOW_STATES):
            raise ValueError("该任务已经结束，无法恢复")
        # wake_recovery=False: waking the engine must not batch-relay
        # every other stranded workflow. It runs before submit() on purpose —
        # the cold start is finished here, so the ensure_started() the
        # command track performs finds a live engine and skips the recovery
        # branch it would otherwise take.
        self.ensure_started(wake_recovery=False)
        original = self._original_user_message(request_id)
        if original is None:
            raise ValueError("该任务找不到可重放的原始指令，无法恢复")
        operation_id = "resume-" + command_fingerprint({
            "engine": self.store.engine_key, "request_id": request_id,
            "boot": snapshot.get("boot_id") or self.recovery.boot_id or "",
            "msg": original})[:48]
        self.commands.submit(operation_id, {
            "kind": "chat", "role": "user", "msg": original,
            "request_id": request_id})
        log.info("resumed workflow %s on explicit request", request_id[:8])
        return True

    def ensure_started(
            self,
            wake_recovery: bool = True) -> bool:
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
            except GahubProcessError:
                # Typed passthrough — see _assert_engine_ready.
                raise
            except Exception as exc:
                raise RuntimeError(
                    rf"gahub_app unavailable (see %TEMP%\gahub_app.log): {exc}"
                ) from exc
        self._ensure_relay()
        status = self.client.status()
        if not status.get("started"):
            # Re-check under the cold-start lock: a concurrent admission may
            # have finished the start between our status check and this line,
            # and a second start would double-run the cold-start sequence.
            with self._cold_start_lock:
                status = self.client.status()
                if not status.get("started"):
                    self.client.start(llm_index=self._conductor_llm_index)
                    # /start restores only the conductor model; re-push the
                    # full hub-owned snapshot so the subagent policy survives
                    # the engine restart instead of silently resetting to
                    # follow_main.
                    self._push_models_to_engine()
                    # Fresh conductor: waking recovery here replays the
                    # durable journal and drains pending commands. On an
                    # already-running conductor this must NOT run — an
                    # admitted workflow may be mid-turn right now. Explicit
                    # start passes wake_recovery=False: no task may be
                    # resumed without a per-task user decision (the store
                    # track fails boot-interrupted workflows instead of
                    # auto-resuming them; resume_workflow is the per-task
                    # channel).
                    if wake_recovery:
                        self.recovery.wake.set()
        self.lifecycle_status()
        return True

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
        self.commands.suspend_commands()
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
            # recovery wake. Only workerless "admitted" workflows are
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
        status["recovery"] = self.recovery.status()
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

    def get_conductor_log(self) -> list:
        try:
            return self.client.get_log()
        except Exception:
            log.debug("gahub_app log unavailable", exc_info=True)
            return []

    def get_chat_messages(self, last: int = 20) -> list:
        """Bootstrap chat history for the conductor page (GET /chat proxy).

        The SQLite store is the durable authority: the engine loses its chat
        memory on every boot, so hydration must not depend on the engine
        being alive long enough to have replayed (reliability plan §4.3).
        """
        with self._chat_lock:
            return list(self.chat_messages[-last:])

    def get_activity(self, request_id: str, limit: int = 200,
                     before_ms: int | None = None) -> dict:
        """Durable 动态 timeline for one workflow (GET /activity).

        Hub-owned read: the timeline has to survive a reload, an app restart
        and an engine resync, so it reads the store instead of replaying the
        engine's live feed. ``before_ms`` walks backwards for the page's
        scroll-up window; ``has_more`` says whether an older window exists.
        """
        rows = self.store.activity_for_request(request_id, limit + 1, before_ms)
        has_more = len(rows) > limit
        return {"items": rows[-limit:] if has_more else rows,
                "has_more": has_more, "durable": True}


    # ===== SSE relay dispatch =====

    def _on_sse_event(self, event: dict) -> bool:
        # Live SSE frames are only a hint; the durable journal (replayed by
        # the recovery loop) is the state truth. There is no store-less
        # reconcile path anymore.
        return self.recovery.on_event(event)

    def _on_remote_chat(self, item: dict) -> None:
        """Mirror an engine-side chat item into the hub log.

        Callers are the journal replay (chat records, including user
        messages the hub itself relayed — dedupe by engine id keeps the
        optimistic copy single) and the chat command's engine receipt.
        """
        if not item:
            return
        role = item.get("role") or "conductor"
        final = bool(item.get("final"))
        hub_item = {**item, "role": role, "ts": item.get("ts") or now_ms(),
                    "read": role != "user", "final": final}
        if final:
            hub_item["kind"] = "final"
        tracker = self.workflow_tracker
        with tracker.transaction():
            if role == "user" and item.get("request_id") and tracker.has_request(item["request_id"]):
                tracker.set_title(item["request_id"], item.get("msg") or "")
            if role in ("conductor", "system") and final and item.get("request_id"):
                if tracker.has_request(item["request_id"]):
                    transition = tracker.record_final(item["request_id"], hub_item)
                    if transition is not None:
                        self._publish_workflow_transition(transition)

            def mirror():
                with self._chat_lock:
                    if item.get("id") in self._relayed_chat_ids:
                        return
                    self.chat_messages.append(hub_item)
                    del self.chat_messages[:-200]
                    self._remember_relayed(item.get("id"))
                self._publish(CONDUCTOR_CHAT, {"item": hub_item})

            self.store.save_chat(hub_item)
            self.store.defer(mirror)

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
        return self.commands.submit(operation_id, {
            "kind": "dispatch", "prompt": prompt, "request_id": request_id,
            "llm_index": llm_index, "conductor_llm_index": conductor_llm_index,
            "subagent_llm_index": subagent_llm_index, "subagent_model_policy": subagent_model_policy,
            "goal": goal, "boundaries": boundaries, "deliverables": deliverables,
            "done_when": done_when, "checks": checks})

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
        return self.apply_subagent_action(
            sid, "input", msg, llm_index=llm_index, request_id=request_id,
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
        return self.apply_subagent_action(
            sid, "accept", msg, request_id=request_id, force=force,
            operation_id=operation_id,
        )

    def subagent_dossier(self, sid: str, max_len: int) -> dict:
        """Full worker dossier for human review.

        The engine GET /subagent/{id} is the source of the cleaned reply; the
        hub list snapshot carries prompt/manifest/verification and fills in
        any field the engine omits, so the UI can show what was asked, what
        landed, and what the machine thinks.
        """
        try:
            detail = self.client.get_subagent(sid, max_len)
        except Exception as exc:
            status_code = getattr(exc, "status_code", None)
            try:
                found = self.store.archived_subagent_snapshots()
                archived = next((item for item in found if item.get("id") == sid), None)
            except Exception:
                log.exception("subagent archive read failed for %s", sid)
                archived = None
            if archived is None:
                raise
            detail = dict(archived)
            detail.setdefault("archived", True)
            if status_code is not None:
                log.info("subagent %s served from archive (engine said %s)", sid, status_code)
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
        expected_boot_id: str | None = None,
        expected_generation: int | None = None,
        expected_command_revision: int | None = None,
    ) -> dict:
        """Dispatch one POST /api/conductor/subagent/{sid} verb.

        Single home for the verb matrix: alias folding, verb validation and
        intent construction (including abort's hub origin and the optimistic
        concurrency expectations) all happen here before the intent is
        handed to the command track.
        """
        action = action.lower().strip()
        action = SUBAGENT_ACTION_ALIASES.get(action, action)
        if action not in SUBAGENT_VERBS:
            raise ValueError(f"unknown conductor action: {action}")
        intent = {"kind": "action", "sid": sid, "action": action, "msg": msg,
                  "request_id": request_id, "force": force, "llm_index": llm_index,
                  "conductor_llm_index": conductor_llm_index, "subagent_llm_index": subagent_llm_index,
                  "subagent_model_policy": subagent_model_policy}
        if action == "abort":
            intent["origin"] = "hub"
        intent.update({key: value for key, value in {
            "expected_boot_id": expected_boot_id, "expected_generation": expected_generation,
            "expected_command_revision": expected_command_revision,
        }.items() if value is not None})
        return self.commands.submit(operation_id, intent)

    # ===== snapshots & chat product surface =====

    def _archive_subagent_snapshots(self, items: list[dict]) -> None:
        """Persist pool snapshots so per-worker detail outlives the engine.

        The engine clears its pool on conductor stop (and on engine
        restarts), while completed workflows keep referencing their workers.
        Best-effort: archiving must never break the snapshot surface.
        """
        if not items:
            return
        try:
            self.store.save_subagent_snapshots(items)
        except Exception:
            log.exception("subagent archive write failed")

    def _merge_archived_subagents(self, items: list[dict]) -> list[dict]:
        """Append archived workers missing from the live pool snapshot."""
        try:
            live_ids = {item.get("id") for item in items if item.get("id")}
            archived = self.store.archived_subagent_snapshots(exclude=live_ids)
        except Exception:
            log.exception("subagent archive read failed")
            return items
        if not archived:
            return items
        for item in archived:
            item["archived"] = True
        merged = list(items) + archived
        merged.sort(key=lambda item: int(item.get("updated_at")
                                         or item.get("created_at") or 0))
        return merged

    def get_subagent_snapshot(self) -> list[dict]:
        """Pool snapshot (gahub_app enriches generation/request attribution),
        merged with archived workers whose pool entries no longer exist."""
        return self._merge_archived_subagents(self.pool.snapshot())

    def get_subagent_envelope(self) -> dict:
        envelope = self.pool.envelope()
        items = envelope.get("items") or []
        self._archive_subagent_snapshots(items)
        items = self._merge_archived_subagents(items)
        for item in items:
            item["stage"] = subagent_stage(status=str(item.get("status") or ""),
                attempt=int(item.get("attempt") or 1), review_status=str(item.get("review_status") or ""))
        envelope["items"] = items
        return envelope

    def get_operation(self, operation_id: str) -> dict:
        command = self.store.command(operation_id)
        if command is None:
            return {"operation_id": operation_id, "known": False}
        return {"operation_id": operation_id, "known": True, "state": command["state"],
                "result": command["result"], "request_id": command["payload"].get("request_id"),
                "updated_at": command["updated_at"]}

    def get_workflow_snapshot(self, limit: int = 20) -> list[dict]:
        """Expose the Hub-owned workflow projection for page reloads."""
        return self.workflow_tracker.snapshots(limit=limit)

    def forget_workflow(self, request_id: str) -> None:
        """Delete a workflow from the board at the user's request.

        Terminal workflows are always deletable. While the conductor runs,
        live workflows stay locked (events would resurrect them); once the
        conductor is stopped (paused session) every row is deletable — the
        tombstone keeps the engine from re-admitting it after a restart.
        """
        self._assert_open()
        self.workflow_tracker.forget_workflow(
            request_id, allow_active=not self._started)

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
        if kind is not None and role != "conductor":
            raise ValueError("kind is only valid for conductor messages")
        if kind == "final" and not request_id:
            raise ValueError("request_id is required for a final conductor message")
        if role != "user" and request_id and not self.workflow_tracker.has_request(request_id):
            raise ValueError(f"unknown conductor request_id: {request_id}")
        # Failure semantics (store track): the command is persisted before
        # the engine call, so a delivery failure leaves it pending/rejected
        # for the drain loop and journal reconciliation — there is no
        # synchronous fail_supervisor transition here anymore. Boot-change
        # outcomes are reconciled by recovery.sync() (fail_supervisor on an
        # old-boot admitted workflow) and per-task retries go through
        # resume_workflow.
        return self.commands.submit(operation_id, {
            "kind": "chat", "msg": msg, "role": role, "request_id": request_id,
            "final": kind == "final", "llm_index": llm_index,
            "subagent_llm_index": subagent_llm_index, "subagent_model_policy": subagent_model_policy})

    def get_readmes(self) -> dict:
        return READMES

    def get_readme(self, topic: str) -> Optional[str]:
        return READMES.get(topic)
