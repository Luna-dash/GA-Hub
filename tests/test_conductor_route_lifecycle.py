from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from server.routes import conductor as conductor_routes
from server.services.conductor_client import GahubProcessError
from server.services.conductor_service import ConductorService


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
        },
    )]


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
        },
    )]


def test_resume_route_uses_service_policy_boundary(monkeypatch):
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

    assert result["instruction"] == conductor_routes.INSTR_DISPATCHED
    assert service.subagent_calls == [(
        ("worker-1", "retry"),
        {
            "llm_index": 3,
            "conductor_llm_index": 1,
            "subagent_llm_index": 5,
            "subagent_model_policy": "locked",
        },
    )]


def test_accept_route_forwards_request_and_returns_committed_review(monkeypatch):
    service = FakeService(STOPPED)
    service.accept_subagent = Mock(return_value={
        "id": "worker-1",
        "status": "stopped",
        "review_status": "accepted",
        "request_id": "request-1",
    })
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
    service.accept_subagent.assert_called_once_with(
        "worker-1", "verified", request_id="request-1"
    )


def test_rework_state_conflict_returns_http_409(monkeypatch):
    service = FakeService(STOPPED)
    service.rework_subagent = Mock(return_value={
        "id": "worker-1",
        "error": "only a stopped pending subagent can be reworked",
    })
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
    }
    assert service.stop_calls == 1


def test_service_lifecycle_status_refreshes_compatibility_cache():
    service = ConductorService.__new__(ConductorService)
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
    service.input_subagent = Mock(side_effect=GahubProcessError(
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


def test_keyinfo_engine_conflict_maps_to_409(monkeypatch):
    """keyinfo must go through the engine mapping too: the engine's
    one-intervention-per-attempt budget conflict surfaces as 409."""
    service = FakeService(STOPPED)
    service.pool = SimpleNamespace(
        counts=lambda: (0, 1),
        get=lambda _sid: SimpleNamespace(),
        keyinfo_subagent=Mock(side_effect=GahubProcessError(
            "gahub_app /subagent/abc -> 409: only a running subagent can "
            "receive keyinfo",
            status_code=409,
            detail="only a running subagent can receive keyinfo",
        )),
    )
    monkeypatch.setattr(conductor_routes, "svc", lambda: service)

    with pytest.raises(conductor_routes.HTTPException) as raised:
        asyncio.run(conductor_routes.subagent_action(
            "abc",
            conductor_routes.ConductorSubagentAction(action="keyinfo", msg="x"),
        ))

    assert raised.value.status_code == 409
    assert "only a running subagent" in str(raised.value.detail)
