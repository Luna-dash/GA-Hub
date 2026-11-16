"""Fixed handoff regressions. Never closes or starts a real desktop."""
import json
from pathlib import Path

import pytest

from server.services import update_handoff as handoff
from server.services.self_update import EXECUTABLES, UpdateStore, atomic_json, digest
from server.services.update_executor import ProcessIdentity
from test_self_update import release
from test_update_executor import FakeHost, prepare


def setup_request(tmp_path, monkeypatch):
    store = UpdateStore(tmp_path / 'updates')
    old_dir = tmp_path / 'old'
    old_dir.mkdir()
    for name in EXECUTABLES:
        (old_dir / name).write_bytes(b'old')
    old = ProcessIdentity(42, 'old', old_dir / EXECUTABLES[0])
    me = ProcessIdentity(99, 'worker', tmp_path / 'helper.exe')
    monkeypatch.setattr(handoff, 'identity', lambda pid: old if pid == 42 else me)
    monkeypatch.setattr(handoff, 'alive', lambda value: True)
    monkeypatch.setattr(handoff.subprocess, 'run', lambda *a, **k: None)
    return store, old


def test_same_worker_runs_two_updates(tmp_path, monkeypatch):
    store, old = setup_request(tmp_path, monkeypatch)
    hosts = []
    closed = []
    for _ in range(2):
        plan = prepare(store, release(tmp_path))
        handoff.request(store, tmp_path, plan['id'], old.pid)
        host = FakeHost(); hosts.append(host)
        def advance(_seconds):
            value = handoff.read_json(store.root / 'handoff.json')
            if value['state'] == 'ready':
                handoff.approve(store, plan['id'])
                value = handoff.read_json(store.root / 'handoff.json')
                value['not_before'] = 0
                atomic_json(store.root / 'handoff.json', value)
        result = handoff.worker(store, tmp_path, sleep=advance,
                                host_factory=lambda *args: host, close=closed.append)
        assert result['state'] == 'succeeded'
        assert handoff.read_json(store.root / 'current.json')['id'] == plan['id']
        assert handoff.read_json(store.root / 'handoff.json')['state'] == 'succeeded'
        assert not (store.root / 'maintenance.json').exists()
    assert closed == [old, old]
    assert len(hosts) == 2


def test_unapproved_worker_never_closes(tmp_path, monkeypatch):
    store, old = setup_request(tmp_path, monkeypatch)
    plan = prepare(store, release(tmp_path))
    handoff.request(store, tmp_path, plan['id'], old.pid)
    ticks = iter([0, 1, 9999])
    value = handoff.read_json(store.root / 'handoff.json')
    value['requested_at'] = 0
    atomic_json(store.root / 'handoff.json', value)
    closed = []
    with pytest.raises(ValueError, match='Approval expired'):
        handoff.worker(store, tmp_path, clock=lambda: next(ticks), sleep=lambda _: None,
                       host_factory=lambda *args: FakeHost(), close=closed.append)
    assert closed == []
    assert store.read()['state'] == 'failed'
    assert not (store.root / 'maintenance.json').exists()


@pytest.mark.parametrize('target', ['candidate', 'old'])
def test_tampering_during_countdown_never_closes(tmp_path, monkeypatch, target):
    store, old = setup_request(tmp_path, monkeypatch)
    plan = prepare(store, release(tmp_path))
    handoff.request(store, tmp_path, plan['id'], old.pid)
    closed = []

    def advance(_seconds):
        value = handoff.read_json(store.root / 'handoff.json')
        if value['state'] == 'ready':
            handoff.approve(store, plan['id'])
            value = handoff.read_json(store.root / 'handoff.json')
            value['not_before'] = 0
            atomic_json(store.root / 'handoff.json', value)
            directory = store.candidate(plan) if target == 'candidate' else old.executable.parent
            (directory / EXECUTABLES[0]).write_bytes(b'tampered')

    with pytest.raises(ValueError):
        handoff.worker(store, tmp_path, sleep=advance,
                       host_factory=lambda *args: FakeHost(), close=closed.append)
    assert closed == []
    assert store.read()['state'] == 'failed'
    assert not (store.root / 'maintenance.json').exists()
