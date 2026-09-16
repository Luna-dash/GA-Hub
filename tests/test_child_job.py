"""Child-process cage, spawn registry and orphan sweep.

The behaviour under test is the one that failed in production: GA-Hub was hard
killed and left a 6-day-old engine and a 3-day-old feishu bot behind, because
every long-lived child was a naked ``subprocess.Popen`` with no tie to the
parent's lifetime. Two mechanisms close that (see ``services/child_job``):
a kill-on-close job object, and a spawn registry swept at the next startup.

Nothing here spawns a real child: ``Popen``, the job API and the liveness probe
are all replaced, so the tests stay fast and cannot kill anything.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import pytest

import server
from server import _paths
from server.constants import ENV_GAHUB_KEEP_CHILDREN_ON_EXIT
from server.services import child_job


class _FakeProc:
    """Popen stand-in carrying the one attribute the cage needs."""

    def __init__(self, pid: int = 4242) -> None:
        self.pid = pid
        self._handle = 0x1234
        self.returncode: int | None = None

    def poll(self) -> int | None:
        return self.returncode

    def terminate(self) -> None:
        self.returncode = 0

    def kill(self) -> None:
        self.returncode = -9

    def wait(self, timeout: float | None = None) -> int:
        self.returncode = 0
        return 0


class _FakeJobApi:
    """Records what would have been handed to kernel32."""

    def __init__(self, job: object = 0xABCD, assign_ok: bool = True, error: int = 0):
        self.job = job
        self.created = 0
        self.assigned: list[tuple[object, int]] = []
        self.assigned_pids: list[tuple[object, int]] = []
        self._assign_ok = assign_ok
        self._error = error

    def create_kill_on_close(self):
        self.created += 1
        return self.job

    def assign(self, job, proc):
        self.assigned.append((job, proc.pid))
        return self._assign_ok, self._error

    def assign_pid(self, job, pid):
        self.assigned_pids.append((job, pid))
        return self._assign_ok, self._error


@pytest.fixture
def cage(tmp_path, monkeypatch):
    """Isolated registry + no real cage, atexit handler or liveness probe."""
    monkeypatch.setattr(_paths, "ADMIN_DATA", tmp_path)
    monkeypatch.delenv(ENV_GAHUB_KEEP_CHILDREN_ON_EXIT, raising=False)
    registered: list = []
    monkeypatch.setattr(
        child_job.atexit, "register", lambda func: registered.append(func) or func
    )
    child_job.ChildJob.reset_instance()
    yield SimpleNamespace(root=tmp_path, atexit_registered=registered)
    child_job.ChildJob.reset_instance()


def _install_api(monkeypatch, api: _FakeJobApi | None = None) -> _FakeJobApi:
    api = api or _FakeJobApi()
    monkeypatch.setattr(child_job.os, "name", "nt")
    monkeypatch.setattr(child_job, "_job_api_cache", api)
    return api


def _registry_rows() -> list[dict]:
    path = _paths.child_processes_file()
    if not path.is_file():
        return []
    return json.loads(path.read_text("utf-8"))["entries"]


def _write_rows(rows: list[dict]) -> None:
    path = _paths.child_processes_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"version": 1, "entries": rows}), "utf-8")


# ── spawn: cage + registration ──────────────────────────────────

def test_spawn_cages_the_child_and_registers_it(cage, monkeypatch):
    api = _install_api(monkeypatch)
    monkeypatch.setattr(child_job, "pid_alive", lambda pid: True)
    proc = _FakeProc()
    monkeypatch.setattr(child_job.subprocess, "Popen", lambda *a, **kw: proc)

    spawned = child_job.spawn(
        ["python.exe", "-u", "D:/ga/frontends/gahub_app.py"], kind="engine",
        cwd="D:/ga",
    )

    assert spawned is proc
    assert api.created == 1
    assert api.assigned == [(api.job, proc.pid)]
    assert cage.atexit_registered == [child_job._atexit_reap]
    rows = _registry_rows()
    assert len(rows) == 1
    assert rows[0].pop("started_at") > 0
    assert rows[0] == {
        "kind": "engine",
        "pid": proc.pid,
        "parent": os.getpid(),
        "marker": "D:/ga/frontends/gahub_app.py",
    }


def test_spawn_forwards_popen_kwargs_untouched(cage, monkeypatch):
    _install_api(monkeypatch)
    monkeypatch.setattr(child_job, "pid_alive", lambda pid: True)
    seen: dict = {}

    def fake_popen(cmd, **kwargs):
        seen["cmd"] = cmd
        seen["kwargs"] = kwargs
        return _FakeProc()

    monkeypatch.setattr(child_job.subprocess, "Popen", fake_popen)
    kwargs = dict(cwd="D:/ga", stdin=None, text=True, bufsize=1)

    child_job.spawn(["python.exe", "-c", "pass"], kind="ga_worker",
                    marker="web_execute_js", **kwargs)

    assert seen["cmd"] == ["python.exe", "-c", "pass"]
    assert seen["kwargs"] == kwargs


def test_spawn_still_returns_the_child_when_adoption_fails(cage, monkeypatch):
    """A cage/registry failure must never turn a successful spawn into an error."""
    api = _install_api(monkeypatch, _FakeJobApi(assign_ok=False, error=5))
    monkeypatch.setattr(child_job, "pid_alive", lambda pid: True)
    proc = _FakeProc()
    monkeypatch.setattr(child_job.subprocess, "Popen", lambda *a, **kw: proc)
    broken = mock.Mock(side_effect=RuntimeError("registry exploded"))
    monkeypatch.setattr(child_job, "_read_registry", broken)

    assert child_job.spawn(["python.exe", "x.py"], kind="engine") is proc
    assert api.assigned == [(api.job, proc.pid)]


def test_spawn_skips_registration_for_a_child_that_is_already_gone(cage, monkeypatch):
    """A dead pid is not worth a row — and it keeps test doubles out of the file."""
    _install_api(monkeypatch)
    monkeypatch.setattr(child_job, "pid_alive", lambda pid: False)
    monkeypatch.setattr(child_job.subprocess, "Popen", lambda *a, **kw: _FakeProc())

    child_job.spawn(["python.exe", "x.py"], kind="engine")

    assert _registry_rows() == []


def test_spawn_skips_registration_for_a_non_pid_handle(cage, monkeypatch):
    _install_api(monkeypatch)
    monkeypatch.setattr(child_job.subprocess, "Popen",
                        lambda *a, **kw: SimpleNamespace(pid="not-a-pid"))

    child_job.spawn(["python.exe", "x.py"], kind="engine")

    assert _registry_rows() == []


def test_spawn_without_a_cage_still_registers(cage, monkeypatch):
    """POSIX has no job object; the startup sweep is the only mechanism there."""
    monkeypatch.setattr(child_job.os, "name", "posix")
    monkeypatch.setattr(child_job, "pid_alive", lambda pid: True)
    monkeypatch.setattr(child_job.subprocess, "Popen", lambda *a, **kw: _FakeProc())

    child_job.spawn(["python3", "x.py"], kind="engine")

    assert child_job._windows_job_api() is None
    assert [row["pid"] for row in _registry_rows()] == [4242]


# ── intermediary spawns: the real child is one level down ───────

class _FakePsutil:
    """psutil stand-in answering ``Process(pid).children()`` from a tree."""

    def __init__(self, tree: dict[int, list[int]] | None = None, boom: bool = False):
        self.tree = tree or {}
        self.boom = boom

    def Process(self, pid):  # noqa: N802 - mirrors the psutil API
        outer = self

        class _Proc:
            def __init__(self, pid: int) -> None:
                self.pid = pid

            def children(self, recursive: bool = False):
                if outer.boom:
                    raise RuntimeError("process vanished mid-walk")
                if not recursive:
                    return [_Proc(k) for k in outer.tree.get(self.pid, [])]
                found: list = []
                for kid in outer.tree.get(self.pid, []):
                    child = _Proc(kid)
                    found.append(child)
                    found.extend(child.children(recursive=True))
                return found

        return _Proc(pid)


def test_cage_descendants_brings_the_whole_subtree_into_the_cage(cage, monkeypatch):
    """A cmd.exe intermediary spawns the engine *after* cmd was caged, so the
    engine inherits nothing; the descendants are assigned explicitly."""
    api = _install_api(monkeypatch)
    monkeypatch.setitem(sys.modules, "psutil",
                        _FakePsutil({500: [600, 700], 600: [800]}))

    assert child_job.cage_descendants(500) == [600, 800, 700]

    assert api.created == 1
    assert api.assigned_pids == [(api.job, 600), (api.job, 800), (api.job, 700)]


def test_cage_descendants_never_targets_an_unset_pid(cage, monkeypatch):
    """psutil reads a missing pid as *this* process: an unvalidated lookup
    would walk up on our own children."""
    api = _install_api(monkeypatch)
    monkeypatch.setitem(sys.modules, "psutil", _FakePsutil({0: [1, 2], None: [3]}))

    assert child_job.cage_descendants(None) == []
    assert child_job.cage_descendants(0) == []
    assert child_job.cage_descendants("500") == []

    assert api.assigned_pids == []
    assert api.created == 0


def test_cage_descendants_survives_a_child_that_is_already_gone(cage, monkeypatch):
    """The lookup races the process; a failure costs the fence, never the run."""
    api = _install_api(monkeypatch)
    monkeypatch.setitem(sys.modules, "psutil", _FakePsutil(boom=True))

    assert child_job.cage_descendants(500) == []
    assert api.assigned_pids == []


def test_cage_descendants_reports_an_assign_it_could_not_make(cage, monkeypatch):
    api = _install_api(monkeypatch, _FakeJobApi(assign_ok=False, error=6))
    monkeypatch.setitem(sys.modules, "psutil", _FakePsutil({500: [600]}))

    assert child_job.cage_descendants(500) == []
    assert api.assigned_pids == [(api.job, 600)]


def test_cage_descendants_leaves_everything_alone_under_the_escape_hatch(cage, monkeypatch):
    monkeypatch.setenv(ENV_GAHUB_KEEP_CHILDREN_ON_EXIT, "1")
    child_job.ChildJob.reset_instance()
    api = _install_api(monkeypatch)
    monkeypatch.setitem(sys.modules, "psutil", _FakePsutil({500: [600]}))

    assert child_job.cage_descendants(500) == []
    assert api.created == 0 and api.assigned_pids == []


def test_assign_pid_opens_the_handle_it_needs_and_closes_it(monkeypatch):
    """A descendant found by a tree walk has no Popen handle, so the assign
    opens one with the two rights the call documents."""
    api = object.__new__(child_job._WindowsJobApi)
    api.ctypes = SimpleNamespace(get_last_error=lambda: 87,
                                 c_void_p=lambda value: ("handle", value))
    opened: list = []
    closed: list = []

    class _Kernel32:
        def OpenProcess(self, access, inherit, pid):  # noqa: N802
            opened.append((access, inherit, pid))
            return 0x77

        def AssignProcessToJobObject(self, job, handle):  # noqa: N802
            assert job == 0xABCD and handle == 0x77
            return 1

        def CloseHandle(self, handle):  # noqa: N802
            closed.append(handle)

    api.kernel32 = _Kernel32()

    assert api.assign_pid(0xABCD, 5150) == (True, 0)
    assert opened == [(child_job._PROCESS_SET_QUOTA | child_job._PROCESS_TERMINATE,
                       False, 5150)]
    assert closed == [0x77]


def test_assign_pid_reports_an_unopenable_process():
    api = object.__new__(child_job._WindowsJobApi)
    api.ctypes = SimpleNamespace(get_last_error=lambda: 87,
                                 c_void_p=lambda value: value)

    class _Kernel32:
        def OpenProcess(self, access, inherit, pid):  # noqa: N802
            return None

    api.kernel32 = _Kernel32()

    assert api.assign_pid(0xABCD, 5150) == (False, 87)


def test_tree_termination_never_targets_an_unset_pid(monkeypatch):
    """``_terminate_tree`` is reachable with whatever a caller has at hand
    (a test double, a child that never reported a pid) — and psutil resolves a
    missing pid to the *calling* process, so the guard is what keeps a reap
    from walking up on our own tree."""
    monkeypatch.setitem(sys.modules, "psutil", _FakePsutil())

    assert child_job.terminate_tree(None) is False
    assert child_job.terminate_tree(0) is False
    assert child_job.terminate_tree(-1) is False
    assert child_job._terminate_tree("5150", 0.0) is False


# ── graceful reap ───────────────────────────────────────────────

def test_reap_all_terminates_registered_children_and_clears_rows(cage, monkeypatch):
    _install_api(monkeypatch)
    monkeypatch.setattr(child_job, "pid_alive", lambda pid: True)
    monkeypatch.setattr(child_job.subprocess, "Popen",
                        lambda *a, **kw: _FakeProc(pid=101))
    monkeypatch.setattr(child_job, "_terminate_tree",
                        lambda pid, timeout: pid == 101)
    child_job.spawn(["python.exe", "x.py"], kind="engine")

    assert child_job.reap_all() == [101]
    assert _registry_rows() == []


def test_reap_all_keeps_the_row_when_the_child_survives(cage, monkeypatch):
    _install_api(monkeypatch)
    monkeypatch.setattr(child_job, "pid_alive", lambda pid: True)
    monkeypatch.setattr(child_job.subprocess, "Popen",
                        lambda *a, **kw: _FakeProc(pid=202))
    monkeypatch.setattr(child_job, "_terminate_tree", lambda pid, timeout: False)
    child_job.spawn(["python.exe", "x.py"], kind="engine")

    assert child_job.reap_all() == []
    assert [row["pid"] for row in _registry_rows()] == [202]


def test_forget_drops_one_row_and_leaves_the_rest(cage, monkeypatch):
    _install_api(monkeypatch)
    monkeypatch.setattr(child_job, "pid_alive", lambda pid: True)
    pids = iter([11, 22])
    monkeypatch.setattr(child_job.subprocess, "Popen",
                        lambda *a, **kw: _FakeProc(pid=next(pids)))
    child_job.spawn(["python.exe", "engine.py"], kind="engine")
    child_job.spawn(["python.exe", "feishu.py"], kind="feishu")

    child_job.forget(11)

    assert [row["pid"] for row in _registry_rows()] == [22]


def test_a_normal_exit_reaps_what_the_services_left_behind(cage, monkeypatch):
    """The atexit hook is the graceful half; the job object covers the crash."""
    _install_api(monkeypatch)
    monkeypatch.setattr(child_job, "pid_alive", lambda pid: True)
    monkeypatch.setattr(child_job.subprocess, "Popen", lambda *a, **kw: _FakeProc(pid=33))
    reaped: list[int] = []
    monkeypatch.setattr(child_job, "_terminate_tree",
                        lambda pid, timeout: reaped.append(pid) or True)
    child_job.spawn(["python.exe", "x.py"], kind="ga_worker", marker="web_execute_js")

    child_job._atexit_reap()

    assert reaped == [33]


# ── startup sweep ───────────────────────────────────────────────

def _orphan_row(pid: int = 555, parent: int = 999, marker: str = "D:/ga/frontends/gahub_app.py"):
    return {"kind": "engine", "pid": pid, "parent": parent, "marker": marker,
            "started_at": 0.0}


def test_sweep_reaps_a_child_whose_parent_is_gone(cage, monkeypatch):
    _write_rows([_orphan_row()])
    monkeypatch.setattr(child_job, "pid_alive", lambda pid: pid != 999)
    monkeypatch.setattr(child_job, "_matches_identity", lambda pid, marker: True)
    killed: list[int] = []
    monkeypatch.setattr(child_job, "_terminate_tree",
                        lambda pid, timeout: killed.append(pid) or True)

    assert child_job.sweep_registry() == [555]
    assert killed == [555]
    assert _registry_rows() == []


def test_sweep_leaves_children_of_a_live_instance_alone(cage, monkeypatch):
    """Two GA-Hub instances: the second must not reap the first's engine."""
    _write_rows([_orphan_row()])
    monkeypatch.setattr(child_job, "pid_alive", lambda pid: True)
    monkeypatch.setattr(child_job, "_terminate_tree",
                        lambda pid, timeout: pytest.fail("must not terminate"))

    assert child_job.sweep_registry() == []
    assert _registry_rows() == [_orphan_row()]


def test_sweep_drops_rows_whose_child_already_exited(cage, monkeypatch):
    _write_rows([_orphan_row(pid=555, parent=999)])
    monkeypatch.setattr(child_job, "pid_alive", lambda pid: False)
    monkeypatch.setattr(child_job, "_terminate_tree",
                        lambda pid, timeout: pytest.fail("must not terminate"))

    assert child_job.sweep_registry() == []
    assert _registry_rows() == []


def test_sweep_never_kills_a_pid_it_cannot_identify(cage, monkeypatch):
    """Pids are recycled; a stale row must not turn into somebody else's death."""
    _write_rows([_orphan_row()])
    monkeypatch.setattr(child_job, "pid_alive", lambda pid: pid != 999)
    monkeypatch.setattr(child_job, "_matches_identity", lambda pid, marker: False)
    monkeypatch.setattr(child_job, "_terminate_tree",
                        lambda pid, timeout: pytest.fail("must not terminate"))

    assert child_job.sweep_registry() == []
    # The row described a child that is gone; the pid now belongs to someone
    # else, so there is nothing left to heal.
    assert _registry_rows() == []


def test_sweep_keeps_rows_with_an_unreadable_owner(cage, monkeypatch):
    _write_rows([{"kind": "engine", "pid": 555, "marker": "x.py"}])
    monkeypatch.setattr(child_job, "pid_alive", lambda pid: True)
    monkeypatch.setattr(child_job, "_terminate_tree",
                        lambda pid, timeout: pytest.fail("must not terminate"))

    assert child_job.sweep_registry() == []
    assert [row["pid"] for row in _registry_rows()] == [555]


def test_sweep_tolerates_a_corrupt_registry(cage, monkeypatch):
    path = _paths.child_processes_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{ not json", "utf-8")
    monkeypatch.setattr(child_job, "_terminate_tree",
                        lambda pid, timeout: pytest.fail("must not terminate"))

    assert child_job.sweep_registry() == []


def test_identity_check_matches_a_real_command_line(cage):
    """The psutil-backed check, against this very process."""
    import psutil

    own = psutil.Process(os.getpid()).cmdline()
    assert own, "the test process must expose a command line"
    assert child_job._matches_identity(os.getpid(), own[0]) is True
    assert child_job._matches_identity(os.getpid(), "absent-from-this-cmdline") is False
    assert child_job._matches_identity(os.getpid(), "") is False
    assert child_job._matches_identity(os.getpid(), None) is False


def test_marker_derivation_prefers_the_script_path():
    assert child_job._derive_marker(
        ["python.exe", "-u", "D:/ga/frontends/fsapp.py"]).endswith("fsapp.py")
    # Inline ``-c`` programs have no distinctive path, so nothing is recorded
    # and the sweep will never guess: the caller must name a marker.
    assert child_job._derive_marker(["python.exe", "-u", "-c", "print(1)"]) == ""


# ── escape hatch ────────────────────────────────────────────────

def test_escape_hatch_leaves_children_unmanaged_and_sweeps_nothing(cage, monkeypatch):
    monkeypatch.setenv(ENV_GAHUB_KEEP_CHILDREN_ON_EXIT, "1")
    child_job.ChildJob.reset_instance()
    api = _install_api(monkeypatch)
    monkeypatch.setattr(child_job.subprocess, "Popen", lambda *a, **kw: _FakeProc())
    _write_rows([_orphan_row()])
    monkeypatch.setattr(child_job, "_terminate_tree",
                        lambda pid, timeout: pytest.fail("must not terminate"))

    proc = child_job.spawn(["python.exe", "D:/ga/frontends/gahub_app.py"], kind="engine")

    assert proc.pid == 4242
    assert api.created == 0
    assert api.assigned == []
    assert _registry_rows() == [_orphan_row()]
    assert child_job.reap_all() == []
    assert child_job.sweep_registry() == []


@pytest.mark.parametrize("value,expected", [
    ("1", True), ("true", True), ("on", True), ("  YES  ", True),
    ("0", False), ("", False), ("no", False),
])
def test_escape_hatch_parsing(monkeypatch, value, expected):
    monkeypatch.setenv(ENV_GAHUB_KEEP_CHILDREN_ON_EXIT, value)
    child_job.ChildJob.reset_instance()
    try:
        assert child_job.ChildJob.instance().keep_children is expected
    finally:
        child_job.ChildJob.reset_instance()


# ── deployment contract ─────────────────────────────────────────

def test_every_long_lived_spawn_goes_through_child_job():
    """The three naked ``Popen`` call sites that leaked orphans stay fixed.

    A new long-lived child added with a bare ``subprocess.Popen`` would silently
    lose both the cage and the registry, which is invisible in review — this
    scan is what makes it visible.
    """
    package_root = Path(server.__file__).resolve().parent
    sites = {
        "services/conductor_client.py": "engine",
        "services/feishu_service.py": "feishu",
        "services/ga_external_worker.py": "ga_worker",
    }
    for relative, kind in sites.items():
        source = (package_root / relative).read_text("utf-8")
        assert "subprocess.Popen(" not in source, f"{relative} spawns without the cage"
        assert f'kind="{kind}"' in source, f"{relative} does not register its child"


def test_job_object_bindings_are_the_kill_on_close_pair():
    """The one bit that makes "handle closed" mean "children terminated"."""
    source = (Path(child_job.__file__)).read_text("utf-8")
    assert "_JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000" in source
    assert "AssignProcessToJobObject" in source
    assert "CreateJobObjectW" in source
    assert "SetInformationJobObject" in source


def test_registry_lives_under_admin_data(cage):
    assert child_job.registry_path() == cage.root / "child_processes.json"


def test_platform_probe_never_returns_an_api_off_windows(monkeypatch):
    monkeypatch.setattr(child_job.os, "name", "posix")
    monkeypatch.setattr(child_job, "_job_api_cache", child_job._UNSET)
    assert child_job._windows_job_api() is None
