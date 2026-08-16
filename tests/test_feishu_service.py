"""Regression tests for the Feishu process probe."""
from __future__ import annotations

import subprocess
from types import SimpleNamespace
from unittest import mock

from server.services.feishu_service import FeishuService


def test_windows_external_pid_probe_does_not_spawn_powershell():
    processes = [
        SimpleNamespace(info={"pid": 111, "name": "python.exe", "cmdline": ["python", r"D:\study\GA\frontends\fsapp.py"]}),
        SimpleNamespace(info={"pid": 43210, "name": "pythonw.exe", "cmdline": ["pythonw", "D:/study/GA/frontends/fsapp.py"]}),
        SimpleNamespace(info={"pid": 99999, "name": "node.exe", "cmdline": ["node", "frontends/fsapp.py"]}),
    ]
    service = FeishuService()

    with (
        mock.patch("server.services.feishu_service.os.name", "nt"),
        mock.patch("server.services.feishu_service.psutil.process_iter", return_value=processes) as process_iter,
        mock.patch("server.services.feishu_service.subprocess.run") as run,
    ):
        assert service._find_external_pid() == 43210

    process_iter.assert_called_once_with(["pid", "name", "cmdline"])
    run.assert_not_called()


def test_windows_helper_process_flags_hide_console_and_preserve_group():
    service = FeishuService()
    with (
        mock.patch("server.services.feishu_service.os.name", "nt"),
        mock.patch.object(subprocess, "CREATE_NO_WINDOW", 0x08000000, create=True),
        mock.patch.object(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200, create=True),
    ):
        assert service._creationflags() == 0x08000000
        assert service._creationflags(new_process_group=True) == 0x08000200


def test_windows_check_launches_python_without_console(tmp_path):
    service = FeishuService()
    fsapp = tmp_path / "fsapp.py"
    fsapp.write_text("# test fixture", encoding="utf-8")
    completed = SimpleNamespace(returncode=0, stdout='{"ready": true}')

    with (
        mock.patch("server.services.feishu_service.os.name", "nt"),
        mock.patch.object(subprocess, "CREATE_NO_WINDOW", 0x08000000, create=True),
        mock.patch.object(service, "fsapp_path", return_value=fsapp),
        mock.patch.object(service, "_python", return_value="python.exe"),
        mock.patch("server.services.feishu_service.subprocess.run", return_value=completed) as run,
    ):
        result = service.check()

    assert result["ready"] is True
    assert run.call_args.kwargs["creationflags"] == 0x08000000
