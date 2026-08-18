"""ConductorService — multi-agent orchestration with supervisor pattern.

Manages one conductor (supervisor) agent that delegates to a pool of
subagents. The conductor monitors user messages, subagent completion
events, and dispatches/reviews/reports work.

Architecture differences from standalone conductor.py:
- Uses EventBus instead of custom WS broadcast
- Singleton pattern aligned with other GA-Hub services
- No IM poller (rely on wechat_service/feishu_service)
- Subagents are independent GenericAgent instances (don't touch AgentService singleton)
"""
from __future__ import annotations

import inspect
import logging
import queue
import re
import threading
import time
import uuid
from typing import Dict, Literal, Optional

from .. import _paths

if _paths.GA_ROOT is None:
    raise RuntimeError("ConductorService imported before GA_ROOT is configured")

from agentmain import GenericAgent  # noqa: E402
from frontends.conductor_core import (
    Conductor as CoreConductor,
    ConductorCallbacks,
    PoolRuntime,
    RequestOutcome,
    SubAgentEvent,
    SubagentPool as CoreSubagentPool,
)

from .conductor_ext_contract import ConductorContractExt  # noqa: E402
from .conductor_ext_timeout import OutputBudget, TimeoutMonitor  # noqa: E402
from .event_bus import bus  # noqa: E402
from .request_usage import RequestUsageStore  # noqa: E402

log = logging.getLogger(__name__)

# Constants
HOST = "127.0.0.1"
PORT = None  # Not needed, integrated into main GA-Hub server

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


def _get_webui_port() -> int:
    """Read the actual webui port (used by conductor prompt)."""
    try:
        import mykey  # type: ignore
        port = int(getattr(mykey, "webui_port", 8765) or 8765)
        return port
    except Exception:
        return 8765


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


def _resolve_llm_index(llm_index: Optional[int] = None) -> Optional[int]:
    """Page-scoped LLM wins; persisted/global preference is fallback."""
    if llm_index is not None:
        try:
            return int(llm_index)
        except Exception:
            return None
    return _get_preferred_llm()


def _apply_llm_selection(agent: GenericAgent, llm_index: Optional[int], label: str) -> bool:
    selected = _resolve_llm_index(llm_index)
    if selected is None:
        return False
    try:
        agent.load_llm_sessions()
        clients = getattr(agent, "llmclients", []) or []
        if 0 <= selected < len(clients):
            agent.next_llm(selected)
            source = "page" if llm_index is not None else "preferred_llm_no"
            log.info("%s selected LLM %s via %s", label, selected, source)
            return True
        else:
            log.warning("%s requested invalid LLM index %s (available=%s)", label, selected, len(clients))
    except Exception as e:
        log.warning("Failed to set LLM for %s: %s", label, e)
    return False

_TURN_SPLIT_RE = re.compile(r'\**LLM Running \(Turn \d+\) \.\.\.\**')
_SUMMARY_RE = re.compile(r'<summary>(.*?)</summary>\s*', re.DOTALL)


def now_ms() -> int:
    return int(time.time() * 1000)


def short_id() -> str:
    return uuid.uuid4().hex[:8]


def extract_last_summary(full: str) -> str:
    """Extract the latest <summary> content for in-progress display."""
    matches = _SUMMARY_RE.findall(full or "")
    if not matches:
        return ""
    s = matches[-1].strip()
    return s[-1000:] if len(s) > 1000 else s


def extract_last_text_reply(full: str) -> str:
    """Extract only the last turn's text reply (like stapp.py fold_turns logic)."""
    parts = _TURN_SPLIT_RE.split(full)
    last = parts[-1] if parts else full
    last = _SUMMARY_RE.sub('', last)
    last = re.sub(r'\[(Status|Info)\][^\n]*\n?', '', last)
    last = last.strip()
    return last[-3000:] if len(last) > 3000 else last


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


def push_subagent_cards(snapshot: list):
    """Publish subagent pool snapshot to event bus."""
    bus.publish("conductor:subagents", {"items": snapshot})


def add_chat(
    msg: str,
    role: str,
    chat_messages: list,
    request_id: str | None = None,
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
    chat_messages.append(item)
    if len(chat_messages) > 200:
        del chat_messages[:-200]
    bus.publish("conductor:chat", {"item": item})
    return item


def start_agent_runner(agent: GenericAgent, name: str) -> threading.Thread:
    t = threading.Thread(target=agent.run, name=name, daemon=True)
    t.start()
    return t


def monitor_display_queue(
    agent_id: str,
    dq: queue.Queue,
    pool: SubagentPool,
    trigger_when_done: bool,
    *,
    generation: int | None = None,
):
    """Monitor subagent display queue and update pool state."""
    budget = OutputBudget(agent_id, publish=bus.publish)

    def display(output: str, done: bool) -> bool:
        if generation is None:
            result = pool.on_display(agent_id, output, done=done)
        else:
            result = pool.on_display(
                agent_id, output, done=done, generation=generation
            )
        # Legacy pools returned None after accepting an update.
        return result is not False

    while True:
        item = dq.get()
        if "next" in item:
            output = budget.append(item.get("next") or "")
            display(output, done=False)
        if "done" in item:
            done = budget.finish(item.get("done") or budget.output)
            accepted = display(done, done=True)
            if trigger_when_done and accepted:
                # Notify conductor that subagent finished
                ConductorService.instance().notify({
                    "type": "subagent_done",
                    "id": agent_id,
                    "reply": done,
                    "generation": generation,
                })
            break



READMES = {
    "api": """Conductor API (integrated into GA-Hub)

POST /api/conductor/chat
  body: {"msg": "...", "role": "user", "llm_index": 1,
         "subagent_llm_index": 5, "subagent_model_policy": "default"}
  添加用户消息、更新页面模型配置，并确保 Conductor 已启动。

POST /api/conductor/subagent
  body: {"prompt": "...", "llm_index": 3}
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
POST /api/conductor/subagent/{id}  body: {"action": "stop"}
GET  /api/conductor/chat?last=N
GET  /api/conductor/subagent
GET  /api/conductor/subagent/{id}?max_len=N
""",
    "usermsg": """用户消息流程：
1. 结合记忆、上下文和用户偏好判断真实需求；不清楚时用精简checklist一次性问用户。
2. 判断是新任务还是延续现有任务；优先复用已有stopped subagent（用input追加）。
3. 分派前必须POST /api/conductor/chat告知用户：改写后的prompt + 分派方案。
4. 派发时可用 llm_index 指定本次子代理模型；locked 策略下页面锁定值优先。
5. 执行分派，完成即停。危险操作必须改成先让subagent出方案；验收后请用户确认。""",
    "subagent": """subagent完成流程：
1. 读subagent输出；若最后一条不足以判断，GET /api/conductor/subagent/{id}?max_len=3000 补足信息。
2. 预测用户是否满意；不满意就reply/keyinfo要求返工、修改、优化，继续监督。
3. 预计用户满意后，POST /api/conductor/chat给简洁交付报告。""",
}


class HubConductorCallbacks(ConductorCallbacks):
    """Translate shared-core lifecycle events into GA-Hub EventBus events."""
    def __init__(self, service: "ConductorService"):
        self.service = service
        self._snapshot_publish_lock = threading.Lock()
        self._last_subagent_snapshot: list | None = None

    def publish_subagent_snapshot(self) -> None:
        """Publish changed pool state without allowing concurrent reordering."""
        with self._snapshot_publish_lock:
            try:
                snapshot = self.service.pool.snapshot()
                if snapshot == self._last_subagent_snapshot:
                    return
                push_subagent_cards(snapshot)
                # Keep the old value when publishing fails so a later event retries.
                self._last_subagent_snapshot = snapshot
            except Exception:
                # Observer failures must not change an already committed pool action.
                log.exception("Failed to publish conductor subagent snapshot")

    def on_conductor_request_started(self, request_id: str):
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
            ),
            None,
        )
        if latest is not None:
            payload["item"] = latest
        bus.publish("conductor:request_outcome", payload)

    def on_conductor_request_finished(self, request_id: str, token) -> None:
        try:
            self.service.usage_store.complete(request_id)
        finally:
            try:
                if token is not None:
                    self.service.usage_store.deactivate(token)
            finally:
                self._publish_request_outcome(
                    request_id,
                    status="ok",
                    phase="finish",
                )

    def on_conductor_request_outcome(
        self, request_id: str, token, outcome: RequestOutcome
    ) -> None:
        attribution = (
            "OK"
            if outcome.status == "ok"
            else f"FAILED_{outcome.phase.upper()}"
        )
        try:
            self.service.usage_store.complete(request_id, attribution)
        finally:
            try:
                if token is not None:
                    self.service.usage_store.deactivate(token)
            finally:
                self._publish_request_outcome(
                    request_id,
                    status=outcome.status,
                    phase=outcome.phase,
                    error=outcome.error or "",
                )

    def on_subagent_output(self, agent_id: str, output: str, done: bool) -> None:
        if not done:
            self.publish_subagent_snapshot()

    def on_subagent_completed(self, agent_id: str, output: str) -> None:
        """The generation-aware monitor emits the single conductor wake-up."""
        pass

    def on_subagent_event(self, agent_id: str, event: SubAgentEvent, payload: dict) -> None:
        # RUNNING is emitted for every output chunk; the snapshot above is the
        # authoritative UI update, so a second per-chunk lifecycle frame only
        # increases queue pressure without adding information.
        if event == SubAgentEvent.RUNNING:
            return
        try:
            bus.publish(
                f"conductor:subagent_{event.value}", {"id": agent_id, **payload}
            )
        except Exception:
            log.exception("Failed to publish conductor subagent lifecycle event")
        self.publish_subagent_snapshot()

    def on_conductor_log_frame(self, frame: object) -> None:
        """Bridge the shared core's private log frame to the Hub event bus."""
        try:
            if not isinstance(frame, dict) or frame.get("type") != "log":
                return
            item = frame.get("item")
            if not isinstance(item, dict):
                return
            if not (
                isinstance(item.get("id"), str)
                and isinstance(item.get("ts"), int)
                and isinstance(item.get("event"), str)
                and isinstance(item.get("text"), str)
                and (item.get("turn") is None or isinstance(item.get("turn"), int))
            ):
                return
            bus.publish("conductor:log", {"item": dict(item)})
        except Exception:
            # Logging is an observer path and must not fail a conductor request.
            log.exception("Failed to publish conductor log frame")

    def on_conductor_event(self, event_type: str, payload: dict) -> None:
        bus.publish(f"conductor:{event_type}", payload)


def _new_agent(llm_index: Optional[int] = None, label: str = "Conductor agent") -> GenericAgent:
    agent = GenericAgent()
    agent.inc_out = True
    _apply_llm_selection(agent, llm_index, label)
    return agent


def _configure_subagent(agent: GenericAgent, llm_index=None) -> bool:
    agent.verbose = False
    agent.no_print = True
    return _apply_llm_selection(agent, llm_index, "Subagent")


def _monitor_core_display(
    agent_id: str,
    dq: queue.Queue,
    trigger_when_done: bool,
    pool,
    *,
    generation: int | None = None,
):
    """Runtime bridge: retain Hub display behavior while core owns orchestration."""
    monitor_display_queue(
        agent_id,
        dq,
        pool,
        trigger_when_done,
        generation=generation,
    )


class ConductorService:
    """Singleton GA-Hub adapter around the shared GA conductor core."""
    _instance: Optional["ConductorService"] = None
    _lock = threading.Lock()

    def __init__(self):
        # Application shutdown is a terminal lifecycle separate from the
        # user-facing ``stop`` route.  Keep the singleton alive while a close
        # is in progress (or after a timeout) so a late request cannot create a
        # second core/monitor pair beside the one still being reaped.
        self._shutdown_lock = threading.RLock()
        self._shutdown_in_progress = False
        self._shutdown_complete = False
        self._shutdown_event = threading.Event()
        self._shutdown_event.set()
        self._shutdown_core_stopped = False
        self._shutdown_monitor_stopped = False
        self._closed = False
        self.chat_messages: list = []
        self.usage_store = RequestUsageStore()
        try:
            import cost_tracker
            cost_tracker.set_usage_sink(self.usage_store.record)
            cost_tracker.install()
        except Exception:
            # The shared GA core remains usable without the optional tracker.
            log.debug("Direct usage attribution sink unavailable", exc_info=True)
        self._started = False
        self._conductor_llm_index = None
        self._subagent_llm_index = None
        self._subagent_model_policy: SubagentModelPolicy = "follow_main"
        self._model_lock = threading.RLock()
        self.callbacks = HubConductorCallbacks(self)
        # The pool is constructed first because the monitor bridge needs it.
        runtime = PoolRuntime(
            agent_factory=GenericAgent,
            on_display_fn=lambda sid, dq, done, generation=None: _monitor_core_display(
                sid, dq, done, self.pool, generation=generation
            ),
            # The service resolves one immutable dispatch snapshot before
            # entering the GA core.  The injected selector only applies that
            # resolved index, so a concurrent policy update cannot re-route an
            # already admitted dispatch.
            llm_selector=_configure_subagent,
        )
        self.pool = CoreSubagentPool(runtime=runtime, callbacks=self.callbacks)
        self.contract_ext = ConductorContractExt(self.pool, publish=bus.publish)
        self.timeout_monitor = TimeoutMonitor(self.pool, publish=bus.publish)
        self.timeout_monitor.start()
        self.conductor = CoreConductor(
            pool=self.pool,
            prompt_builder=self._build_prompt,
            agent_factory=lambda: _new_agent(self._conductor_llm_index),
            callbacks=self.callbacks,
        )

    @classmethod
    def instance(cls) -> "ConductorService":
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    def _ensure_shutdown_state(self) -> None:
        """Backfill lifecycle fields for legacy ``object.__new__`` tests.

        A few integrations construct a service shell without invoking
        ``__init__`` to exercise one method in isolation.  Keeping this small
        compatibility shim avoids making those callers know about the new
        terminal-close state while normal instances initialize everything
        eagerly above.
        """
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
        """Interpret old best-effort stop helpers compatibly.

        The shared core and the timeout monitor return ``bool``.  Treating a
        legacy ``None`` return as success preserves compatibility with simple
        test doubles and older adapters; an explicit ``False`` remains a
        failed/retryable close.
        """
        return result is not False

    def shutdown(self, timeout: float = 2.0) -> bool:
        """Terminally close the core and monitor under one shared deadline.

        Exactly one caller owns cleanup for an attempt.  Concurrent callers
        wait on that attempt's event for their own remaining budget and never
        run a second ``stop`` pair concurrently.  A timeout or exception keeps
        the singleton closed but retryable; only a complete core+monitor reap
        is cached as successful.
        """
        self._ensure_shutdown_state()
        deadline = time.monotonic() + max(0.0, float(timeout))

        with self._shutdown_lock:
            if self._shutdown_complete:
                return True
            if self._shutdown_in_progress:
                event = self._shutdown_event
                remaining = max(0.0, deadline - time.monotonic())
                # Do not hold the lifecycle lock while waiting for the owner.
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
            conductor = getattr(self, "conductor", None)
            if not core_ok:
                if conductor is None:
                    core_ok = True
                else:
                    try:
                        stop = getattr(conductor, "stop", None)
                        core_ok = (
                            True
                            if not callable(stop)
                            else self._stop_result(
                                stop(timeout=max(0.0, deadline - time.monotonic()))
                            )
                        )
                    except Exception:
                        core_ok = False
                        log.exception("conductor core shutdown failed")
                self._shutdown_core_stopped = core_ok

            # Always attempt the monitor, even when the core raised or used up
            # the whole deadline.  Passing the remaining budget (including
            # zero) keeps the two components within one atomic time envelope.
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
        model.
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
            return self.model_policy_snapshot()

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

    def _build_prompt(self, events: list) -> str:
        running, stopped = self.pool.counts()
        unread = sum(1 for m in self.chat_messages if m.get("role") == "user" and not m.get("read"))
        if unread:
            for m in self.chat_messages:
                if m.get("role") == "user" and not m.get("read"):
                    m["read"] = True
            bus.publish("conductor:chat_read", {})
        done_count = sum(1 for e in events if e.get("type") == "subagent_done")
        summary = (
            f"subagents: {running} running, {stopped} stopped | "
            f"{unread} unread user messages, {done_count} completed events"
        )
        base = f"http://{HOST}:{_get_webui_port()}/api/conductor"
        models = self.model_policy_snapshot()
        return f"""You are the Conductor supervisor. Delegate independent work to subagents and report concise results to the user.
API base: {base}. Use GET /api/conductor/readme for the complete contract.

Subagent model routing:
- Current policy: {models['subagent_model_policy']}
- Conductor model index: {models['llm_index']}
- Default/locked subagent model index: {models['subagent_llm_index']}
- To request a model for one dispatch, POST /api/conductor/subagent with
  {{"prompt": "...", "llm_index": N}}. The locked policy overrides N;
  otherwise an explicit N overrides the configured default.

Operating rules:
- Reuse a suitable stopped subagent when continuing the same task.
- Before dispatching, explain the rewritten prompt and delegation plan through POST /api/conductor/chat.
- Preserve Unicode task text exactly. Send self-API requests as UTF-8 JSON (prefer Python requests with json=); never round-trip prompts through a shell code page.
- Use subagent input/keyinfo/abort actions as needed, then verify results before reporting completion.
- Do not perform destructive work without first obtaining a plan and user confirmation.

Current state: {summary}"""

    def ensure_started(self) -> bool:
        self._ensure_shutdown_state()
        with self._shutdown_lock:
            if self._closed:
                raise RuntimeError("Conductor service is closed")
            start = self.conductor.start
            if _accepts_keyword(start, "log_broadcaster"):
                started = start(
                    log_broadcaster=self.callbacks.on_conductor_log_frame
                )
            else:
                log.warning("GA conductor core lacks log_broadcaster support")
                started = start()
        self.lifecycle_status()
        return started

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

    def start_subagent(
        self,
        prompt: str,
        llm_index: Optional[int] = None,
        *,
        conductor_llm_index: Optional[int] = None,
        subagent_llm_index: Optional[int] = None,
        subagent_model_policy: Optional[SubagentModelPolicy] = None,
    ) -> dict:
        """Dispatch through the single Hub model-policy boundary."""
        self._assert_open()
        models = self.configure_models(
            llm_index=conductor_llm_index,
            subagent_llm_index=subagent_llm_index,
            subagent_model_policy=subagent_model_policy,
        )
        selected = self._resolve_subagent_model_from_snapshot(llm_index, models)
        result = self.pool.start_subagent(prompt, llm_index=selected)
        result.setdefault("llm_index", selected)
        result.setdefault("model_policy", models["subagent_model_policy"])
        return result

    def input_subagent(
        self,
        sid: str,
        msg: str,
        llm_index: Optional[int] = None,
        *,
        conductor_llm_index: Optional[int] = None,
        subagent_llm_index: Optional[int] = None,
        subagent_model_policy: Optional[SubagentModelPolicy] = None,
    ) -> dict:
        """Resume a stopped worker through the same model-policy boundary."""
        self._assert_open()
        models = self.configure_models(
            llm_index=conductor_llm_index,
            subagent_llm_index=subagent_llm_index,
            subagent_model_policy=subagent_model_policy,
        )
        selected = self._resolve_subagent_model_from_snapshot(llm_index, models)
        result = self.pool.input_subagent(sid, msg, llm=selected)
        if "error" not in result:
            # The shared core currently emits no lifecycle event for a plain
            # input resume, so expose the committed running state immediately.
            self.callbacks.publish_subagent_snapshot()
        result.setdefault("llm_index", selected)
        result.setdefault("model_policy", models["subagent_model_policy"])
        return result

    def stop(self, timeout: float = 5.0) -> bool:
        stopped = self.conductor.stop(timeout=timeout)
        self.lifecycle_status()
        return stopped

    def lifecycle_status(self) -> dict[str, bool]:
        """Return the shared core's live lifecycle state."""
        status = self.conductor.lifecycle_snapshot()
        self._started = status["started"]
        return status

    def notify(self, event: dict) -> bool:
        return self.conductor.notify(event)

    def get_chat_messages(self, last: int = 20) -> list:
        return self.chat_messages[-last:]

    def add_chat_message(
        self,
        msg: str,
        role: str = "conductor",
        llm_index: Optional[int] = None,
        subagent_llm_index: Optional[int] = None,
        subagent_model_policy: Optional[SubagentModelPolicy] = None,
    ) -> dict:
        self._assert_open()
        request_id = self.usage_store.begin() if role == "user" else None
        try:
            item = add_chat(
                msg,
                role,
                self.chat_messages,
                request_id=request_id,
            )
        except Exception:
            if request_id:
                self.usage_store.complete(request_id, "FAILED_ADMISSION")
            raise
        if request_id:
            try:
                self.configure_models(
                    llm_index=llm_index,
                    subagent_llm_index=subagent_llm_index,
                    subagent_model_policy=subagent_model_policy,
                )
                self.ensure_started()
            except Exception:
                self.usage_store.complete(request_id, "FAILED_START")
                raise
            try:
                accepted = self.notify({
                    "type": "user_message",
                    "msg": msg,
                    "request_id": request_id,
                })
                if not accepted:
                    raise RuntimeError("conductor stopped before event admission")
            except Exception:
                self.usage_store.complete(request_id, "FAILED_ADMISSION")
                raise
        return item

    def get_readmes(self) -> dict:
        return READMES

    def get_readme(self, topic: str) -> Optional[str]:
        return READMES.get(topic)

    def get_conductor_log(self) -> list:
        return self.conductor.log


def shutdown_conductor_service(timeout: float = 2.0) -> bool:
    """Close the existing singleton without constructing one at app exit.

    Unlike restartable service registries, the terminally closed instance is
    intentionally retained.  This prevents a late request during ASGI
    teardown from installing a second core while a timed-out first owner is
    still finishing, and it lets a later shutdown call reap that same owner.
    """
    with ConductorService._lock:
        service = ConductorService._instance
    if service is None:
        return True
    return service.shutdown(timeout=timeout)
