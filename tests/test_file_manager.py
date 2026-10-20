"""Explorer reuse without opening real windows during the test suite."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from server.services import file_manager as fm


class Folder:
    def __init__(self, path):
        self.Self = SimpleNamespace(Path=str(path))
        self.ParseName = Mock(side_effect=lambda name: name)


class Window:
    def __init__(self, hwnd, folder):
        self.HWND = hwnd
        self.FullName = "explorer.exe"
        self.Document = SimpleNamespace(Folder=Folder(folder), SelectItem=Mock())
        self.Navigate2 = Mock(side_effect=self.navigate)

    def navigate(self, folder):
        self.Document.Folder = Folder(folder)


@pytest.fixture
def environment(tmp_path, monkeypatch):
    manager = fm.ExplorerWindow()
    windows = [Window(10, tmp_path)]  # An existing user window, even same folder.
    shell = SimpleNamespace(Windows=lambda: list(windows))
    monkeypatch.setattr(manager, "_activate", Mock())
    clock = [0.0]
    monkeypatch.setattr(fm.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(fm.time, "sleep", lambda seconds: clock.__setitem__(0, clock[0] + seconds))
    launch = Mock(side_effect=lambda command: windows.append(Window(20 + launch.call_count, tmp_path)))
    monkeypatch.setattr(fm.subprocess, "Popen", launch)
    return manager, shell, windows, launch


def test_reuses_owned_window_across_files_and_directories(tmp_path, environment):
    manager, shell, windows, launch = environment
    first = tmp_path / "file with spaces.txt"
    first.touch()
    second = tmp_path / "other directory" / "报告.txt"
    second.parent.mkdir()
    second.touch()

    for target in [first, first, second, tmp_path]:
        manager._reveal(shell, target)

    launch.assert_called_once_with(f'explorer.exe /n,"{tmp_path}"')
    assert len(windows) == 2
    assert manager._hwnd == windows[1].HWND
    windows[0].Navigate2.assert_not_called()
    windows[0].Document.SelectItem.assert_not_called()
    assert windows[1].Navigate2.call_args_list == [((str(second.parent),),), ((str(tmp_path),),)]
    assert windows[1].Document.SelectItem.call_args_list[-1].args == (second.name, 29)


def test_closed_owned_window_is_recreated(tmp_path, environment):
    manager, shell, windows, launch = environment
    manager._reveal(shell, tmp_path)
    first_hwnd = manager._hwnd
    windows[:] = windows[:1]
    manager._reveal(shell, tmp_path)
    assert launch.call_count == 2
    assert manager._hwnd != first_hwnd
    assert windows[0].HWND == 10


def test_slow_launch_does_not_spawn_more_on_retry(tmp_path, environment):
    manager, shell, windows, launch = environment
    launch.side_effect = None
    for _ in range(2):
        with pytest.raises(OSError, match="still opening"):
            manager._reveal(shell, tmp_path)
    assert launch.call_count == 1
    windows.append(Window(55, tmp_path))
    manager._reveal(shell, tmp_path)
    assert manager._hwnd == 55
    assert manager._pending is None
    assert launch.call_count == 1


def test_failed_launch_can_be_retried(tmp_path, environment):
    manager, shell, windows, launch = environment
    launch.side_effect = OSError("missing explorer")
    with pytest.raises(OSError, match="missing explorer"):
        manager._reveal(shell, tmp_path)
    assert manager._pending is None
    launch.side_effect = lambda command: windows.append(Window(21, tmp_path))
    manager._reveal(shell, tmp_path)
    assert manager._hwnd == 21


def test_navigation_timeout_keeps_owned_window(tmp_path, environment):
    manager, shell, windows, launch = environment
    manager._reveal(shell, tmp_path)
    owned = windows[-1]
    owned.Navigate2.side_effect = None
    other = tmp_path / "other"
    other.mkdir()
    with pytest.raises(OSError, match="still navigating"):
        manager._reveal(shell, other)
    assert manager._hwnd == owned.HWND
    owned.Navigate2.side_effect = owned.navigate
    manager._reveal(shell, other)
    assert launch.call_count == 1


@pytest.mark.skipif(__import__('sys').platform != 'win32', reason='Windows COM adapter')
def test_concurrent_reveals_serialize_com_and_initialize_each_thread(tmp_path, environment, monkeypatch):
    import pythoncom
    from win32com.client import dynamic

    manager, shell, windows, launch = environment
    initialize, uninitialize = Mock(), Mock()
    monkeypatch.setattr(pythoncom, "CoInitialize", initialize)
    monkeypatch.setattr(pythoncom, "CoUninitialize", uninitialize)
    monkeypatch.setattr(dynamic, "Dispatch", lambda name: shell)
    with ThreadPoolExecutor(max_workers=4) as executor:
        list(executor.map(manager.reveal, [tmp_path] * 12))
    assert launch.call_count == 1
    assert len(windows) == 2
    assert initialize.call_count == uninitialize.call_count == 12


@pytest.mark.skipif(__import__('sys').platform != 'win32', reason='Windows focus adapter')
@pytest.mark.parametrize('retry_succeeds', [True, False])
def test_focus_retry_detaches_input_even_when_foreground_is_denied(monkeypatch, retry_succeeds):
    import win32api
    import win32gui
    import win32process

    foreground = [10]
    attempts = []

    def activate(hwnd):
        attempts.append(hwnd)
        if len(attempts) == 1 or not retry_succeeds:
            raise OSError('foreground denied')
        foreground[0] = hwnd

    monkeypatch.setattr(win32gui, 'IsIconic', lambda hwnd: False)
    monkeypatch.setattr(win32gui, 'GetForegroundWindow', lambda: foreground[0])
    monkeypatch.setattr(win32gui, 'SetForegroundWindow', activate)
    monkeypatch.setattr(win32api, 'GetCurrentThreadId', lambda: 100)
    monkeypatch.setattr(win32process, 'GetWindowThreadProcessId', lambda hwnd: (200, 300))
    attach, bring, flash = Mock(), Mock(), Mock()
    monkeypatch.setattr(win32process, 'AttachThreadInput', attach)
    monkeypatch.setattr(win32gui, 'BringWindowToTop', bring)
    monkeypatch.setattr(win32gui, 'FlashWindow', flash)
    fm.ExplorerWindow._activate(20)
    assert attempts == [20, 20]
    assert attach.call_args_list == [((100, 200, True),), ((100, 200, False),)]
    bring.assert_called_once_with(20)
    assert flash.call_count == (0 if retry_succeeds else 1)


@pytest.mark.skipif(__import__('sys').platform != 'win32', reason='Windows focus adapter')
def test_focus_success_does_not_attach_input(monkeypatch):
    import win32gui
    import win32process

    monkeypatch.setattr(win32gui, 'IsIconic', lambda hwnd: False)
    monkeypatch.setattr(win32gui, 'SetForegroundWindow', Mock())
    monkeypatch.setattr(win32gui, 'GetForegroundWindow', lambda: 20)
    attach = Mock()
    monkeypatch.setattr(win32process, 'AttachThreadInput', attach)
    fm.ExplorerWindow._activate(20)
    attach.assert_not_called()
