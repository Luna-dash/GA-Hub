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
