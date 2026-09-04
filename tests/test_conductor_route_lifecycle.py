from __future__ import annotations

import asyncio
import os
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from server.routes import conductor as conductor_routes
from server.services.conductor_client import GahubProcessError
from server.services.conductor_service import ConductorService, INSTR_DISPATCHED


RUNNING = {
    "started": True,
    "stopping": False,
    "admission_open": True,
    "loop_alive": True,
    "agent_alive": True,
}
STOPPED = {
    "started": False,
    "stopping": False,
    "admission_open": False,
    "loop_alive": False,
    "agent_alive": False,
}


class FakeService:
    def __init__(self, lifecycle):
        self._started = not lifecycle["started"]
        self._lifecycle = dict(lifecycle)
        self.pool = SimpleNamespace(
            counts=lambda: (2, 3),
            get=lambda _sid: SimpleNamespace(),
        )
        self.chat_messages = [{"role": "user"}]
        self.start_calls = []
        self.chat_calls = []
        self.subagent_calls = []
        self.stop_calls = 0
        self.auto_accept = True
        self.settings_calls = []
        self.apply_calls = []
        self.apply_result: dict = {}
        self.subagent_dossier = Mock()

    def lifecycle_status(self):
        self._started = self._lifecycle["started"]
        return dict(self._lifecycle)

    def start(
        self,
        llm_index=None,
        subagent_llm_index=None,
        subagent_model_policy=None,
    ):
        self.start_calls.append(
            (llm_index, subagent_llm_index, subagent_model_policy)
        )
        already_started = self._lifecycle["started"]
        self._lifecycle = dict(RUNNING)
        return not already_started

    def add_chat_message(self, msg, **kwargs):
        self.chat_calls.append((msg, kwargs))
        return {"id": "chat-1", "role": kwargs["role"], "msg": msg, "ts": 1}

    def start_subagent(self, prompt, **kwargs):
        self.subagent_calls.append((prompt, kwargs))
        return {"id": "worker-1", "status": "running"}

    def input_subagent(self, sid, msg, **kwargs):
        self.subagent_calls.append(((sid, msg), kwargs))
        return {"id": sid, "status": "running"}

    def apply_subagent_action(self, sid, action, msg="", **kwargs):
        self.apply_calls.append((sid, action, msg, kwargs))
        return dict(self.apply_result)

    def stop(self):
        self.stop_calls += 1
        self._lifecycle = dict(STOPPED)
        return True


def test_status_route_uses_live_lifecycle_instead_of_cached_started(monkeypatch):
    service = FakeService(STOPPED)
    assert service._started is True
    monkeypatch.setattr(conductor_routes, "svc", lambda: service)

    result = asyncio.run(conductor_routes.get_status())

    assert result == {
        **STOPPED,
        "subagents": {"running": 2, "stopped": 3},
        "chat_count": 1,
        "auto_accept": True,
    }
    assert service._started is False


def test_start_route_returns_live_lifecycle_and_remains_idempotent(monkeypatch):
    service = FakeService(RUNNING)
    monkeypatch.setattr(conductor_routes, "svc", lambda: service)

    result = asyncio.run(conductor_routes.start_conductor())

    assert result == {
        "ok": True,
        **RUNNING,
        "subagents": {"running": 2, "stopped": 3},
        "chat_count": 1,
        "auto_accept": True,
    }
    assert service.start_calls == [(None, None, None)]


def test_start_route_forwards_main_and_subagent_models(monkeypatch):
    service = FakeService(STOPPED)
    monkeypatch.setattr(conductor_routes, "svc", lambda: service)

    result = asyncio.run(
        conductor_routes.start_conductor(
            conductor_routes.ConductorStartReq(llm_index=2, subagent_llm_index=5)
        )
    )

    assert result == {
        "ok": True,
        **RUNNING,
        "subagents": {"running": 2, "stopped": 3},
        "chat_count": 1,
        "auto_accept": True,
    }
    assert service.start_calls == [(2, 5, None)]


def test_start_route_forwards_locked_policy(monkeypatch):
    service = FakeService(STOPPED)
    monkeypatch.setattr(conductor_routes, "svc", lambda: service)

    asyncio.run(
        conductor_routes.start_conductor(
            conductor_routes.ConductorStartReq(
                llm_index=2,
                subagent_llm_index=5,
                subagent_model_policy="locked",
            )
        )
    )

    assert service.start_calls == [(2, 5, "locked")]


def test_chat_route_forwards_model_policy(monkeypatch):
    service = FakeService(STOPPED)
    monkeypatch.setattr(conductor_routes, "svc", lambda: service)

    result = asyncio.run(
        conductor_routes.post_chat(
            conductor_routes.ConductorChatIn(
                msg="hello",
                role="user",
                llm_index=1,
                subagent_llm_index=5,
                subagent_model_policy="default",
            )
        )
    )

    assert result["id"] == "chat-1"
    assert service.chat_calls == [(
        "hello",
        {
            "role": "user",
            "llm_index": 1,
            "subagent_llm_index": 5,
            "subagent_model_policy": "default",
            "operation_id": None,
        },
    )]


def test_subagent_detail_route_delegates_to_service_dossier(monkeypatch):
    """The engine+mirror merge lives in ConductorService; the route only
    forwards (the merge matrix is covered at service level)."""
    service = FakeService(STOPPED)
    dossier = {"id": "w1", "reply": "full cleaned reply", "status": "stopped"}
    service.subagent_dossier = Mock(return_value=dossier)
    monkeypatch.setattr(conductor_routes, "svc", lambda: service)

    result = asyncio.run(conductor_routes.get_subagent("w1", max_len=5000))

    service.subagent_dossier.assert_called_once_with("w1", 5000)
    assert result == dossier


def test_subagent_route_uses_service_policy_boundary(monkeypatch):
    service = FakeService(STOPPED)
    monkeypatch.setattr(conductor_routes, "svc", lambda: service)
    prompt = "请检查中文路径 D:\\项目\\指挥 🚀，不要改动原文件。"

    result = asyncio.run(
        conductor_routes.start_subagent(
            conductor_routes.ConductorStartSubagent(
                prompt=prompt,
                llm_index=3,
                conductor_llm_index=1,
                subagent_llm_index=5,
                subagent_model_policy="locked",
            )
        )
    )

    assert result["instruction"] == conductor_routes.INSTR_DISPATCHED
    assert service.subagent_calls == [(
        prompt,
        {
            "llm_index": 3,
            "conductor_llm_index": 1,
            "subagent_llm_index": 5,
            "subagent_model_policy": "locked",
            "goal": None,
            "boundaries": [],
            "deliverables": [],
            "done_when": None,
            "checks": [],
            "operation_id": None,
        },
    )]


def test_subagent_route_forwards_engine_manifest_contract(monkeypatch):
    """The public dispatch route must carry the Contract B manifest fields:
    the engine answers 422 without goal + deliverables, so dropping them
    would make the endpoint unusable against the real engine."""
    service = FakeService(STOPPED)
    monkeypatch.setattr(conductor_routes, "svc", lambda: service)

    asyncio.run(
        conductor_routes.start_subagent(
            conductor_routes.ConductorStartSubagent(
                prompt="build the report",
                request_id="request-1",
                goal="produce the audit report",
                boundaries=["no network access"],
                deliverables=[{"path": "D:/out/report.md", "desc": "final"}],
                done_when="report exists",
                checks=[{"kind": "file_contains", "path": "D:/out/report.md",
                         "contains": "AUDIT"}],
            )
        )
    )

    _, kwargs = service.subagent_calls[0]
    assert kwargs["goal"] == "produce the audit report"
    assert kwargs["boundaries"] == ["no network access"]
    assert kwargs["deliverables"] == [
        {"path": "D:/out/report.md", "desc": "final"}]
    assert kwargs["done_when"] == "report exists"
    assert kwargs["checks"] == [
        {"kind": "file_contains", "path": "D:/out/report.md",
         "contains": "AUDIT", "paths": [], "min_lines": None,
         "max_lines": None, "algorithm": None, "expected": "",
         "severity": "blocking", "timeout_seconds": 30}]


def test_subagent_action_route_forwards_verbs_to_service_dispatcher(monkeypatch):
    """Verb matrix, instructions, and owner forwarding live in the service;
    the route forwards the action body verbatim."""
    service = FakeService(STOPPED)
    monkeypatch.setattr(conductor_routes, "svc", lambda: service)

    result = asyncio.run(
        conductor_routes.subagent_action(
            "worker-1",
            conductor_routes.ConductorSubagentAction(
                action="input",
                msg="retry",
                llm_index=3,
                conductor_llm_index=1,
                subagent_llm_index=5,
                subagent_model_policy="locked",
            ),
        )
    )

    assert result == {}
    assert service.apply_calls == [(
        "worker-1", "input", "retry",
        {
            "request_id": None,
            "force": False,
            "llm_index": 3,
            "conductor_llm_index": 1,
            "subagent_llm_index": 5,
            "subagent_model_policy": "locked",
            "operation_id": None,
        },
    )]


def test_accept_route_forwards_request_and_returns_committed_review(monkeypatch):
    service = FakeService(STOPPED)
    service.apply_result = {
        "id": "worker-1",
        "status": "stopped",
        "review_status": "accepted",
        "request_id": "request-1",
    }
    monkeypatch.setattr(conductor_routes, "svc", lambda: service)

    result = asyncio.run(conductor_routes.subagent_action(
        "worker-1",
        conductor_routes.ConductorSubagentAction(
            action="accept",
            msg="verified",
            request_id="request-1",
        ),
    ))

    assert result["review_status"] == "accepted"
    assert service.apply_calls == [(
        "worker-1", "accept", "verified",
        {
            "request_id": "request-1",
            "force": False,
            "llm_index": None,
            "conductor_llm_index": None,
            "subagent_llm_index": None,
            "subagent_model_policy": None,
            "operation_id": None,
        },
    )]


def test_accept_route_forces_verdict_escape_hatch(monkeypatch):
    """force=true is forwarded so an audited accept can bypass a failing
    deterministic verdict after the UI has shown the evidence."""
    service = FakeService(STOPPED)
    service.apply_result = {
        "id": "worker-1", "status": "stopped", "review_status": "accepted",
    }
    monkeypatch.setattr(conductor_routes, "svc", lambda: service)

    result = asyncio.run(conductor_routes.subagent_action(
        "worker-1",
        conductor_routes.ConductorSubagentAction(
            action="accept", msg="verified by hand", force=True,
        ),
    ))

    assert result["review_status"] == "accepted"
    assert service.apply_calls == [(
        "worker-1", "accept", "verified by hand",
        {
            "request_id": None,
            "force": True,
            "llm_index": None,
            "conductor_llm_index": None,
            "subagent_llm_index": None,
            "subagent_model_policy": None,
            "operation_id": None,
        },
    )]


def test_accept_route_unverified_409_keeps_verification_evidence(monkeypatch):
    """The 409 body must carry the engine's verification payload, not just
    the error string — the UI renders that evidence before offering force."""
    service = FakeService(STOPPED)
    verification = {
        "id": "worker-1", "error": "completion_unverified",
        "checks_ok": False,
        "quality_checks": {"checks": [
            {"kind": "file_contains", "path": "D:/out/report.md",
             "passed": False, "status": "failed", "severity": "blocking",
             "detail": "content did not match"}],
            "checks_ok": False},
        "deliverables_missing": [],
        "verification": {"verified": False, "checks_ok": False},
    }
    service.apply_result = verification
    monkeypatch.setattr(conductor_routes, "svc", lambda: service)

    with pytest.raises(conductor_routes.HTTPException) as raised:
        asyncio.run(conductor_routes.subagent_action(
            "worker-1",
            conductor_routes.ConductorSubagentAction(action="accept"),
        ))

    assert raised.value.status_code == 409
    assert raised.value.detail["error"] == "completion_unverified"
    assert raised.value.detail["quality_checks"]["checks_ok"] is False
    assert raised.value.detail["verification"]["verified"] is False


def test_rework_state_conflict_returns_http_409(monkeypatch):
    service = FakeService(STOPPED)
    service.apply_result = {
        "id": "worker-1",
        "error": "only a stopped pending subagent can be reworked",
    }
    monkeypatch.setattr(conductor_routes, "svc", lambda: service)

    with pytest.raises(conductor_routes.HTTPException) as raised:
        asyncio.run(conductor_routes.subagent_action(
            "worker-1",
            conductor_routes.ConductorSubagentAction(
                action="rework",
                msg="add evidence",
                request_id="request-1",
            ),
        ))

    assert raised.value.status_code == 409


def test_stop_route_delegates_and_returns_live_lifecycle(monkeypatch):
    service = FakeService(RUNNING)
    monkeypatch.setattr(conductor_routes, "svc", lambda: service)

    result = asyncio.run(conductor_routes.stop_conductor())

    assert result == {
        "ok": True,
        **STOPPED,
        "subagents": {"running": 2, "stopped": 3},
        "chat_count": 1,
        "auto_accept": True,
    }
    assert service.stop_calls == 1


def test_settings_route_flips_auto_accept_and_returns_live_status(monkeypatch):
    service = FakeService(RUNNING)
    monkeypatch.setattr(conductor_routes, "svc", lambda: service)

    result = asyncio.run(
        conductor_routes.update_conductor_settings(
            conductor_routes.ConductorSettingsReq(auto_accept=False)
        )
    )

    assert result == {
        **RUNNING,
        "subagents": {"running": 2, "stopped": 3},
        "chat_count": 1,
        "auto_accept": False,
    }
    assert service.auto_accept is False


def test_service_lifecycle_status_refreshes_compatibility_cache():
    service = ConductorService.for_tests()
    service._started = True
    service._lifecycle_cache = {}
    service.client = SimpleNamespace(status=lambda: dict(STOPPED))

    assert service.lifecycle_status() == STOPPED
    assert service._started is False


# ── engine error mapping (D2) ─────────────────────────────────────────────────

def test_engine_4xx_contract_rejection_passes_through(monkeypatch):
    """Engine Contract-B 422 must surface as 422 with the readable message,
    not a blind hub 500."""
    service = Mock()
    service.start_subagent = Mock(side_effect=GahubProcessError(
        'gahub_app /subagent -> 422: goal', status_code=422, detail=[
            {"type": "missing", "loc": ["body", "goal"], "msg": "Field required"},
        ],
    ))
    monkeypatch.setattr(conductor_routes, "svc", lambda: service)

    with pytest.raises(conductor_routes.HTTPException) as raised:
        asyncio.run(conductor_routes.start_subagent(
            conductor_routes.ConductorStartSubagent(prompt="test"),
        ))

    assert raised.value.status_code == 422
    assert "Field required" in str(raised.value.detail)


def test_engine_terminal_state_conflict_passes_through(monkeypatch):
    """Engine 409 domain conflicts (accepted terminal / keyinfo budget /
    rework gate) keep their status code and message."""
    service = Mock()
    service.apply_subagent_action = Mock(side_effect=GahubProcessError(
        "gahub_app /subagent/abc -> 409: accepted_subagent_is_terminal",
        status_code=409,
        detail="accepted_subagent_is_terminal",
    ))
    monkeypatch.setattr(conductor_routes, "svc", lambda: service)

    with pytest.raises(conductor_routes.HTTPException) as raised:
        asyncio.run(conductor_routes.subagent_action(
            "abc",
            conductor_routes.ConductorSubagentAction(action="input", msg="x"),
        ))

    assert raised.value.status_code == 409
    assert "accepted_subagent_is_terminal" in str(raised.value.detail)


def test_engine_unreachable_maps_to_503(monkeypatch):
    """Transport-level failures (no HTTP status) mean the engine is down."""
    service = Mock()
    service.start_subagent = Mock(side_effect=GahubProcessError(
        "gahub_app /subagent request failed: connection refused",
    ))
    monkeypatch.setattr(conductor_routes, "svc", lambda: service)

    with pytest.raises(conductor_routes.HTTPException) as raised:
        asyncio.run(conductor_routes.start_subagent(
            conductor_routes.ConductorStartSubagent(prompt="test"),
        ))

    assert raised.value.status_code == 503


def test_engine_5xx_maps_to_502(monkeypatch):
    """An upstream engine crash must read as 502, never a hub-internal 500."""
    service = Mock()
    service.start_subagent = Mock(side_effect=GahubProcessError(
        "gahub_app /subagent -> 500: boom", status_code=500, detail="boom",
    ))
    monkeypatch.setattr(conductor_routes, "svc", lambda: service)

    with pytest.raises(conductor_routes.HTTPException) as raised:
        asyncio.run(conductor_routes.start_subagent(
            conductor_routes.ConductorStartSubagent(prompt="test"),
        ))

    assert raised.value.status_code == 502


def test_engine_log_falls_back_when_canonical_path_is_blocked(tmp_path, monkeypatch):
    """The canonical engine log is shared machine-wide; a live holder (e.g.
    an orphaned engine whose parent backend died) must not block spawning a
    new engine — the spawn falls back to a unique per-process log file."""
    from server.services import conductor_client as ccm

    monkeypatch.setenv("GAHUB_TEMP_DIR", str(tmp_path))
    # A directory at the canonical path makes open(..., "ab") fail the same
    # way a live holder's lock does on Windows.
    (tmp_path / "gahub_app.log").mkdir()

    handle, path = ccm._open_engine_log()
    handle.close()

    assert path != str(tmp_path / "gahub_app.log")
    assert "gahub_app-" in os.path.basename(path)
    assert path.endswith(".log")


def test_engine_503_is_relayed_with_its_own_reason(monkeypatch):
    """An engine 503 is the engine's own unavailability signal (e.g. the
    conductor is stopping and refused admission): relay it verbatim instead
    of degrading it to a generic 502."""
    service = Mock()
    service.start_subagent = Mock(side_effect=GahubProcessError(
        "gahub_app /subagent -> 503: conductor is stopping",
        status_code=503,
        detail={"error": "conductor is stopping"},
    ))
    monkeypatch.setattr(conductor_routes, "svc", lambda: service)

    with pytest.raises(conductor_routes.HTTPException) as raised:
        asyncio.run(conductor_routes.start_subagent(
            conductor_routes.ConductorStartSubagent(prompt="test"),
        ))

    assert raised.value.status_code == 503
    assert "conductor is stopping" in str(raised.value.detail)


def test_keyinfo_engine_conflict_maps_to_409(monkeypatch):
    """keyinfo must go through the engine mapping too: the engine's
    one-intervention-per-attempt budget conflict surfaces as 409."""
    service = FakeService(STOPPED)
    service.apply_subagent_action = Mock(side_effect=GahubProcessError(
        "gahub_app /subagent/abc -> 409: only a running subagent can "
        "receive keyinfo",
        status_code=409,
        detail="only a running subagent can receive keyinfo",
    ))
    monkeypatch.setattr(conductor_routes, "svc", lambda: service)

    with pytest.raises(conductor_routes.HTTPException) as raised:
        asyncio.run(conductor_routes.subagent_action(
            "abc",
            conductor_routes.ConductorSubagentAction(action="keyinfo", msg="x"),
        ))

    assert raised.value.status_code == 409
    assert "only a running subagent" in str(raised.value.detail)


def test_abort_engine_unreachable_maps_to_503(monkeypatch):
    """abort/stop must go through the engine mapping too: stopping a worker
    while the engine is being respawned reads as 503, never a blind 500."""
    service = FakeService(STOPPED)
    service.apply_subagent_action = Mock(side_effect=GahubProcessError(
        "gahub_app /subagent/abc request failed: connection refused",
    ))
    monkeypatch.setattr(conductor_routes, "svc", lambda: service)

    with pytest.raises(conductor_routes.HTTPException) as raised:
        asyncio.run(conductor_routes.subagent_action(
            "abc",
            conductor_routes.ConductorSubagentAction(action="stop"),
        ))

    assert raised.value.status_code == 503
    assert "respawned on demand" in str(raised.value.detail)


def test_poolmirror_stamps_request_id_and_hub_origin():
    """PoolMirror is the single point that stamps hub-origin aborts; the
    request_id rides the same call into the engine body."""
    from server.services import conductor_service as csm
    mirror = csm.PoolMirror.__new__(csm.PoolMirror)
    mirror.client = Mock()
    mirror.client.subagent_action = Mock(return_value={})

    mirror.keyinfo_subagent("s1", "msg", request_id="rid-1")
    mirror.abort_subagent("s1", request_id="rid-1")

    mirror.client.subagent_action.assert_any_call(
        "s1", "keyinfo", "msg", request_id="rid-1")
    mirror.client.subagent_action.assert_any_call(
        "s1", "abort", origin="hub", request_id="rid-1")


# ── journal catch-up proxy (P2-A) ────────────────────────────────────────────

def test_journal_route_forwards_catch_up_params_to_engine(monkeypatch):
    service = Mock()
    payload = {"journal": {"disabled": False, "epoch": "e1", "last_seq": 3},
               "events": [{"seq": 2, "type": "subagent_done"}]}
    service.client = SimpleNamespace(journal=Mock(return_value=payload))
    monkeypatch.setattr(conductor_routes, "svc", lambda: service)

    result = asyncio.run(
        conductor_routes.get_conductor_journal(after_seq=1, limit=100))

    service.client.journal.assert_called_once_with(1, 100)
    assert result == payload


def test_journal_route_defaults_pass_engine_defaults(monkeypatch):
    service = Mock()
    service.client = SimpleNamespace(
        journal=Mock(return_value={"journal": {"disabled": True}, "events": []}))
    monkeypatch.setattr(conductor_routes, "svc", lambda: service)

    result = asyncio.run(
        conductor_routes.get_conductor_journal(after_seq=0, limit=500))

    service.client.journal.assert_called_once_with(0, 500)
    assert result["journal"]["disabled"] is True
    assert result["events"] == []


def test_journal_route_engine_unreachable_maps_to_503(monkeypatch):
    service = Mock()
    service.client = SimpleNamespace(journal=Mock(side_effect=GahubProcessError(
        "gahub_app /journal request failed: connection refused",
    )))
    monkeypatch.setattr(conductor_routes, "svc", lambda: service)

    with pytest.raises(conductor_routes.HTTPException) as raised:
        asyncio.run(conductor_routes.get_conductor_journal())

    assert raised.value.status_code == 503
