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
        captured["stdin"] = kwargs.get("stdin")
        captured["executable"] = kwargs.get("executable")
        return FakeProc()

    monkeypatch.setattr(subprocess, "Popen", fake_popener)
    monkeypatch.setattr("server.services.conductor_client.tempfile.gettempdir",
                        lambda: str(tmp_path))
    # The route assertions below pin the Windows intermediary; keep them true
    # on any host. Adoption of cmd's child has its own tests further down.
    from server.services import conductor_client as cc

    monkeypatch.setattr("server.services.conductor_client.os.name", "nt")
    monkeypatch.setattr(cc.child_job, "cage_descendants", lambda pid: [])

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
    # Exactly one child process: the engine itself, no probe child — started
    # through the signed system shell (see the intermediary tests below).
    cmd = captured["cmd"]
    assert isinstance(cmd, str)
    exe, _, command = cmd.partition(" /c ")
    assert exe.lower().endswith("cmd.exe")
    assert "-u " in command and str(tmp_path / "frontends" / "gahub_app.py") in command
    # The timeout diagnostic names the AV condition for the operator.
    assert "security software" in str(raised.value)


# ── engine spawn route: cmd.exe as the signed intermediary ───────────────────
#
# A frozen sidecar spawning the engine directly hangs before the child's first
# byte of output (measured 3/3; the same command from a non-frozen parent comes
# up in seconds), so the spawn is routed through the signed system shell. cmd
# re-parses the command line as shell text — it strips the outermost quote pair
# of a /c command line — which is what the quoting and the tests below pin.

_CMD = r"C:\Windows\System32\cmd.exe"


def _engine_manager(tmp_path, monkeypatch, *, pid: int = 4242, healthy_after: int = 999):
    """A manager whose spawn is captured instead of executed.

    ``healthy_after`` counts *probes*: two health gates run before the spawn
    (unlocked + locked), then one per loop turn. The default never turns
    healthy; ``2`` brings the engine up on the loop's first probe.

    Both ``Popen`` and ``child_job.spawn`` are replaced, so nothing real is
    created — no console, no job object, no registry row.
    """
    from server.services import conductor_client as cc

    (tmp_path / "frontends").mkdir(exist_ok=True)
    (tmp_path / "frontends" / "gahub_app.py").write_text("# engine\n")
    manager = GahubProcessManager(
        python_exe="D:/py/python.exe", ga_root=str(tmp_path), port=8791, token="tok")
    captured: dict = {}
    calls = {"healthy": 0}

    class FakeProc:
        def __init__(self):
            self.pid = pid
            self.returncode = None
            self.terminated = False

        def poll(self):
            return self.returncode

        def terminate(self):
            self.terminated = True

        def kill(self):
            self.terminated = True

        def wait(self, timeout=None):
            return 0

    def fake_spawn(cmd, **kwargs):
        captured["cmd"] = cmd
        captured.update(kwargs)
        captured["proc"] = FakeProc()
        return captured["proc"]

    def is_healthy(timeout: float = 1.0) -> bool:
        calls["healthy"] += 1
        return calls["healthy"] > healthy_after

    monkeypatch.setattr(cc.child_job, "spawn", fake_spawn)
    monkeypatch.setattr(cc, "_open_engine_log",
                        lambda: (io.BytesIO(), str(tmp_path / "engine.log")))
    monkeypatch.setattr(cc.child_job, "cage_descendants", lambda pid: [])
    monkeypatch.setattr(manager, "is_healthy", is_healthy)
    return manager, captured


def _spawn_through_cmd(tmp_path, monkeypatch, **kwargs) -> tuple:
    """Capture one Windows spawn; returns ``(manager, captured, command)``."""
    from server.services import conductor_client as cc

    monkeypatch.setattr(cc.os, "name", "nt")
    monkeypatch.setattr(cc.os, "environ", {"ComSpec": _CMD})
    manager, captured = _engine_manager(tmp_path, monkeypatch, **kwargs)
    with pytest.raises(GahubProcessError):
        manager.ensure_running(startup_timeout=0.3)
    exe, sep, command = captured["cmd"].partition(" /c ")
    assert sep and exe == _CMD
    return manager, captured, command


def test_engine_spawn_shape_is_cmd_exe_slash_c(tmp_path, monkeypatch) -> None:
    """Windows: ``cmd.exe /c "<python> -u <script> --host … --port …>"``."""
    _, captured, command = _spawn_through_cmd(tmp_path, monkeypatch)
    engine_cmd = ["D:/py/python.exe", "-u", str(tmp_path / "frontends" / "gahub_app.py"),
                  "--host", "127.0.0.1", "--port", "8791", "--token", "tok"]
    # The outer pair is the one cmd strips again when it parses /c.
    assert command == '"' + subprocess.list2cmdline(engine_cmd) + '"'
    # …and the interpreter is pinned rather than parsed off the command line.
    assert captured["executable"] == _CMD
    assert captured["stdin"] is subprocess.DEVNULL
    assert captured["stderr"] is subprocess.STDOUT


def test_engine_spawn_quotes_spaced_and_metacharacter_arguments(tmp_path, monkeypatch) -> None:
    """Paths with spaces and tokens with cmd syntax must reach the engine
    verbatim: cmd reads its command line as shell text, so anything it could
    interpret is quoted — and the C-runtime escaping stays untouched."""
    from server.services import conductor_client as cc

    spaced_root = tmp_path / "ga root"
    (spaced_root / "frontends").mkdir(parents=True)
    (spaced_root / "frontends" / "gahub_app.py").write_text("# engine\n")

    monkeypatch.setattr(cc.os, "name", "nt")
    monkeypatch.setattr(cc.os, "environ", {"ComSpec": _CMD})
    manager, captured = _engine_manager(tmp_path, monkeypatch, pid=9001)
    manager.ga_root = str(spaced_root)
    manager.python_exe = r"D:\py dir\python.exe"
    manager.token = "a&b=c d"
    with pytest.raises(GahubProcessError):
        manager.ensure_running(startup_timeout=0.3)

    command = captured["cmd"].partition(" /c ")[2]
    assert command.startswith('"') and command.endswith('"')
    inner = command[1:-1]
    assert '"D:\\py dir\\python.exe"' in inner
    assert f'"{spaced_root / "frontends" / "gahub_app.py"}"' in inner
    assert '"a&b=c d"' in inner
    # Space-bearing parts quote exactly as the engine's own argv parse expects.
    assert inner == subprocess.list2cmdline([
        manager.python_exe, "-u", str(spaced_root / "frontends" / "gahub_app.py"),
        "--host", "127.0.0.1", "--port", str(manager.port), "--token", "a&b=c d",
    ])


def test_engine_spawn_quotes_a_token_that_cmd_would_read_as_syntax(tmp_path, monkeypatch) -> None:
    """A token without spaces is not quoted by the C-runtime rules, so the
    cmd-level quoting has to add it — otherwise ``&`` splits the command."""
    from server.services import conductor_client as cc

    monkeypatch.setattr(cc.os, "name", "nt")
    monkeypatch.setattr(cc.os, "environ", {"ComSpec": _CMD})
    manager, captured = _engine_manager(tmp_path, monkeypatch, pid=9002)
    manager.token = "a&b"
    with pytest.raises(GahubProcessError):
        manager.ensure_running(startup_timeout=0.3)

    assert '"a&b"' in captured["cmd"].partition(" /c ")[2]


@pytest.mark.parametrize("part,expected", [
    ("plain", "plain"),
    ("--port=8791", "--port=8791"),
    ("with space", '"with space"'),
    ("a&b", '"a&b"'),
    ("x|y", '"x|y"'),
    ("a<b", '"a<b"'),
    ("caret^", '"caret^"'),
    ("", '""'),
    ('say "hi"', '"say \\"hi\\""'),
])
def test_cmd_quote_keeps_every_argument_literal(part, expected) -> None:
    from server.services import conductor_client as cc

    assert cc._cmd_quote(part) == expected


def test_engine_spawn_keeps_the_direct_exec_off_windows(tmp_path, monkeypatch) -> None:
    """POSIX has no shell in the middle: argv is passed through untouched."""
    from server.services import conductor_client as cc

    monkeypatch.setattr(cc.os, "name", "posix")
    manager, captured = _engine_manager(tmp_path, monkeypatch, pid=9003)
    with pytest.raises(GahubProcessError):
        manager.ensure_running(startup_timeout=0.3)

    assert captured["cmd"] == [
        "D:/py/python.exe", "-u", str(tmp_path / "frontends" / "gahub_app.py"),
        "--host", "127.0.0.1", "--port", "8791", "--token", "tok",
    ]
    assert "executable" not in captured
    assert captured["stdin"] is subprocess.DEVNULL


def test_engine_spawn_adopts_cmds_child_into_the_cage(tmp_path, monkeypatch) -> None:
    """The engine is cmd's child, and cmd can start it before joining the cage
    itself, so it inherits nothing — ensure_running assigns it explicitly:
    once right after the spawn (cmd may be quick) and once /health answers
    (cmd may be slow, in which case the first call found no children yet)."""
    from server.services import conductor_client as cc

    monkeypatch.setattr(cc.os, "name", "nt")
    monkeypatch.setattr(cc.os, "environ", {"ComSpec": _CMD})
    manager, _ = _engine_manager(tmp_path, monkeypatch, pid=5150, healthy_after=2)
    adopted: list = []
    monkeypatch.setattr(cc.child_job, "cage_descendants",
                        lambda pid: adopted.append(pid) or [])

    manager.ensure_running(startup_timeout=2.0)

    assert adopted == [5150, 5150]


def test_engine_spawn_registers_cmds_pid_with_the_script_as_marker(tmp_path, monkeypatch) -> None:
    """The registry row describes the process that will be killed — now cmd —
    and the sweep's identity check needs a marker its command line carries:
    the engine's script path is right there in ``cmd /c``."""
    from server.services import conductor_client as cc

    monkeypatch.setattr(cc.os, "name", "nt")
    monkeypatch.setattr(cc.os, "environ", {"ComSpec": _CMD})
    manager, captured = _engine_manager(tmp_path, monkeypatch, pid=8100)

    with pytest.raises(GahubProcessError):
        manager.ensure_running(startup_timeout=0.3)

    script = str(tmp_path / "frontends" / "gahub_app.py")
    assert captured["kind"] == "engine"
    assert captured["marker"] == script
    assert script in captured["cmd"]           # …and visible on cmd's own line
    assert captured["cwd"] == str(tmp_path)


def test_failed_start_reaps_cmd_and_the_engine_behind_it(tmp_path, monkeypatch) -> None:
    """A hung engine is one level down, so the reap walks the tree: killing
    the cmd handle would leave the engine holding the port and the lock."""
    from server.services import conductor_client as cc

    monkeypatch.setattr(cc.os, "name", "nt")
    monkeypatch.setattr(cc.os, "environ", {"ComSpec": _CMD})
    manager, captured = _engine_manager(tmp_path, monkeypatch, pid=6001)
    killed: list = []
    forgotten: list = []
    monkeypatch.setattr(cc.child_job, "terminate_tree",
                        lambda pid, timeout: killed.append(pid) or True)
    monkeypatch.setattr(cc.child_job, "forget", forgotten.append)

    with pytest.raises(GahubProcessError):
        manager.ensure_running(startup_timeout=0.3)

    assert killed == [6001]
    assert forgotten == [6001]
    # The handle is only the fallback, and it was not needed.
    assert captured["proc"].terminated is False
    assert manager._proc is None


def test_stop_reaps_the_intermediary_and_the_engine_behind_it(tmp_path, monkeypatch) -> None:
    from server.services import conductor_client as cc

    monkeypatch.setattr(cc.os, "name", "nt")
    monkeypatch.setattr(cc.os, "environ", {"ComSpec": _CMD})
    manager, captured = _engine_manager(tmp_path, monkeypatch, pid=7007, healthy_after=2)
    monkeypatch.setattr(cc.child_job, "cage_descendants", lambda pid: [])
    manager.ensure_running(startup_timeout=2.0)

    killed: list = []
    monkeypatch.setattr(cc.child_job, "terminate_tree",
                        lambda pid, timeout: killed.append(pid) or True)

    assert manager.stop(timeout=1.0) is True
    assert killed == [7007]
    assert manager._proc is None


def test_reaping_never_kills_a_pid_whose_process_is_gone(tmp_path, monkeypatch) -> None:
    """Pids get recycled: once the child is gone its number is not a kill
    target any more, and the Popen handle takes over."""
    from server.services import conductor_client as cc

    monkeypatch.setattr(cc.os, "name", "nt")
    monkeypatch.setattr(cc.os, "environ", {"ComSpec": _CMD})
    manager, captured = _engine_manager(tmp_path, monkeypatch, pid=7008, healthy_after=2)
    manager.ensure_running(startup_timeout=2.0)
    proc = captured["proc"]
    proc.returncode = 0                      # exited on its own
    killed: list = []
    monkeypatch.setattr(cc.child_job, "terminate_tree",
                        lambda pid, timeout: killed.append(pid) or True)

    assert manager.stop(timeout=1.0) is True
    assert killed == []
    assert proc.terminated is True


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
