"""Long-running route adapters must not monopolize FastAPI's event loop."""
from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace
from unittest import mock

from server.routes import agent, autonomous, conductor, conversations, memory, mykey, notify, sessions, tasks, upload, wechat
from server.schemas import ChatRetryConfigReq, RewindReq, TextWrite
from server.services import mykey_service


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


def test_mykey_sync_runs_in_worker_thread(tmp_path) -> None:
    path = tmp_path / "mykey.py"
    path.write_text("# fixture\n", encoding="utf-8")

    with (
        mock.patch.object(mykey_service, "_mykey_path", return_value=path),
        mock.patch.object(mykey_service, "_run_mykey_sync", side_effect=lambda _args: _slow_result({
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
        pool=SimpleNamespace(counts=lambda: (0, 0)),
        chat_messages=[],
        auto_accept=True,
    )

    with mock.patch.object(conductor, "svc", return_value=service):
        result = asyncio.run(_run_with_probe(conductor.stop_conductor()))

    assert result == {
        "ok": True,
        **stopped,
        "subagents": {"running": 0, "stopped": 0},
        "chat_count": 0,
        "auto_accept": True,
    }


def test_session_restore_runs_in_worker_thread() -> None:
    reset = mock.Mock()
    service = SimpleNamespace(agent=object(), reset_live_snapshots=reset)

    with (
        mock.patch.object(agent, "svc", return_value=service),
        mock.patch.object(agent, "_restore_session_sync", side_effect=lambda *_args: _slow_result(("ok", "full"))),
    ):
        result = asyncio.run(_run_with_probe(agent.restore_session(0)))

    assert result == {"ok": True, "message": "ok", "full": "full"}
    reset.assert_called_once_with("session_restored")


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


def test_memory_read_write_run_in_worker_thread(tmp_path) -> None:
    target = tmp_path / "global_mem.txt"
    with (
        mock.patch.object(memory, "_global_mem", return_value=str(target)),
        mock.patch.object(memory, "_write", side_effect=lambda _p, _c: _slow_result(None)),
        mock.patch.object(memory, "_read", side_effect=lambda _p: _slow_result("body")),
    ):
        written = asyncio.run(_run_with_probe(memory.put_global(TextWrite(content="x"))))
        read = asyncio.run(_run_with_probe(memory.get_global()))

    assert written == {"ok": True, "size": 1}
    assert read == {"content": "body"}


def test_memory_skill_search_runs_in_worker_thread() -> None:
    payload = {"hits": [], "scanned": 0, "truncated": False}
    with mock.patch.object(
        memory,
        "_search_skills",
        side_effect=lambda *_args: _slow_result(payload),
    ):
        result = asyncio.run(_run_with_probe(memory.search_skills(q="x")))

    assert result == payload


def test_archive_zip_reads_run_in_worker_thread(tmp_path) -> None:
    (tmp_path / "a.zip").write_bytes(b"PK\x05\x06" + b"\x00" * 18)
    with (
        mock.patch.object(conversations, "_archive_dir", return_value=str(tmp_path)),
        mock.patch.object(
            conversations,
            "_list_zip_entries_sync",
            side_effect=lambda _p: _slow_result({"entries": []}),
        ),
        mock.patch.object(
            conversations,
            "_read_zip_entry_sync",
            side_effect=lambda _p, _e: _slow_result(b"data"),
        ),
    ):
        entries = asyncio.run(_run_with_probe(conversations.list_zip_entries("a.zip")))
        body = asyncio.run(_run_with_probe(conversations.read_zip_entry("a.zip", "x.txt")))

    assert entries == {"entries": []}
    assert body.body == b"data"


def test_upload_write_runs_in_worker_thread(tmp_path) -> None:
    class _FakeUpload:
        def __init__(self) -> None:
            self._chunks = [b"hello", b""]

        async def read(self, _size: int) -> bytes:
            return self._chunks.pop(0)

    writer = mock.Mock(side_effect=lambda _out, _c: _slow_result(None))
    with mock.patch.object(upload, "_write_chunk", writer):
        size = asyncio.run(
            _run_with_probe(
                upload._save_upload_stream(_FakeUpload(), tmp_path / "u.bin", max_size=100)
            )
        )

    assert size == 5
    assert writer.call_args_list[0].args[1] == b"hello"


def test_session_delete_release_runs_in_worker_thread() -> None:
    coordinator = SimpleNamespace(release_runtime=lambda *_a, **_k: _slow_result(None))
    store = SimpleNamespace(get=lambda _sid: {"id": "s1"}, delete=mock.Mock())
    with (
        mock.patch.object(sessions, "_store", store),
        mock.patch.object(sessions, "_coordinator", coordinator),
        mock.patch.object(sessions, "_get_coordinator", return_value=coordinator),
    ):
        result = asyncio.run(_run_with_probe(sessions.delete_session("s1")))

    assert result.status_code == 204


def test_conversation_delete_release_runs_in_worker_thread(tmp_path) -> None:
    archive = tmp_path / "conv.txt"
    archive.write_text("x", encoding="utf-8")
    binding = {"id": "s1"}
    coordinator = SimpleNamespace(release_runtime=lambda *_a, **_k: _slow_result(None))
    metadata = SimpleNamespace(
        find_by_archive=lambda _p: binding,
        delete_by_archive=mock.Mock(),
    )
    with (
        mock.patch.object(conversations, "archive_session_by_id", return_value=(str(archive),)),
        mock.patch.object(conversations, "_metadata", metadata),
        mock.patch.object(sessions, "_coordinator", coordinator),
        mock.patch.object(conversations, "invalidate_archive_catalogue", mock.Mock()),
    ):
        result = asyncio.run(
            _run_with_probe(conversations.delete_conversation("conv.txt"))
        )

    assert result == {"ok": True, "id": "conv.txt"}


def test_notify_send_runs_in_worker_thread() -> None:
    with mock.patch.object(
        notify.notify_service,
        "send",
        side_effect=lambda *_args: _slow_result({"ok": True, "backend": "test"}),
    ):
        result = asyncio.run(
            _run_with_probe(notify.post_notify(notify.NotifyReq(title="t", body="b")))
        )

    assert result == {"ok": True, "backend": "test"}


def test_session_rewind_runs_in_worker_thread() -> None:
    coordinator = SimpleNamespace(
        rewind=lambda *_a, **_k: _slow_result({"kept": 1, "history_lines": 2,
                                               "removed_history_entries": 2,
                                               "removed_sids": ["s2"]}))
    with (
        mock.patch.object(sessions, "_session", return_value={"id": "s1"}),
        mock.patch.object(sessions, "_coordinator", coordinator),
        mock.patch.object(sessions, "_get_coordinator", return_value=coordinator),
        mock.patch.object(sessions, "_store", SimpleNamespace(touch=mock.Mock())),
    ):
        result = asyncio.run(
            _run_with_probe(sessions.session_rewind("s1", RewindReq(n=1)))
        )

    assert result["kept"] == 1


def test_agent_llms_reload_runs_in_worker_thread() -> None:
    service = SimpleNamespace(list_llms=lambda: _slow_result([]))
    with mock.patch.object(agent, "svc", return_value=service):
        result = asyncio.run(_run_with_probe(agent.list_llms()))

    assert result == {"llms": []}


def test_agent_chat_retry_config_write_runs_in_worker_thread() -> None:
    config = SimpleNamespace(to_dict=lambda: {"enabled": True})
    with mock.patch.object(
        agent, "save_chat_retry_config", side_effect=lambda _d: _slow_result(config)
    ):
        result = asyncio.run(
            _run_with_probe(agent.put_chat_retry_config(ChatRetryConfigReq()))
        )

    assert result == {"enabled": True}


def test_session_llm_reload_runs_in_worker_thread() -> None:
    entries = [("key-a", 3)]
    with (
        mock.patch.object(sessions, "_store", SimpleNamespace(update=mock.Mock(return_value={"id": "s1"}))),
        mock.patch("server.services.agent_service.get_agent_service"),
        mock.patch(
            "server.services.llm_registry.LlmRegistry.reload_and_snapshot",
            side_effect=lambda _agent: _slow_result(entries),
        ),
    ):
        result = asyncio.run(
            _run_with_probe(
                sessions.update_session_model(
                    "s1", sessions.SessionModelUpdate(llm_index=3)
                )
            )
        )

    assert result == {"id": "s1"}


def test_project_prepare_runs_in_worker_thread() -> None:
    prepared = {"ok": True, "name": "p1", "path": "D:/proj"}
    with mock.patch.object(
        sessions.workspace_cmd, "prepare", side_effect=lambda _p: _slow_result(prepared)
    ):
        result = asyncio.run(
            _run_with_probe(sessions.create_project(sessions.ProjectCreate(path="D:/proj")))
        )

    assert result.name == "p1"


def test_session_sidecar_list_runs_in_worker_thread() -> None:
    store = SimpleNamespace(list=lambda: _slow_result([]))
    with mock.patch.object(sessions, "_store", store):
        result = asyncio.run(_run_with_probe(sessions.list_sessions()))

    assert result.total == 0


def test_scheduled_chat_create_runs_in_worker_thread() -> None:
    service = SimpleNamespace(create=lambda **_k: _slow_result({"id": "t1"}))
    request = sessions.ScheduledChatCreate(text="hi", scheduled_for=time.time() + 60)
    with (
        mock.patch.object(sessions, "_session", return_value={"id": "s1"}),
        mock.patch.object(sessions, "_get_scheduled_chats", return_value=service),
    ):
        result = asyncio.run(
            _run_with_probe(sessions.create_scheduled_chat("s1", request))
        )

    assert result == {"id": "t1"}


def test_upload_resolve_by_path_runs_in_worker_thread() -> None:
    with mock.patch.object(
        upload, "_resolve_file_by_path", side_effect=lambda _p: _slow_result("D:/tmp/x")
    ):
        result = asyncio.run(_run_with_probe(upload.get_file_by_path(path="x")))

    assert result.path == "D:/tmp/x"
