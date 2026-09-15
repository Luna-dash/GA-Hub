from __future__ import annotations

import json
import threading

import pytest

from server.services import conversation_titles
from server.services import session_metadata
from server.services.session_metadata import SessionMetadataStore


def _store(tmp_path):
    return SessionMetadataStore(tmp_path / "sessions")


def _write_legacy_sidecar(tmp_path, titles: dict[str, str]):
    sidecar = tmp_path / "legacy" / "titles.json"
    sidecar.parent.mkdir(parents=True, exist_ok=True)
    sidecar.write_text(
        json.dumps({"schema_version": 1, "titles": titles}), encoding="utf-8"
    )
    return sidecar


@pytest.fixture(autouse=True)
def _reset_migration_flag(monkeypatch):
    """Each test gets a fresh one-shot migration budget."""
    monkeypatch.setattr(conversation_titles, "_migrated", False)


def test_legacy_titles_are_migrated_once_via_sid_to_path_map(tmp_path):
    sessions = _store(tmp_path)
    archive = tmp_path / "model_responses_a.txt"
    archive.write_text("x", encoding="utf-8")
    sidecar = _write_legacy_sidecar(tmp_path, {"model_responses_a.txt": "Legacy title"})

    migrated = conversation_titles.migrate_legacy_titles(
        sessions, lambda sid: str(archive) if sid == "model_responses_a.txt" else None,
        sidecar=sidecar,
    )

    assert migrated == 1
    rows = sessions.list()
    assert len(rows) == 1
    assert rows[0]["title"] == "Legacy title"
    assert rows[0]["archive_path"] == str(archive.resolve())
    assert not sidecar.exists()


def test_migration_drops_titles_for_vanished_sessions_and_is_idempotent(tmp_path):
    sessions = _store(tmp_path)
    archive = tmp_path / "model_responses_a.txt"
    archive.write_text("x", encoding="utf-8")
    sidecar = _write_legacy_sidecar(tmp_path, {
        "model_responses_a.txt": "Legacy title",
        "model_responses_gone.txt": "Orphan",
    })

    resolver = lambda sid: str(archive) if sid == "model_responses_a.txt" else None  # noqa: E731
    assert conversation_titles.migrate_legacy_titles(
        sessions, resolver, sidecar=sidecar) == 1
    # Second sweep in the same process is a no-op (one-shot flag).
    assert conversation_titles.migrate_legacy_titles(
        sessions, resolver, sidecar=sidecar) == 0
    titles = {row["archive_path"]: row["title"] for row in sessions.list()}
    assert titles == {str(archive.resolve()): "Legacy title"}


def test_title_for_archive_reads_canonical_store_only(tmp_path):
    sessions = _store(tmp_path)
    archive = tmp_path / "archive.txt"
    archive.write_text("x", encoding="utf-8")

    assert sessions.title_for_archive(archive) == ""

    row = sessions.create(title="Canonical")
    sessions.bind_archive(row["id"], archive)
    assert sessions.title_for_archive(archive) == "Canonical"


def test_set_title_for_archive_keeps_stable_id(tmp_path):
    sessions = _store(tmp_path)
    archive = tmp_path / "archive.txt"
    archive.write_text("x", encoding="utf-8")

    first = sessions.set_title_for_archive(archive, "First")
    second = sessions.set_title_for_archive(archive, "Renamed")

    assert first["id"] == second["id"]
    assert second["title"] == "Renamed"
    assert len(sessions.list()) == 1


def test_archive_metadata_id_marks_title_only_rows(tmp_path):
    """The title row's id is the signal "metadata, not a binding"."""
    sessions = _store(tmp_path)
    bound = tmp_path / "bound.txt"
    bound.write_text("x", encoding="utf-8")
    owner = sessions.create(title="真实会话")
    sessions.bind_archive(owner["id"], bound)

    titled = sessions.set_title_for_archive(tmp_path / "untitled.txt", "改过名")

    assert session_metadata.is_archive_metadata_id(titled["id"]) is True
    assert session_metadata.is_archive_metadata_id(owner["id"]) is False
    assert session_metadata.is_archive_metadata_id("") is False
    assert session_metadata.is_archive_metadata_id(None) is False
    assert titled["id"].startswith(session_metadata.ARCHIVE_ROW_ID_PREFIX)


def test_conflicting_stable_id_binding_does_not_overwrite_other_session(tmp_path, monkeypatch):
    sessions = _store(tmp_path)
    first = tmp_path / "first.txt"
    second = tmp_path / "second.txt"
    first.write_text("1", encoding="utf-8")
    second.write_text("2", encoding="utf-8")
    monkeypatch.setattr(session_metadata, "stable_archive_id", lambda _path: "same-id")

    sessions.set_title_for_archive(first, "First")
    with pytest.raises(ValueError):
        sessions.set_title_for_archive(second, "Second")

    rows = sessions.list()
    assert len(rows) == 1
    assert rows[0]["archive_path"] == str(first.resolve())
    assert rows[0]["title"] == "First"


def test_delete_by_archive_removes_only_target_rows(tmp_path):
    sessions = _store(tmp_path)
    target = tmp_path / "target.txt"
    other = tmp_path / "other.txt"
    target.write_text("1", encoding="utf-8")
    other.write_text("2", encoding="utf-8")
    target_row = sessions.set_title_for_archive(target, "Target")
    other_row = sessions.set_title_for_archive(other, "Other")

    assert sessions.delete_by_archive(target) is True
    assert sessions.delete_by_archive(target) is False
    assert {row["id"] for row in sessions.list()} == {other_row["id"]}
    assert target_row["id"] != other_row["id"]


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
    store = _store(tmp_path)
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


def test_session_metadata_persists_optional_project_binding(tmp_path):
    store = _store(tmp_path)
    row = store.create()

    bound = store.update(row["id"], {
        "project_name": "GA-Hub-a1b2c3d4",
        "project_path": str(tmp_path / "repo"),
    })

    assert bound["project_name"] == "GA-Hub-a1b2c3d4"
    assert bound["project_path"] == str(tmp_path / "repo")
    assert store.get(row["id"])["project_name"] == "GA-Hub-a1b2c3d4"

    unbound = store.update(row["id"], {"project_name": None, "project_path": None})
    assert unbound["project_name"] is None
    assert unbound["project_path"] is None


def test_deleting_bound_archive_releases_session_runtime_before_unlink(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from server.routes import conversations, sessions

    sessions_store = _store(tmp_path)
    archive = tmp_path / "model_responses_delete.txt"
    archive.write_text("archive", encoding="utf-8")
    row = sessions_store.create(title="Bound")
    sessions_store.bind_archive(row["id"], archive)

    released: list[str] = []
    events: list[str] = []

    class Coordinator:
        def release_runtime(
            self, session_id: str, *, shutdown, operation="release", after_release=None
        ) -> bool:
            released.append(session_id)

            class Runtime:
                def shutdown(self) -> None:
                    events.append("shutdown")

            shutdown(Runtime())
            if after_release is not None:
                after_release()
            return True

    monkeypatch.setattr(sessions, "_coordinator", Coordinator())
    monkeypatch.setattr(conversations, "_metadata", sessions_store)
    monkeypatch.setattr(
        conversations,
        "archive_session_by_id",
        lambda cid: (str(archive), 0, "", 1),
    )

    app = FastAPI()
    app.include_router(conversations.router)
    with TestClient(app) as client:
        response = client.delete(f"/api/conversations/{archive.name}")

    assert response.status_code == 200
    assert released == [row["id"]]
    # Coordinator fakes execute the route callback synchronously; file absence
    # and unbinding prove the callback ran before release returned.
    assert not archive.exists()
    assert sessions_store.find_by_archive(archive) is None
