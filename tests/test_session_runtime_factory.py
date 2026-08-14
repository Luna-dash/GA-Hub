"""Runtime construction binds Hub metadata to GA's native log identity."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import pytest

from server.services.session_metadata import SessionMetadataStore
from server.services.session_runtime_factory import RuntimeRestoreError, SessionRuntimeFactory


@dataclass
class FakeAgent:
    log_path: str


class FakeService:
    def __init__(self, log_path: Path, calls: list[object]) -> None:
        self.agent = FakeAgent(str(log_path))
        self.calls = calls
        self.started = False

    def start_run_thread(self) -> None:
        self.calls.append("start")
        self.started = True

    def bind_rewind_store(self) -> None:
        self.calls.append("bind_rewind")


def test_new_session_binds_native_log_and_starts_runtime(tmp_path: Path) -> None:
    store = SessionMetadataStore(tmp_path / "metadata")
    row = store.create(title="new")
    calls: list[object] = []
    native_log = tmp_path / "model_responses_123456.txt"

    def make_service(*, session_id: str, manage_global_preference: bool) -> FakeService:
        calls.append(("construct", session_id, manage_global_preference))
        return FakeService(native_log, calls)

    def acquire(agent: FakeAgent, agent_id: str) -> None:
        calls.append(("birth_lock", agent.log_path, agent_id))

    factory = SessionRuntimeFactory(
        store,
        service_factory=make_service,
        acquire_birth_lock=acquire,
    )
    runtime = factory(row["id"])

    assert runtime.started is True
    assert calls == [
        ("construct", row["id"], False),
        ("birth_lock", str(native_log), row["id"]),
        "bind_rewind",
        "start",
    ]
    bound = store.get(row["id"])
    assert bound["archive_path"] == str(native_log.resolve())
    assert "messages" not in bound


def test_existing_session_restores_native_archive_before_start(tmp_path: Path) -> None:
    store = SessionMetadataStore(tmp_path / "metadata")
    row = store.create(title="existing")
    archive = tmp_path / "model_responses_654321.txt"
    archive.write_text("native GA archive", encoding="utf-8")
    store.bind_archive(row["id"], archive)
    calls: list[object] = []

    def make_service(*, session_id: str, manage_global_preference: bool) -> FakeService:
        calls.append(("construct", session_id, manage_global_preference))
        return FakeService(tmp_path / "unused.txt", calls)

    def restore(agent: FakeAgent, path: str, **kwargs: object):
        calls.append(("restore", path, kwargs))
        agent.log_path = path
        return "restored", True

    factory = SessionRuntimeFactory(
        store,
        service_factory=make_service,
        continue_inplace=restore,
    )
    runtime = factory(row["id"])

    assert runtime.started is True
    assert calls == [
        ("construct", row["id"], False),
        (
            "restore",
            str(archive.resolve()),
            {"agent_id": row["id"], "restore_wm": True},
        ),
        "bind_rewind",
        "start",
    ]


def test_restore_failure_does_not_start_runtime(tmp_path: Path) -> None:
    store = SessionMetadataStore(tmp_path / "metadata")
    row = store.create(title="broken")
    archive = tmp_path / "broken.txt"
    store.bind_archive(row["id"], archive)
    calls: list[object] = []

    def make_service(*, session_id: str, manage_global_preference: bool) -> FakeService:
        return FakeService(tmp_path / "unused.txt", calls)

    def restore(agent: FakeAgent, path: str, **kwargs: object):
        calls.append("restore")
        return "cannot restore", False

    factory = SessionRuntimeFactory(
        store,
        service_factory=make_service,
        continue_inplace=restore,
    )

    with pytest.raises(RuntimeRestoreError, match="cannot restore"):
        factory(row["id"])
    assert calls == ["restore"]


def test_bound_project_is_restored_when_runtime_is_created(tmp_path: Path) -> None:
    store = SessionMetadataStore(tmp_path / "metadata")
    row = store.create(title="project session")
    store.update(row["id"], {
        "project_name": "GA-Hub-a1b2c3d4",
        "project_path": str(tmp_path / "repo"),
    })
    calls: list[object] = []

    def make_service(*, session_id: str, manage_global_preference: bool) -> FakeService:
        return FakeService(tmp_path / "model_responses_project.txt", calls)

    runtime = SessionRuntimeFactory(store, service_factory=make_service)(row["id"])

    assert runtime.agent._ga_project_mode_name == "GA-Hub-a1b2c3d4"
    assert runtime.started is True


def test_rewind_store_failure_releases_archive_lock_and_never_starts(tmp_path: Path) -> None:
    store = SessionMetadataStore(tmp_path / "metadata")
    row = store.create(title="rewind failure")
    calls: list[object] = []

    class FailingService(FakeService):
        def bind_rewind_store(self) -> None:
            calls.append("bind_rewind")
            raise RuntimeError("checkpoint corrupt")

    def make_service(*, session_id: str, manage_global_preference: bool) -> FakeService:
        calls.append(("construct", session_id, manage_global_preference))
        return FailingService(tmp_path / "model_responses_failure.txt", calls)

    def acquire(agent: FakeAgent, agent_id: str) -> None:
        calls.append(("birth_lock", agent.log_path, agent_id))

    def release(agent: FakeAgent) -> None:
        calls.append(("release", agent.log_path))

    factory = SessionRuntimeFactory(
        store,
        service_factory=make_service,
        acquire_birth_lock=acquire,
        release_current=release,
    )

    with pytest.raises(RuntimeRestoreError, match="checkpoint initialization"):
        factory(row["id"])

    assert calls == [
        ("construct", row["id"], False),
        ("birth_lock", str(tmp_path / "model_responses_failure.txt"), row["id"]),
        "bind_rewind",
        ("release", str(tmp_path / "model_responses_failure.txt")),
    ]
