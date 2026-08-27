"""Session identity contract for AgentService runtimes."""
from __future__ import annotations

import asyncio
import queue
import threading
import time
from unittest import mock

import pytest

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
        while (not handle.finished or service._streams) and time.time() < deadline:
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
    service._lock = threading.Lock()
    handle = svc_mod.StreamHandle(
        "stream-1", queue.Queue(), session_id="session-A", run_id="run-1"
    )
    service._streams = {handle.stream_id: handle}
    snapshot = svc_mod.ChatSnapshot(
        "stream-1",
        "webui",
        "hello",
        time.time(),
        session_id="session-A",
        run_id="run-1",
    )

    with mock.patch.object(svc_mod.bus, "publish") as publish:
        service._fanout(BrokenQueue(), handle.display_queue, handle, snapshot)

    assert handle.finished is True
    assert snapshot.done is True
    assert snapshot.aborted is True
    assert service._streams == {}
    assert handle.display_queue.get_nowait()["done"] == handle.final_text
    topic, payload = publish.call_args.args
    assert topic == "chat:done"
    assert payload["session_id"] == "session-A"
    assert payload["run_id"] == "run-1"


def test_done_postprocessing_failure_emits_one_consistent_terminal() -> None:
    service = object.__new__(svc_mod.AgentService)
    service._lock = threading.Lock()
    service._streams = {}
    handle = svc_mod.StreamHandle(
        "stream-1", queue.Queue(), session_id="session-A", run_id="run-1"
    )
    service._streams[handle.stream_id] = handle
    source = queue.Queue()
    source.put({"done": "core-success"})
    snapshot = svc_mod.ChatSnapshot(
        "stream-1",
        "webui",
        "hello",
        time.time(),
        session_id="session-A",
        run_id="run-1",
    )

    with (
        mock.patch.object(service, "_sync_rewind_store", side_effect=RuntimeError("sync failed")),
        mock.patch.object(svc_mod.bus, "publish"),
    ):
        service._fanout(source, handle.display_queue, handle, snapshot)

    terminal_items = []
    while True:
        try:
            terminal_items.append(handle.display_queue.get_nowait())
        except queue.Empty:
            break
    assert len(terminal_items) == 1
    assert "stream error: sync failed" in terminal_items[0]["done"]
    assert handle.final_text == terminal_items[0]["done"]
    assert service._streams == {}


def test_unconsumed_stream_queue_is_bounded_and_preserves_terminal_item() -> None:
    class VerboseAgent(FakeAgent):
        def put_task(self, query, *, source, images):
            q = queue.Queue()
            for index in range(100):
                q.put({"next": f"partial-{index}"})
            q.put({"done": "complete"})
            return q

    with mock.patch.object(svc_mod, "install_continue"), \
         mock.patch.object(svc_mod.bus, "publish"):
        service = svc_mod.AgentService(
            agent=VerboseAgent(),
            manage_global_preference=False,
        )
        handle = service.submit("hello")
        deadline = time.time() + 1
        while (not handle.finished or service._streams) and time.time() < deadline:
            time.sleep(0.005)

    queued_items = handle.display_queue.qsize()

    async def collect_stream() -> list[dict]:
        return [item async for item in service.stream(handle, poll_interval=0.01)]

    with mock.patch.object(svc_mod.bus, "publish"):
        items = asyncio.run(collect_stream())

    assert handle.finished is True
    assert queued_items <= svc_mod._STREAM_MIRROR_QUEUE_CAPACITY
    assert items[-1]["type"] == "done"
    assert items[-1]["content"] == "complete"
    assert any(
        item.get("type") == "next" and item.get("content") == "partial-99"
        for item in items
    )
    assert service._streams == {}


def test_many_completed_submissions_do_not_accumulate_stream_handles() -> None:
    with mock.patch.object(svc_mod, "install_continue"), \
         mock.patch.object(svc_mod.bus, "publish"):
        service = svc_mod.AgentService(
            agent=FakeAgent(),
            manage_global_preference=False,
        )
        handles = [service.submit(f"task-{index}") for index in range(100)]
        deadline = time.time() + 2
        while (
            any(not handle.finished for handle in handles) or service._streams
        ) and time.time() < deadline:
            time.sleep(0.005)

    assert all(handle.finished for handle in handles)
    assert service._streams == {}
    assert all(
        handle.display_queue.qsize() <= svc_mod._STREAM_MIRROR_QUEUE_CAPACITY
        for handle in handles
    )


def test_shutdown_wakes_a_fanout_with_no_terminal_frame() -> None:
    class StuckAgent(FakeAgent):
        def put_task(self, query, *, source, images):
            return queue.Queue()

    with mock.patch.object(svc_mod, "install_continue"), \
         mock.patch.object(svc_mod.bus, "publish"):
        service = svc_mod.AgentService(
            agent=StuckAgent(),
            manage_global_preference=False,
        )
        handle = service.submit("never finishes")
        deadline = time.time() + 1
        while not service._fanout_threads and time.time() < deadline:
            time.sleep(0.005)
        assert service._fanout_threads

        assert service.shutdown(timeout=2) is True

    assert handle.finished is True
    assert "stream aborted: service shutdown" in handle.final_text
    assert service._streams == {}
    assert not service._fanout_threads
    assert handle.display_queue.get_nowait()["done"] == handle.final_text


def test_submit_is_rejected_after_agent_service_shutdown() -> None:
    with mock.patch.object(svc_mod, "install_continue"):
        service = svc_mod.AgentService(
            agent=FakeAgent(),
            manage_global_preference=False,
        )

    assert service.shutdown(timeout=0) is True
    with pytest.raises(RuntimeError, match="shutting down"):
        service.submit("late task")
