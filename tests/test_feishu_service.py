"""Regression tests for the Feishu process probe."""
from __future__ import annotations

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
