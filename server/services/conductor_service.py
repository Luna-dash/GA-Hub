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
from dataclasses import dataclass, field
from typing import Dict, Optional

from .. import _paths

if _paths.GA_ROOT is None:
    raise RuntimeError("ConductorService imported before GA_ROOT is configured")

from agentmain import GenericAgent  # noqa: E402

from .event_bus import bus  # noqa: E402

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


def add_chat(msg: str, role: str, chat_messages: list) -> dict:
    """Add message to chat history and publish to event bus."""
    item = {
        "id": short_id(),
        "role": role,
        "msg": msg,
        "ts": now_ms(),
        "read": role != "user"
    }
    chat_messages.append(item)
    if len(chat_messages) > 200:
        del chat_messages[:-200]
    bus.publish("conductor:chat", {"item": item})
    return item


def start_agent_runner(agent: GenericAgent, name: str) -> threading.Thread:
    t = threading.Thread(target=agent.run, name=name, daemon=True)
    t.start()
    return t


def monitor_display_queue(agent_id: str, dq: queue.Queue, pool: SubagentPool, trigger_when_done: bool):
    """Monitor subagent display queue and update pool state."""
    acc = ""
    while True:
        item = dq.get()
        if "next" in item:
            chunk = item.get("next") or ""
            acc += chunk
            pool.on_display(agent_id, acc, done=False)
            push_subagent_cards(pool.snapshot())
        if "done" in item:
            done = item.get("done") or acc
            pool.on_display(agent_id, done, done=True)
            push_subagent_cards(pool.snapshot())
            if trigger_when_done:
                # Notify conductor that subagent finished
                ConductorService.instance().notify({"type": "subagent_done", "id": agent_id, "reply": done})
            break


@dataclass
class SubAgentState:
    id: str
    agent: GenericAgent
    prompt: str
    thread: Optional[threading.Thread] = None
    reply: str = ""
    status: str = "running"  # running | stopped
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)


class SubagentPool:
    """Manages a pool of independent subagent instances."""

    def __init__(self):
        self.subagents: Dict[str, SubAgentState] = {}
        self.lock = threading.RLock()
        threading.Thread(target=self._auto_cleanup_loop, name="subagent-cleanup", daemon=True).start()

    def snapshot(self) -> list[dict]:
        with self.lock:
            return [
                {
                    "id": s.id,
                    "prompt": s.prompt,
                    "reply": (
                        extract_last_summary(s.reply) if s.status == "running"
                        else extract_last_text_reply(s.reply)
                    ) if s.reply else "",
                    "status": s.status,
                    "created_at": s.created_at,
                    "updated_at": s.updated_at,
                }
                for s in self.subagents.values()
            ]

    def get(self, sid: str) -> Optional[SubAgentState]:
        with self.lock:
            return self.subagents.get(sid)

    def counts(self) -> tuple:
        with self.lock:
            running = sum(1 for s in self.subagents.values() if s.status == "running")
            stopped = sum(1 for s in self.subagents.values() if s.status != "running")
        return running, stopped

    def on_display(self, agent_id: str, acc: str, done: bool):
        with self.lock:
            s = self.subagents.get(agent_id)
            if s:
                s.reply = acc
                s.updated_at = time.time()
                s.status = "stopped" if done else "running"

    def _auto_cleanup_loop(self):
        IDLE_TIMEOUT = 3600
        while True:
            time.sleep(300)
            now = time.time()
            to_abort = []
            with self.lock:
                for sid, s in self.subagents.items():
                    if s.status == "stopped" and (now - s.updated_at) > IDLE_TIMEOUT:
                        to_abort.append((sid, s))
            for sid, s in to_abort:
                s.agent.abort()
                s.agent.task_queue.put("EXIT")
                with self.lock:
                    self.subagents.pop(sid, None)
            if to_abort:
                push_subagent_cards(self.snapshot())

    def start_subagent(self, prompt: str) -> dict:
        sid = short_id()
        agent = GenericAgent()
        agent.inc_out = True
        agent.verbose = False
        agent.no_print = True
        th = start_agent_runner(agent, f"subagent-{sid}")
        state = SubAgentState(id=sid, agent=agent, prompt=prompt, status="running", thread=th)
        with self.lock:
            self.subagents[sid] = state
        return self._send_msg(sid, prompt)

    def _send_msg(self, sid: str, msg: str) -> dict:
        with self.lock:
            s = self.subagents.get(sid)
        if not s:
            return {"error": "subagent not found", "id": sid}
        dq = s.agent.put_task(msg, source=f"subagent:{sid}")
        threading.Thread(
            target=monitor_display_queue,
            args=(sid, dq, self, True),
            name=f"monitor-{sid}",
            daemon=True
        ).start()
        push_subagent_cards(self.snapshot())
        return {"id": sid, "status": "running"}

    def input_subagent(self, sid: str, msg: str) -> dict:
        with self.lock:
            s = self.subagents.get(sid)
        if not s:
            return {"error": "subagent not found", "id": sid}
        if s.status == "running":
            return {
                "error": "subagent is still running, cannot input/reply. Start a new subagent instead.",
                "id": sid
            }
        s.prompt = msg
        s.reply = ""
        s.status = "running"
        s.updated_at = time.time()
        return self._send_msg(sid, msg)

    def keyinfo_subagent(self, sid: str, msg: str) -> dict:
        with self.lock:
            s = self.subagents.get(sid)
        if not s:
            return {"error": "subagent not found", "id": sid}
        h = s.agent.handler
        h.working['key_info'] = h.working.get('key_info', '') + f"\n[MASTER] {msg}"
        s.updated_at = time.time()
        return {"id": sid, "status": "keyinfo_injected"}

    def abort_subagent(self, sid: str) -> dict:
        with self.lock:
            s = self.subagents.get(sid)
        if not s:
            return {"error": "subagent not found", "id": sid}
        s.agent.abort()
        s.status = "stopped"
        s.updated_at = time.time()
        push_subagent_cards(self.snapshot())
        return {"id": sid, "status": "stopped"}


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


class Conductor:
    """The supervisor agent that orchestrates subagents."""

    LOG_MAX = 50

    def __init__(self, pool: SubagentPool, chat_messages: list):
        self.pool = pool
        self.chat_messages = chat_messages
        self.inbox: queue.Queue[dict] = queue.Queue()
        self.agent: Optional[GenericAgent] = None
        self.started = False
        self.log: list = []

    def notify(self, event: dict):
        """Thread-safe: enqueue event to wake conductor."""
        self.inbox.put(event)

    def _build_prompt(self, events: list) -> str:
        running, stopped = self.pool.counts()
        unread = sum(1 for m in self.chat_messages if m.get("role") == "user" and not m.get("read"))
        # Mark user messages as read now that the conductor is processing them.
        # (Front-end polling of GET /chat must NOT mark read; only the conductor does.)
        if unread:
            for m in self.chat_messages:
                if m.get("role") == "user" and not m.get("read"):
                    m["read"] = True
            bus.publish("conductor:chat_read", {})
        done_count = sum(1 for e in events if e.get("type") == "subagent_done")
        summary = (
            f"subagents: {running} running, {stopped} stopped | "
            f"{unread}条用户未读消息, {done_count}个subagent完成报告"
        )
        port = _get_webui_port()
        base = f"http://{HOST}:{port}/api/conductor"
        return f"""你是agent总管。用户只和你对话，你负责调度、验收、交付，目标是降低用户管理多个agent的负担。
API: {base}；先requests，GET /api/conductor/readme查用法，GET /api/conductor/chat读未读对话，GET /api/conductor/subagent看状态；POST /api/conductor/chat是唯一对用户说话方式。
流程文档按需读取: GET /api/conductor/readme/usermsg | GET /api/conductor/readme/subagent

铁律：
- 绝不亲自执行任务/探测环境；一切执行交给subagent。你只分析、派遣、审查、沟通。
- 每次唤醒只做最小必要动作（发消息/开subagent/reply/keyinfo/abort），做完立刻停，等待下次事件唤醒。
- 改写prompt时严禁添加用户未提及的假设、工具、前提条件。只能精炼/结构化用户原意。

原则：
- 信任subagent足够聪明，不要写具体步骤；能自己判断的自己判断，只在真正需要用户决策时打扰。
{summary}"""

    def _drain(self, dq: queue.Queue, events: list) -> str:
        event_label = ",".join(e.get("type", "") for e in events) or "wake"
        cur_turn = None
        buf = ""

        def flush():
            nonlocal buf
            cleaned = clean_log_text(buf)
            if cleaned:
                item = {
                    "id": short_id(),
                    "ts": now_ms(),
                    "event": event_label,
                    "turn": cur_turn,
                    "text": cleaned
                }
                self.log.append(item)
                if len(self.log) > self.LOG_MAX:
                    self.log.pop(0)
                bus.publish("conductor:log", {"item": item})
            buf = ""

        while True:
            item = dq.get()
            if "next" in item:
                t = item.get("turn")
                if cur_turn is None:
                    cur_turn = t
                elif t != cur_turn:
                    flush()
                    cur_turn = t
                buf += item.get("next", "") or ""
            elif "done" in item:
                if cur_turn is None:
                    cur_turn = item.get("turn")
                flush()
                log.info("Conductor task done")
                return

    def _run(self):
        self.agent = GenericAgent()
        self.agent.inc_out = True
        start_agent_runner(self.agent, "conductor-agent")
        self.started = True
        while True:
            # Block until first event
            first = self.inbox.get()
            self.inbox.task_done()
            # Debounce: collect additional events
            time.sleep(0.3)
            events = [first]
            while not self.inbox.empty():
                try:
                    events.append(self.inbox.get_nowait())
                    self.inbox.task_done()
                except Exception:
                    break
            try:
                prompt = self._build_prompt(events)
                dq = self.agent.put_task(prompt, source="conductor")
                self._drain(dq, events)
            except Exception as e:
                log.exception(f"Conductor error: {e}")

    def start(self):
        threading.Thread(target=self._run, name="conductor-loop", daemon=True).start()


class ConductorService:
    """Singleton service managing conductor + subagent pool."""

    _instance: Optional[ConductorService] = None
    _lock = threading.Lock()

    def __init__(self):
        self.pool = SubagentPool()
        self.chat_messages: list = []
        self.conductor = Conductor(self.pool, self.chat_messages)
        self._started = False

    @classmethod
    def instance(cls) -> ConductorService:
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    def start(self):
        """Bootstrap conductor agent loop."""
        if not self._started:
            self.conductor.start()
            self._started = True
            log.info("ConductorService started")

    def notify(self, event: dict):
        """Forward event to conductor inbox."""
        self.conductor.notify(event)

    def get_chat_messages(self, last: int = 20) -> list:
        """Get recent chat messages (does NOT mark as read)."""
        return self.chat_messages[-last:]

    def add_chat_message(self, msg: str, role: str = "conductor") -> dict:
        """Add message to chat and notify/start conductor if from user."""
        item = add_chat(msg, role, self.chat_messages)
        if role == "user":
            # A user typing into the Conductor chat is an implicit wake-up.
            # Previously messages sent while stopped only entered the inbox,
            # but no conductor loop consumed them, making the input look dead.
            if not self._started:
                self.start()
            self.notify({"type": "user_message", "msg": msg})
        return item

    def get_readmes(self) -> dict:
        return READMES

    def get_readme(self, topic: str) -> Optional[str]:
        return READMES.get(topic)

    def get_conductor_log(self) -> list:
        return self.conductor.log
