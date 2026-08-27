"""Regression coverage for the gahub_app engine-adapter service surface.

These pin the three post-restructuring defects found by live diagnosis:
the missing GET /chat bootstrap proxy, replayed finals for untracked
request_ids, and the interpreter probe's child environment.
"""
from __future__ import annotations

import io
import subprocess
import threading

import pytest

from server.services import conductor_service as cs
from server.services.conductor_client import GahubProcessManager


def _bare_service() -> cs.ConductorService:
    """Build a ConductorService without running __init__ (no engine needed)."""
    return object.__new__(cs.ConductorService)


def test_get_chat_messages_proxies_engine_items(monkeypatch) -> None:
    service = _bare_service()

    class FakeClient:
        def __init__(self):
            self.calls = []

        def get_chat(self, last=20):
            self.calls.append(last)
            return [{"id": "a", "role": "user", "msg": "hi"}]

    client = FakeClient()
    service.client = client
    assert service.get_chat_messages(last=7) == [
        {"id": "a", "role": "user", "msg": "hi"}
    ]
    assert client.calls == [7]


def test_get_chat_messages_degrades_to_empty_when_engine_down(monkeypatch) -> None:
    service = _bare_service()

    class DownClient:
        def get_chat(self, last=20):
            raise RuntimeError("engine unreachable")

    service.client = DownClient()
    assert service.get_chat_messages(last=50) == []


def test_replayed_final_for_unknown_request_is_downgraded(monkeypatch) -> None:
    """Hello-snapshot finals for request ids this tracker never admitted must
    log-and-continue: no raise, chat line still mirrored, no transition."""
    service = _bare_service()
    service.chat_messages = []
    service._relayed_chat_ids = set()
    monkeypatch.setattr(cs.bus, "publish", lambda *a, **k: None)

    transitions: list = []
    monkeypatch.setattr(
        service, "_publish_workflow_transition",
        lambda transition: transitions.append(transition),
    )

    service._on_remote_chat({
        "id": "old-final",
        "role": "conductor",
        "msg": "已完成：历史请求的最终回复",
        "final": True,
        "request_id": "never-admitted",
    })

    assert not transitions
    # 聊天行本身仍然被镜像，UI 历史不受影响
    assert any(m["msg"] == "已完成：历史请求的最终回复" for m in service.chat_messages)


def test_probe_interpreter_passes_clean_child_env(monkeypatch) -> None:
    """The probe must launch its child with the _MEI-stripped environment —
    a regression here previously died on an undefined `env` name before any
    diagnostic could be produced."""
    captured: dict = {}

    class FakeProc:
        returncode = 0

        def communicate(self, timeout=None):
            return b"PROBE_OK\n", b""

    def fake_venv_popener(cmd, **kwargs):
        captured["cmd"] = cmd
        captured["env"] = kwargs.get("env")
        return FakeProc()

    monkeypatch.setattr(subprocess, "Popen", fake_venv_popener)

    manager = GahubProcessManager(python_exe="python-does-not-matter")
    polluted_path = f"C:\\Temp\\_MEI12345\\bin{chr(59)}C:\\Windows"
    monkeypatch.setattr("server.services.conductor_client.os.environ", {
        "PATH": polluted_path,
        "_PYI_ARCHIVE": "1",
    })
    manager._probe_interpreter(io.BytesIO())

    env = captured["env"]
    assert env is not None
    assert all("_MEI" not in item for item in env["PATH"].split(chr(59)))
    assert "_PYI_ARCHIVE" not in env
