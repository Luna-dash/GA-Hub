"""Regression tests for Wave 1 backend resource optimizations."""
from __future__ import annotations

import asyncio
import time
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.routes.im import router as im_router
from server.services import agy_profile
from server.services.agy_runtime import (
    IDLE_SESSION_TTL,
    MAX_IDLE_WORKERS,
    AgyRuntimeManager,
)
from server.services.event_bus import EventBus
from server.services.im_adapter import IMAdapter, IMRegistry
from server.services.session_coordinator import (
    IDLE_RUNTIME_TTL,
    MAX_IDLE_RUNTIMES,
    SessionCoordinator,
)


class _DummyIMAdapter:
    def __init__(self, adapter_id: str = "demo", name: str = "Demo IM", *, explode: bool = False) -> None:
        self.id = adapter_id
        self.name = name
        self._explode = explode
        self.shutdown_called = False

    def status(self) -> dict:
        if self._explode:
            raise RuntimeError("boom")
        return {"running": True, "summary": "已连接"}

    def start(self) -> dict:
        return {"running": True}

    def stop(self) -> dict:
        return {"running": False}

    def send_text(self, target_id: str, text: str, **kwargs) -> dict:
        return {"ok": True, "target_id": target_id, "text": text}

    def shutdown(self) -> None:
        self.shutdown_called = True


def test_im_registry_empty_and_adapter_lifecycle() -> None:
    reg = IMRegistry()
    assert not reg.has_adapters()
    assert reg.status_snapshot() == {"configured": False, "adapters": []}

    adapter = _DummyIMAdapter()
    assert isinstance(adapter, IMAdapter)
    reg.register(adapter)
    assert reg.has_adapters()
    snap = reg.status_snapshot()
    assert snap["configured"] is True
    assert snap["adapters"][0]["id"] == "demo"
    assert snap["adapters"][0]["running"] is True

    app = FastAPI()
    app.state.im_registry = reg
    app.include_router(im_router)
    with TestClient(app) as client:
        res = client.get("/api/im/status")
        assert res.status_code == 200
        assert res.json()["configured"] is True
        assert res.json()["adapters"][0]["id"] == "demo"

    reg.shutdown_all()
    assert adapter.shutdown_called is True
    reg.unregister("demo")
    assert not reg.has_adapters()


def test_agy_runtime_balanced_defaults_and_lru_eviction(tmp_path: Path) -> None:
    assert IDLE_SESSION_TTL == 600.0
    assert MAX_IDLE_WORKERS == 2

    mgr = AgyRuntimeManager(idle_ttl=600.0, max_idle_workers=2)
    closed: list[str] = []

    class _FakeWorker:
        def __init__(self, sid: str, last_used: float) -> None:
            self.session_id = sid
            self.profile_id = "default"
            self.workspace = tmp_path
            self.active_turn = None
            self._closed = False
            self._retired = False
            self.last_used = last_used

        def exit_pending(self) -> bool:
            return False

        def close(self, force: bool = False) -> None:
            closed.append(self.session_id)

    now = 1000.0
    mgr._workers[(str(tmp_path), "default", "s1")] = _FakeWorker("s1", now - 30)
    mgr._workers[(str(tmp_path), "default", "s2")] = _FakeWorker("s2", now - 20)
    mgr._workers[(str(tmp_path), "default", "s3")] = _FakeWorker("s3", now - 10)
    mgr._workers[(str(tmp_path), "default", "s4")] = _FakeWorker("s4", now - 5)

    reaped = mgr.reap_idle_workers(now=now)
    assert reaped == 2
    assert set(closed) == {"s1", "s2"}
    assert {k[2] for k in mgr._workers} == {"s3", "s4"}


def test_session_coordinator_idle_runtime_lru_eviction() -> None:
    assert MAX_IDLE_RUNTIMES == 5
    assert IDLE_RUNTIME_TTL == 1800.0

    shut_down: list[str] = []

    def factory(sid: str):
        return SimpleNamespace(
            submit=lambda *a, **k: None,
            abort=lambda: None,
            shutdown=lambda _sid=sid: (shut_down.append(_sid), True)[1],
        )

    coord = SessionCoordinator(factory, capacity=2, max_idle_runtimes=2, idle_runtime_ttl=1800.0)
    base = time.monotonic()
    for i, sid in enumerate(("s1", "s2", "s3", "s4")):
        coord._runtimes[sid] = factory(sid)
        coord._runtime_last_used[sid] = base + i

    evicted = coord.reap_idle_runtimes(now=base + 10)
    assert evicted == 2
    assert set(shut_down) == {"s1", "s2"}
    assert set(coord._runtimes) == {"s3", "s4"}


def test_event_bus_ephemeral_delivers_live_without_polluting_history() -> None:
    async def scenario() -> None:
        eb = EventBus(history=100)
        eb.attach_loop(asyncio.get_running_loop())
        seen: list[str] = []

        async def reader() -> None:
            async for evt in eb.subscribe(["chat:"]):
                seen.append(evt.topic)
                if evt.topic == "chat:done":
                    break

        task = asyncio.create_task(reader())
        await asyncio.sleep(0.01)
        eb.publish("chat:started", {"n": 1})
        eb.publish("chat:next", {"content": "x" * 500}, ephemeral=True)
        eb.publish("chat:done", {"n": 2})
        await asyncio.wait_for(task, timeout=2.0)
        assert seen == ["chat:started", "chat:next", "chat:done"]
        assert [e.topic for e in eb._history] == ["chat:started", "chat:done"]

    asyncio.run(scenario())


def test_agy_profile_preserves_host_toolchain_caches(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(agy_profile, "_root", lambda: tmp_path / "agy-profiles")
    host = tmp_path / "real-host"
    base_env = {"USERPROFILE": str(host), "HOME": str(host), "PATH": "C:\\Windows"}
    env = agy_profile.clean_agy_env("default", base_env=base_env)
    assert env["HOME"] != str(host)
    assert env["RUSTUP_HOME"] == str(host / ".rustup")
    assert env["CARGO_HOME"] == str(host / ".cargo")
    assert env["GOMODCACHE"] == str(host / "go" / "pkg" / "mod")
    assert "PIP_CACHE_DIR" in env
    assert "UV_CACHE_DIR" in env
    assert "NPM_CONFIG_CACHE" in env

    # Explicit host override must win over default.
    custom = {**base_env, "CARGO_HOME": "E:\\custom-cargo"}
    env2 = agy_profile.clean_agy_env("default", base_env=custom)
    assert env2["CARGO_HOME"] == "E:\\custom-cargo"
