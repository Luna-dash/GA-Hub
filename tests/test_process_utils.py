from __future__ import annotations

import asyncio
import subprocess
from types import SimpleNamespace
from unittest import mock

import pytest
from fastapi import HTTPException

from server import process_utils
from server.routes import mykey


class _StartupInfo:
    def __init__(self) -> None:
        self.dwFlags = 0
        self.wShowWindow = -1


def test_hidden_process_kwargs_are_empty_off_windows():
    with mock.patch.object(process_utils.os, "name", "posix"):
        assert process_utils.hidden_process_kwargs() == {}


def test_hidden_process_kwargs_suppress_console_and_hide_window():
    with (
        mock.patch.object(process_utils.os, "name", "nt"),
        mock.patch.object(subprocess, "CREATE_NO_WINDOW", 0x08000000, create=True),
        mock.patch.object(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200, create=True),
        mock.patch.object(subprocess, "STARTUPINFO", _StartupInfo, create=True),
        mock.patch.object(subprocess, "STARTF_USESHOWWINDOW", 1, create=True),
        mock.patch.object(subprocess, "SW_HIDE", 0, create=True),
    ):
        kwargs = process_utils.hidden_process_kwargs(
            new_process_group=True,
            existing_creationflags=0x10,
        )

    assert kwargs["creationflags"] == 0x08000210
    assert kwargs["startupinfo"].dwFlags == 1
    assert kwargs["startupinfo"].wShowWindow == 0


def test_windows_mykey_open_uses_startfile_without_command_shell(tmp_path):
    target = tmp_path / "mykey.py"
    target.write_text("# config", encoding="utf-8")
    startfile = mock.Mock()

    with (
        mock.patch.object(mykey, "_mykey_path", return_value=target),
        mock.patch.object(mykey.sys, "platform", "win32"),
        mock.patch.object(mykey.os, "startfile", startfile, create=True),
        mock.patch.object(mykey.subprocess, "Popen") as popen,
    ):
        result = asyncio.run(mykey.open_mykey_file())

    assert result == {"ok": True, "path": str(target)}
    startfile.assert_called_once_with(str(target))
    popen.assert_not_called()


def test_windows_mykey_sync_uses_hidden_process_policy(tmp_path):
    script = tmp_path / "assets" / "mykey_sync.py"
    script.parent.mkdir()
    script.write_text("# sync", encoding="utf-8")
    python = tmp_path / "python.exe"
    python.write_bytes(b"")
    completed = SimpleNamespace(returncode=0, stdout="ok", stderr="")

    with (
        mock.patch.object(mykey._paths, "GA_ROOT", tmp_path),
        mock.patch.object(mykey, "_mykey_sync_script", return_value=script),
        mock.patch.object(mykey._paths, "discover_user_python", return_value=str(python)),
        mock.patch.dict(mykey.os.environ, {
            "GA_MYKEY_SYNC_PASSPHRASE": "passphrase-sentinel",
            "GA_MYKEY_UPLOAD_TOKEN": "token-sentinel",
        }),
        mock.patch.object(process_utils.os, "name", "nt"),
        mock.patch.object(subprocess, "CREATE_NO_WINDOW", 0x08000000, create=True),
        mock.patch.object(mykey.subprocess, "run", return_value=completed) as run,
    ):
        result = mykey._run_mykey_sync(["upload"])

    assert result["returncode"] == 0
    assert run.call_args.args[0] == [str(python), "-X", "utf8", str(script), "upload"]
    assert "passphrase-sentinel" not in run.call_args.args[0]
    assert "token-sentinel" not in run.call_args.args[0]
    assert run.call_args.kwargs["creationflags"] == 0x08000000
    assert run.call_args.kwargs["stdin"] is subprocess.DEVNULL
    assert run.call_args.kwargs["encoding"] == "utf-8"
    assert run.call_args.kwargs["errors"] == "replace"
    assert run.call_args.kwargs["env"]["GA_ROOT"] == str(tmp_path)
    assert run.call_args.kwargs["env"]["GA_PYTHON"] == str(python)
    assert run.call_args.kwargs["env"]["PYTHONUTF8"] == "1"
    assert run.call_args.kwargs["env"]["PYTHONIOENCODING"] == "utf-8"
    assert run.call_args.kwargs["env"]["GA_MYKEY_SYNC_PASSPHRASE"] == "passphrase-sentinel"
    assert run.call_args.kwargs["env"]["GA_MYKEY_UPLOAD_TOKEN"] == "token-sentinel"


def test_packaged_mykey_sync_rejects_sidecar_as_python(tmp_path):
    script = tmp_path / "assets" / "mykey_sync.py"
    script.parent.mkdir()
    script.write_text("# sync", encoding="utf-8")
    sidecar = tmp_path / "ga-hub-sidecar.exe"
    sidecar.write_bytes(b"")

    with (
        mock.patch.object(mykey._paths, "GA_ROOT", tmp_path),
        mock.patch.object(mykey, "_mykey_sync_script", return_value=script),
        mock.patch.object(mykey._paths, "discover_user_python", return_value=str(sidecar)),
        mock.patch.object(mykey.sys, "executable", str(sidecar)),
        mock.patch.object(mykey.sys, "frozen", True, create=True),
        mock.patch.object(mykey.subprocess, "run") as run,
        pytest.raises(HTTPException) as error,
    ):
        mykey._run_mykey_sync(["upload"])

    assert error.value.status_code == 503
    assert error.value.detail["error"] == "mykey_python_unavailable"
    run.assert_not_called()


def test_mykey_sync_reports_missing_cryptography_actionably(tmp_path):
    script = tmp_path / "assets" / "mykey_sync.py"
    script.parent.mkdir()
    script.write_text("# sync", encoding="utf-8")
    python = tmp_path / "python.exe"
    python.write_bytes(b"")
    completed = SimpleNamespace(
        returncode=1,
        stdout="",
        stderr="ModuleNotFoundError: No module named 'cryptography'\n",
    )

    with (
        mock.patch.object(mykey._paths, "GA_ROOT", tmp_path),
        mock.patch.object(mykey, "_mykey_sync_script", return_value=script),
        mock.patch.object(mykey._paths, "discover_user_python", return_value=str(python)),
        mock.patch.object(mykey.subprocess, "run", return_value=completed),
        pytest.raises(HTTPException) as error,
    ):
        mykey._run_mykey_sync(["upload"])

    assert error.value.status_code == 500
    assert error.value.detail["error"] == "mykey_sync_failed"
    assert "cryptography" in error.value.detail["message"]
    assert str(python) in error.value.detail["message"]


@pytest.mark.parametrize(
    ("environment", "expected_url"),
    [
        ({}, "https://sector.lunadash.me/api/mykey/upload"),
        ({"GA_MYKEY_SYNC_URL": "https://mirror.example/"}, "https://mirror.example/api/mykey/upload"),
        ({"GA_MYKEY_SYNC_UPLOAD_URL": "https://upload.example/custom"}, "https://upload.example/custom"),
    ],
)
def test_mykey_upload_route_preserves_sync_cli_url_contract(tmp_path, environment, expected_url):
    target = tmp_path / "mykey.py"
    target.write_text("# config\n", encoding="utf-8")
    runner = mock.Mock(return_value={"returncode": 0, "stdout": "ok", "stderr": ""})

    with (
        mock.patch.object(mykey, "_mykey_path", return_value=target),
        mock.patch.object(mykey, "_run_mykey_sync", runner),
        mock.patch.dict(mykey.os.environ, environment, clear=True),
    ):
        result = asyncio.run(mykey.sync_upload_mykey())

    assert result["ok"] is True
    runner.assert_called_once_with([
        "upload",
        "--upload-url", expected_url,
        "--source", str(target),
    ])
