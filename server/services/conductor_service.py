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

import inspect
import json
import logging
import re
import threading
import time
import uuid
from types import SimpleNamespace
from typing import Any, Dict, Literal, Optional

from .. import _paths

from .conductor_client import GaConductorClient, GahubProcessManager
from .conductor_ext_timeout import TimeoutMonitor
from .conductor_workflow import WorkflowTracker
from .event_bus import bus
from .request_usage import RequestUsageStore

log = logging.getLogger(__name__)

SubagentModelPolicy = Literal["follow_main", "default", "locked"]
SUBAGENT_MODEL_POLICIES = frozenset({"follow_main", "default", "locked"})


def _accepts_keyword(callable_obj, name: str) -> bool:
    """Return whether a callable can receive a named compatibility hook."""
    try:
        signature = inspect.signature(callable_obj)
    except (TypeError, ValueError):
        return False
    named = signature.parameters.get(name)
    return (
        named is not None
        and named.kind in (
            inspect.Parameter.POSITIONAL_OR_KEYWORD,
            inspect.Parameter.KEYWORD_ONLY,
        )
    ) or any(
        parameter.kind is inspect.Parameter.VAR_KEYWORD
        for parameter in signature.parameters.values()
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


_TURN_SPLIT_RE = re.compile(r'\**LLM Running \(Turn \d+\) \.\.\.\**')
_SUMMARY_RE = re.compile(r'<summary>(.*?)</summary>\s*', re.DOTALL)


def now_ms() -> int:
    return int(time.time() * 1000)


def short_id() -> str:
    return uuid.uuid4().hex[:8]


def clean_log_text(s: str) -> str:
    if not s:
        return s
    s = re.sub(r'`{5}\n.*?`{5}\n?', '', s, flags=re.DOTALL)
    s = re.sub(r'🛠️ Tool: `([^`]+)`\s*📥 args:\n`{4}.*?`{4}\n?', r'🛠️ `\1`\n', s, flags=re.DOTALL)
    s = re.sub(r'^🛠️ .*\n?', '', s, flags=re.MULTILINE)
    s = re.sub(r'<thinking>.*?</thinking>\s*', '', s, flags=re.DOTALL)
    s = re.sub(r'^\s*\[(?:Info|Status)\][^\n]*\n?', '', s, flags=re.MULTILINE)
    s = re.sub(r'^\s*`{4,5}\s*$\n?', '', s, flags=re.MULTILINE)
    s = re.sub(r'\n{3,}', '\n\n', s)
    return s.strip()


def add_chat(
    msg: str,
    role: str,
    chat_messages: list,
    request_id: str | None = None,
    kind: str | None = None,
) -> dict:
    """Add message to chat history and publish to event bus."""
    item = {
        "id": short_id(),
        "role": role,
        "msg": msg,
        "ts": now_ms(),
        "read": role != "user"
    }
    if request_id:
        item["request_id"] = request_id
    if kind:
        item["kind"] = kind
    chat_messages.append(item)
    if len(chat_messages) > 200:
        del chat_messages[:-200]
    bus.publish("conductor:chat", {"item": item})
    return item


def push_subagent_cards(snapshot: list):
    """Publish subagent pool snapshot to event bus."""
    bus.publish("conductor:subagents", {"items": snapshot})


def _event_name(event: Any) -> str:
    """Coerce a subagent event (enum or SSE string) to its stable value."""
    return getattr(event, "value", None) or str(event)


READMES = {
    "api": """Conductor API (integrated into GA-Hub)

POST /api/conductor/chat
  用户页面提交任务: {"msg": "...", "role": "user", "llm_index": 1,
         "subagent_llm_index": 5, "subagent_model_policy": "default"}
  Conductor 写入计划: {"msg": "...", "role": "conductor", "request_id": "..."}
  Conductor 最终报告: {"msg": "...", "role": "conductor", "request_id": "...", "final": true}
  role=user 会创建新的用户任务并唤醒 Conductor；Supervisor 自己写消息时
  必须使用 role=conductor，不能把计划或报告作为用户任务重新入队。

POST /api/conductor/subagent
  body: {"prompt": "...", "request_id": "...", "llm_index": 3}
  启动一个子代理；llm_index 是 Conductor 对本次派单的显式模型请求。
  解析优先级：页面锁定 > 本次显式请求 > 默认子代理模型 > 主模型 > 全局首选。
  prompt 是 UTF-8 JSON 文本；必须原样保留中文、emoji 和路径。调用本机 API
  时直接使用 requests 的 json= 参数，不要让任务文字经过 shell 代码页转换。

模型策略：
  follow_main  未显式指定时跟随 Conductor 主模型。
  default      未显式指定时用页面默认模型；允许本次派单覆盖。
  locked       始终使用页面锁定模型；忽略本次派单的其他模型。

POST /api/conductor/approval       body: {"prompt": "...", "source": "..."}
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
        running = sum(1 for item in items if item.get("status") == "running")
        return running, max(0, len(items) - running)

    def get(self, sid: str) -> Optional[_MirrorState]:
        with self.lock:
            return self.subagents.get(sid)

    def snapshot(self) -> list[dict]:
        with self.lock:
            return [dict(item) for item in self._items]

    def keyinfo_subagent(self, sid: str, msg: str) -> dict:
        return self.client.subagent_action(sid, "keyinfo", msg)

    def abort_subagent(self, sid: str) -> dict:
        return self.client.subagent_action(sid, "abort")


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
                log.exception("Failed to publish conductor subagent snapshot")

    # request lifecycle ------------------------------------------------------
    def on_conductor_request_started(self, request_id: str):
        self.service.usage_store.begin(request_id)
        return self.service.usage_store.activate(request_id)

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
        latest = next(
            (
                item
                for item in reversed(getattr(self.service, "chat_messages", ()))
                if item.get("role") == "conductor"
                and item.get("request_id") == request_id
                and item.get("kind") == ("final" if status == "ok" else "error")
            ),
            None,
        )
        if latest is not None:
            payload["item"] = latest
        bus.publish("conductor:request_outcome", payload)

    def on_conductor_request_finished(self, request_id: str, token=None) -> None:
        try:
            if token is not None:
                self.service.usage_store.deactivate(token)
            self._publish_request_outcome(
                request_id,
                status="ok",
                phase="finish",
            )
        except Exception:
            log.exception("request finished handling failed")

    def on_conductor_request_yielded(self, request_id: str, token=None,
                                     outcome=None) -> None:
        """Close only this supervisor turn; the workflow remains active."""
        try:
            if token is not None:
                self.service.usage_store.deactivate(token)
            self._publish_request_outcome(
                request_id,
                status="yielded",
                phase=getattr(outcome, "phase", "yield") or "yield",
            )
        except Exception:
            log.exception("request yielded handling failed")

    def on_conductor_request_outcome(self, request_id: str, token=None,
                                     outcome=None) -> None:
        status = getattr(outcome, "status", "failed") or "failed"
        phase = getattr(outcome, "phase", "finish") or "finish"
        error = getattr(outcome, "error", "") or ""
        try:
            if token is not None:
                self.service.usage_store.deactivate(token)
            if status != "ok":
                tracker = self.service._ensure_workflow_tracker()
                transition = tracker.fail_supervisor(
                    request_id,
                    phase=phase,
                    error=error,
                )
                if transition is not None:
                    self.service._publish_workflow_transition(transition)
                elif tracker.snapshot(request_id) is None:
                    self.service.usage_store.complete(
                        request_id, f"FAILED_{phase.upper()}"
                    )
            self._publish_request_outcome(
                request_id, status=status, phase=phase, error=error
            )
        except Exception:
            log.exception("request outcome handling failed")

    # subagent lifecycle ------------------------------------------------------
    def on_subagent_event(self, agent_id: str, event, payload) -> None:
        name = _event_name(event)
        if name == "running":
            return
        if not isinstance(payload, dict):
            payload = dict(getattr(payload, "__dict__", {}) or {})
        service = self.service
        tracker = service._ensure_workflow_tracker()
        getter = getattr(getattr(service, "pool", None), "get", None)
        state = getter(agent_id) if callable(getter) else None
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
        self.publish_subagent_snapshot()

    def on_subagent_output(self, agent_id: str, output, done) -> None:
        """Legacy stream hook; snapshots now arrive via SSE subagents events."""
        if not done:
            self.publish_subagent_snapshot()

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
            bus.publish("conductor:log", {"item": dict(frame)})
        except Exception:
            # Logging is an observer path and must not fail a conductor request.
            log.exception("Failed to publish conductor log frame")

    def on_conductor_event(self, event_type: str, payload) -> None:
        try:
            payload = dict(payload or {})
            if event_type == "error":
                detail = str(payload.get("error", "")).strip()
                if not detail:
                    return
                latest = next(
                    (
                        item
                        for item in reversed(getattr(self.service, "chat_messages", ()))
                        if item.get("kind") == "error"
                    ),
                    None,
                )
                if latest is None or detail not in latest.get("msg", ""):
                    latest = add_chat(
                        f"Conductor reply failed: {detail}",
                        "error",
                        self.service.chat_messages,
                        kind="error",
                    )
                payload = {**payload, "item": latest}
            bus.publish(f"conductor:{event_type}", payload)
        except Exception:
            log.exception("conductor event handling failed")


class ConductorService:
    """Singleton GA-Hub product layer around the gahub_app engine."""
    _instance: Optional["ConductorService"] = None
    _lock = threading.Lock()

    def __init__(self):
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
        self.usage_store = RequestUsageStore()
        self.workflow_tracker = WorkflowTracker()
        self._dispatch_context = threading.local()
        self._started = False
        self._conductor_llm_index = None
        self._subagent_llm_index = None
        self._subagent_model_policy: SubagentModelPolicy = "follow_main"
        self._model_lock = threading.RLock()
        self.callbacks = HubConductorCallbacks(self)
        self._process_manager = GahubProcessManager()
        self.client = GaConductorClient(self._process_manager)
        self.pool = PoolMirror(self.client)
        self.timeout_monitor = TimeoutMonitor(self.pool, publish=bus.publish)
        self.timeout_monitor.start()
        self._relay_stop = threading.Event()
        self._relay_thread: Optional[threading.Thread] = None
        self._relayed_chat_ids: set[str] = set()
        self._lifecycle_cache: dict = {}

    @classmethod
    def instance(cls) -> "ConductorService":
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    def _ensure_shutdown_state(self) -> None:
        """Backfill lifecycle fields for legacy ``object.__new__`` tests."""
        if not hasattr(self, "_shutdown_lock"):
            self._shutdown_lock = threading.RLock()
        if not hasattr(self, "_shutdown_in_progress"):
            self._shutdown_in_progress = False
        if not hasattr(self, "_shutdown_complete"):
            self._shutdown_complete = False
        if not hasattr(self, "_shutdown_event"):
            self._shutdown_event = threading.Event()
            self._shutdown_event.set()
        if not hasattr(self, "_shutdown_core_stopped"):
            self._shutdown_core_stopped = False
        if not hasattr(self, "_shutdown_monitor_stopped"):
            self._shutdown_monitor_stopped = False
        if not hasattr(self, "_closed"):
            self._closed = False

    @staticmethod
    def _stop_result(result: object) -> bool:
        """Treat legacy best-effort ``None`` stop helpers as success."""
        return result is not False

    def shutdown(self, timeout: float = 2.0) -> bool:
        """Terminally close the engine session and monitor under one deadline."""
        self._ensure_shutdown_state()
        relay_stop = getattr(self, "_relay_stop", None)
        if relay_stop is not None:
            relay_stop.set()
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
                        timeout=max(0.0, deadline - time.monotonic())
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
            monitor = getattr(self, "timeout_monitor", None)
            if not monitor_ok:
                if monitor is None:
                    monitor_ok = True
                else:
                    try:
                        stop = getattr(monitor, "stop", None)
                        monitor_ok = (
                            True
                            if not callable(stop)
                            else self._stop_result(
                                stop(timeout=max(0.0, deadline - time.monotonic()))
                            )
                        )
                    except Exception:
                        monitor_ok = False
                        log.exception("conductor timeout monitor shutdown failed")
                self._shutdown_monitor_stopped = monitor_ok
        finally:
            with self._shutdown_lock:
                self._shutdown_core_stopped = bool(core_ok)
                self._shutdown_monitor_stopped = bool(monitor_ok)
                complete = bool(core_ok and monitor_ok)
                self._shutdown_complete = complete
                self._shutdown_in_progress = False
                event.set()

        if not complete:
            log.warning(
                "Conductor shutdown did not finish before deadline "
                "(core=%s monitor=%s)",
                core_ok,
                monitor_ok,
            )
        return complete

    def _assert_open(self) -> None:
        self._ensure_shutdown_state()
        with self._shutdown_lock:
            if self._closed:
                raise RuntimeError("Conductor service is closed")

    def _ensure_workflow_tracker(self) -> WorkflowTracker:
        """Backfill workflow state for focused tests and legacy adapters."""
        tracker = getattr(self, "workflow_tracker", None)
        if tracker is None:
            tracker = WorkflowTracker()
            self.workflow_tracker = tracker
        if not hasattr(self, "_dispatch_context"):
            self._dispatch_context = threading.local()
        if not hasattr(self, "_chat_lock"):
            self._chat_lock = threading.RLock()
        if not hasattr(self, "chat_messages"):
            self.chat_messages = []
        return tracker

    def _publish_workflow_transition(
        self, transition: tuple[str, dict]
    ) -> None:
        """Commit usage attribution before publishing one terminal workflow event."""
        topic, payload = transition
        request_id = payload["request_id"]
        if topic == "conductor:workflow_completed":
            self.usage_store.complete(request_id, "OK")
        elif topic == "conductor:workflow_failed":
            phase = str(payload.get("phase") or "subagent").upper()
            self.usage_store.complete(request_id, f"FAILED_{phase}")
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
        self._ensure_workflow_tracker()
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
            return add_chat(
                f"Conductor workflow failed during {phase}: {detail}",
                "conductor",
                self.chat_messages,
                request_id=request_id,
                kind="error",
            )

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
        its dispatch resolution and supervisor prompt stay in sync.
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
        client = getattr(self, "client", None)
        if client is None:
            return
        snapshot = snapshot or self.model_policy_snapshot()
        try:
            client.push_models(
                conductor_llm_index=snapshot["llm_index"],
                subagent_llm_index=snapshot["subagent_llm_index"],
                subagent_model_policy=snapshot["subagent_model_policy"],
                preferred_llm_index=_get_preferred_llm(),
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

    def resolve_subagent_model(
        self, requested_llm_index: Optional[int] = None
    ) -> Optional[int]:
        """Resolve one dispatch using the Hub policy priority chain."""
        return self._resolve_subagent_model_from_snapshot(
            requested_llm_index, self.model_policy_snapshot()
        )

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
        thread = self._relay_thread
        if thread is not None and thread.is_alive():
            return
        self._relay_stop.clear()
        self._relay_thread = threading.Thread(
            target=self.client.stream_events,
            args=(self._on_sse_event, self._relay_stop.is_set),
            name="conductor-sse-relay",
            daemon=True,
        )
        self._relay_thread.start()

    def ensure_started(self) -> bool:
        self._ensure_shutdown_state()
        with self._shutdown_lock:
            if self._closed:
                raise RuntimeError("Conductor service is closed")
        # The SSE relay spawns gahub_app asynchronously; a first message raced
        # that cold start and failed on connection refused. Wait for the
        # process here (idempotent, shared lock with the relay's spawn).
        manager = getattr(self, "_process_manager", None)
        if manager is not None:
            try:
                manager.ensure_running()
            except Exception as exc:
                raise RuntimeError(
                    f"gahub_app unavailable (see %TEMP%\gahub_app.log): {exc}"
                ) from exc
        self._ensure_relay()
        status = self.client.status()
        if not status.get("started"):
            self.client.start(llm_index=self._conductor_llm_index)
        self.lifecycle_status()
        return True

    def start(
        self,
        llm_index: Optional[int] = None,
        subagent_llm_index: Optional[int] = None,
        subagent_model_policy: Optional[SubagentModelPolicy] = None,
    ) -> bool:
        """Compatibility facade: configure models, then ensure lifecycle."""
        self.configure_models(
            llm_index=llm_index,
            subagent_llm_index=subagent_llm_index,
            subagent_model_policy=subagent_model_policy,
        )
        return self.ensure_started()

    def stop(self, timeout: float = 5.0) -> bool:
        try:
            result = self.client.stop(timeout=timeout)
            stopped = bool(result.get("stopped"))
        except Exception:
            log.exception("gahub_app stop failed")
            stopped = False
        self.lifecycle_status()
        return stopped

    def lifecycle_status(self) -> dict:
        try:
            status = self.client.status()
        except Exception:
            status = dict(self._lifecycle_cache or {})
            status.setdefault("started", False)
            status.setdefault("stopping", False)
            status.setdefault("admission_open", True)
            status.setdefault("loop_alive", False)
            status.setdefault("agent_alive", False)
        self._started = bool(status.get("started"))
        self._lifecycle_cache = status
        return status

    def notify(self, event: dict) -> bool:
        """Admit a user message into the gahub_app conductor inbox."""
        if event.get("type") != "user_message":
            return False
        self.client.post_chat(
            event.get("msg", ""), "user", event.get("request_id")
        )
        return True

    def get_conductor_log(self) -> list:
        try:
            return self.client.get_log()
        except Exception:
            log.debug("gahub_app log unavailable", exc_info=True)
            return []

    # ===== SSE relay dispatch =====

    def _on_sse_event(self, event: dict) -> None:
        kind = event.get("event")
        try:
            if kind == "hello":
                self.pool.update(event.get("subagents") or [])
                for item in (event.get("chat") or [])[-20:]:
                    self._on_remote_chat(item)
            elif kind == "request_started":
                self.usage_store.begin(event.get("request_id"))
            elif kind == "request_outcome":
                outcome = SimpleNamespace(
                    status=event.get("status"),
                    phase=event.get("phase"),
                    error=event.get("error", ""),
                )
                rid = event.get("request_id")
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
                bus.publish("conductor:chat_read", {})
            elif kind == "log":
                self.callbacks.on_conductor_log_frame(event.get("item") or {})
            elif kind == "usage":
                self._apply_usage_delta(event)
            elif kind == "request_yield_requested":
                bus.publish("conductor:request_yield_requested", {
                    "request_id": event.get("request_id"),
                    "reason": event.get("reason", ""),
                })
            elif kind == "error":
                payload = {k: v for k, v in event.items() if k != "event"}
                self.callbacks.on_conductor_event("error", payload)
        except Exception:
            log.exception("SSE relay handler failed for %s", kind)

    def _apply_usage_delta(self, event: dict) -> None:
        rid = event.get("request_id")
        if not rid:
            return
        if event.get("kind") == "usage":
            self.usage_store.apply_delta(
                rid,
                requests=1,
                input=int(event.get("input", 0) or 0),
                cache_create=int(event.get("cache_create", 0) or 0),
                cache_read=int(event.get("cache_read", 0) or 0),
            )
        else:
            self.usage_store.apply_delta(
                rid, output=int(event.get("tokens", 0) or 0)
            )

    def _on_remote_chat(self, item: dict) -> None:
        """Mirror conductor-role chat from gahub_app into the hub chat log."""
        if not item or item.get("id") in self._relayed_chat_ids:
            return
        self._relayed_chat_ids.add(item.get("id"))
        if len(self._relayed_chat_ids) > 500:
            self._relayed_chat_ids = set(list(self._relayed_chat_ids)[-250:])
        role = item.get("role") or "conductor"
        final = bool(item.get("final"))
        hub_item = add_chat(
            item.get("msg", ""), role, self.chat_messages,
            request_id=item.get("request_id"),
            kind=("final" if final else None),
        )
        if role == "conductor" and final and item.get("request_id"):
            tracker = self._ensure_workflow_tracker()
            try:
                transition = tracker.record_final(item["request_id"], hub_item)
                if transition is not None:
                    self._publish_workflow_transition(transition)
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
    ) -> dict:
        """Dispatch through the single Hub model-policy boundary."""
        self._assert_open()
        tracker = self._ensure_workflow_tracker()
        if request_id is not None and not tracker.has_request(request_id):
            raise ValueError(f"unknown conductor request_id: {request_id}")
        models = self.configure_models(
            llm_index=conductor_llm_index,
            subagent_llm_index=subagent_llm_index,
            subagent_model_policy=subagent_model_policy,
        )
        selected = self._resolve_subagent_model_from_snapshot(llm_index, models)
        result = self.client.start_subagent(prompt, request_id, selected)
        sid = result.get("id")
        if request_id and sid and "error" not in result:
            generation = int(result.get("active_generation", 0) or 0)
            completed = tracker.bind_subagent(request_id, sid, generation)
            if completed is not None:
                self._publish_workflow_transition(
                    ("conductor:workflow_completed", completed)
                )
            # gahub_app auto-yields the supervisor turn on dispatch.
            result.setdefault("request_id", request_id)
        result.setdefault("llm_index", selected)
        result.setdefault("model_policy", models["subagent_model_policy"])
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
    ) -> dict:
        """Resume a stopped worker through the same model-policy boundary."""
        self._assert_open()
        tracker = self._ensure_workflow_tracker()
        if request_id is not None and not tracker.has_request(request_id):
            raise ValueError(f"unknown conductor request_id: {request_id}")
        models = self.configure_models(
            llm_index=conductor_llm_index,
            subagent_llm_index=subagent_llm_index,
            subagent_model_policy=subagent_model_policy,
        )
        selected = self._resolve_subagent_model_from_snapshot(llm_index, models)
        result = self.client.subagent_action(
            sid, "input", msg, request_id=request_id, llm_index=selected
        )
        if "error" not in result:
            owner = request_id or tracker.request_for_subagent(sid)
            if owner:
                generation = int(result.get("active_generation", 0) or 0)
                tracker.bind_subagent(owner, sid, generation)
                result.setdefault("request_id", owner)
            # gahub_app auto-yields the supervisor turn on resume.
        result.setdefault("llm_index", selected)
        result.setdefault("model_policy", models["subagent_model_policy"])
        return result

    def accept_subagent(
        self, sid: str, msg: str = "", *, request_id: str | None = None
    ) -> dict:
        """Accept a pending worker and advance its request-scoped workflow."""
        self._assert_open()
        tracker = self._ensure_workflow_tracker()
        if request_id is not None and not tracker.has_request(request_id):
            raise ValueError(f"unknown conductor request_id: {request_id}")
        result = self.client.subagent_action(sid, "accept", msg, request_id=request_id)
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
    ) -> dict:
        """Rework a pending worker through the model-policy boundary."""
        self._assert_open()
        tracker = self._ensure_workflow_tracker()
        if request_id is not None and not tracker.has_request(request_id):
            raise ValueError(f"unknown conductor request_id: {request_id}")
        models = self.configure_models(
            llm_index=conductor_llm_index,
            subagent_llm_index=subagent_llm_index,
            subagent_model_policy=subagent_model_policy,
        )
        selected = self._resolve_subagent_model_from_snapshot(llm_index, models)
        result = self.client.subagent_action(
            sid, "rework", msg, request_id=request_id, llm_index=selected
        )
        if "error" not in result:
            owner = request_id or tracker.request_for_subagent(sid)
            if owner:
                generation = int(result.get("active_generation", 0) or 0)
                tracker.bind_subagent(owner, sid, generation)
                result.setdefault("request_id", owner)
            # gahub_app auto-yields the supervisor turn on rework.
        result.setdefault("llm_index", selected)
        result.setdefault("model_policy", models["subagent_model_policy"])
        return result

    # ===== snapshots & chat product surface =====

    def get_subagent_snapshot(self) -> list[dict]:
        """Pool snapshot (gahub_app enriches generation/request attribution)."""
        return self.pool.snapshot()

    def get_workflow_snapshot(self, limit: int = 20) -> list[dict]:
        """Expose the Hub-owned workflow projection for page reloads."""
        return self._ensure_workflow_tracker().snapshots(limit=limit)

    def add_chat_message(
        self,
        msg: str,
        role: str = "conductor",
        request_id: str | None = None,
        kind: str | None = None,
        llm_index: Optional[int] = None,
        subagent_llm_index: Optional[int] = None,
        subagent_model_policy: Optional[SubagentModelPolicy] = None,
    ) -> dict:
        self._assert_open()
        tracker = self._ensure_workflow_tracker()
        if kind is not None and role != "conductor":
            raise ValueError("kind is only valid for conductor messages")
        if kind == "final" and not request_id:
            raise ValueError("request_id is required for a final conductor message")
        if role != "user" and request_id and not tracker.has_request(request_id):
            raise ValueError(f"unknown conductor request_id: {request_id}")
        if kind == "final" and request_id:
            tracker.assert_ready_for_final(request_id)
        admitted_request_id = self.usage_store.begin() if role == "user" else request_id
        try:
            item = add_chat(
                msg,
                role,
                self.chat_messages,
                request_id=admitted_request_id,
                kind=kind,
            )
        except Exception:
            if role == "user" and admitted_request_id:
                self.usage_store.complete(admitted_request_id, "FAILED_ADMISSION")
            raise
        if role == "user" and admitted_request_id:
            tracker.admit(admitted_request_id)
            try:
                self.configure_models(
                    llm_index=llm_index,
                    subagent_llm_index=subagent_llm_index,
                    subagent_model_policy=subagent_model_policy,
                )
                self.ensure_started()
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
                accepted = self.notify({
                    "type": "user_message",
                    "msg": msg,
                    "request_id": admitted_request_id,
                })
                if not accepted:
                    raise RuntimeError("conductor stopped before event admission")
            except Exception:
                transition = tracker.fail_supervisor(
                    admitted_request_id,
                    phase="admission",
                    error="conductor event admission failed",
                )
                if transition is not None:
                    self._publish_workflow_transition(transition)
                raise
        elif role == "conductor" and kind == "final" and admitted_request_id:
            transition = tracker.record_final(admitted_request_id, item)
            if transition is not None:
                self._publish_workflow_transition(transition)
        return item

    def get_readmes(self) -> dict:
        return READMES

    def get_readme(self, topic: str) -> Optional[str]:
        return READMES.get(topic)


def shutdown_conductor_service(timeout: float = 2.0) -> bool:
    """Close the existing singleton without constructing one at app exit."""
    with ConductorService._lock:
        service = ConductorService._instance
    if service is None:
        return True
    return service.shutdown(timeout=timeout)
