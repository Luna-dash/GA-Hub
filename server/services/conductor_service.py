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

import logging
import queue
import re
import threading
import time
import uuid
from typing import Dict, Optional

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


def _apply_llm_selection(agent: GenericAgent, llm_index: Optional[int], label: str) -> None:
    selected = _resolve_llm_index(llm_index)
    if selected is None:
        return
    try:
        agent.load_llm_sessions()
        clients = getattr(agent, "llmclients", []) or []
        if 0 <= selected < len(clients):
            agent.next_llm(selected)
            source = "page" if llm_index is not None else "preferred_llm_no"
            log.info("%s selected LLM %s via %s", label, selected, source)
        else:
            log.warning("%s requested invalid LLM index %s (available=%s)", label, selected, len(clients))
    except Exception as e:
        log.warning("Failed to set LLM for %s: %s", label, e)

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
            push_subagent_cards(pool.snapshot())
        if "done" in item:
            done = budget.finish(item.get("done") or budget.output)
            accepted = display(done, done=True)
            push_subagent_cards(pool.snapshot())
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

POST /api/conductor/chat           body: {"msg": "..."}  给用户发消息
POST /api/conductor/subagent       body: {"prompt": "..."}  启动新subagent
POST /api/conductor/approval       body: {"prompt": "...", "source": "..."}  推待批任务
POST /api/conductor/subagent/{id}  body: {"action": "keyinfo", "msg": "..."}  注入key_info
POST /api/conductor/subagent/{id}  body: {"action": "input", "msg": "..."}  追加任务
POST /api/conductor/subagent/{id}  body: {"action": "stop"}  中断执行
GET /api/conductor/chat?last=N     返回最近N条对话（默认20）
GET /api/conductor/subagent        返回 {"items": [...]}  查看所有subagent状态
GET /api/conductor/subagent/{id}?max_len=N  返回单个subagent详情
""",
    "usermsg": """用户消息流程：
1. 结合记忆、上下文和用户偏好判断真实需求；不清楚时用精简checklist一次性问用户。
2. 判断是新任务还是延续现有任务；优先复用已有stopped subagent（用input追加）。
3. 分派前必须POST /api/conductor/chat告知用户：改写后的prompt + 分派方案。
4. 执行分派，完成即停。危险操作必须改成先让subagent出方案；验收后请用户确认。""",
    "subagent": """subagent完成流程：
1. 读subagent输出；若最后一条不足以判断，GET /api/conductor/subagent/{id}?max_len=3000 补足信息。
2. 预测用户是否满意；不满意就reply/keyinfo要求返工、修改、优化，继续监督。
3. 预计用户满意后，POST /api/conductor/chat给简洁交付报告。""",
}


class HubConductorCallbacks(ConductorCallbacks):
    """Translate shared-core lifecycle events into GA-Hub EventBus events."""
    def __init__(self, service: "ConductorService"):
        self.service = service

    def on_conductor_request_started(self, request_id: str):
        return self.service.usage_store.activate(request_id)

    def on_conductor_request_finished(self, request_id: str, token) -> None:
        try:
            self.service.usage_store.complete(request_id)
        finally:
            if token is not None:
                self.service.usage_store.deactivate(token)

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
            if token is not None:
                self.service.usage_store.deactivate(token)

    def on_subagent_output(self, agent_id: str, output: str, done: bool) -> None:
        push_subagent_cards(self.service.pool.snapshot())
        bus.publish("conductor:subagent_output", {
            "id": agent_id, "done": done, "output_len": len(output),
        })

    def on_subagent_completed(self, agent_id: str, output: str) -> None:
        """The generation-aware monitor emits the single conductor wake-up."""
        pass

    def on_subagent_event(self, agent_id: str, event: SubAgentEvent, payload: dict) -> None:
        bus.publish(f"conductor:subagent_{event.value}", {"id": agent_id, **payload})

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
        self.callbacks = HubConductorCallbacks(self)
        # The pool is constructed first because the monitor bridge needs it.
        runtime = PoolRuntime(
            agent_factory=GenericAgent,
            on_display_fn=lambda sid, dq, done, generation=None: _monitor_core_display(
                sid, dq, done, self.pool, generation=generation
            ),
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

    def shutdown(self) -> None:
        """Stop Hub-owned background helpers without creating new work."""
        self.timeout_monitor.stop()

    def _build_prompt(self, events: list) -> str:
        running, stopped = self.pool.counts()
        unread = sum(1 for m in self.chat_messages if m.get("role") == "user" and not m.get("read"))
        if unread:
            for m in self.chat_messages:
                if m.get("role") == "user" and not m.get("read"):
                    m["read"] = True
            bus.publish("conductor:chat_read", {})
        done_count = sum(1 for e in events if e.get("type") == "subagent_done")
        summary = f"subagents: {running} running, {stopped} stopped | {unread}???????, {done_count}?subagent????"
        base = f"http://{HOST}:{_get_webui_port()}/api/conductor"
        return f"""??agent??????????????????????????????????agent????
API: {base}??requests?GET /api/conductor/readme????GET /api/conductor/chat??????GET /api/conductor/subagent????POST /api/conductor/chat???????????
????????: GET /api/conductor/readme/usermsg | GET /api/conductor/readme/subagent

???
- ????????/???????????subagent???????????????
- ????????????????/?subagent/reply/keyinfo/abort?????????????????
- ??prompt??????????????????????????/????????

???
- ??subagent??????????????????????????????????????
{summary}"""

    def start(self, llm_index: Optional[int] = None) -> bool:
        if llm_index is not None:
            self._conductor_llm_index = llm_index
        started = self.conductor.start()
        self._started = self.conductor.started
        return started

    def stop(self, timeout: float = 5.0) -> bool:
        stopped = self.conductor.stop(timeout=timeout)
        self._started = self.conductor.started
        return stopped

    def notify(self, event: dict) -> bool:
        return self.conductor.notify(event)

    def get_chat_messages(self, last: int = 20) -> list:
        return self.chat_messages[-last:]

    def add_chat_message(self, msg: str, role: str = "conductor", llm_index: Optional[int] = None) -> dict:
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
                self.start(llm_index)
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
