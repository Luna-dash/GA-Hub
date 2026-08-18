"""Regression tests for the Feishu process probe."""
from __future__ import annotations

import json
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest import mock

from server.process_utils import hidden_process_kwargs
from server.services.feishu_service import FeishuService


def _chat_line(event_id: str, *, newline: bool = True) -> str:
    payload = {"event_id": event_id, "type": "message", "text": event_id}
    suffix = "\n" if newline else ""
    return f"INFO {FeishuService._CHAT_MARKER}{json.dumps(payload)}{suffix}"


def test_feishu_log_cursor_reads_tail_then_only_appends(tmp_path):
    log_file = tmp_path / "feishuapp.log"
    log_file.write_text(_chat_line("initial-1") + _chat_line("initial-2"), encoding="utf-8")
    service = FeishuService()

    with mock.patch.object(service, "log_file", return_value=log_file), mock.patch(
        "server.services.feishu_service.bus.publish"
    ) as publish:
        assert service._publish_chat_events_from_log() == 2
        assert publish.call_count == 2

        with log_file.open("a", encoding="utf-8") as handle:
            handle.write(_chat_line("appended"))
        assert service._publish_chat_events_from_log() == 1
        assert service._publish_chat_events_from_log() == 0

    assert [call.args[1]["event_id"] for call in publish.call_args_list] == [
        "initial-1",
        "initial-2",
        "appended",
    ]


def test_feishu_log_cursor_waits_for_partial_final_line(tmp_path):
    log_file = tmp_path / "feishuapp.log"
    log_file.write_text(_chat_line("partial", newline=False), encoding="utf-8")
    service = FeishuService()

    with mock.patch.object(service, "log_file", return_value=log_file), mock.patch(
        "server.services.feishu_service.bus.publish"
    ) as publish:
        assert service._publish_chat_events_from_log() == 0
        with log_file.open("a", encoding="utf-8") as handle:
            handle.write("\n")
        assert service._publish_chat_events_from_log() == 1
        assert publish.call_args.args[1]["event_id"] == "partial"


def test_feishu_log_cursor_resets_after_replacement_and_deduplicates_ids(tmp_path):
    log_file = tmp_path / "feishuapp.log"
    log_file.write_text(_chat_line("before"), encoding="utf-8")
    service = FeishuService()

    with mock.patch.object(service, "log_file", return_value=log_file), mock.patch(
        "server.services.feishu_service.bus.publish"
    ) as publish:
        assert service._publish_chat_events_from_log() == 1
        replacement = tmp_path / "feishuapp.log.new"
        replacement.write_text(_chat_line("after") + _chat_line("after"), encoding="utf-8")
        replacement.replace(log_file)
        assert service._publish_chat_events_from_log() == 1

    assert [call.args[1]["event_id"] for call in publish.call_args_list] == ["before", "after"]


def test_feishu_tail_reads_bounded_lines(tmp_path):
    log_file = tmp_path / "feishuapp.log"
    log_file.write_text("".join(f"line-{i}\n" for i in range(1000)), encoding="utf-8")
    service = FeishuService()

    with mock.patch.object(service, "log_file", return_value=log_file):
        assert service.tail(3) == ["line-997\n", "line-998\n", "line-999\n"]


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
    with (
        mock.patch("server.services.feishu_service.os.name", "nt"),
        mock.patch.object(subprocess, "CREATE_NO_WINDOW", 0x08000000, create=True),
        mock.patch.object(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200, create=True),
    ):
        assert hidden_process_kwargs()["creationflags"] == 0x08000000
        assert hidden_process_kwargs(new_process_group=True)["creationflags"] == 0x08000200


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


def test_check_singleflight_shares_one_probe_between_threads(tmp_path):
    service = FeishuService()
    fsapp = tmp_path / "fsapp.py"
    fsapp.write_text("# test fixture", encoding="utf-8")
    completed = SimpleNamespace(returncode=0, stdout='{"ready": true}')

    def slow_run(*_args, **_kwargs):
        import time

        time.sleep(0.15)
        return completed

    with (
        mock.patch.object(service, "fsapp_path", return_value=fsapp),
        mock.patch.object(service, "_python", return_value="python.exe"),
        mock.patch("server.services.feishu_service.subprocess.run", side_effect=slow_run) as run,
        mock.patch("server.services.feishu_service.bus.publish"),
    ):
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _index: service.check(), range(8)))

    assert run.call_count == 1
    assert all(result["ok"] is True for result in results)


def test_check_cache_supports_explicit_refresh(tmp_path):
    service = FeishuService()
    fsapp = tmp_path / "fsapp.py"
    fsapp.write_text("# test fixture", encoding="utf-8")
    completed = SimpleNamespace(returncode=0, stdout='{"ready": true}')

    with (
        mock.patch.object(service, "fsapp_path", return_value=fsapp),
        mock.patch.object(service, "_python", return_value="python.exe"),
        mock.patch("server.services.feishu_service.subprocess.run", return_value=completed) as run,
        mock.patch("server.services.feishu_service.bus.publish"),
    ):
        service.check()
        service.check()
        service.check(force=True)

    assert run.call_count == 2


def test_status_external_pid_probe_is_singleflight_and_negative_cached(tmp_path):
    service = FeishuService()
    fsapp = tmp_path / "fsapp.py"
    log_file = tmp_path / "feishuapp.log"
    fsapp.write_text("# fixture", encoding="utf-8")

    def slow_probe():
        time.sleep(0.1)
        return None

    with (
        mock.patch.object(service, "fsapp_path", return_value=fsapp),
        mock.patch.object(service, "log_file", return_value=log_file),
        mock.patch.object(service, "_python", return_value="python.exe"),
        mock.patch.object(service, "_publish_chat_events_from_log", return_value=0),
        mock.patch.object(service, "_find_external_pid", side_effect=slow_probe) as probe,
    ):
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _index: service.status(), range(8)))
        cached = service.status()

    assert probe.call_count == 1
    assert all(result["running"] is False for result in [*results, cached])


def test_status_external_pid_cache_expires(tmp_path):
    service = FeishuService()
    service._STATUS_PID_CACHE_TTL_SECONDS = 0.02
    fsapp = tmp_path / "fsapp.py"
    log_file = tmp_path / "feishuapp.log"

    with (
        mock.patch.object(service, "fsapp_path", return_value=fsapp),
        mock.patch.object(service, "log_file", return_value=log_file),
        mock.patch.object(service, "_python", return_value="python.exe"),
        mock.patch.object(service, "_publish_chat_events_from_log", return_value=0),
        mock.patch.object(service, "_find_external_pid", return_value=None) as probe,
    ):
        service.status()
        service.status()
        time.sleep(0.03)
        service.status()

    assert probe.call_count == 2


def test_start_bypasses_negative_status_pid_cache(tmp_path):
    service = FeishuService()
    fsapp = tmp_path / "fsapp.py"
    log_file = tmp_path / "feishuapp.log"
    fsapp.write_text("# fixture", encoding="utf-8")

    with (
        mock.patch.object(service, "fsapp_path", return_value=fsapp),
        mock.patch.object(service, "log_file", return_value=log_file),
        mock.patch.object(service, "_python", return_value="python.exe"),
        mock.patch.object(service, "_publish_chat_events_from_log", return_value=0),
        mock.patch.object(service, "_find_external_pid", side_effect=[None, 43210]) as probe,
        mock.patch("server.services.feishu_service.subprocess.Popen") as popen,
    ):
        assert service.status()["running"] is False
        result = service.start()

    assert result == {
        "started": False,
        "running": True,
        "pid": 43210,
        "external": True,
    }
    assert probe.call_count == 2
    popen.assert_not_called()


def test_status_log_refresh_is_singleflight_but_forced_reads_remain_live():
    service = FeishuService()

    def slow_read(_n=300):
        time.sleep(0.1)
        return _chat_line("status")

    with (
        mock.patch.object(service, "_read_incremental_log_text", side_effect=slow_read) as read,
        mock.patch.object(service, "_publish_chat_events_from_text", return_value=1),
    ):
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(
                lambda _index: service._publish_chat_events_from_log(min_interval=1.0),
                range(8),
            ))
        service._publish_chat_events_from_log()
        service._publish_chat_events_from_log()

    assert read.call_count == 3
    assert results.count(1) == 1
    assert results.count(0) == 7


def test_failed_log_refresh_releases_waiters_and_allows_retry():
    service = FeishuService()
    attempts = 0

    def flaky_read(_n=300):
        nonlocal attempts
        attempts += 1
        time.sleep(0.05)
        if attempts == 1:
            raise OSError("temporary log failure")
        return _chat_line("retry")

    def refresh(_index):
        try:
            return service._publish_chat_events_from_log(min_interval=1.0)
        except OSError:
            return "error"

    with (
        mock.patch.object(service, "_read_incremental_log_text", side_effect=flaky_read),
        mock.patch.object(service, "_publish_chat_events_from_text", return_value=1),
    ):
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(refresh, range(2)))

    assert sorted(results, key=str) == [1, "error"]
    assert attempts == 2
