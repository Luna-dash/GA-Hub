"""GoalHive service — independent agent for goal/hive mode.

Owns its OWN GeneraticAgent instance, separate thread, and separate message
state. Does NOT share anything with AgentService, so the main realtime chat
(``/ws/chat``) is never affected.
"""
from __future__ import annotations

import logging
import queue as _q
import threading
import time
import uuid
from dataclasses import dataclass

from .. import _paths

if _paths.GA_ROOT is None:
    raise RuntimeError("GoalHiveService imported before GA_ROOT is configured")

from agentmain import GeneraticAgent  # noqa: E402  (resolved via _paths sys.path)

log = logging.getLogger(__name__)

# Goal/Hive prompts — replicated verbatim from frontends/slash_cmds.py
# (build_goal_prompt / build_hive_prompt). User text is appended as the goal.
_GOAL_PROMPT = (
    "请进入 Goal 模式：先读 memory/goal_mode_sop.md。"
    "若未给目标，先 ask_user 一次性问清：一句话目标 + condition 约束。"
)

_HIVE_PROMPT = (
    "请进入 Goal Hive 模式（多 worker 协作版 goal）：先读 "
    "memory/goal_hive_sop.md。"
    "集群目标 / worker 配额 / 终止条件未明确时先 ask_user 补齐再启动。"
)


def _tail(args_text: str, label: str) -> str:
    """Append user-supplied goal text, mirroring slash_cmds._tail."""
    args_text = (args_text or "").strip()
    if not args_text:
        return ""
    return f"\n\n{label}：{args_text}"


@dataclass
class HiveMessage:
    id: str
    role: str  # 'user' | 'assistant'
    content: str
    ts: float
    streaming: bool = False


class GoalHiveService:
    """Separate agent instance for Goal/Hive mode.

    Independent of AgentService.agent — its own GeneraticAgent, its own
    drain thread, its own message list.
    """

    def __init__(self) -> None:
        self.agent: GeneraticAgent | None = None
        self.messages: list[HiveMessage] = []
        self._lock = threading.Lock()
        self._active_stream_id: str | None = None

    def ensure_agent(self) -> GeneraticAgent:
        """Lazy-init a separate GeneraticAgent for GoalHive."""
        if self.agent is None:
            # Same construction as AgentService: no-arg constructor wires
            # up its own llmclients from mykey.
            self.agent = GeneraticAgent()
            self.agent.inc_out = False  # web mode: queue carries cumulative text
            log.info("GoalHive agent initialized (separate instance)")
        return self.agent

    def submit(self, text: str, mode: str = "goal", llm_index: int | None = None) -> str:
        """Submit a goal/hive task. Returns stream_id for tracking."""
        agent = self.ensure_agent()

        if bool(getattr(agent, "is_running", False)):
            raise RuntimeError("GoalHive agent is already running; stop or wait first")

        # Switch LLM if requested (mirror AgentService.switch_llm semantics)
        if llm_index is not None:
            try:
                clients = getattr(agent, "llmclients", []) or []
                if 0 <= int(llm_index) < len(clients):
                    if int(getattr(agent, "llm_no", -1)) != int(llm_index):
                        agent.next_llm(int(llm_index))
                        log.info("GoalHive switched to LLM %d (%s)", llm_index, agent.get_llm_name())
            except Exception as e:
                log.warning("failed to switch GoalHive LLM=%s: %s", llm_index, e)

        stream_id = uuid.uuid4().hex[:12]

        # Record user message
        user_msg = HiveMessage(
            id=uuid.uuid4().hex[:8],
            role="user",
            content=text,
            ts=time.time(),
        )
        # Prepare streaming assistant message
        assistant_msg = HiveMessage(
            id=uuid.uuid4().hex[:8],
            role="assistant",
            content="",
            ts=time.time(),
            streaming=True,
        )
        with self._lock:
            self.messages.append(user_msg)
            self.messages.append(assistant_msg)
            self._active_stream_id = stream_id

        # Build prompt with goal/hive preamble (verbatim slash_cmds semantics)
        label = "集群目标" if mode == "hive" else "用户目标"
        preamble = _HIVE_PROMPT if mode == "hive" else _GOAL_PROMPT
        prompt = preamble + _tail(text, label)

        # Submit to the agent's own queue
        display_queue = agent.put_task(prompt, source="goalhive")

        # Spawn drain thread
        threading.Thread(
            target=self._drain,
            args=(stream_id, assistant_msg.id, display_queue),
            daemon=True,
            name=f"goalhive-drain-{stream_id}",
        ).start()

        return stream_id

    def _drain(self, stream_id: str, msg_id: str, dq: "_q.Queue") -> None:
        """Drain agent output. Queue 'next'/'done' items carry CUMULATIVE text."""
        try:
            while True:
                try:
                    item = dq.get(timeout=300)
                except _q.Empty:
                    # liveness; keep waiting
                    continue

                if "next" in item:
                    content = item["next"]  # cumulative full text so far
                    with self._lock:
                        for msg in self.messages:
                            if msg.id == msg_id:
                                msg.content = content
                                break

                if "done" in item:
                    content = item["done"]  # final full text
                    with self._lock:
                        for msg in self.messages:
                            if msg.id == msg_id:
                                msg.content = content
                                msg.streaming = False
                                break
                        if self._active_stream_id == stream_id:
                            self._active_stream_id = None
                    break
        except Exception as e:
            log.exception("GoalHive drain failed for %s: %s", stream_id, e)
            with self._lock:
                for msg in self.messages:
                    if msg.id == msg_id:
                        msg.streaming = False
                        if not msg.content:
                            msg.content = f"[Error: {e}]"
                        break
                if self._active_stream_id == stream_id:
                    self._active_stream_id = None

    def get_messages(self) -> list[dict]:
        """Return current message history for the UI."""
        with self._lock:
            return [
                {
                    "id": m.id,
                    "role": m.role,
                    "content": m.content,
                    "ts": m.ts,
                    "streaming": m.streaming,
                }
                for m in self.messages
            ]

    def is_running(self) -> bool:
        with self._lock:
            return self._active_stream_id is not None

    def abort(self) -> None:
        """Abort the current stream."""
        if self.agent:
            try:
                self.agent.abort()
            except Exception as e:
                log.warning("GoalHive abort failed: %s", e)
        with self._lock:
            for msg in self.messages:
                if msg.streaming:
                    msg.streaming = False
            self._active_stream_id = None

    def reset(self) -> None:
        """Clear message history (and agent conversation state)."""
        with self._lock:
            self.messages.clear()
            self._active_stream_id = None
        if self.agent:
            try:
                self.agent.history.clear()
            except Exception:
                pass


_service: GoalHiveService | None = None


def get_goalhive_service() -> GoalHiveService:
    """Singleton accessor."""
    global _service
    if _service is None:
        _service = GoalHiveService()
    return _service
