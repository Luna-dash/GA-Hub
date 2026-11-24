"""No real desktop processes are started or stopped by these tests."""
import json
from pathlib import Path

import pytest

from server.services.self_update import EXECUTABLES
from server.services.update_executor import ProcessIdentity, UpdateExecutor
from test_self_update import prepare as prepare_release, release
from server.services.update_preflight import SCOPE
from server.services.self_update import atomic_json


def prepare(store, archive):
    # Fake EXEs: unit fixture only, never a runtime bypass.
    plan = prepare_release(store, archive)
    atomic_json(store.root / "admission" / f"{plan['id']}.json", {
        "id": plan["id"], "sha256": plan["sha256"], "scope": SCOPE, "passed": True,
    })
    return plan
from server.services.self_update import UpdateStore


class FakeHost:
    detached = True
    exited = True
    ready = True
    restored_ready = True
    stopped = True

    def __init__(self):
        self.events = []

    def independent(self):
        return self.detached

    def validate_old(self, identity):
        self.events.append("validate")

    def wait_old_exit(self, identity, timeout):
        self.events.append("wait")
        return self.exited

    def start(self, executable, plan_id):
        self.events.append("start")
        return ProcessIdentity(222, "new-created", executable)

    def healthy(self, identity, plan, timeout):
        self.events.append("health")
        return self.ready

    def rollback_ready(self, identity, plan, timeout):
        self.events.append("health")
        return self.restored_ready

    def stop_candidate(self, identity, timeout):
        self.events.append("stop")
        return self.stopped

    def restore(self, executable, plan_id):
        self.events.append("restore")
        return ProcessIdentity(789, "restored", executable)


@pytest.fixture
def setup(tmp_path):
    store = UpdateStore(tmp_path / "updates")
    plan = prepare(store, release(tmp_path))
    old = tmp_path / "old"
    old.mkdir()
    for name in EXECUTABLES:
        (old / name).write_bytes(b"old-" + name.encode())
    identity = ProcessIdentity(111, "old-created", old / EXECUTABLES[0])
    host = FakeHost()
    return store, plan, identity, host, UpdateExecutor(store, host)


def test_independence_required_before_arm(setup):
    store, plan, old, host, worker = setup
    host.detached = False
    with pytest.raises(ValueError, match="independent"):
        worker.arm(plan["id"], old)
    assert store.read()["state"] == "prepared"
    assert host.events == []


def test_success_publishes_pair_only_after_health(setup):
    store, plan, old, host, worker = setup
    worker.arm(plan["id"], old)
    assert not (store.root / "current.json").exists()
    assert worker.run(plan["id"])["state"] == "succeeded"
    assert host.events == ["validate", "wait", "start", "health"]
    pointer = json.loads((store.root / "current.json").read_text())
    assert pointer["sha256"] == plan["sha256"]
    assert Path(pointer["executable"]).parent == store.candidate(plan)
    assert old.executable.read_bytes().startswith(b"old-")


@pytest.mark.parametrize("ready,stopped,expected", [(False, True, "rolled_back"), (False, False, "failed")])
def test_health_failure_never_runs_versions_together(setup, ready, stopped, expected):
    store, plan, old, host, worker = setup
    host.ready, host.stopped = ready, stopped
    worker.arm(plan["id"], old)
    result = worker.run(plan["id"])
    assert result["state"] == expected
    if expected == "failed":
        assert result["switch_started"] is True
    assert ("restore" in host.events) == stopped
    assert not (store.root / "current.json").exists()


def test_old_exit_timeout_does_not_start_or_stop_anything(setup):
    store, plan, old, host, worker = setup
    host.exited = False
    worker.arm(plan["id"], old)
    result = worker.run(plan["id"])
    assert result["state"] == "failed"
    assert result["switch_started"] is False
    assert host.events == ["validate", "wait"]


def test_tamper_after_arm_restores_old_without_starting_candidate(setup):
    store, plan, old, host, worker = setup
    worker.arm(plan["id"], old)
    (store.candidate(plan) / EXECUTABLES[1]).write_bytes(b"tampered")
    assert worker.run(plan["id"])["state"] == "rolled_back"
    assert host.events == ["validate", "wait", "restore", "health"]


def test_changed_old_pair_refuses_rollback(setup):
    store, plan, old, host, worker = setup
    worker.arm(plan["id"], old)
    host.ready = False
    old.executable.write_bytes(b"changed")
    result = worker.run(plan["id"])
    assert result["state"] == "failed" and "Old executable pair changed" in result["error"]
    assert "restore" not in host.events


def test_stale_executor_cannot_rearm_or_run(setup):
    store, plan, old, host, worker = setup
    worker.arm(plan["id"], old)
    with pytest.raises(ValueError):
        worker.arm(plan["id"], old)
    worker.run(plan["id"])
    with pytest.raises(ValueError):
        worker.run(plan["id"])


def test_uncertain_launch_never_restores_second_version(setup, monkeypatch):
    store, plan, old, host, worker = setup
    worker.arm(plan["id"], old)
    def uncertain(*args):
        raise OSError("spawn succeeded but identity unavailable")
    monkeypatch.setattr(host, "start", uncertain)
    result = worker.run(plan["id"])
    assert result["state"] == "failed"
    assert "launch uncertain" in result["error"]
    assert "restore" not in host.events


@pytest.mark.parametrize("previous", [None, {"id": "previous"}])
def test_publication_failure_restores_previous_pointer(setup, monkeypatch, previous):
    from server.services.self_update import atomic_json
    store, plan, old, host, worker = setup
    pointer = store.root / "current.json"
    if previous is not None:
        atomic_json(pointer, previous)
    worker.arm(plan["id"], old)
    transition = store.transition
    def fail_success(pid, expected, state, **fields):
        if state == "succeeded":
            raise OSError("simulated final state write failure")
        return transition(pid, expected, state, **fields)
    monkeypatch.setattr(store, "transition", fail_success)
    assert worker.run(plan["id"])["state"] == "rolled_back"
    assert "stop" in host.events and "restore" in host.events
    if previous is None:
        assert not pointer.exists()
    else:
        assert json.loads(pointer.read_text()) == previous


@pytest.mark.parametrize("receipt", [None, "malformed", "wrong-hash", "failed"])
def test_arm_rejects_invalid_admission(setup, receipt):
    store, plan, old, host, worker = setup
    path = store.root / "admission" / f"{plan['id']}.json"
    if receipt is None:
        path.unlink()
    elif receipt == "malformed":
        path.write_text("not-json", encoding="utf8")
    else:
        value = json.loads(path.read_text())
        value["sha256" if receipt == "wrong-hash" else "passed"] = {} if receipt == "wrong-hash" else False
        path.write_text(json.dumps(value), encoding="utf8")
    with pytest.raises(ValueError):
        worker.arm(plan["id"], old)
    assert store.read()["state"] == "prepared"
    assert "start" not in host.events


def test_rollback_not_ready_is_stopped_and_marked_failed(setup):
    store, plan, old, host, worker = setup
    host.ready = host.restored_ready = False
    worker.arm(plan["id"], old)
    result = worker.run(plan["id"])
    assert result["state"] == "failed"
    assert "rollback failed" in result["error"]
    assert host.events[-5:] == ["health", "stop", "restore", "health", "stop"]
    assert not (store.root / "current.json").exists()
