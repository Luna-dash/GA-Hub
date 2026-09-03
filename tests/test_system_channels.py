"""System channels: background producers entering the merged chat chain."""
from __future__ import annotations

from dataclasses import dataclass

import pytest

from server.services.session_metadata import SessionMetadataStore
from server.services.system_channels import (
    SYSTEM_CHANNEL_TITLES,
    SystemChannel,
    system_session_id,
)


@dataclass
class FakeHandle:
    stream_id: str = "stream-1"
    finished: bool = False


class FakeAgent:
    def list_llms(self):
        return [(0, "a", True)]


class FakeRuntime:
    def __init__(self, session_id: str) -> None:
        self.session_id = session_id
        self.submissions: list[dict] = []
        self.agent = FakeAgent()
        self.switch_llm_calls: list[int] = []

    def submit(self, text: str, **kwargs) -> FakeHandle:
        self.submissions.append({"text": text, **kwargs})
        return FakeHandle()

    def switch_llm(self, n: int) -> dict:
        self.switch_llm_calls.append(n)
        return {"switched": n}


class FakeCoordinator:
    def __init__(self) -> None:
        self.runtimes: dict[str, FakeRuntime] = {}
        self.stream_calls: list[dict] = []
        self.abort_calls: list[str] = []
        self.ensure_calls: list[str] = []

    def submit_stream(self, text: str, **kwargs):
        self.stream_calls.append({"text": text, **kwargs})
        state = object()
        return state, FakeHandle()

    def abort_if_current(self, *, session_id: str):
        self.abort_calls.append(session_id)
        return "aborted-state"

    def ensure_runtime(self, session_id: str) -> FakeRuntime:
        self.ensure_calls.append(session_id)
        return self.runtimes.setdefault(session_id, FakeRuntime(session_id))

    def peek_runtime(self, session_id: str) -> FakeRuntime | None:
        return self.runtimes.get(session_id)


@pytest.fixture()
def store(tmp_path) -> SessionMetadataStore:
    return SessionMetadataStore(base_dir=tmp_path)


def _channel(store: SessionMetadataStore, coordinator: FakeCoordinator) -> SystemChannel:
    return SystemChannel(
        "wechat",
        coordinator=lambda: coordinator,
        store=store,
        llm_key_resolver=lambda row: "resolved-key" if row.get("llm_key") is None else row["llm_key"],
    )


def test_system_session_id_is_stable_and_prefixed() -> None:
    assert system_session_id("wechat") == "system-wechat"
    assert set(SYSTEM_CHANNEL_TITLES) == {"wechat", "autonomous", "scheduled_task"}


def test_unknown_channel_is_rejected(store: SessionMetadataStore) -> None:
    coordinator = FakeCoordinator()
    with pytest.raises(ValueError):
        SystemChannel(
            "feishu",
            coordinator=lambda: coordinator,
            store=store,
            llm_key_resolver=lambda row: None,
        )


def test_submit_creates_system_row_once_and_routes_through_coordinator(
    store: SessionMetadataStore, tmp_path
) -> None:
    coordinator = FakeCoordinator()
    channel = _channel(store, coordinator)

    handle = channel.submit("hello", source="wechat")

    row = store.get("system-wechat")
    assert row["kind"] == "system"
    assert row["title"] == "微信 Bot"
    # Routing: same session id every time, resolved llm key, original source tag.
    assert coordinator.stream_calls == [
        {
            "text": "hello",
            "session_id": "system-wechat",
            "source": "wechat",
            "images": None,
            "llm_key": "resolved-key",
        }
    ]
    assert handle.stream_id == "stream-1"

    channel.submit("again", source="wechat")
    rows = [r for r in store.list() if r["id"] == "system-wechat"]
    assert len(rows) == 1


def test_abort_is_scoped_to_the_channel_session(store: SessionMetadataStore) -> None:
    coordinator = FakeCoordinator()
    channel = _channel(store, coordinator)

    state = channel.abort()

    assert state == "aborted-state"
    assert coordinator.abort_calls == ["system-wechat"]


def test_agent_and_llm_commands_touch_only_the_channel_runtime(
    store: SessionMetadataStore,
) -> None:
    coordinator = FakeCoordinator()
    channel = _channel(store, coordinator)

    channel.switch_llm(2)
    channel.list_llms()

    assert coordinator.ensure_calls == ["system-wechat", "system-wechat"]
    # switch_llm goes through the runtime, not a global singleton.
    assert coordinator.runtimes["system-wechat"].switch_llm_calls == [2]


def test_system_channels_registry_caches_channels(store: SessionMetadataStore) -> None:
    from server.services.system_channels import SystemChannels

    coordinator = FakeCoordinator()
    registry = SystemChannels(
        coordinator=lambda: coordinator,
        store=store,
        llm_key_resolver=lambda row: None,
    )
    assert registry.channel("wechat") is registry.channel("wechat")
    assert registry.channel("wechat").session_id == "system-wechat"
    assert registry.channel("autonomous").session_id == "system-autonomous"
    assert registry.channel("scheduled_task").session_id == "system-scheduled_task"
