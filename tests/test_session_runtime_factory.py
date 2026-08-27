"""Runtime construction binds Hub metadata to GA's native log identity."""
from __future__ import annotations

import json
import subprocess
import sys
import types
from dataclasses import dataclass
from pathlib import Path

import pytest

from server.services.session_metadata import SessionMetadataStore
from server.services.session_runtime_factory import (
    RuntimeRestoreError,
    SessionRuntimeFactory,
    _pid_alive,
    _takeover_stale_lock,
)


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


def test_dead_process_lock_is_taken_over_and_restore_retried(tmp_path: Path) -> None:
    """重启后首次续接：死进程残留锁被清除，立即重试并成功。"""
    store = SessionMetadataStore(tmp_path / "metadata")
    row = store.create(title="stale lock")
    archive = tmp_path / "model_responses_dead.txt"
    archive.write_text("native archive", encoding="utf-8")
    store.bind_archive(row["id"], archive)
    calls: list[object] = []

    def make_service(*, session_id: str, manage_global_preference: bool) -> FakeService:
        return FakeService(tmp_path / "unused.txt", calls)

    def restore(agent: FakeAgent, path: str, **kwargs: object):
        calls.append(("restore", path))
        if len(calls) == 1:
            return "❌ 会话已被占用，无法原地接管", False
        agent.log_path = path
        return "✅ 已恢复", True

    def takeover(path: str) -> bool:
        calls.append(("takeover", path))
        return True

    factory = SessionRuntimeFactory(
        store,
        service_factory=make_service,
        continue_inplace=restore,
        takeover_stale_lock=takeover,
    )
    runtime = factory(row["id"])

    assert runtime.started is True
    assert calls == [
        ("restore", str(archive.resolve())),
        ("takeover", str(archive.resolve())),
        ("restore", str(archive.resolve())),
        "bind_rewind",
        "start",
    ]


def test_live_lock_holder_keeps_restore_failure(tmp_path: Path) -> None:
    """持锁进程仍活着（或探测不了）时不接管，维持原有报错。"""
    store = SessionMetadataStore(tmp_path / "metadata")
    row = store.create(title="live lock")
    archive = tmp_path / "model_responses_live.txt"
    store.bind_archive(row["id"], archive)
    calls: list[object] = []

    def make_service(*, session_id: str, manage_global_preference: bool) -> FakeService:
        return FakeService(tmp_path / "unused.txt", calls)

    def restore(agent: FakeAgent, path: str, **kwargs: object):
        calls.append("restore")
        return "❌ 会话已被占用，无法原地接管", False

    factory = SessionRuntimeFactory(
        store,
        service_factory=make_service,
        continue_inplace=restore,
        takeover_stale_lock=lambda path: False,
    )

    with pytest.raises(RuntimeRestoreError, match="已被占用"):
        factory(row["id"])
    assert calls == ["restore"]


def test_takeover_stale_lock_removes_only_dead_holder_lock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import server.services.session_runtime_factory as srf

    archive = tmp_path / "model_responses_x.txt"
    archive.write_text("native archive", encoding="utf-8")
    lock_file = tmp_path / "dead.lock"
    lock_file.write_text(json.dumps({"pid": 4242}), encoding="utf-8")

    fake_module = types.SimpleNamespace(
        session_occupant=lambda path: {"pid": 4242},
        _lock_path=lambda path: str(lock_file),
    )
    monkeypatch.setitem(sys.modules, "frontends.continue_cmd", fake_module)
    monkeypatch.setattr(srf, "_pid_alive", lambda pid: pid == 4242)

    assert srf._takeover_stale_lock(str(archive)) is False
    assert lock_file.exists()

    monkeypatch.setattr(srf, "_pid_alive", lambda pid: False)
    assert srf._takeover_stale_lock(str(archive)) is True
    assert not lock_file.exists()

    fake_module.session_occupant = lambda path: None
    assert srf._takeover_stale_lock(str(archive)) is False


def test_pid_alive_reports_own_process_and_dead_process() -> None:
    import os

    assert _pid_alive(0) is False
    assert _pid_alive(-1) is False
    assert _pid_alive(os.getpid()) is True  # 自身 pid 必然活着

    dead = subprocess.Popen([sys.executable, "-c", "pass"])
    dead.wait()
    # 竞态说明：等待退出后立即探测；pid 恰好在这一瞬间被复用时可能误报
    # 存活，方向保守（不接管），不影响正确性。
    assert _pid_alive(dead.pid) is False


def test_unreadable_archive_is_rotated_and_session_recovers(tmp_path: Path) -> None:
    """L2：prompt-only 等内容级损坏不再永久卡死，轮换新日志照常打开。"""
    store = SessionMetadataStore(tmp_path / "metadata")
    row = store.create(title="prompt-only")
    archive = tmp_path / "model_responses_464437.txt"
    archive.write_text(
        '=== Prompt === 2026-08-22 21:11:27\n{"role": "user"}\n',  # 无 Response
        encoding="utf-8",
    )
    store.bind_archive(row["id"], archive)
    calls: list[object] = []
    rotated_log = tmp_path / "model_responses_rotated.txt"

    def make_service(*, session_id: str, manage_global_preference: bool) -> FakeService:
        return FakeService(tmp_path / "unused.txt", calls)

    def restore(agent: FakeAgent, path: str, **kwargs: object):
        calls.append(("restore", path))
        agent.log_path = path
        return f"❌ {Path(path).name} 为空或格式不符", False

    def fresh(agent: FakeAgent) -> None:
        calls.append("fresh")
        agent.log_path = str(rotated_log)

    factory = SessionRuntimeFactory(
        store,
        service_factory=make_service,
        continue_inplace=restore,
        takeover_stale_lock=lambda path: False,
        begin_fresh_session=fresh,
    )
    runtime = factory(row["id"])

    assert runtime.started is True
    assert ("restore", str(archive.resolve())) in calls
    assert "fresh" in calls
    bound = store.get(row["id"])
    assert bound["archive_path"] == str(rotated_log.resolve())
    # 原档案被改名备份，数据不丢
    assert not archive.exists()
    backups = list(tmp_path.glob("model_responses_464437.txt.broken-*"))
    assert len(backups) == 1
    assert backups[0].read_text(encoding="utf-8").startswith("=== Prompt ===")


def test_busy_lock_refusal_still_raises_without_rotation(tmp_path: Path) -> None:
    """L3：真并发占用（持有者活着）必须继续报错，绝不轮换他人会话。"""
    store = SessionMetadataStore(tmp_path / "metadata")
    row = store.create(title="busy")
    archive = tmp_path / "model_responses_busy.txt"
    archive.write_text("native archive", encoding="utf-8")
    store.bind_archive(row["id"], archive)
    calls: list[object] = []

    def make_service(*, session_id: str, manage_global_preference: bool) -> FakeService:
        return FakeService(tmp_path / "unused.txt", calls)

    def restore(agent: FakeAgent, path: str, **kwargs: object):
        calls.append("restore")
        return "❌ 会话已被占用，无法原地接管", False

    def fresh(agent: FakeAgent) -> None:
        raise AssertionError("busy refusal must never rotate the archive")

    factory = SessionRuntimeFactory(
        store,
        service_factory=make_service,
        continue_inplace=restore,
        takeover_stale_lock=lambda path: False,
        begin_fresh_session=fresh,
    )

    with pytest.raises(RuntimeRestoreError, match="已被占用"):
        factory(row["id"])
    assert calls == ["restore"]


def test_pid_alive_treats_missing_windows_pid_as_dead() -> None:
    # 远超 Windows pid 空间的值必然 OpenProcess 失败且非 ACCESS_DENIED → 死
    assert _pid_alive(2**28) is False
