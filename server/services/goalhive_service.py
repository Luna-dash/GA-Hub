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
from typing import Callable

from .. import _paths

if _paths.GA_ROOT is None:
    raise RuntimeError("GoalHiveService imported before GA_ROOT is configured")

from agentmain import GeneraticAgent  # noqa: E402  (resolved via _paths sys.path)

log = logging.getLogger(__name__)

_RUNNER_STOP = "__goalhive_shutdown__"
_RUNNER_STOPPED_KEY = "__goalhive_runner_stopped__"
_DRAIN_POLL_SECONDS = 0.1

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


def _worker_llm_instruction(llm_index: int | None) -> str:
    """Pin every Hive worker process to the page-selected subagent model."""
    if llm_index is None:
        return ""
    return (
        "\n\n子代理模型规则：本次所有 Hive worker 启动命令都必须追加 "
        f"`--llm_no {int(llm_index)}`；包括首个 worker 和后续扩容 worker，不得省略。"
    )


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

    def __init__(
        self,
        *,
        agent_factory: Callable[[], GeneraticAgent] = GeneraticAgent,
        drain_poll_seconds: float = _DRAIN_POLL_SECONDS,
    ) -> None:
        self._agent_factory = agent_factory
        self._drain_poll_seconds = max(0.01, float(drain_poll_seconds))
        self.agent: GeneraticAgent | None = None
        self.messages: list[HiveMessage] = []
        self._lock = threading.Lock()
        self._lifecycle_lock = threading.RLock()
        self._runner_thread: threading.Thread | None = None
        self._drain_threads: set[threading.Thread] = set()
        self._stream_queues: dict[str, _q.Queue] = {}
        self._shutdown_requested = threading.Event()
        self._shutdown_abort_sent = False
        self._closed = False
        self._active_stream_id: str | None = None

    def ensure_agent(self) -> GeneraticAgent:
        """Lazy-init the agent and its single owned queue-consumer thread."""
        with self._lifecycle_lock:
            if self._closed:
                raise RuntimeError("GoalHive service is closed")
            if self.agent is None:
                # Same construction as AgentService: no-arg constructor wires
                # up its own llmclients from mykey.
                self.agent = self._agent_factory()
                self.agent.inc_out = False  # web mode: queue carries cumulative text
                log.info("GoalHive agent initialized (separate instance)")
            self._ensure_runner_locked(self.agent)
            return self.agent

    def _ensure_runner_locked(self, agent: GeneraticAgent) -> None:
        runner = self._runner_thread
        if runner is not None and runner.is_alive():
            return
        runner = threading.Thread(
            target=self._run_agent,
            args=(agent,),
            daemon=True,
            name="goalhive-agent",
        )
        self._runner_thread = runner
        try:
            runner.start()
        except BaseException:
            self._runner_thread = None
            raise

    def _run_agent(self, agent: GeneraticAgent) -> None:
        try:
            agent.run()
        except Exception:
            if not self._shutdown_requested.is_set():
                log.exception("GoalHive agent runner stopped unexpectedly")
        finally:
            current = threading.current_thread()
            with self._lifecycle_lock:
                if not self._shutdown_requested.is_set():
                    with self._lock:
                        stream_id = self._active_stream_id
                        display_queue = self._stream_queues.get(stream_id or "")
                    if display_queue is not None:
                        try:
                            display_queue.put_nowait({_RUNNER_STOPPED_KEY: True})
                        except Exception:
                            log.exception("GoalHive drain wake-up failed after runner exit")
                if self._runner_thread is current:
                    self._runner_thread = None

    def _finish_active_messages(self) -> None:
        with self._lock:
            for msg in self.messages:
                if msg.streaming:
                    msg.streaming = False
            self._active_stream_id = None

    @staticmethod
    def _join_until(thread: threading.Thread | None, deadline: float) -> None:
        if thread is None or thread is threading.current_thread() or not thread.is_alive():
            return
        thread.join(timeout=max(0.0, deadline - time.monotonic()))

    @staticmethod
    def _discard_pending_tasks(task_queue: object) -> None:
        get_nowait = getattr(task_queue, "get_nowait", None)
        task_done = getattr(task_queue, "task_done", None)
        if not callable(get_nowait):
            return
        while True:
            try:
                get_nowait()
            except _q.Empty:
                return
            except Exception:
                log.exception("GoalHive pending-task cleanup failed")
                return
            if callable(task_done):
                try:
                    task_done()
                except Exception:
                    log.exception("GoalHive pending-task accounting failed")

    @staticmethod
    def _abort_agent(agent: GeneraticAgent) -> None:
        try:
            agent.abort()
        except Exception:
            log.exception("GoalHive abort during shutdown failed")

    def shutdown(self, timeout: float = 2.0) -> bool:
        """Stop all GoalHive-owned threads within one shared deadline.

        Closing is terminal and idempotent. A timed-out call leaves the closed
        service in place so a later shutdown can finish reaping the same owned
        threads instead of creating a second agent beside them.
        """
        deadline = time.monotonic() + max(0.0, float(timeout))
        with self._lifecycle_lock:
            self._closed = True
            self._shutdown_requested.set()
            agent = self.agent
            runner = self._runner_thread
            drains = tuple(self._drain_threads)
            send_abort = not self._shutdown_abort_sent
            self._shutdown_abort_sent = True

        if agent is not None:
            task_queue = getattr(agent, "task_queue", None)
            if task_queue is not None and runner is not None and runner.is_alive():
                # A submit can enqueue just before the GA runner marks itself
                # running. Remove work that is still pending before waking the
                # runner with its supported string shutdown sentinel.
                self._discard_pending_tasks(task_queue)
                try:
                    task_queue.put_nowait(_RUNNER_STOP)
                except Exception:
                    log.exception("GoalHive runner shutdown signal failed")
            # GenericAgent.abort() is intentionally a no-op while idle. Call it
            # regardless, then retry below if the runner crossed into active
            # execution after this first check.
            if send_abort:
                self._abort_agent(agent)

        self._finish_active_messages()
        for drain in drains:
            self._join_until(drain, deadline)
        if runner is not None and runner is not threading.current_thread():
            while runner.is_alive():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                runner.join(timeout=min(0.05, remaining))
                if runner.is_alive() and agent is not None:
                    self._abort_agent(agent)

        with self._lifecycle_lock:
            runner_alive = bool(
                self._runner_thread is not None and self._runner_thread.is_alive()
            )
            self._drain_threads = {
                thread for thread in self._drain_threads if thread.is_alive()
            }
            stopped = not runner_alive and not self._drain_threads
        if not stopped:
            log.warning(
                "GoalHive shutdown timed out runner_alive=%s drain_threads=%s",
                runner_alive,
                len(self._drain_threads),
            )
        return stopped

    def submit(
        self,
        text: str,
        mode: str = "goal",
        llm_index: int | None = None,
        subagent_llm_index: int | None = None,
    ) -> str:
        """Submit one goal/hive task unless the service is closing or busy."""
        with self._lifecycle_lock:
            return self._submit_locked(
                text,
                mode=mode,
                llm_index=llm_index,
                subagent_llm_index=subagent_llm_index,
            )

    def _submit_locked(
        self,
        text: str,
        mode: str = "goal",
        llm_index: int | None = None,
        subagent_llm_index: int | None = None,
    ) -> str:
        """Submit a goal/hive task. Returns stream_id for tracking."""
        agent = self.ensure_agent()

        with self._lock:
            active = self._active_stream_id is not None
        if active or bool(getattr(agent, "is_running", False)):
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
        worker_instruction = (
            _worker_llm_instruction(subagent_llm_index)
            if mode == "hive"
            else ""
        )
        prompt = preamble + worker_instruction + _tail(text, label)

        # Submit to the agent's own queue. Keep the UI reservation transactional:
        # a queue-admission failure must not leave a phantom streaming message.
        try:
            display_queue = agent.put_task(prompt, source="goalhive")
        except BaseException:
            with self._lock:
                self.messages[:] = [
                    message
                    for message in self.messages
                    if message.id not in {user_msg.id, assistant_msg.id}
                ]
                if self._active_stream_id == stream_id:
                    self._active_stream_id = None
            raise
        with self._lock:
            self._stream_queues[stream_id] = display_queue

        # Spawn and retain the drain so shutdown can wake and reap it.
        drain = threading.Thread(
            target=self._drain,
            args=(stream_id, assistant_msg.id, display_queue),
            daemon=True,
            name=f"goalhive-drain-{stream_id}",
        )
        self._drain_threads.add(drain)
        try:
            drain.start()
        except BaseException:
            self._drain_threads.discard(drain)
            with self._lock:
                self._stream_queues.pop(stream_id, None)
            self._finish_active_messages()
            raise

        return stream_id

    def _drain(self, stream_id: str, msg_id: str, dq: "_q.Queue") -> None:
        """Drain agent output. Queue 'next'/'done' items carry CUMULATIVE text."""
        try:
            while True:
                if self._shutdown_requested.is_set():
                    break
                try:
                    item = dq.get(timeout=self._drain_poll_seconds)
                except _q.Empty:
                    continue

                if item.get(_RUNNER_STOPPED_KEY):
                    with self._lock:
                        for msg in self.messages:
                            if msg.id == msg_id:
                                msg.streaming = False
                                if not msg.content:
                                    msg.content = "[Error: GoalHive agent runner stopped unexpectedly]"
                                break
                        if self._active_stream_id == stream_id:
                            self._active_stream_id = None
                    break

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
        finally:
            if self._shutdown_requested.is_set():
                with self._lock:
                    for msg in self.messages:
                        if msg.id == msg_id:
                            msg.streaming = False
                            break
                    if self._active_stream_id == stream_id:
                        self._active_stream_id = None
            with self._lifecycle_lock:
                self._drain_threads.discard(threading.current_thread())
                with self._lock:
                    self._stream_queues.pop(stream_id, None)

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
        with self._lifecycle_lock:
            agent = self.agent
            if agent:
                try:
                    agent.abort()
                except Exception as e:
                    log.warning("GoalHive abort failed: %s", e)
            self._finish_active_messages()

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
_service_lock = threading.Lock()


def get_goalhive_service() -> GoalHiveService:
    """Singleton accessor."""
    global _service
    if _service is None:
        with _service_lock:
            if _service is None:
                _service = GoalHiveService()
    return _service


def shutdown_goalhive_service(timeout: float = 2.0) -> bool:
    """Close the existing singleton without constructing one during shutdown."""
    global _service
    with _service_lock:
        service = _service
    if service is None:
        return True
    stopped = service.shutdown(timeout=timeout)
    if stopped:
        with _service_lock:
            if _service is service:
                _service = None
    return stopped
