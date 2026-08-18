"""Long-running route adapters must not monopolize FastAPI's event loop."""
from __future__ import annotations

import asyncio
import threading
import time
from types import SimpleNamespace
from unittest import mock

from server.routes import agent, autonomous, conductor, mykey, sessions, tasks, wechat


async def _run_with_probe(awaitable):
    started = time.perf_counter()
    task = asyncio.create_task(awaitable)
    await asyncio.sleep(0.02)
    probe_elapsed = time.perf_counter() - started
    result = await task
    assert probe_elapsed < 0.15
    return result


def _slow_result(result):
    time.sleep(0.3)
    return result


def test_llm_probe_runs_in_worker_thread() -> None:
    backend = SimpleNamespace(history=["saved"], tools={"saved": True})

    class Client:
        def __init__(self) -> None:
            self.backend = backend

        def chat(self, **_kwargs):
            time.sleep(0.3)
            yield "pong"

    client = Client()
    fake_agent = SimpleNamespace(
        llmclients=[client],
        get_llm_name=lambda _client, model=False: "model" if model else "client",
    )
    service = SimpleNamespace(agent=fake_agent)

    with mock.patch.object(agent, "svc", return_value=service):
        result = asyncio.run(_run_with_probe(agent.test_llm(0)))

    assert result["ok"] is True
    assert backend.history == ["saved"]
    assert backend.tools == {"saved": True}


def test_mykey_sync_runs_in_worker_thread(tmp_path) -> None:
    path = tmp_path / "mykey.py"
    path.write_text("# fixture\n", encoding="utf-8")

    with (
        mock.patch.object(mykey, "_mykey_path", return_value=path),
        mock.patch.object(mykey, "_run_mykey_sync", side_effect=lambda _args: _slow_result({
            "returncode": 0,
            "stdout": "ok",
            "stderr": "",
        })),
    ):
        result = asyncio.run(_run_with_probe(mykey.sync_upload_mykey()))

    assert result["ok"] is True


def test_wechat_send_runs_in_worker_thread() -> None:
    service = SimpleNamespace(
        bot=SimpleNamespace(has_token=True),
        send_text=lambda *_args: _slow_result({"ok": True}),
        send_file=mock.Mock(),
    )
    request = wechat.WxSendReq(uid="user", text="hello")

    with mock.patch.object(wechat, "svc", return_value=service):
        result = asyncio.run(_run_with_probe(wechat.send(request)))

    assert result == {"ok": True}


def test_email_probe_runs_in_worker_thread() -> None:
    request = tasks.EmailTestReq(to="user@example.com")
    with mock.patch.object(
        tasks.email_service,
        "test_email",
        side_effect=lambda *_args: _slow_result({"ok": True, "to": request.to}),
    ):
        result = asyncio.run(_run_with_probe(tasks.test_email(request)))

    assert result == {"ok": True, "to": request.to}


def test_autonomous_schedule_list_runs_in_worker_thread() -> None:
    service = SimpleNamespace(list=lambda: _slow_result([{"id": "s1"}]))
    with mock.patch.object(autonomous, "svc", return_value=service):
        result = asyncio.run(_run_with_probe(autonomous.list_schedules()))
    assert result == {"schedules": [{"id": "s1"}]}


def test_task_schedule_list_runs_in_worker_thread() -> None:
    service = SimpleNamespace(list=lambda: _slow_result([{"id": "t1"}]))
    with mock.patch.object(tasks, "svc", return_value=service):
        result = asyncio.run(_run_with_probe(tasks.list_schedules()))
    assert result == {"schedules": [{"id": "t1"}]}


def test_conductor_stop_runs_in_worker_thread() -> None:
    stopped = {
        "started": False,
        "stopping": False,
        "admission_open": False,
        "loop_alive": False,
        "agent_alive": False,
    }
    service = SimpleNamespace(
        stop=lambda: _slow_result(True),
        lifecycle_status=lambda: stopped,
    )

    with mock.patch.object(conductor, "svc", return_value=service):
        result = asyncio.run(_run_with_probe(conductor.stop_conductor()))

    assert result == {"ok": True, **stopped}


def test_session_restore_runs_in_worker_thread() -> None:
    service = SimpleNamespace(
        agent=object(),
        _lock=threading.Lock(),
        _snapshots=[{"id": "old"}],
    )

    with (
        mock.patch.object(agent, "svc", return_value=service),
        mock.patch.object(agent, "_restore_session_sync", side_effect=lambda *_args: _slow_result(("ok", "full"))),
        mock.patch.object(agent.bus, "publish"),
    ):
        result = asyncio.run(_run_with_probe(agent.restore_session(0)))

    assert result == {"ok": True, "message": "ok", "full": "full"}
    assert service._snapshots == []


def test_archive_page_projection_runs_in_worker_thread() -> None:
    projection = {
        "archive_bound": True,
        "revision": "revision",
        "items": [],
        "total": 0,
        "has_more": False,
        "next_before": None,
    }
    with (
        mock.patch.object(sessions, "_session", return_value={"archive_path": "archive.txt"}),
        mock.patch.object(
            sessions,
            "read_archive_messages",
            side_effect=lambda *_args, **_kwargs: _slow_result(projection),
        ),
    ):
        result = asyncio.run(
            _run_with_probe(
                sessions.get_session_messages(
                    "session-id",
                    before=None,
                    limit=32,
                    max_chars=400_000,
                )
            )
        )

    assert result.total == 0
    assert result.items == []
