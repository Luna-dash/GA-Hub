"""Regression coverage for the gahub_app engine-adapter service surface.

These pin the three post-restructuring defects found by live diagnosis:
the missing GET /chat bootstrap proxy, replayed finals for untracked
request_ids, and the interpreter probe's child environment.
"""
from __future__ import annotations

import io
import subprocess
import threading
from types import SimpleNamespace
from unittest import mock
from unittest.mock import MagicMock, Mock

import pytest

from server.services import conductor_service as cs
from server.services.conductor_client import GahubProcessManager


def _bare_service() -> cs.ConductorService:
    """Build a ConductorService without running __init__ (no engine needed)."""
    return cs.ConductorService.for_tests()


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


def test_engine_spawn_env_injects_hub_journal_path(monkeypatch, tmp_path) -> None:
    """The spawned engine must get GAHUB_JOURNAL_PATH under ADMIN_DATA (P2-A):
    the durable journal lives with hub-owned state, never inside the GA repo.
    An operator-provided environment value wins over the hub default."""
    from server.services import conductor_client as cc

    journal_file = tmp_path / "gahub_journal" / "journal.jsonl"
    monkeypatch.setattr(cc._paths, "gahub_journal_file", lambda: journal_file)
    monkeypatch.setattr("server.services.conductor_client.os.environ", {
        "PATH": f"C:\\Temp\\_MEI12345\\bin{chr(59)}C:\\Windows",
    })

    env = cc._engine_spawn_env()

    assert env["GAHUB_JOURNAL_PATH"] == str(journal_file)
    assert all("_MEI" not in item for item in env["PATH"].split(chr(59)))


def test_engine_spawn_env_respects_operator_journal_path(monkeypatch) -> None:
    from server.services import conductor_client as cc

    monkeypatch.setenv("GAHUB_JOURNAL_PATH", "D:\\custom\\journal.jsonl")
    env = cc._engine_spawn_env()
    assert env["GAHUB_JOURNAL_PATH"] == "D:\\custom\\journal.jsonl"


# ── subagent dossier: engine reply + hub mirror merge ────────────────────────

def test_subagent_dossier_merges_engine_reply_with_mirror_facts() -> None:
    """Human review reads the engine reply plus list-side review facts."""
    service = _bare_service()
    service.client = SimpleNamespace(get_subagent=Mock(return_value={
        "id": "w1",
        "reply": "full cleaned reply",
        "status": "stopped",
        "review_status": "pending",
        "attempt": 1,
        "active_generation": 2,
        "manifest": {"goal": "写报告"},
        "deliverables_missing": ["D:/out/report.md"],
        "done_marker": False,
        "quality_checks": {"checks_ok": False},
    }))
    service.pool = SimpleNamespace(get=lambda _sid: SimpleNamespace(
        prompt="检查桌面启动流程",
        created_at=3,
        updated_at=4,
        review_note="",
        completed_at=4,
        accepted_at=None,
        deliverables_missing=["D:/out/report.md"],
        deliverables_stale=[],
        done_marker=False,
        quality_checks={"checks_ok": False},
        manifest={"goal": "写报告"},
        forced_accept=False,
        force_reason="",
        forced_at=None,
    ))
    service.workflow_tracker = SimpleNamespace(
        request_for_subagent=lambda _sid: "request-1")

    detail = service.subagent_dossier("w1", 5000)

    service.client.get_subagent.assert_called_once_with("w1", 5000)
    assert detail["reply"] == "full cleaned reply"
    # Mirror-only facts (the engine omits them) ride along for review.
    assert detail["prompt"] == "检查桌面启动流程"
    assert detail["manifest"]["goal"] == "写报告"
    assert detail["deliverables_missing"] == ["D:/out/report.md"]
    assert detail["generation"] == 2
    assert detail["request_id"] == "request-1"


# ── apply_subagent_action: the single verb dispatcher ────────────────────────

def _dispatch_service() -> cs.ConductorService:
    service = _bare_service()
    service.pool = SimpleNamespace(
        get=lambda _sid: SimpleNamespace(),
        keyinfo_subagent=Mock(return_value={"id": "w1", "status": "ok"}),
        abort_subagent=Mock(return_value={"id": "w1", "status": "cancelled"}),
    )
    return service


def test_apply_dispatches_input_aliases_and_attaches_instruction() -> None:
    service = _dispatch_service()
    service.input_subagent = Mock(return_value={"id": "w1"})

    result = service.apply_subagent_action(
        "w1", "  MSG ", "retry", llm_index=3, conductor_llm_index=1,
        subagent_llm_index=5, subagent_model_policy="locked",
        operation_id="op-1",
    )

    # Aliases normalize (case/whitespace) onto the single input verb.
    service.input_subagent.assert_called_once_with(
        "w1", "retry", 3, request_id=None, conductor_llm_index=1,
        subagent_llm_index=5, subagent_model_policy="locked",
        operation_id="op-1",
    )
    assert result["instruction"] == cs.INSTR_DISPATCHED


def test_apply_rework_attaches_instruction_only_on_success() -> None:
    service = _dispatch_service()
    service.rework_subagent = Mock(return_value={
        "id": "w1", "error": "only a stopped pending subagent can be reworked"})

    failed = service.apply_subagent_action("w1", "rework", "again")

    service.rework_subagent.assert_called_once_with(
        "w1", "again", None, request_id=None, conductor_llm_index=None,
        subagent_llm_index=None, subagent_model_policy=None,
        operation_id=None,
    )
    assert "instruction" not in failed

    service.rework_subagent = Mock(return_value={"id": "w1"})
    ok = service.apply_subagent_action("w1", "rework", "again")
    assert ok["instruction"] == cs.INSTR_DISPATCHED


def test_start_subagent_attaches_dispatch_instruction() -> None:
    service = _bare_service()
    service._conductor_llm_index = 1
    service._subagent_llm_index = None
    service._subagent_model_policy = "follow_main"
    service._model_lock = threading.RLock()
    service.pool = Mock()
    service.pool.snapshot.return_value = []
    service.client = Mock()
    service.client.start_subagent.return_value = {"id": "worker-1", "active_generation": 1}

    result = service.start_subagent("检查桌面启动流程", llm_index=3)

    # Dispatched responses carry the instruction from the service itself,
    # the same contract as apply_subagent_action's rework/input verbs.
    assert result["instruction"] == cs.INSTR_DISPATCHED


def test_duplicate_operation_id_in_flight_is_refused() -> None:
    service = _dispatch_service()
    # Reserve manually to simulate a concurrent duplicate mid-engine-call.
    assert service._reserve_action_operation("op-x") is None
    with pytest.raises(ValueError, match="already executing"):
        service._reserve_action_operation("op-x")


def test_failed_action_releases_reservation_for_retry() -> None:
    service = _dispatch_service()
    service.input_subagent = Mock(side_effect=RuntimeError("engine down"))

    with pytest.raises(RuntimeError):
        service.apply_subagent_action("w1", "input", "msg", operation_id="op-y")

    # The reservation was released, so the genuine retry reaches the engine.
    service.input_subagent = Mock(return_value={"id": "w1"})
    result = service.apply_subagent_action("w1", "input", "msg", operation_id="op-y")
    assert result["instruction"] == cs.INSTR_DISPATCHED


def test_retried_final_replays_recorded_item() -> None:
    service = _bare_service()
    tracker = Mock()
    tracker.has_request.return_value = True
    # Plain Mocks forbid assert_* attribute names; wire it explicitly.
    tracker.assert_ready_for_final = Mock()
    service.workflow_tracker = tracker
    service.chat_messages = []
    recorded = {"id": "c1", "role": "conductor", "kind": "final", "msg": "done"}
    service._record_action_operation("op-final", recorded)

    result = service.add_chat_message(
        "done", role="conductor", request_id="req-1",
        kind="final", operation_id="op-final",
    )

    assert result == recorded
    tracker.assert_ready_for_final.assert_not_called()


def test_delivered_final_is_recorded_for_replay() -> None:
    service = _bare_service()
    tracker = Mock()
    tracker.has_request.return_value = True
    tracker.assert_ready_for_final = Mock()  # Mocks reject assert_* names
    tracker.record_final.return_value = None
    service.workflow_tracker = tracker
    service.chat_messages = []

    with mock.patch.object(cs, "bus", mock.MagicMock()):
        item = service.add_chat_message(
            "done", role="conductor", request_id="req-1",
            kind="final", operation_id="op-f2",
        )

    assert service._replay_action_operation("op-f2") == item


def test_apply_accept_forwards_request_force_and_operation_id() -> None:
    service = _dispatch_service()
    service.accept_subagent = Mock(return_value={
        "id": "w1", "review_status": "accepted"})

    result = service.apply_subagent_action(
        "w1", "accept", "verified", request_id="rid-1", force=True,
        operation_id="op-2",
    )

    service.accept_subagent.assert_called_once_with(
        "w1", "verified", request_id="rid-1", force=True, operation_id="op-2")
    assert result["review_status"] == "accepted"


def test_apply_keyinfo_and_abort_forward_tracker_owner() -> None:
    """P0-B ownership: the pool verbs carry the tracker-resolved request."""
    service = _dispatch_service()
    service.workflow_tracker.admit("rid-owner")
    service.workflow_tracker.bind_subagent("rid-owner", "w1", 1)

    keyinfo = service.apply_subagent_action("w1", "keyinfo", "ctx")
    service.apply_subagent_action("w1", "stop")

    assert keyinfo["instruction"] == cs.INSTR_KEYINFO
    service.pool.keyinfo_subagent.assert_called_once_with(
        "w1", "ctx", request_id="rid-owner")
    service.pool.abort_subagent.assert_called_once_with(
        "w1", request_id="rid-owner")


def test_apply_unbound_worker_degrades_owner_to_none() -> None:
    """A worker unknown to the tracker keeps legacy None ownership."""
    service = _dispatch_service()

    service.apply_subagent_action("w1", "keyinfo", "ctx")

    service.pool.keyinfo_subagent.assert_called_once_with(
        "w1", "ctx", request_id=None)


def test_apply_rejects_unknown_verb() -> None:
    service = _dispatch_service()
    with pytest.raises(ValueError, match="unknown conductor action"):
        service.apply_subagent_action("w1", "explode")


# ── tracker-owner parity for accept/resume (P0-B loophole fix) ───────────────

def _owner_ready_service(sid: str = "w1", owner: str | None = "rid-owner"):
    """Service with a stubbed engine seam and a real, bound workflow tracker."""
    service = _bare_service()
    service._process_manager = None
    service._ensure_relay = lambda: None  # type: ignore[method-assign]
    service.client = SimpleNamespace(
        status=lambda: {"started": True},
        subagent_action=Mock(return_value={"id": sid}),
    )
    if owner:
        service.workflow_tracker.admit(owner)
        service.workflow_tracker.bind_subagent(owner, sid, 1)
    return service


def test_accept_resolves_tracker_owner_when_caller_omits_request() -> None:
    """The engine's request_mismatch guard must see the owner on accepts
    whose caller omitted the request — same as keyinfo/abort already do."""
    service = _owner_ready_service()

    result = service.accept_subagent("w1", "verified by machine")

    service.client.subagent_action.assert_called_once_with(
        "w1", "accept", "verified by machine",
        request_id="rid-owner", force=False)
    assert result["request_id"] == "rid-owner"


def test_accept_keeps_none_owner_for_unbound_worker() -> None:
    service = _owner_ready_service(owner=None)

    service.accept_subagent("w1")

    service.client.subagent_action.assert_called_once_with(
        "w1", "accept", "", request_id=None, force=False)


def test_resume_forwards_tracker_owner_to_engine() -> None:
    service = _owner_ready_service()
    service.configure_models = Mock(return_value={  # type: ignore[method-assign]
        "llm_index": None, "subagent_llm_index": None,
        "subagent_model_policy": "default"})
    service._resolve_subagent_model_from_snapshot = Mock(  # type: ignore[method-assign]
        return_value=None)

    service.input_subagent("w1", "continue")

    service.client.subagent_action.assert_called_once_with(
        "w1", "input", "continue", request_id="rid-owner", llm_index=None)
