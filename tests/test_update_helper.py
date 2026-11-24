"""External helper regression tests; never start the real desktop."""
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from server import update_helper as cli
from server.services import update_native as native
from server.services.self_update import EXECUTABLES, UpdateStore
from server.services.update_executor import ProcessIdentity
from test_self_update import prepare, release


def test_clean_desktop_environment(tmp_path, monkeypatch):
    for name in ("GA_HUB_SIDECAR", "GA_HUB_PYTHON", "GA_HUB_BRIDGE_PORT",
                 "GA_HUB_UPDATE_NONCE", "GA_HUB_UPDATE_RECEIPT"):
        monkeypatch.setenv(name, "inherited")
    env = native.desktop_environment(tmp_path)
    assert env["GA_ADMIN_DATA"] == str(tmp_path.resolve())
    assert not any(k in env for k in ("GA_HUB_SIDECAR", "GA_HUB_PYTHON", "GA_HUB_UPDATE_NONCE"))


def test_ready_endpoint_requires_nonce_and_reports_real_paths(tmp_path, monkeypatch):
    from server import main
    monkeypatch.setattr(main._paths, "GA_ROOT", None)
    monkeypatch.setattr(main._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setenv("GA_HUB_UPDATE_NONCE", "a" * 64)
    app = main.create_app()
    client = TestClient(app, base_url="http://127.0.0.1")  # No lifespan or background tasks.
    assert client.get("/api/updates/ready").status_code == 404
    app.state.update_ready = True
    response = client.get("/api/updates/ready", headers={"X-Update-Nonce": "a" * 64})
    assert response.status_code == 200
    assert response.json()["admin_data"] == str(tmp_path.resolve())
    assert response.json()["pid"] == os.getpid()
    assert response.json()["ready"] is True


def test_setup_blocks_application_without_touching_handoff(tmp_path, monkeypatch):
    from server import main
    from server.routes import updates

    monkeypatch.setattr(main._paths, "GA_ROOT", None)
    app = main.create_app()
    assert app.state.setup_mode
    monkeypatch.setattr(updates, "store", lambda: pytest.fail("Setup reached the update store"))
    # Setup may discover GA_ROOT before restarting; app mode is a startup snapshot.
    monkeypatch.setattr(main._paths, "GA_ROOT", tmp_path)
    client = TestClient(app, base_url="http://127.0.0.1")
    for action in ("preflight", "request", "approve"):
        response = client.post(f"/api/updates/{action}", json={"id": "a" * 32})
        assert response.status_code == 409, response.text
        assert "Complete GA setup" in response.json()["detail"]


def test_observe_children_skips_exited_children_and_preserves_live_siblings(tmp_path, monkeypatch):
    parent = ProcessIdentity(111, "1.0", tmp_path / EXECUTABLES[0])
    previous = ProcessIdentity(200, "0.5", tmp_path / EXECUTABLES[1])
    survivor = ProcessIdentity(222, "2.0", tmp_path / EXECUTABLES[1])
    def vanished():
        raise native.psutil.NoSuchProcess(201)
    def denied():
        raise native.psutil.AccessDenied(202)
    live = SimpleNamespace(pid=222, create_time=lambda: 2.0, exe=lambda: str(survivor.executable),
                           is_running=lambda: True)
    children = [SimpleNamespace(pid=201, create_time=vanished), live]
    monkeypatch.setattr(native, "_matching_process", lambda value: SimpleNamespace(
        children=lambda **kwargs: children))
    observed = {previous}
    assert native._observe_children(parent, observed) is True
    assert observed == {previous, survivor}
    children.insert(1, SimpleNamespace(pid=202, create_time=denied))
    observed.clear()
    assert native._observe_children(parent, observed) is False
    assert observed == {survivor}


def test_restore_stops_only_its_own_observed_children(tmp_path, monkeypatch):
    host = native.NativeHost(tmp_path, tmp_path)
    old_launch = ProcessIdentity(111, "1", tmp_path / EXECUTABLES[0])
    stale_child = ProcessIdentity(222, "2", tmp_path / EXECUTABLES[1])
    restored = ProcessIdentity(111, "3", tmp_path / EXECUTABLES[0])
    host.candidate_children[old_launch] = {stale_child}
    proc = SimpleNamespace(pid=restored.pid, poll=lambda: 0)
    monkeypatch.setattr(native.subprocess, "Popen", lambda *args, **kwargs: proc)
    monkeypatch.setattr(native, "identity", lambda pid: restored)
    monkeypatch.setattr(native, "_observe_children", lambda value, observed: True)
    monkeypatch.setattr(native, "alive", lambda value: False)
    calls = []
    monkeypatch.setattr(native, "_terminate_owned", calls.append)
    assert host.restore(restored.executable, "plan") == restored
    assert host.stop_candidate(restored, 1) is True
    assert calls == [restored]
    assert host.stop_candidate(old_launch, 1) is False


def test_diagnostic_receipt_is_only_accepted_for_rollback(tmp_path, monkeypatch):
    from io import BytesIO

    host = native.NativeHost(tmp_path / "updates", tmp_path)
    desktop = ProcessIdentity(123, "desktop", tmp_path / EXECUTABLES[0])
    backend = ProcessIdentity(124, "backend", tmp_path / EXECUTABLES[1])
    host.nonce = "a" * 64
    host.receipt = tmp_path / "receipt.json"
    host.receipt.write_text(json.dumps({"nonce": host.nonce, "pid": desktop.pid,
                                       "executable": str(desktop.executable), "port": 32100}))
    report = {"nonce": host.nonce, "ready": False, "diagnostic_ready": True,
              "pid": backend.pid, "executable": str(backend.executable), "admin_data": str(tmp_path)}
    monkeypatch.setattr(native, "alive", lambda value: value == desktop)
    monkeypatch.setattr(native, "identity", lambda pid: backend)
    monkeypatch.setattr(native, "_observe_children", lambda value, observed: True)
    monkeypatch.setattr(native.psutil, "Process", lambda pid: SimpleNamespace(
        children=lambda **kwargs: [], parents=lambda: [SimpleNamespace(pid=desktop.pid)]))
    monkeypatch.setattr(native.urllib.request, "build_opener", lambda *args: SimpleNamespace(
        open=lambda *args, **kwargs: BytesIO(json.dumps(report).encode("utf8"))))
    def monotonic():
        return next(ticks)

    monkeypatch.setattr(native, "time", SimpleNamespace(monotonic=monotonic, sleep=lambda delay: None))
    ticks = iter([0, 0, 2])
    assert host.healthy(desktop, {}, 1) is False
    ticks = iter([0, 0])
    assert host.rollback_ready(desktop, {}, 1) is True
    report["admin_data"] = str(tmp_path / "wrong")
    ticks = iter([0, 0, 2])
    assert host.rollback_ready(desktop, {}, 1) is False


def test_apply_forwards_exit_timeout(tmp_path, monkeypatch):
    old = tmp_path / "old"
    old.mkdir()
    exe = old / EXECUTABLES[0]
    value = ProcessIdentity(123, "created", exe.resolve())
    monkeypatch.setattr(cli, "outside_job", lambda: True)
    monkeypatch.setattr(cli, "identity", lambda pid: value)
    monkeypatch.setattr(cli, "atomic_json", lambda *a: None)
    seen = {}

    class Worker:
        def __init__(self, *args):
            pass

        def arm(self, plan_id, identity):
            seen["armed"] = plan_id

        def run(self, plan_id, *, exit_timeout):
            seen["timeout"] = exit_timeout
            return {"state": "succeeded"}

    monkeypatch.setattr(cli, "UpdateExecutor", Worker)
    assert cli.main(["--admin-data", str(tmp_path), "apply", "--plan", "plan",
                     "--old-pid", "123", "--old-executable", str(exe),
                     "--old-exit-timeout", "1.5"]) == 0
    assert seen == {"armed": "plan", "timeout": 1.5}


def test_apply_refuses_job_before_inspecting_old(tmp_path, monkeypatch):
    monkeypatch.setattr(cli, "outside_job", lambda: False)
    monkeypatch.setattr(cli, "identity", lambda _: pytest.fail("must refuse first"))
    assert cli.main(["--admin-data", str(tmp_path), "apply", "--plan", "x",
                     "--old-pid", "123", "--old-executable", str(tmp_path / EXECUTABLES[0])]) == 1


def test_dead_candidate_with_live_observed_child_blocks_rollback(tmp_path, monkeypatch):
    host = native.NativeHost(tmp_path, tmp_path)
    parent = ProcessIdentity(111, "p", tmp_path / EXECUTABLES[0])
    child = ProcessIdentity(222, "c", tmp_path / EXECUTABLES[1])
    host.started[parent] = SimpleNamespace(poll=lambda: 0)
    host.candidate_children[parent] = {child}
    calls = []
    monkeypatch.setattr(native, "_observe_children", lambda value, observed: True)
    monkeypatch.setattr(native, "_terminate_owned", calls.append)
    monkeypatch.setattr(native, "alive", lambda value: value == child)
    assert host.stop_candidate(parent, .01) is False
    assert calls == [parent, child]
    monkeypatch.setattr(native, "alive", lambda value: False)
    assert host.stop_candidate(parent, .01) is True


def test_recover_requires_confirmation(tmp_path):
    store = UpdateStore(tmp_path / "updates")
    plan = prepare(store, release(tmp_path))
    store.transition(plan["id"], {"prepared"}, "armed")
    assert cli.main(["--admin-data", str(tmp_path), "recover", "--plan", plan["id"]]) == 1
    assert store.read()["state"] == "armed"


@pytest.mark.parametrize("terminal", ["cancelled", "succeeded", "rolled_back"])
def test_recover_only_clears_matching_marker_after_desktops_exit(tmp_path, monkeypatch, terminal):
    from server.services.self_update import atomic_json

    store = UpdateStore(tmp_path / "updates")
    plan = prepare(store, release(tmp_path))
    plan_id = plan["id"]
    store.transition(plan_id, {"prepared"}, "switching", switch_started=True)
    marker = store.root / "maintenance.json"
    command = ["--admin-data", str(tmp_path), "recover", "--plan", plan_id, "--confirm-all-exited"]
    checked = []

    def check_exit(store, plan):
        checked.append(plan["id"])
        if len(checked) == 1:
            raise ValueError("Desktop still running")

    monkeypatch.setattr(cli, "ensure_no_desktop", check_exit)
    atomic_json(marker, {"id": "another-plan"})
    assert cli.main(command) == 1
    assert checked == [] and marker.exists()
    atomic_json(marker, {"id": plan_id})
    assert cli.main(command) == 1
    assert store.read()["state"] == "switching" and marker.exists()

    # Simulate interruption after the terminal write but before marker deletion.
    store.transition(plan_id, {"switching"}, terminal)
    assert cli.main(command) == 0
    assert checked == [plan_id, plan_id]
    assert store.read()["state"] == terminal and not marker.exists()


def test_launch_current_survives_later_prepared_plan(tmp_path, monkeypatch):
    from server.services.self_update import atomic_json
    store = UpdateStore(tmp_path / "updates")
    plan = prepare(store, release(tmp_path))
    completed = {**plan, "state": "succeeded"}
    atomic_json(store.root / "completed" / f"{plan['id']}.json", completed)
    atomic_json(store.root / "current.json", {
        "id": plan["id"], "sha256": plan["sha256"], "data_epoch": plan["data_epoch"],
        "executable": str(store.candidate(plan) / EXECUTABLES[0]),
    })
    store.transition(plan["id"], {"prepared"}, "succeeded")
    newer = prepare(store, release(tmp_path))
    assert newer["id"] != plan["id"]
    monkeypatch.setattr(cli, "ensure_no_desktop", lambda *args: None)
    seen = []
    def spawn(argv, **kwargs):
        seen.append(argv)
        return SimpleNamespace(pid=12345)
    monkeypatch.setattr(cli.subprocess, "Popen", spawn)
    assert cli.launch_current(store, tmp_path) == 12345
    assert seen == [[str(store.candidate(plan) / EXECUTABLES[0])]]
    store.transition(newer["id"], {"prepared"}, "armed")
    with pytest.raises(ValueError, match="Unresolved"):
        cli.launch_current(store, tmp_path)
    assert len(seen) == 1

    # A failure before switching began does not strand the existing verified install.
    store.transition(newer["id"], {"armed"}, "failed", switch_started=False)
    assert cli.launch_current(store, tmp_path) == 12345
    assert len(seen) == 2

    # A mid-switch failure must still block launching until recovered.
    store.transition(newer["id"], {"failed"}, "failed", switch_started=True)
    with pytest.raises(ValueError, match="Unresolved"):
        cli.launch_current(store, tmp_path)
    assert len(seen) == 2


def test_native_wait_and_candidate_stop_real_processes(tmp_path):
    """Only short-lived Python test processes; no actual desktop or shared data."""
    import subprocess
    import sys
    host = native.NativeHost(tmp_path / "updates", tmp_path)
    proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"],
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL)
    try:
        pinned = native.identity(proc.pid)
        assert native.alive(pinned)
        assert host.wait_old_exit(pinned, .05) is False
        # Adapter may only stop an explicitly registered owned process.
        assert host.stop_candidate(pinned, .05) is False
        host.started[pinned] = proc
        host.candidate_children[pinned] = set()
        assert host.stop_candidate(pinned, 5) is True
        proc.wait(timeout=5)
        assert host.wait_old_exit(pinned, 1) is True
    finally:
        if proc.poll() is None:
            proc.terminate()
            proc.wait(timeout=5)


def test_launch_command_waits_for_launcher_before_start(tmp_path, monkeypatch):
    seen = []
    expected = Path(cli.sys.executable).resolve().with_name(EXECUTABLES[0])
    def wait(timeout):
        seen.append(("wait", timeout))
    monkeypatch.setattr(cli.psutil, "Process", lambda pid: SimpleNamespace(exe=lambda: str(expected), wait=wait))
    monkeypatch.setattr(cli, "outside_job", lambda: True)
    monkeypatch.setattr(cli, "launch_current", lambda *a: seen.append(("launch",)) or 321)
    assert cli.main(["--admin-data", str(tmp_path), "launch", "--launcher-pid", "123"]) == 0
    assert seen == [("wait", 15), ("launch",)]


def test_launch_command_does_not_start_if_launcher_is_alive(tmp_path, monkeypatch):
    expected = Path(cli.sys.executable).resolve().with_name(EXECUTABLES[0])
    def wait(timeout):
        raise cli.psutil.TimeoutExpired(timeout)
    monkeypatch.setattr(cli.psutil, "Process", lambda pid: SimpleNamespace(exe=lambda: str(expected), wait=wait))
    monkeypatch.setattr(cli, "outside_job", lambda: True)
    monkeypatch.setattr(cli, "launch_current", lambda *a: pytest.fail("must not start"))
    assert cli.main(["--admin-data", str(tmp_path), "launch", "--launcher-pid", "123"]) == 1


def test_launch_command_allows_non_hub_external_job_and_logs_refusals(tmp_path, monkeypatch):
    from server.services import update_job
    monkeypatch.setattr(cli, "outside_job", lambda: False)
    monkeypatch.setattr(update_job, "desktop_job_memberships", lambda: [])
    monkeypatch.setattr(cli, "launch_current", lambda *a: 456)
    assert cli.main(["--admin-data", str(tmp_path), "launch"]) == 0

    (tmp_path / "logs").mkdir()
    def fail_inspect():
        raise OSError("Access denied")
    monkeypatch.setattr(update_job, "desktop_job_memberships", fail_inspect)
    assert cli.main(["--admin-data", str(tmp_path), "launch"]) == 1
    log_text = (tmp_path / "logs" / "update_helper.log").read_text(encoding="utf-8")
    assert "Cannot verify Hub desktop Job exclusion: Access denied" in log_text


def test_ensure_installed_without_handoff_file(tmp_path, monkeypatch):
    from server.services import update_handoff as handoff
    import sys
    store = UpdateStore(tmp_path / "updates")
    desktop = tmp_path / EXECUTABLES[0]
    source = desktop.with_name("ga-hub-update.exe")
    source.write_bytes(b"MZ-helper-test")
    installed = store.root / "bin/ga-hub-update.exe"
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    seen = []
    def run(argv, **kwargs):
        seen.append(argv)
        installed.parent.mkdir(parents=True, exist_ok=True)
        installed.write_bytes(source.read_bytes())
        return SimpleNamespace(returncode=0)
    monkeypatch.setattr(handoff.subprocess, "run", run)
    handoff.ensure_installed(store, tmp_path, desktop)
    assert len(seen) == 1 and seen[0][-1] == "install"
    handoff.ensure_installed(store, tmp_path, desktop)
    assert len(seen) == 1
