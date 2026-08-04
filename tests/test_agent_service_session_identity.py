"""Session identity contract for AgentService runtimes."""
from __future__ import annotations

import queue
import time
from unittest import mock

from server.services import agent_service as svc_mod


class FakeAgent:
    def __init__(self) -> None:
        self.inc_out = True
        self.verbose = True
        self.last_reply_time = 0
        self._turn_end_hooks = {}
        self.is_running = False

    def put_task(self, query, *, source, images):
        q = queue.Queue()
        q.put({"next": "partial"})
        q.put({"done": "complete"})
        return q

    def run(self):
        return None


def test_session_runtime_skips_process_global_preference_hooks() -> None:
    agent = FakeAgent()
    with mock.patch.object(svc_mod, "install_continue"), \
         mock.patch.object(svc_mod.AgentService, "_wrap_next_llm_with_persistence") as wrap, \
         mock.patch.object(svc_mod.AgentService, "_restore_preferred_llm") as restore:
        service = svc_mod.AgentService(
            agent=agent,
            session_id="session-A",
            manage_global_preference=False,
        )

    assert service.agent is agent
    assert service.session_id == "session-A"
    wrap.assert_not_called()
    restore.assert_not_called()


def test_submit_and_stream_events_keep_session_and_run_identity() -> None:
    agent = FakeAgent()
    with mock.patch.object(svc_mod, "install_continue"), \
         mock.patch.object(svc_mod.bus, "publish") as publish:
        service = svc_mod.AgentService(
            agent=agent,
            session_id="session-A",
            manage_global_preference=False,
        )
        handle = service.submit(
            "hello",
            source="scheduled_task",
            session_id="session-A",
            run_id="run-1",
        )
        deadline = time.time() + 1
        while not handle.finished and time.time() < deadline:
            time.sleep(0.005)

    assert handle.finished is True
    assert handle.session_id == "session-A"
    assert handle.run_id == "run-1"
    relevant = {
        topic: payload
        for (topic, payload), _kwargs in publish.call_args_list
        if topic in {"agent:submit", "chat:started", "chat:next", "chat:done"}
    }
    assert set(relevant) == {"agent:submit", "chat:started", "chat:next", "chat:done"}
    for payload in relevant.values():
        assert payload["session_id"] == "session-A"
        assert payload["run_id"] == "run-1"


def test_fanout_crash_finishes_handle_and_keeps_identity() -> None:
    class BrokenQueue:
        def get(self, timeout):
            raise RuntimeError("queue broke")

    service = object.__new__(svc_mod.AgentService)
    handle = svc_mod.StreamHandle(
        "stream-1", queue.Queue(), session_id="session-A", run_id="run-1"
    )
    snapshot = svc_mod.ChatSnapshot(
        "stream-1",
        "webui",
        "hello",
        time.time(),
        session_id="session-A",
        run_id="run-1",
    )

    with mock.patch.object(svc_mod.bus, "publish") as publish:
        service._fanout(BrokenQueue(), queue.Queue(), handle, snapshot)

    assert handle.finished is True
    assert snapshot.done is True
    assert snapshot.aborted is True
    topic, payload = publish.call_args.args
    assert topic == "chat:done"
    assert payload["session_id"] == "session-A"
    assert payload["run_id"] == "run-1"
