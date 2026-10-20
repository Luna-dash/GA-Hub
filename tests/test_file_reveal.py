from pathlib import Path
from unittest.mock import Mock

import pytest
from fastapi import HTTPException

from server import _paths
from server.routes import upload


def test_resolve_reveal_path_allows_any_safe_file_type(tmp_path, monkeypatch):
    ga_root = tmp_path / "ga"
    ga_root.mkdir()
    target = ga_root / "temp" / "report.md"
    target.parent.mkdir()
    target.write_text("ok", encoding="utf-8")
    uploads = tmp_path / "uploads"
    uploads.mkdir()

    monkeypatch.setattr(_paths, "GA_ROOT", ga_root)
    monkeypatch.setattr(_paths, "admin_uploads_dir", lambda: uploads)

    assert upload._resolve_reveal_path("temp/report.md") == target.resolve()
    assert upload._resolve_reveal_path(str(target)) == target.resolve()

    # Outside GA_ROOT is OK for safe document types (agent often cites Hub paths).
    outside = tmp_path / "notes.md"
    outside.write_text("ok", encoding="utf-8")
    assert upload._resolve_reveal_path(str(outside)) == outside.resolve()

    # Directories open in Explorer/Finder.
    folder = tmp_path / "folder"
    folder.mkdir()
    assert upload._resolve_reveal_path(str(folder)) == folder.resolve()


def test_resolve_reveal_path_rejects_executables_and_missing(tmp_path, monkeypatch):
    ga_root = tmp_path / "ga"
    ga_root.mkdir()
    monkeypatch.setattr(_paths, "GA_ROOT", ga_root)
    monkeypatch.setattr(_paths, "admin_uploads_dir", lambda: tmp_path / "uploads")

    exe = tmp_path / "evil.exe"
    exe.write_bytes(b"MZ")
    with pytest.raises(HTTPException) as exc:
        upload._resolve_reveal_path(str(exe))
    assert exc.value.status_code == 403
    assert "not allowed" in str(exc.value.detail).lower()

    bat = tmp_path / "run.bat"
    bat.write_text("@echo off\n", encoding="utf-8")
    with pytest.raises(HTTPException) as exc2:
        upload._resolve_reveal_path(str(bat))
    assert exc2.value.status_code == 403

    missing = tmp_path / "nope.md"
    with pytest.raises(HTTPException) as exc3:
        upload._resolve_reveal_path(str(missing))
    assert exc3.value.status_code == 404


@pytest.mark.parametrize("is_dir", [False, True])
def test_windows_files_and_folders_use_shared_explorer(tmp_path, monkeypatch, is_dir):
    from server.services.file_manager import explorer_window

    target = tmp_path / ("reports" if is_dir else "report.md")
    if is_dir:
        target.mkdir()
    else:
        target.write_text("ok", encoding="utf-8")
    reveal = Mock()
    startfile = Mock()
    popen = Mock()
    monkeypatch.setattr(upload.platform, "system", lambda: "Windows")
    monkeypatch.setattr(upload.os, "startfile", startfile, raising=False)
    monkeypatch.setattr(upload.subprocess, "Popen", popen)
    monkeypatch.setattr(explorer_window, "reveal", reveal)

    upload._open_in_default_app(target)

    reveal.assert_called_once_with(target)
    startfile.assert_not_called()
    popen.assert_not_called()


def test_windows_reuse_failure_does_not_spawn_another_window(tmp_path, monkeypatch):
    from server.services.file_manager import explorer_window

    monkeypatch.setattr(upload.platform, "system", lambda: "Windows")
    monkeypatch.setattr(explorer_window, "reveal", Mock(side_effect=OSError("busy")))
    popen = Mock()
    monkeypatch.setattr(upload.subprocess, "Popen", popen)
    with pytest.raises(HTTPException) as exc:
        upload._show_in_file_manager(tmp_path)
    assert exc.value.status_code == 500
    popen.assert_not_called()


def test_resolve_path_info_citation_cascade(tmp_path, monkeypatch):
    ga_root = tmp_path / "ga"
    temp = ga_root / "temp"
    l4 = ga_root / "memory" / "L4_raw_sessions"
    for folder in (temp, l4):
        folder.mkdir(parents=True)
    (temp / "model_responses_1.txt").write_text("x", encoding="utf-8")
    (l4 / "sess.txt").write_text("x", encoding="utf-8")
    hub = tmp_path / "hub" / "scripts"
    hub.mkdir(parents=True)
    (hub / "build_all.py").write_text("x", encoding="utf-8")
    monkeypatch.setattr(_paths, "GA_ROOT", ga_root)
    monkeypatch.setattr(_paths, "ADMIN_ROOT", tmp_path / "hub")

    # 相对 ga_root（temp 前缀齐全）
    info = upload._resolve_path_info("temp/model_responses_1.txt")
    assert info["resolved"] == str((temp / "model_responses_1.txt").resolve())
    assert info["exists"] and not info["is_dir"]

    # 省略 temp 的裸文件名
    info = upload._resolve_path_info("model_responses_1.txt")
    assert info["resolved"] == str((temp / "model_responses_1.txt").resolve())

    # 省略 memory/L4_raw_sessions 的裸文件名
    info = upload._resolve_path_info("sess.txt")
    assert info["resolved"] == str((l4 / "sess.txt").resolve())

    # GA-Hub 仓库内相对路径（反斜杠 + ./ 噪声）
    info = upload._resolve_path_info(r".\scripts\build_all.py")
    assert info["resolved"] == str((hub / "build_all.py").resolve())

    # 绝对路径原样
    outside = tmp_path / "notes.md"
    outside.write_text("x", encoding="utf-8")
    assert upload._resolve_path_info(str(outside))["resolved"] == str(outside.resolve())

    # 目录也算命中
    folder = ga_root / "temp" / "reports"
    folder.mkdir()
    info = upload._resolve_path_info("reports")
    assert info["is_dir"] is True


def test_project_search_unique_tail_hit_and_ambiguity(tmp_path, monkeypatch):
    ga = tmp_path / "ga"
    ga.mkdir()
    monkeypatch.setattr(_paths, "GA_ROOT", ga)
    monkeypatch.setattr(_paths, "ADMIN_ROOT", tmp_path / "hub")
    project = tmp_path / "project"
    deep = project / "reports" / "deep"
    deep.mkdir(parents=True)
    target = deep / "diagram.svg"
    target.write_text("x", encoding="utf-8")
    assert upload._resolve_path_info("diagram.svg")["resolved"] is None
    info = upload._resolve_path_info("diagram.svg", str(project))
    assert info["resolved"] == str(target.resolve())
    assert upload._resolve_path_info("reports/deep/diagram.svg", str(project))["resolved"] == str(target.resolve())
    assert upload._resolve_path_info("unrelated/diagram.svg", str(project))["resolved"] is None
    second = project / "other"
    second.mkdir()
    (second / "diagram.svg").write_text("x", encoding="utf-8")
    info = upload._resolve_path_info("diagram.svg", str(project))
    assert info["resolved"] is None and info["ambiguous"]
    assert len(info["candidates"]) == 2
    assert upload._resolve_path_info("nope.md", str(project))["resolved"] is None


def test_resolve_reveal_path_404_when_unresolved(tmp_path, monkeypatch):
    ga_root = tmp_path / "ga"
    ga_root.mkdir()
    monkeypatch.setattr(_paths, "GA_ROOT", ga_root)
    monkeypatch.setattr(_paths, "ADMIN_ROOT", tmp_path / "hub")

    with pytest.raises(HTTPException) as exc:
        upload._resolve_reveal_path("temp/ghost.md")
    assert exc.value.status_code == 404


@pytest.mark.parametrize("system, command", [("Darwin", "open"), ("Linux", "xdg-open")])
def test_non_windows_reveal_opens_parent_or_directory(tmp_path, monkeypatch, system, command):
    target_file = tmp_path / "report.md"
    target_file.write_text("x", encoding="utf-8")
    target_dir = tmp_path / "reports"
    target_dir.mkdir()
    popen = Mock()
    monkeypatch.setattr(upload.platform, "system", lambda: system)
    monkeypatch.setattr(upload.subprocess, "Popen", popen)

    upload._show_in_file_manager(target_file)
    upload._show_in_file_manager(target_dir)

    assert popen.call_args_list[0].args[0] == [command, str(tmp_path)]
    assert popen.call_args_list[1].args[0] == [command, str(target_dir)]


def test_reveal_endpoint_supports_parent_mode(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    folder = tmp_path / "docs"
    folder.mkdir()
    target = folder / "a.md"
    target.write_text("x", encoding="utf-8")
    monkeypatch.setattr(_paths, "GA_ROOT", tmp_path)
    monkeypatch.setattr(_paths, "ADMIN_ROOT", tmp_path)
    monkeypatch.setattr(_paths, "admin_uploads_dir", lambda: tmp_path / "uploads")
    opened = []
    monkeypatch.setattr(upload, "_open_in_default_app", lambda p: opened.append(p))

    # This is a file-route test; a full app requires a successful GA startup
    # probe before serving normal endpoints (covered by test_core_startup).
    app = FastAPI()
    app.include_router(upload.router)
    client = TestClient(app, base_url="http://127.0.0.1")
    resp = client.post("/api/files/reveal", json={"path": "docs/a.md", "mode": "parent"})

    assert resp.status_code == 200
    assert opened == [folder.resolve()]


def test_exact_paths_do_not_scan_and_format_variants(tmp_path, monkeypatch):
    from server.services import file_resolution as resolver
    monkeypatch.setattr(_paths, "GA_ROOT", tmp_path)
    target = tmp_path / "a space.md"
    target.write_text("x", encoding="utf-8")
    monkeypatch.setattr(resolver.os, "scandir", Mock(side_effect=AssertionError("exact hit must not scan")))
    for raw in [str(target), target.as_uri(), str(target) + ":12:3"]:
        assert resolver.resolve(raw)["resolved"] == str(target.resolve())
    assert resolver.resolve(str(tmp_path / "missing" / "a space.md"))["resolved"] is None


def test_bounded_search_does_not_cross_projects_or_shared_temp(tmp_path, monkeypatch):
    from server.services import file_resolution as resolver
    monkeypatch.setattr(_paths, "GA_ROOT", tmp_path)
    project = tmp_path / "project"
    project.mkdir()
    other = tmp_path / "temp" / "other-project"
    other.mkdir(parents=True)
    (other / "report.md").write_text("x", encoding="utf-8")
    assert resolver.resolve("report.md", str(project))["resolved"] is None
    nested = project / "docs"
    nested.mkdir()
    (nested / "report.md").write_text("x", encoding="utf-8")
    monkeypatch.setattr(resolver, "MAX_ENTRIES", 1)
    info = resolver.resolve("report.md", str(project))
    assert info["incomplete"] and info["resolved"] is None


def test_file_work_admission_is_bounded_and_independent(monkeypatch):
    import asyncio
    from concurrent.futures import ThreadPoolExecutor
    from threading import BoundedSemaphore, Event

    async def exercise():
        started, release = Event(), Event()
        slots = BoundedSemaphore(1)
        other_slots = BoundedSemaphore(1)
        def blocking():
            started.set()
            release.wait(5)
            return 1
        with ThreadPoolExecutor(max_workers=1) as pool, ThreadPoolExecutor(max_workers=1) as other:
            monkeypatch.setitem(upload._FILE_POOLS, "test", (pool, slots))
            monkeypatch.setitem(upload._FILE_POOLS, "other", (other, other_slots))
            task = asyncio.create_task(upload._file_job("test", blocking))
            try:
                while not started.is_set():
                    await asyncio.sleep(0.001)
                with pytest.raises(HTTPException) as exc:
                    await upload._file_job("test", lambda: 2)
                assert exc.value.status_code == 429
                assert await upload._file_job("other", lambda: 3) == 3
                task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await task
                # Cancelling the waiter must not free a still-running worker.
                assert not slots.acquire(blocking=False)
            finally:
                release.set()
        assert slots.acquire(blocking=False)
        slots.release()
    asyncio.run(exercise())
