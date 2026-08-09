from __future__ import annotations

import asyncio
import threading
import time

from server.routes import conversations


def test_conversation_title_uses_metadata_adapter(tmp_path, monkeypatch):
    archive = tmp_path / "session.txt"
    calls: list[tuple[str, str]] = []

    class Metadata:
        def get_title(self, conversation_id, archive_path):
            calls.append((conversation_id, archive_path))
            return "Canonical title"

    monkeypatch.setattr(conversations, "_metadata", Metadata())

    assert conversations._conversation_title("session.txt", str(archive)) == "Canonical title"
    assert calls == [("session.txt", str(archive))]


def test_list_conversations_does_not_block_event_loop(tmp_path, monkeypatch):
    archive = tmp_path / "session.txt"
    archive.write_text("needle", encoding="utf-8")
    events: list[str] = []

    def slow_sessions():
        events.append("scan-start")
        time.sleep(0.05)
        events.append("scan-end")
        return [(str(archive), 0.0, "preview", 1)]

    monkeypatch.setattr(conversations, "_ga_sessions", slow_sessions)
    monkeypatch.setattr(conversations, "_conversation_title", lambda cid, path: "title")

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
        "_ga_sessions",
        lambda: [
            (str(matching), 2.0, "preview a", 2),
            (str(other), 1.0, "preview b", 3),
        ],
    )
    monkeypatch.setattr(conversations, "_conversation_title", lambda cid, path: "")

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
        }],
    }


def test_list_uses_first_user_question_only_for_untitled_page_items(tmp_path, monkeypatch):
    untitled = tmp_path / "untitled.txt"
    titled = tmp_path / "titled.txt"
    untitled.write_text("archive", encoding="utf-8")
    titled.write_text("archive", encoding="utf-8")
    monkeypatch.setattr(
        conversations,
        "_ga_sessions",
        lambda: [
            (str(untitled), 2.0, "last question", 2),
            (str(titled), 1.0, "last question", 2),
        ],
    )
    monkeypatch.setattr(
        conversations,
        "_conversation_title",
        lambda cid, path: "Renamed" if cid == "titled.txt" else "",
    )
    parsed: list[str] = []

    def extract(path):
        parsed.append(path)
        return [
            {"role": "system", "content": "instructions"},
            {"role": "user", "content": "  Original\n  question  "},
            {"role": "assistant", "content": "answer"},
            {"role": "user", "content": "last question"},
        ]

    monkeypatch.setattr(conversations, "_ga_extract", extract)

    result = asyncio.run(conversations.list_conversations(offset=0, limit=2))

    assert [item["original_user_preview"] for item in result["items"]] == [
        "Original question",
        "",
    ]
    assert parsed == [str(untitled)]
    assert all("_archive_path" not in item for item in result["items"])


def test_detail_and_export_parsing_do_not_block_event_loop(tmp_path, monkeypatch):
    archive = tmp_path / "session.txt"
    archive.write_text("body", encoding="utf-8")
    events: list[str] = []

    monkeypatch.setattr(
        conversations,
        "_session_by_id",
        lambda cid: (str(archive), 0.0, "preview", 1),
    )
    monkeypatch.setattr(conversations, "_conversation_title", lambda cid, path: "title")

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


def test_restore_archive_work_does_not_block_event_loop(tmp_path, monkeypatch):
    from server.services.agent_service import AgentService
    from server.services.event_bus import bus

    archive = tmp_path / "session.txt"
    archive.write_text("body", encoding="utf-8")
    events: list[str] = []

    class Service:
        agent = object()
        _lock = threading.Lock()
        _snapshots = {"stale": object()}

    service = Service()
    monkeypatch.setattr(
        conversations,
        "_session_by_id",
        lambda cid: (str(archive), 0.0, "preview", 1),
    )
    monkeypatch.setattr(conversations, "_conversation_title", lambda cid, path: "Title")
    monkeypatch.setattr(AgentService, "instance", classmethod(lambda cls: service))
    monkeypatch.setattr(bus, "publish", lambda topic, payload: events.append("published"))

    def slow_restore(agent, path):
        assert agent is service.agent
        events.append("restore-start")
        time.sleep(0.05)
        events.append("restore-end")
        return [{"role": "user", "content": "hello"}]

    monkeypatch.setattr(conversations, "_restore_archive", slow_restore)

    async def heartbeat():
        await asyncio.sleep(0.01)
        events.append("heartbeat")

    async def run():
        result, _ = await asyncio.gather(
            conversations.restore_conversation("session.txt"),
            heartbeat(),
        )
        return result

    result = asyncio.run(run())

    assert events.index("heartbeat") < events.index("restore-end")
    assert events[-1] == "published"
    assert service._snapshots == {}
    assert result["restored_lines"] == 1


def test_repeated_detail_and_export_requests_are_consistent(tmp_path, monkeypatch):
    archive = tmp_path / "session.txt"
    archive.write_text("body", encoding="utf-8")
    messages = [{"role": "user", "content": "body"}]
    monkeypatch.setattr(
        conversations,
        "_session_by_id",
        lambda cid: (str(archive), 7.0, "preview", 1),
    )
    monkeypatch.setattr(conversations, "_conversation_title", lambda cid, path: "Title")
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
