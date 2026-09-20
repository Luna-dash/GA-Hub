"""Conductor engine lifecycle (task-model plan, H1).

Three invariants:
1. Every spawned engine gets ``GAHUB_MULTI_REQUEST_TURNS=off``: the hub runs
   one task per turn (task = request_id = one archive), so an inherited
   environment value must not silently re-enable F1 batching.
2. Bring-up is lazy and idempotent: the Conductor page ensures the engine on
   entry (an already-running engine is left alone), and no app-startup path
   spawns it.
3. App close reaps the engine: the supervisor stop is best-effort, the
   process reap is not. Dev (``server.run``) and the desktop sidecar both run
   ``server.main``'s lifespan, so this is the single close path.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest import mock

import pytest

from server.services import conductor_client as cc
from server.services.conductor_client import (
    GahubProcessManager,
    GahubProcessError,
)
from server.services.conductor_service import ConductorService


# ── H1.1 一次一个任务 (F1 off) ───────────────────────────────────────────────

def test_spawn_env_forces_single_request_turns(monkeypatch) -> None:
    """The env override is an invariant, not an operator default."""
    monkeypatch.setenv("GAHUB_MULTI_REQUEST_TURNS", "on")

    env = cc._engine_spawn_env()

    assert env["GAHUB_MULTI_REQUEST_TURNS"] == "off"


# ── H1.2 懒启动：幂等 ensure ────────────────────────────────────────────────

def test_ensure_running_skips_the_spawn_when_the_engine_is_healthy(monkeypatch) -> None:
    """An already-running engine must not be spawned again.

    Spawning is disabled here: reaching the cold path would raise, so a clean
    return proves the health gate short-circuited before any Popen.
    """
    manager = GahubProcessManager(ga_root="D:/nonexistent-ga", spawn_enabled=False)
    monkeypatch.setattr(manager, "is_healthy", lambda timeout=1.0: True)
    monkeypatch.setattr(
        cc.subprocess, "Popen",
        mock.Mock(side_effect=AssertionError("a healthy engine must not be respawned")))

    manager.ensure_running(startup_timeout=0.1)


def test_ensure_running_rejects_http_200_with_missing_capability(monkeypatch) -> None:
    """Reachable is not ready: startup must validate the health contract."""
    manager = GahubProcessManager(ga_root="D:/nonexistent-ga", spawn_enabled=False)
    response = mock.Mock(status_code=200)
    response.raise_for_status.return_value = None
    response.json.return_value = {
        "ok": True,
        "service": "gahub",
        "protocol_version": 2,
        "capabilities": [
            "snapshot_revision", "path_policy", "sse_resync",
            "guarded_actions", "unified_admission", "request_recovery",
        ],
    }
    get = mock.Mock(return_value=response)
    monkeypatch.setattr(cc.requests, "get", get)
    monkeypatch.setattr(
        cc.subprocess, "Popen",
        mock.Mock(side_effect=AssertionError("an incompatible engine must not be respawned")))

    with pytest.raises(GahubProcessError, match="operation_receipts"):
        manager.ensure_running(startup_timeout=0.1)

    assert get.call_count == 1


def test_ensure_running_still_refuses_to_spawn_when_disabled(monkeypatch) -> None:
    """The health gate is the only reason a disabled manager is silent."""
    manager = GahubProcessManager(ga_root="D:/nonexistent-ga", spawn_enabled=False)
    monkeypatch.setattr(manager, "is_healthy", lambda timeout=1.0: False)

    with pytest.raises(GahubProcessError):
        manager.ensure_running(startup_timeout=0.1)


def _entry_ensure_service() -> ConductorService:
    """A service whose engine is alive: page entry must not restart it."""
    service = ConductorService.for_tests()
    service._process_manager = mock.Mock()
    service.client = mock.Mock()
    service.client.status.return_value = {"started": True}
    # The SSE relay would spawn a real thread; entry ensure must not need it.
    service._ensure_relay = lambda: None  # type: ignore[method-assign]
    return service


def test_entry_ensure_leaves_a_running_supervisor_alone() -> None:
    """POST /api/conductor/start is the page-entry ensure (H1.2).

    It configures models and probes the lifecycle, but an already-started
    supervisor is never re-started — that would re-run the engine's cold-start
    sequence on every page visit.
    """
    service = _entry_ensure_service()
    try:
        assert service.start() is True
        assert service.start() is True

        # Process-level ensure ran (its own health gate skips the spawn)…
        assert service._process_manager.ensure_running.call_count == 2
        # …and the supervisor itself was never restarted.
        service.client.start.assert_not_called()
    finally:
        service.store.close()


def test_entry_ensure_starts_a_stopped_supervisor_once() -> None:
    """A cold engine is brought up by entry, then reported as running."""
    service = _entry_ensure_service()
    service.client.status.return_value = {"started": False}
    try:
        assert service.start() is True

        assert service.client.start.call_count == 1
        # /start restores only the conductor model: the full hub-owned
        # snapshot (subagent policy) is re-pushed right after it.
        service.client.push_models.assert_called()
    finally:
        service.store.close()


# ── H1.3 关闭回收 ───────────────────────────────────────────────────────────

def test_app_close_reaps_the_engine_process_even_when_the_engine_stop_fails() -> None:
    """No orphan engine after app close, whatever the supervisor does.

    ``ConductorService.shutdown`` is what ``AppServices.shutdown_all`` calls;
    the engine HTTP stop is best-effort, the process reap is not.
    """
    service = ConductorService.for_tests()
    service.client = SimpleNamespace(stop=mock.Mock(side_effect=RuntimeError("engine refused")))
    reaped: list[float] = []
    service._process_manager = SimpleNamespace(
        stop=lambda timeout: reaped.append(timeout) or True)
    service.timeout_monitor = SimpleNamespace(stop=lambda timeout: True)

    assert service.shutdown(timeout=0.1) is False  # the engine stop failed…

    assert len(reaped) == 1                        # …the process was still reaped
    # Inside the shared deadline (the sampled remaining budget can overshoot by
    # a clock tick — see the float-rounding note in the shutdown tests).
    assert 0.0 <= reaped[0] <= 0.11


def test_app_close_reaps_the_engine_process_after_a_clean_stop() -> None:
    service = ConductorService.for_tests()
    stopped: list[float] = []
    service.client = SimpleNamespace(
        stop=lambda timeout: stopped.append(timeout) or {"stopped": True})
    reaped: list[float] = []
    service._process_manager = SimpleNamespace(
        stop=lambda timeout: reaped.append(timeout) or True)
    service.timeout_monitor = SimpleNamespace(stop=lambda timeout: True)

    assert service.shutdown(timeout=0.5) is True

    assert len(stopped) == 1 and len(reaped) == 1
    # The supervisor drains first; the process reap gets what is left.
    assert reaped[0] <= stopped[0]
