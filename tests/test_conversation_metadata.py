from __future__ import annotations

import threading

import pytest

from server.services.conversation_metadata import ConversationMetadataAdapter
from server.services.conversation_titles import ConversationTitleStore
from server.services.session_metadata import SessionMetadataStore


def _stores(tmp_path):
    sessions = SessionMetadataStore(tmp_path / "sessions")
    legacy = ConversationTitleStore(tmp_path / "legacy")
    return sessions, legacy, ConversationMetadataAdapter(sessions, legacy)


def test_legacy_title_is_migrated_once_to_session_metadata(tmp_path):
    sessions, legacy, metadata = _stores(tmp_path)
    archive = tmp_path / "archive.txt"
    archive.write_text("x", encoding="utf-8")
    legacy.set("archive.txt", "Legacy title")

    assert metadata.get_title("archive.txt", archive) == "Legacy title"
    rows = sessions.list()
    assert len(rows) == 1
    assert rows[0]["title"] == "Legacy title"
    assert rows[0]["archive_path"] == str(archive.resolve())
    assert legacy.get("archive.txt") == ""


def test_bound_session_title_wins_and_removes_stale_legacy_value(tmp_path):
    sessions, legacy, metadata = _stores(tmp_path)
    archive = tmp_path / "archive.txt"
    archive.write_text("x", encoding="utf-8")
    row = sessions.create(title="Canonical")
    sessions.bind_archive(row["id"], archive)
    legacy.set("archive.txt", "Stale")

    assert metadata.get_title("archive.txt", archive) == "Canonical"
    assert legacy.get("archive.txt") == ""


def test_set_title_uses_only_session_metadata_and_keeps_stable_id(tmp_path):
    sessions, legacy, metadata = _stores(tmp_path)
    archive = tmp_path / "archive.txt"
    archive.write_text("x", encoding="utf-8")

    first = metadata.set_title("archive.txt", archive, "First")
    second = metadata.set_title("archive.txt", archive, "Renamed")

    assert first["id"] == second["id"]
    assert second["title"] == "Renamed"
    assert len(sessions.list()) == 1
    assert legacy.get("archive.txt") == ""


def test_conflicting_stable_id_binding_does_not_overwrite_other_session(tmp_path, monkeypatch):
    sessions, _legacy, metadata = _stores(tmp_path)
    first = tmp_path / "first.txt"
    second = tmp_path / "second.txt"
    first.write_text("1", encoding="utf-8")
    second.write_text("2", encoding="utf-8")
    monkeypatch.setattr(metadata, "_stable_id", lambda _path: "same-id")

    metadata.set_title("first.txt", first, "First")
    with pytest.raises(ValueError):
        metadata.set_title("second.txt", second, "Second")

    rows = sessions.list()
    assert len(rows) == 1
    assert rows[0]["archive_path"] == str(first.resolve())
    assert rows[0]["title"] == "First"


def test_delete_removes_only_metadata_bound_to_target_archive(tmp_path):
    sessions, legacy, metadata = _stores(tmp_path)
    target = tmp_path / "target.txt"
    other = tmp_path / "other.txt"
    target.write_text("1", encoding="utf-8")
    other.write_text("2", encoding="utf-8")
    target_row = metadata.set_title("target.txt", target, "Target")
    other_row = metadata.set_title("other.txt", other, "Other")
    legacy.set("target.txt", "old")

    assert metadata.delete("target.txt", target) is True
    assert {row["id"] for row in sessions.list()} == {other_row["id"]}
    assert target_row["id"] != other_row["id"]
    assert legacy.get("target.txt") == ""


def test_store_instances_share_lock_for_concurrent_archive_upserts(tmp_path):
    base = tmp_path / "sessions"
    stores = [SessionMetadataStore(base), SessionMetadataStore(base)]
    barrier = threading.Barrier(2)
    errors = []

    def write(store, index):
        try:
            barrier.wait(timeout=2)
            for n in range(30):
                archive = tmp_path / f"{index}-{n}.txt"
                store.upsert_archive(
                    f"stable-{index}-{n}", archive, title=f"title-{index}-{n}"
                )
        except Exception as exc:  # pragma: no cover - asserted below
            errors.append(exc)

    threads = [threading.Thread(target=write, args=(store, i)) for i, store in enumerate(stores)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=5)

    assert errors == []
    assert all(not thread.is_alive() for thread in threads)
    assert len(SessionMetadataStore(base).list()) == 60


def test_atomic_write_failure_preserves_previous_file_and_cleans_temp(tmp_path, monkeypatch):
    from server.services import session_metadata

    store = SessionMetadataStore(tmp_path / "sessions")
    row = store.create(title="Before")
    original = store.path.read_bytes()

    def fail_replace(src, dst):
        raise OSError("injected replace failure")

    monkeypatch.setattr(session_metadata.os, "replace", fail_replace)
    with pytest.raises(OSError, match="injected replace failure"):
        store.update(row["id"], {"title": "After"})

    assert store.path.read_bytes() == original
    assert store.get(row["id"])["title"] == "Before"
    assert list(store.base_dir.glob("*.tmp")) == []
