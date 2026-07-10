from pathlib import Path
from unittest.mock import Mock

import pytest
from fastapi import HTTPException

from server import _paths
from server.routes import upload


def test_resolve_reveal_path_allows_ga_files_and_rejects_outside(tmp_path, monkeypatch):
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

    outside = tmp_path / "secret.txt"
    outside.write_text("no", encoding="utf-8")
    with pytest.raises(HTTPException) as exc:
        upload._resolve_reveal_path(str(outside))
    assert exc.value.status_code == 403


def test_reveal_windows_selects_file_without_executing(tmp_path, monkeypatch):
    target = tmp_path / "report.md"
    target.write_text("ok", encoding="utf-8")
    popen = Mock()
    monkeypatch.setattr(upload.platform, "system", lambda: "Windows")
    monkeypatch.setattr(upload.subprocess, "Popen", popen)

    upload._reveal_in_file_manager(target)

    popen.assert_called_once_with(["explorer.exe", "/select,", str(target)])
