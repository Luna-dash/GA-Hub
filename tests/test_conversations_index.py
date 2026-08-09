from __future__ import annotations

from server.routes import conversations


def _row(path: str, mtime: float):
    return (path, mtime, f"preview {path}", 1)


def _reset_index():
    conversations._invalidate_session_index()


def test_session_index_reuses_scan_until_archive_state_changes(monkeypatch):
    states = iter([("v1",), ("v1",), ("v2",)])
    scans = []
    rows = [_row("/sessions/a.txt", 2)]
    monkeypatch.setattr(conversations, "_session_index_signature", lambda: next(states))
    monkeypatch.setattr(conversations, "_ga_sessions", lambda: scans.append(1) or list(rows))
    _reset_index()

    assert conversations._session_by_id("a.txt")[0] == "/sessions/a.txt"
    assert conversations._session_by_id("a.txt")[0] == "/sessions/a.txt"
    rows[:] = [_row("/sessions/b.txt", 3)]
    assert conversations._session_by_id("b.txt")[0] == "/sessions/b.txt"
    assert len(scans) == 2


def test_session_index_refreshes_deleted_and_renamed_files(monkeypatch):
    state = ["v1"]
    rows = [_row("/sessions/a.txt", 2)]
    monkeypatch.setattr(conversations, "_session_index_signature", lambda: tuple(state))
    monkeypatch.setattr(conversations, "_ga_sessions", lambda: list(rows))
    _reset_index()

    assert conversations._session_by_id("a.txt") is not None
    rows[:] = [_row("/sessions/renamed.txt", 2)]
    state[0] = "v2"
    assert conversations._session_by_id("a.txt") is None
    assert conversations._session_by_id("renamed.txt") is not None
    rows.clear()
    state[0] = "v3"
    assert conversations._session_by_id("renamed.txt") is None


def test_session_index_duplicate_basename_keeps_newest_sorted_record(monkeypatch):
    monkeypatch.setattr(conversations, "_session_index_signature", lambda: ("same",))
    monkeypatch.setattr(conversations, "_ga_sessions", lambda: [
        _row("/new/a.txt", 9),
        _row("/old/a.txt", 1),
    ])
    _reset_index()

    assert conversations._session_by_id("a.txt")[0] == "/new/a.txt"


def test_list_sort_order_is_unchanged_by_index(monkeypatch):
    rows = [_row("/sessions/new.txt", 9), _row("/sessions/old.txt", 1)]
    monkeypatch.setattr(conversations, "_ga_sessions", lambda: list(rows))
    monkeypatch.setattr(conversations, "_conversation_title", lambda cid, path: "")
    monkeypatch.setattr(conversations, "_first_user_preview", lambda path: "")

    result = conversations._list_conversations_sync(None, 0, 50)

    assert [item["id"] for item in result["items"]] == ["new.txt", "old.txt"]


def test_session_index_concurrent_reads_share_one_refresh(monkeypatch):
    import concurrent.futures
    import threading
    import time

    _reset_index()
    calls = 0
    calls_lock = threading.Lock()
    start = threading.Barrier(8)
    monkeypatch.setattr(
        conversations,
        "_session_index_signature",
        lambda: (("a.txt", 1, 1),),
    )

    def slow_scan():
        nonlocal calls
        with calls_lock:
            calls += 1
        time.sleep(0.03)
        return [_row("/archive/a.txt", 1.0)]

    monkeypatch.setattr(conversations, "_ga_sessions", slow_scan)

    def read_index(_):
        start.wait(timeout=2)
        return conversations._session_by_id("a.txt")

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(read_index, range(8)))

    assert calls == 1
    assert results == [_row("/archive/a.txt", 1.0)] * 8


def test_delete_conversation_invalidates_index_after_unlink(tmp_path, monkeypatch):
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
        "delete",
        lambda cid, path: events.append("metadata-delete"),
    )
    monkeypatch.setattr(
        conversations,
        "_invalidate_session_index",
        lambda: events.append("invalidate"),
    )

    result = asyncio.run(conversations.delete_conversation("a.txt"))

    assert result == {"ok": True, "id": "a.txt"}
    assert not archive.exists()
    assert events == ["metadata-delete", "invalidate"]
