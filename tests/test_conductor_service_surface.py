"""Regression coverage for the gahub_app engine-adapter service surface.

These pin the three post-restructuring defects found by live diagnosis:
the missing GET /chat bootstrap proxy, replayed finals for untracked
request_ids, and the interpreter probe's child environment.
"""
from __future__ import annotations

import io
import subprocess
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock

import pytest

from server.services import conductor_service as cs
from server.services.conductor_client import GahubProcessError, GahubProcessManager


def _bare_service() -> cs.ConductorService:
    """Build a ConductorService without running __init__ (no engine needed)."""
    return cs.ConductorService.for_tests()


def test_get_chat_messages_serves_the_mirrored_history() -> None:
    """The store-loaded mirror is the hydration authority; the engine's
    chat memory is gone on every boot (reliability plan §4.3)."""
    service = _bare_service()
    with service._chat_lock:
        service.chat_messages = [
            {"id": "old", "role": "user", "msg": "hi"},
            {"id": "new", "role": "conductor", "msg": "plan"},
        ]

    assert service.get_chat_messages(last=1) == [
        {"id": "new", "role": "conductor", "msg": "plan"}
    ]


def test_replayed_final_for_unknown_request_is_downgraded(monkeypatch) -> None:
    """Finals for request ids this tracker never admitted must
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


def test_engine_spawn_uses_mei_stripped_env_and_no_preflight_probe(monkeypatch, tmp_path) -> None:
    """The engine spawn must launch with the _MEI-stripped environment, and
    ensure_running must NOT run a pre-flight probe child: the AV suspends
    every short-lived child (probe hung 3/3, 4/4, 12/12 across sessions)
    while the long-lived engine spawn succeeds right beside it (live
    2026-09-07, three rounds). The engine spawn is its own probe."""
    captured: dict = {}

    class FakeProc:
        returncode = None

        def poll(self):
            return None

    def fake_popener(cmd, **kwargs):
        captured["cmd"] = cmd
        captured["env"] = kwargs.get("env")
        return FakeProc()

    monkeypatch.setattr(subprocess, "Popen", fake_popener)
    monkeypatch.setattr("server.services.conductor_client.tempfile.gettempdir",
                        lambda: str(tmp_path))

    manager = GahubProcessManager(
        python_exe="python-does-not-matter",
        ga_root=str(tmp_path),
    )
    (tmp_path / "frontends").mkdir()
    (tmp_path / "frontends" / "gahub_app.py").write_text("# engine\n")

    polluted_path = f"C:\\Temp\\_MEI12345\\bin{chr(59)}C:\\Windows"
    monkeypatch.setattr("server.services.conductor_client.os.environ", {
        "PATH": polluted_path,
        "_PYI_ARCHIVE": "1",
    })
    # Health never turns true; cap the wait so the test stays fast.
    monkeypatch.setattr(manager, "is_healthy", lambda timeout=1.0: False)

    with pytest.raises(GahubProcessError) as raised:
        manager.ensure_running(startup_timeout=0.5)

    env = captured["env"]
    assert env is not None
    assert all("_MEI" not in item for item in env["PATH"].split(chr(59)))
    assert "_PYI_ARCHIVE" not in env
    # One task per turn (H1.1): the switch must reach the engine's real env,
    # not merely _engine_spawn_env()'s return value.
    assert env["GAHUB_MULTI_REQUEST_TURNS"] == "off"
    # Exactly one child process: the engine itself, no probe child.
    assert captured["cmd"][1:3] == ["-u", str(tmp_path / "frontends" / "gahub_app.py")]
    # The timeout diagnostic names the AV condition for the operator.
    assert "security software" in str(raised.value)


def test_engine_spawn_context_is_logged(monkeypatch, tmp_path) -> None:
    """ensure_running records the spawn context (python path, frozen state)
    into the engine log before spawning — the only pre-flight diagnostic
    that does not itself spawn a short-lived child."""
    monkeypatch.setattr(subprocess, "Popen", lambda cmd, **kw: SimpleNamespace(
        returncode=None, poll=lambda: None))
    monkeypatch.setattr("server.services.conductor_client.tempfile.gettempdir",
                        lambda: str(tmp_path))

    manager = GahubProcessManager(
        python_exe="conda-python.exe", ga_root=str(tmp_path))
    (tmp_path / "frontends").mkdir()
    (tmp_path / "frontends" / "gahub_app.py").write_text("# engine\n")
    monkeypatch.setattr(manager, "is_healthy", lambda timeout=1.0: False)

    log_buf = io.BytesIO()
    manager._log_spawn_context(log_buf)
    text = log_buf.getvalue().decode("utf-8", "replace")
    assert "[spawn]" in text
    assert "conda-python.exe" in text
    assert "frozen=False" in text


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


def test_engine_spawn_env_selects_explicit_absolute_paths(monkeypatch) -> None:
    """Local engines explicitly accept declared absolute paths on other drives."""
    from pathlib import Path

    from server.services import conductor_client as cc

    monkeypatch.setattr("server.services.conductor_client.os.environ", {
        "PATH": f"C:\\Temp\\_MEI12345\\bin{chr(59)}C:\\Windows",
    })
    monkeypatch.setattr(cc._paths, "GA_ROOT", Path("D:/study/GA"))
    monkeypatch.setattr(
        cc._paths, "conductor_deliverables_dir", lambda: Path("D:/user-outputs"))

    env = cc._engine_spawn_env()

    assert env["GAHUB_PATH_POLICY"] == "explicit_absolute"
    assert "GAHUB_DELIVERABLE_ROOTS" not in env


def test_engine_spawn_env_respects_operator_deliverable_roots(monkeypatch) -> None:
    from server.services import conductor_client as cc

    monkeypatch.setenv("GAHUB_DELIVERABLE_ROOTS", "D:\\my-outputs")
    env = cc._engine_spawn_env()
    assert env["GAHUB_DELIVERABLE_ROOTS"] == "D:\\my-outputs"


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


# ── apply_subagent_action: single verb front door over the command track ─────

def _submit_spy(service: cs.ConductorService) -> Mock:
    """The service layer only builds the intent; delivery is the command
    track's job (tested end-to-end in test_conductor_recovery.py)."""
    submit = Mock(return_value={"id": "w1"})
    service.commands = SimpleNamespace(submit=submit)
    return submit


def test_apply_folds_aliases_onto_canonical_verbs() -> None:
    service = _bare_service()
    submit = _submit_spy(service)

    service.apply_subagent_action(
        "w1", "  MSG ", "retry", llm_index=3, conductor_llm_index=1,
        subagent_llm_index=5, subagent_model_policy="locked",
        operation_id="op-1",
    )
    service.apply_subagent_action("w1", "stop")

    first = submit.call_args_list[0].args[1]
    assert submit.call_args_list[0].args[0] == "op-1"
    assert first == {"kind": "action", "sid": "w1", "action": "input",
                     "msg": "retry", "request_id": None, "force": False,
                     "llm_index": 3, "conductor_llm_index": 1,
                     "subagent_llm_index": 5, "subagent_model_policy": "locked"}
    # stop is the abort alias and carries the hub origin marker.
    second = submit.call_args_list[1].args[1]
    assert second["action"] == "abort"
    assert second["origin"] == "hub"


def test_apply_accept_builds_force_intent() -> None:
    service = _bare_service()
    submit = _submit_spy(service)

    service.apply_subagent_action(
        "w1", "accept", "verified", request_id="rid-1", force=True,
        operation_id="op-2",
    )

    submit.assert_called_once_with("op-2", {
        "kind": "action", "sid": "w1", "action": "accept", "msg": "verified",
        "request_id": "rid-1", "force": True, "llm_index": None,
        "conductor_llm_index": None, "subagent_llm_index": None,
        "subagent_model_policy": None})


def test_apply_forwards_optimistic_concurrency_expectations() -> None:
    service = _bare_service()
    submit = _submit_spy(service)

    service.apply_subagent_action("w1", "accept", operation_id="op-3",
                                  expected_boot_id="boot-a", expected_generation=2,
                                  expected_command_revision=7)

    intent = submit.call_args.args[1]
    assert intent["expected_boot_id"] == "boot-a"
    assert intent["expected_generation"] == 2
    assert intent["expected_command_revision"] == 7


def test_apply_rejects_unknown_verb() -> None:
    service = _bare_service()
    _submit_spy(service)
    with pytest.raises(ValueError, match="unknown conductor action"):
        service.apply_subagent_action("w1", "explode")


def test_start_subagent_submits_the_full_manifest() -> None:
    service = _bare_service()
    submit = _submit_spy(service)

    service.start_subagent(
        "检查桌面启动流程", llm_index=3, request_id="rid-1",
        goal="启动", deliverables=["D:/out/report.md"],
        operation_id="op-4",
    )

    submit.assert_called_once_with("op-4", {
        "kind": "dispatch", "prompt": "检查桌面启动流程", "request_id": "rid-1",
        "llm_index": 3, "conductor_llm_index": None,
        "subagent_llm_index": None, "subagent_model_policy": None,
        "goal": "启动", "boundaries": None, "deliverables": ["D:/out/report.md"],
        "done_when": None, "checks": None})


def test_start_facade_configures_models_then_ensures_lifecycle() -> None:
    """POST /api/conductor/start regression: da97cf8 dropped the `start`
    facade as dead code and the start button 500'd (AttributeError) for a
    week — the dead-code sweep grepped service callers but missed the
    route's dynamic reference."""
    service = _bare_service()
    service.configure_models = Mock(return_value={})
    service.ensure_started = Mock(return_value=True)

    assert service.start(llm_index=1, subagent_llm_index=2) is True
    service.configure_models.assert_called_once_with(
        llm_index=1, subagent_llm_index=2, subagent_model_policy=None)
    # Explicit start must be a pure bring-up: the blanket redispatch of
    # every stranded workflow is what the 2026-09 user ruling removed —
    # resuming is a per-task decision (resume_workflow), never a side
    # effect of pressing the header start button.
    service.ensure_started.assert_called_once_with(wake_recovery=False)


class _FakeProc:
    """Popen stand-in that never exits (AV-suspended-at-birth child)."""

    def __init__(self):
        self.terminated = False
        self.killed = False

    def poll(self):
        return None

    def terminate(self):
        self.terminated = True

    def kill(self):
        self.killed = True

    def wait(self, timeout=None):
        return 0


def test_ensure_running_reaps_hung_children(tmp_path, monkeypatch) -> None:
    """2026-09-08 zombie-farm regression: children that never become healthy
    (AV-suspended at birth) must be reaped by the manager — both when the
    spawn times out and before the next spawn attempt — instead of leaking
    until an unrelated job teardown happens to collect them."""
    from server.services import conductor_client as cc

    (tmp_path / "frontends").mkdir()
    (tmp_path / "frontends" / "gahub_app.py").write_text("# engine stub",
                                                         encoding="utf-8")
    manager = GahubProcessManager(ga_root=str(tmp_path), spawn_enabled=True)
    monkeypatch.setattr(manager, "is_healthy", lambda timeout=1.0: False)
    monkeypatch.setattr(cc, "_open_engine_log",
                        lambda: (io.BytesIO(), str(tmp_path / "engine.log")))
    monkeypatch.setattr(cc, "hidden_process_kwargs", lambda: {})

    spawned: list[_FakeProc] = []

    def fake_popen(*args, **kwargs):
        proc = _FakeProc()
        spawned.append(proc)
        return proc

    monkeypatch.setattr(cc.subprocess, "Popen", fake_popen)

    # Phase 1: the spawn never becomes healthy -> the manager reaps the hung
    # child before reporting the failure.
    with pytest.raises(GahubProcessError):
        manager.ensure_running(startup_timeout=0.3)
    assert len(spawned) == 1
    assert spawned[0].terminated is True
    assert manager._proc is None

    # Phase 2: a stale child from an earlier failed cycle is reaped before
    # the next spawn attempt (even when that attempt itself is refused).
    stale = _FakeProc()
    manager._proc = stale

    def refused(*args, **kwargs):
        raise OSError("spawn refused")

    monkeypatch.setattr(cc.subprocess, "Popen", refused)
    with pytest.raises(OSError):
        manager.ensure_running(startup_timeout=0.3)
    assert stale.terminated is True
    assert manager._proc is None


# ===== subagent archive: per-worker detail outlives engine pool resets =====

def _archived_item(sid="sid-1", request_id="request-1", **overrides) -> dict:
    item = {"id": sid, "prompt": "整理归档目录", "reply": "完成", "status": "stopped",
            "review_status": "accepted", "attempt": 1, "created_at": 10, "updated_at": 20,
            "request_id": request_id}
    item.update(overrides)
    return item


def test_subagent_archive_roundtrip_filters_and_cleanup(tmp_path) -> None:
    service = cs.ConductorService.for_tests(store_path=tmp_path / "wf.db")
    store = service.store
    store.save_subagent_snapshots([
        _archived_item("s1"), _archived_item("s2", request_id="request-2")])
    assert {item["id"] for item in store.archived_subagent_snapshots()} == {"s1", "s2"}
    assert [item["id"] for item in store.archived_subagent_snapshots(request_id="request-2")] == ["s2"]
    assert [item["id"] for item in store.archived_subagent_snapshots(exclude={"s1"})] == ["s2"]

    # Deleting the owning workflow cleans up its archived workers.
    with service.workflow_tracker.transaction():
        store.forget_workflow("request-2")
    assert {item["id"] for item in store.archived_subagent_snapshots()} == {"s1"}
    store.close()


def test_envelope_merges_archived_workers_after_pool_reset(tmp_path) -> None:
    service = cs.ConductorService.for_tests(store_path=tmp_path / "wf.db")
    service._archive_subagent_snapshots([_archived_item()])
    # Simulate a pool reset (conductor stop / engine restart): the live pool
    # is empty, yet the completed workflow's workers must stay visible.
    envelope = service.get_subagent_envelope()
    merged = next(item for item in envelope["items"] if item["id"] == "sid-1")
    assert merged["archived"] is True
    assert merged["stage"]
    service.store.close()


def test_dossier_falls_back_to_archive_when_engine_lost_worker(tmp_path) -> None:
    service = cs.ConductorService.for_tests(store_path=tmp_path / "wf.db")
    service._archive_subagent_snapshots([_archived_item()])

    def not_found(sid, max_len=5000):
        raise GahubProcessError("gahub_app /subagent -> 404: not found",
                                status_code=404)

    service.client = Mock()
    service.client.get_subagent.side_effect = not_found
    detail = service.subagent_dossier("sid-1", 5000)
    assert detail["prompt"] == "整理归档目录"
    assert detail["archived"] is True
    service.store.close()
