from __future__ import annotations

from server.routes import conversations
from server.services import archive_messages


def _row(path: str, mtime: float):
    return (path, mtime, f"preview {path}", 1)


def _reset_index():
    archive_messages.invalidate_archive_catalogue()


def _reset_legacy_migration():
    conversations._legacy_titles_migrated = False


def test_archive_catalogue_reuses_scan_until_archive_state_changes(monkeypatch):
    states = iter([("v1",), ("v1",), ("v2",)])
    scans = []
    rows = [_row("/sessions/a.txt", 2)]
    monkeypatch.setattr(archive_messages, "_catalogue_signature", lambda: next(states))
    monkeypatch.setattr(archive_messages, "_ga_sessions", lambda: scans.append(1) or list(rows))
    _reset_index()

    assert archive_messages.archive_session_by_id("a.txt")[0] == "/sessions/a.txt"
    assert archive_messages.archive_session_by_id("a.txt")[0] == "/sessions/a.txt"
    rows[:] = [_row("/sessions/b.txt", 3)]
    assert archive_messages.archive_session_by_id("b.txt")[0] == "/sessions/b.txt"
    assert len(scans) == 2


def test_archive_catalogue_refreshes_deleted_and_renamed_files(monkeypatch):
    state = ["v1"]
    rows = [_row("/sessions/a.txt", 2)]
    monkeypatch.setattr(archive_messages, "_catalogue_signature", lambda: tuple(state))
    monkeypatch.setattr(archive_messages, "_ga_sessions", lambda: list(rows))
    _reset_index()

    assert archive_messages.archive_session_by_id("a.txt") is not None
    rows[:] = [_row("/sessions/renamed.txt", 2)]
    state[0] = "v2"
    assert archive_messages.archive_session_by_id("a.txt") is None
    assert archive_messages.archive_session_by_id("renamed.txt") is not None
    rows.clear()
    state[0] = "v3"
    assert archive_messages.archive_session_by_id("renamed.txt") is None


def test_archive_catalogue_duplicate_basename_keeps_newest_sorted_record(monkeypatch):
    monkeypatch.setattr(archive_messages, "_catalogue_signature", lambda: ("same",))
    monkeypatch.setattr(archive_messages, "_ga_sessions", lambda: [
        _row("/new/a.txt", 9),
        _row("/old/a.txt", 1),
    ])
    _reset_index()

    assert archive_messages.archive_session_by_id("a.txt")[0] == "/new/a.txt"


def test_route_point_lookup_uses_the_archive_catalogue(monkeypatch):
    rows = [_row("/sessions/a.txt", 2)]
    monkeypatch.setattr(archive_messages, "_catalogue_signature", lambda: ("v1",))
    scans = []
    monkeypatch.setattr(
        archive_messages,
        "_ga_sessions",
        lambda: scans.append(1) or list(rows),
    )
    _reset_index()

    assert conversations._session_by_id("a.txt")[0] == "/sessions/a.txt"
    assert conversations._session_by_id("a.txt")[0] == "/sessions/a.txt"
    assert len(scans) == 1


def test_list_sort_order_is_unchanged_by_catalogue(monkeypatch):
    rows = [_row("/sessions/new.txt", 9), _row("/sessions/old.txt", 1)]
    monkeypatch.setattr(conversations, "list_archive_sessions", lambda: list(rows))
    monkeypatch.setattr(
        conversations._metadata,
        "title_for_archive",
        lambda path: "",
    )
    monkeypatch.setattr(conversations, "first_user_preview", lambda path: "")

    result = conversations._list_conversations_sync(None, 0, 50)

    assert [item["id"] for item in result["items"]] == ["new.txt", "old.txt"]


def test_archive_catalogue_concurrent_reads_share_one_refresh(monkeypatch):
    import concurrent.futures
    import threading
    import time

    _reset_index()
    calls = 0
    calls_lock = threading.Lock()
    start = threading.Barrier(8)
    monkeypatch.setattr(
        archive_messages,
        "_catalogue_signature",
        lambda: (("a.txt", 1, 1),),
    )

    def slow_scan():
        nonlocal calls
        with calls_lock:
            calls += 1
        time.sleep(0.03)
        return [_row("/archive/a.txt", 1.0)]

    monkeypatch.setattr(archive_messages, "_ga_sessions", slow_scan)

    def read_index(_):
        start.wait(timeout=2)
        return archive_messages.archive_session_by_id("a.txt")

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(read_index, range(8)))

    assert calls == 1
    assert results == [_row("/archive/a.txt", 1.0)] * 8


def test_legacy_title_migration_runs_once_through_the_catalogue(monkeypatch):
    rows = [_row("/sessions/a.txt", 2)]
    monkeypatch.setattr(archive_messages, "_catalogue_signature", lambda: ("v1",))
    monkeypatch.setattr(archive_messages, "_ga_sessions", lambda: list(rows))
    _reset_index()
    _reset_legacy_migration()
    resolved: list[str | None] = []

    def fake_migrate(store, resolver):
        resolved.append(resolver("a.txt"))
        resolved.append(resolver("missing.txt"))

    monkeypatch.setattr(conversations, "migrate_legacy_titles", fake_migrate)

    conversations._archive_catalogue_with_migration()
    conversations._archive_catalogue_with_migration()

    assert resolved == ["/sessions/a.txt", None]


def test_delete_conversation_invalidates_catalogue_after_unlink(tmp_path, monkeypatch):
    import asyncio

    archive = tmp_path / "a.txt"
    archive.write_text("session", encoding="utf-8")
    events = []
    monkeypatch.setattr(
        conversations,
        "_session_by_id",
        lambda cid: _row(str(archive), 1),
    )
    monkeypatch.setattr(
        conversations._metadata,
        "delete_by_archive",
        lambda path: events.append("metadata-delete"),
    )
    monkeypatch.setattr(
        conversations,
        "invalidate_archive_catalogue",
        lambda: events.append("invalidate"),
    )

    result = asyncio.run(conversations.delete_conversation("a.txt"))

    assert result == {"ok": True, "id": "a.txt"}
    assert not archive.exists()
    assert events == ["metadata-delete", "invalidate"]
