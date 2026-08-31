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


def test_open_windows_file_uses_default_application(tmp_path, monkeypatch):
    target = tmp_path / "report.md"
    target.write_text("ok", encoding="utf-8")
    startfile = Mock()
    monkeypatch.setattr(upload.platform, "system", lambda: "Windows")
    monkeypatch.setattr(upload.os, "startfile", startfile, raising=False)

    upload._open_in_default_app(target)

    startfile.assert_called_once_with(str(target))


def test_open_windows_folder_uses_default_application_without_explorer_process(tmp_path, monkeypatch):
    target = tmp_path / "reports"
    target.mkdir()
    startfile = Mock()
    popen = Mock()
    monkeypatch.setattr(upload.platform, "system", lambda: "Windows")
    monkeypatch.setattr(upload.os, "startfile", startfile, raising=False)
    monkeypatch.setattr(upload.subprocess, "Popen", popen)

    upload._open_in_default_app(target)

    startfile.assert_called_once_with(str(target))
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


def test_fuzzy_find_unique_tail_hit_and_ambiguity(tmp_path, monkeypatch):
    ga_root = tmp_path / "ga"
    ga_root.mkdir()
    monkeypatch.setattr(_paths, "GA_ROOT", ga_root)
    monkeypatch.setattr(_paths, "ADMIN_ROOT", tmp_path / "hub")

    # 唯一命中：裸文件名在深层目录里
    deep = ga_root / "reports" / "deep"
    deep.mkdir(parents=True)
    (deep / "l4_archive_proposal.md").write_text("x", encoding="utf-8")
    hit, ambiguous = upload._fuzzy_find("l4_archive_proposal.md")
    assert hit == deep / "l4_archive_proposal.md"
    assert ambiguous is False

    # 多处命中 → 歧义即放弃
    (ga_root / "temp").mkdir()
    (ga_root / "temp" / "l4_archive_proposal.md").write_text("x", encoding="utf-8")
    hit, ambiguous = upload._fuzzy_find("l4_archive_proposal.md")
    assert hit is None
    assert ambiguous is True

    # 完全未命中
    hit, ambiguous = upload._fuzzy_find("nope.md")
    assert hit is None and ambiguous is False


def test_resolve_reveal_path_404_when_unresolved(tmp_path, monkeypatch):
    ga_root = tmp_path / "ga"
    ga_root.mkdir()
    monkeypatch.setattr(_paths, "GA_ROOT", ga_root)
    monkeypatch.setattr(_paths, "ADMIN_ROOT", tmp_path / "hub")

    with pytest.raises(HTTPException) as exc:
        upload._resolve_reveal_path("temp/ghost.md")
    assert exc.value.status_code == 404


def test_show_in_file_manager_selects_files_and_opens_dirs(tmp_path, monkeypatch):
    target_file = tmp_path / "report.md"
    target_file.write_text("x", encoding="utf-8")
    target_dir = tmp_path / "reports"
    target_dir.mkdir()
    popen = Mock()
    monkeypatch.setattr(upload.platform, "system", lambda: "Windows")
    monkeypatch.setattr(upload.subprocess, "Popen", popen)

    upload._show_in_file_manager(target_file)
    upload._show_in_file_manager(target_dir)

    # 路径引号在 /select, 参数内部；不能整参数重加引号（带空格路径会被
    # Explorer 解析坏），也不能带 SW_HIDE（GUI 进程窗口永不显示）。
    assert popen.call_args_list[0].args[0] == f'explorer /select,"{target_file}"'
    assert popen.call_args_list[1].args[0] == f'explorer "{target_dir}"'
    assert "startupinfo" not in popen.call_args_list[0].kwargs


def test_reveal_endpoint_supports_parent_mode(tmp_path, monkeypatch):
    import server.main as server_main
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

    client = TestClient(server_main.create_app(), base_url="http://127.0.0.1")
    resp = client.post("/api/files/reveal", json={"path": "docs/a.md", "mode": "parent"})

    assert resp.status_code == 200
    assert opened == [folder.resolve()]
