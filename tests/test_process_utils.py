from __future__ import annotations

import asyncio
import subprocess
from types import SimpleNamespace
from unittest import mock

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
    completed = SimpleNamespace(returncode=0, stdout="ok", stderr="")

    with (
        mock.patch.object(mykey._paths, "GA_ROOT", tmp_path),
        mock.patch.object(mykey, "_mykey_sync_script", return_value=script),
        mock.patch.object(process_utils.os, "name", "nt"),
        mock.patch.object(subprocess, "CREATE_NO_WINDOW", 0x08000000, create=True),
        mock.patch.object(mykey.subprocess, "run", return_value=completed) as run,
    ):
        result = mykey._run_mykey_sync(["upload"])

    assert result["returncode"] == 0
    assert run.call_args.kwargs["creationflags"] == 0x08000000
