"""LLM/MyKey ping probes must leave no archive behind.

Every ``client.chat`` round-trip writes ``temp/model_responses/model_responses_<pid>.txt``
unless ``client.log_path`` is ``False``. The 历史对话 page globs that directory,
so a single ping used to materialize a new bogus session entry (or append probe
noise into the live session archive). These tests pin the silence contract:
during a probe ``log_path`` is False, afterwards it is restored.

(The agent-side /api/llms probe chain was deleted as dead code — the only
live ping entry is MyKey's, covered here.)
"""
from __future__ import annotations

import types
from types import SimpleNamespace
from unittest import mock

from server.routes import mykey


class _RecordingClient:
    """Fake ToolClient stand-in that records what log_path it saw."""

    def __init__(self, *, initial_log=None):
        self.backend = SimpleNamespace(history=["saved"], tools={"saved": True}, model="m")
        self.log_path = initial_log
        self.seen_log_paths: list = []

    def chat(self, **_kwargs):
        self.seen_log_paths.append(self.log_path)
        yield "pong"


def test_mykey_probe_silences_log_and_restores_it(monkeypatch) -> None:
    client = _RecordingClient(initial_log=None)
    monkeypatch.setattr(mykey, "_classify", lambda _var: "oai")
    fake_llmcore = types.ModuleType("llmcore")
    fake_llmcore.resolve_client = lambda _var: client
    with mock.patch.dict("sys.modules", {"llmcore": fake_llmcore}):
        result = mykey._test_session_sync("test_oai_config")

    assert result["ok"] is True
    assert client.seen_log_paths == [False], "chat must run with log_path=False"
    assert client.log_path is None
    assert client.backend.history == ["saved"]
