from __future__ import annotations

import asyncio
import os
import threading
import time

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from server.routes import conversations
from server.services import archive_messages
from server.services.session_coordinator import SessionControlBusyError


def test_list_conversations_does_not_block_event_loop(tmp_path, monkeypatch):
    archive = tmp_path / "session.txt"
    archive.write_text("needle", encoding="utf-8")
    events: list[str] = []

    def slow_sessions():
        events.append("scan-start")
        time.sleep(0.05)
        events.append("scan-end")
        return [(str(archive), 0.0, "preview", 1)]

    monkeypatch.setattr(conversations, "list_archive_sessions", slow_sessions)
    monkeypatch.setattr(conversations._metadata, "title_for_archive", lambda path: "title")

    async def heartbeat():
        await asyncio.sleep(0.01)
        events.append("heartbeat")

    async def run():
        result, _ = await asyncio.gather(
            conversations.list_conversations(q="needle"),
            heartbeat(),
        )
        return result

    result = asyncio.run(run())

    assert result["total"] == 1
    assert events.index("heartbeat") < events.index("scan-end")


def test_list_conversations_keeps_search_and_pagination_semantics(tmp_path, monkeypatch):
    matching = tmp_path / "a.txt"
    other = tmp_path / "b.txt"
    matching.write_text("body Needle body", encoding="utf-8")
    other.write_text("unrelated", encoding="utf-8")
    monkeypatch.setattr(
        conversations,
        "list_archive_sessions",
        lambda: [
            (str(matching), 2.0, "preview a", 2),
            (str(other), 1.0, "preview b", 3),
        ],
    )
    monkeypatch.setattr(conversations._metadata, "title_for_archive", lambda path: "")

    result = asyncio.run(conversations.list_conversations(q="needle", offset=0, limit=1))

    assert result == {
        "total": 1,
        "offset": 0,
        "limit": 1,
        "items": [{
            "id": "a.txt",
            "title": "",
            "message_count": 2,
            "last_user_preview": "preview a",
            "original_user_preview": "",
            "bound_session_id": None,
        }],
    }


def test_list_uses_first_user_question_only_for_untitled_page_items(tmp_path, monkeypatch):
    untitled = tmp_path / "untitled.txt"
    titled = tmp_path / "titled.txt"
    native = (
        "=== Prompt === 2026-08-17 12:00:00\n"
        '{"role":"user","content":[{"type":"text","text":"  Original\\n  question  "}]}\n'
        "=== Response === 2026-08-17 12:00:01\n[]\n"
    )
    untitled.write_text(native, encoding="utf-8")
    titled.write_text(native, encoding="utf-8")
    monkeypatch.setattr(
        conversations,
        "list_archive_sessions",
        lambda: [
            (str(untitled), 2.0, "last question", 2),
            (str(titled), 1.0, "last question", 2),
        ],
    )
    monkeypatch.setattr(
        conversations._metadata,
        "title_for_archive",
        lambda path: "Renamed" if os.path.basename(path) == "titled.txt" else "",
    )
    monkeypatch.setattr(
        conversations,
        "_ga_extract",
        lambda _path: (_ for _ in ()).throw(
            AssertionError("conversation list must not parse full archives")
        ),
    )
    archive_messages._first_user_preview_head.cache_clear()

    result = asyncio.run(conversations.list_conversations(offset=0, limit=2))

    assert [item["original_user_preview"] for item in result["items"]] == [
        "Original question",
        "",
    ]
    assert all("_archive_path" not in item for item in result["items"])


def test_first_user_preview_reads_a_bounded_head_and_invalidates_on_append(tmp_path, monkeypatch):
    archive = tmp_path / "large.txt"
    archive.write_text(
        "=== Prompt ===\n"
        '{"role":"user","content":[{"type":"text","text":"中文任务 🚀"}]}\n'
        "=== Response ===\n[]\n"
        + ("x" * (archive_messages.FIRST_USER_PREVIEW_READ_BYTES * 2)),
        encoding="utf-8",
    )
    archive_messages._first_user_preview_head.cache_clear()

    reads: list[int] = []
    original_open = open

    def bounded_open(path, mode="r", *args, **kwargs):
        handle = original_open(path, mode, *args, **kwargs)
        if str(path) == str(archive) and "b" in mode:
            original_read = handle.read

            def read(size=-1):
                reads.append(size)
                return original_read(size)

            handle.read = read
        return handle

    monkeypatch.setattr("builtins.open", bounded_open)
    assert archive_messages.first_user_preview(str(archive)) == "中文任务 🚀"
    assert reads == [archive_messages.FIRST_USER_PREVIEW_READ_BYTES]

    archive.write_text(archive.read_text(encoding="utf-8") + "\n", encoding="utf-8")
    assert archive_messages.first_user_preview(str(archive)) == "中文任务 🚀"
    assert reads == [
        archive_messages.FIRST_USER_PREVIEW_READ_BYTES,
        archive_messages.FIRST_USER_PREVIEW_READ_BYTES,
    ]


def test_detail_and_export_parsing_do_not_block_event_loop(tmp_path, monkeypatch):
    archive = tmp_path / "session.txt"
    archive.write_text("body", encoding="utf-8")
    events: list[str] = []

    monkeypatch.setattr(
        conversations,
        "archive_session_by_id",
        lambda cid: (str(archive), 0.0, "preview", 1),
    )
    monkeypatch.setattr(conversations._metadata, "title_for_archive", lambda path: "title")

    def slow_extract(path):
        events.append("parse-start")
        time.sleep(0.05)
        events.append("parse-end")
        return [{"role": "user", "content": "body"}]

    monkeypatch.setattr(conversations, "_ga_extract", slow_extract)

    async def heartbeat():
        await asyncio.sleep(0.01)
        events.append("heartbeat")

    async def run(route):
        events.clear()
        await asyncio.gather(route(), heartbeat())
        assert events.index("heartbeat") < events.index("parse-end")

    async def run_all():
        await run(lambda: conversations.get_conversation("session.txt"))
        await run(lambda: conversations.export_conversation("session.txt", format="json"))

    asyncio.run(run_all())


def test_restore_builds_session_runtime_via_coordinator(tmp_path, monkeypatch):
    archive = tmp_path / "session.txt"
    archive.write_text("body", encoding="utf-8")
    calls: dict = {}

    class FakeRuntime:
        def __init__(self, name):
            self.name = name
            self.shutdown_calls = 0

        def shutdown(self):
            self.shutdown_calls += 1

    old_runtime = FakeRuntime("old")
    new_runtime = FakeRuntime("new")

    class FakeFactory:
        def __init__(self, store):
            calls["factory_store"] = store

        def __call__(self, session_id, *, archive_override=None):
            calls["build"] = (session_id, archive_override)
            return new_runtime

    class FakeCoordinator:
        def replace_runtime(self, session_id, runtime, *, shutdown=None, operation=None):
            calls["replace"] = (session_id, runtime, operation)
            shutdown(old_runtime)
            return old_runtime

    class FakeMetadata:
        def get(self, session_id):
            calls["validated"] = session_id
            return {"id": session_id}

        def title_for_archive(self, path):
            return "Title"

    monkeypatch.setattr(conversations, "_metadata", FakeMetadata())
    monkeypatch.setattr(conversations, "SessionRuntimeFactory", FakeFactory)
    monkeypatch.setattr(conversations, "_session_coordinator", lambda: FakeCoordinator())
    monkeypatch.setattr(
        conversations,
        "archive_session_by_id",
        lambda cid: (str(archive), "stable-id"),
    )
    monkeypatch.setattr(
        conversations,
        "read_ui_messages",
        lambda path: [{"role": "user", "content": "hello"}],
    )
    events: list[str] = []

    async def heartbeat():
        await asyncio.sleep(0.01)
        events.append("heartbeat")

    async def run():
        result, _ = await asyncio.gather(
            conversations.restore_conversation(
                "archive-1",
                conversations.ConversationRestoreReq(session_id="sess-1"),
            ),
            heartbeat(),
        )
        return result

    result = asyncio.run(run())

    assert calls["validated"] == "sess-1"
    assert calls["build"] == ("sess-1", str(archive))
    assert calls["replace"] == ("sess-1", new_runtime, "restore")
    assert old_runtime.shutdown_calls == 1
    assert new_runtime.shutdown_calls == 0
    assert result == {
        "ok": True,
        "id": "archive-1",
        "title": "Title",
        "restored_lines": 1,
    }
    assert events == ["heartbeat"]


def test_restore_busy_refusal_discards_new_runtime(tmp_path, monkeypatch):
    archive = tmp_path / "session.txt"
    archive.write_text("body", encoding="utf-8")
    calls: dict = {}

    class NewRuntime:
        shutdown_calls = 0

        def shutdown(self):
            self.shutdown_calls += 1

    new_runtime = NewRuntime()

    class FakeFactory:
        def __init__(self, store):
            pass

        def __call__(self, session_id, *, archive_override=None):
            return new_runtime

    class BusyCoordinator:
        def replace_runtime(self, session_id, runtime, *, shutdown=None, operation=None):
            calls["replace"] = (session_id, operation)
            raise SessionControlBusyError(session_id, operation)

    class FakeMetadata:
        def get(self, session_id):
            return {"id": session_id}

        def title_for_archive(self, path):
            raise AssertionError("title must not be read after a refused restore")

    monkeypatch.setattr(conversations, "_metadata", FakeMetadata())
    monkeypatch.setattr(conversations, "SessionRuntimeFactory", FakeFactory)
    monkeypatch.setattr(conversations, "_session_coordinator", lambda: BusyCoordinator())
    monkeypatch.setattr(
        conversations,
        "archive_session_by_id",
        lambda cid: (str(archive), "stable-id"),
    )

    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(
            conversations.restore_conversation(
                "archive-1",
                conversations.ConversationRestoreReq(session_id="sess-1"),
            )
        )

    assert excinfo.value.status_code == 409
    assert excinfo.value.detail["code"] == "session_control_active"
    assert calls["replace"] == ("sess-1", "restore")
    assert new_runtime.shutdown_calls == 1


def test_repeated_detail_and_export_requests_are_consistent(tmp_path, monkeypatch):
    archive = tmp_path / "session.txt"
    archive.write_text("body", encoding="utf-8")
    messages = [{"role": "user", "content": "body"}]
    monkeypatch.setattr(
        conversations,
        "archive_session_by_id",
        lambda cid: (str(archive), 7.0, "preview", 1),
    )
    monkeypatch.setattr(conversations._metadata, "title_for_archive", lambda path: "Title")
    monkeypatch.setattr(conversations, "_ga_extract", lambda path: [dict(m) for m in messages])

    async def run():
        details = [await conversations.get_conversation("session.txt") for _ in range(2)]
        exports = [
            await conversations.export_conversation("session.txt", format="json")
            for _ in range(2)
        ]
        return details, exports

    details, exports = asyncio.run(run())

    assert details[0] == details[1]
    assert exports[0].body == exports[1].body


def test_content_search_reads_in_chunks_and_finds_boundary_match(tmp_path, monkeypatch):
    archive = tmp_path / "large.txt"
    needle = "跨块搜索目标"
    archive.write_bytes(b"a" * (archive_messages.SEARCH_READ_CHUNK_BYTES - 2) + needle.encode() + b"\n")
    archive_messages._archive_contains_query.cache_clear()
    reads: list[int] = []
    original_open = open

    def tracking_open(path, mode="r", *args, **kwargs):
        handle = original_open(path, mode, *args, **kwargs)
        if str(path) == str(archive) and "b" in mode:
            original_read = handle.read

            def read(size=-1):
                reads.append(size)
                return original_read(size)

            handle.read = read
        return handle

    monkeypatch.setattr("builtins.open", tracking_open)
    assert archive_messages.archive_contains(str(archive), needle.lower()) is True
    assert reads
    assert all(size == archive_messages.SEARCH_READ_CHUNK_BYTES for size in reads[:-1])
    assert all(size >= 0 for size in reads)


def test_content_search_cache_invalidates_after_archive_append(tmp_path):
    archive = tmp_path / "archive.txt"
    archive.write_text("old content", encoding="utf-8")
    archive_messages._archive_contains_query.cache_clear()

    assert archive_messages.archive_contains(str(archive), "new content") is False
    with archive.open("a", encoding="utf-8") as handle:
        handle.write(" new content")
    assert archive_messages.archive_contains(str(archive), "new content") is True


def test_restore_requires_target_session_id_in_request_body():
    app = FastAPI()
    app.include_router(conversations.router)

    with TestClient(app) as client:
        response = client.post("/api/conversations/archive-1/restore")

    assert response.status_code == 422


def test_restore_rejects_unknown_target_session_before_loading_archive(monkeypatch):
    app = FastAPI()
    app.include_router(conversations.router)
    archive_lookup_called = False

    def archive_lookup(_cid):
        nonlocal archive_lookup_called
        archive_lookup_called = True
        raise AssertionError("archive lookup must follow session validation")

    monkeypatch.setattr(conversations._metadata, "get", lambda _session_id: (_ for _ in ()).throw(KeyError("missing")))
    monkeypatch.setattr(conversations, "archive_session_by_id", archive_lookup)

    with TestClient(app) as client:
        response = client.post(
            "/api/conversations/archive-1/restore",
            json={"session_id": "missing"},
        )

    assert response.status_code == 404
    assert archive_lookup_called is False
