"""Daily sync uses synthetic configurations and never accesses real credentials."""
import asyncio
import hashlib
import io
import json
import struct
import subprocess
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import HTTPException
from starlette.requests import Request

from server.routes import mykey
from server.schemas import MyKeyAutoSyncSettings, MyKeyAutoSyncStatus, MyKeySyncResultResp
from server.services import mykey_auto_sync as auto
from server.services import mykey_service as svc


@pytest.mark.parametrize('status', [200, 206])
def test_probe_reads_only_authenticated_metadata(monkeypatch, capsys, status):
    import runpy
    import urllib.request
    source_hash = hashlib.sha256(b'synthetic config').hexdigest()
    key = bytes(32)
    nonce = bytes(12)
    encrypted = b'GAMK2' + nonce + AESGCM(key).encrypt(nonce, json.dumps({'source_sha256': source_hash}).encode(), b'meta')
    header = b'GAMK2' + struct.pack('>I', len(encrypted))
    payload = header + encrypted + b'DO_NOT_READ_MODEL_PAYLOAD' * 1000
    streams = []

    class Response(io.BytesIO):
        def __init__(self, start, size):
            super().__init__(payload[start:start + size] if status == 206 else payload)
            self.status = status
            self.headers = {'Content-Range': f'bytes {start}-{start + size - 1}/{len(payload)}'}
            self.bytes_read = 0

        def read(self, size=-1):
            assert size >= 0, 'probe must never read the whole response'
            value = super().read(size)
            self.bytes_read += len(value)
            return value

    def urlopen(req, timeout):
        start, end = map(int, req.get_header('Range').removeprefix('bytes=').split('-'))
        response = Response(start, end - start + 1)
        streams.append(response)
        return response

    def get_passphrase():
        print('synthetic credential module banner')
        return 'synthetic'

    def run_path(*args, **kwargs):
        print('synthetic helper banner')
        return helper

    helper = {
        'get_passphrase': get_passphrase, 'derive_storage_key': lambda _: 'test-storage',
        'get_base_url': lambda override=None: override or 'https://synthetic.invalid', 'derive_meta_key': lambda _: key,
        'decrypt': lambda k, blob, aad: AESGCM(k).decrypt(blob[5:17], blob[17:], aad),
    }
    monkeypatch.setattr(runpy, 'run_path', run_path)
    monkeypatch.setattr(urllib.request, 'urlopen', urlopen)
    monkeypatch.setattr('sys.argv', ['probe', 'synthetic-helper.py'])
    exec(auto.PROBE_CODE, {})
    output = capsys.readouterr()
    assert json.loads(output.out) == {'sha256': source_hash}
    assert output.err.splitlines() == ['synthetic helper banner', 'synthetic credential module banner']
    assert len(streams) == 2 and all(s.closed for s in streams)
    assert sum(s.bytes_read for s in streams) == len(header) + len(encrypted) + (9 if status == 200 else 0)


@pytest.fixture
def config(monkeypatch, tmp_path):
    path = tmp_path / 'synthetic.py'
    path.write_text("oai_config_a = {'name': 'A'}\n", encoding='utf-8')
    monkeypatch.setattr(svc, '_mykey_path', lambda: path)
    return path


def test_equal_hash_skips_download_and_has_valid_api_response(monkeypatch, config):
    monkeypatch.setattr(auto, 'remote_fingerprint', lambda: auto.fingerprint(config))
    fetch = Mock()
    monkeypatch.setattr(svc, 'sync_fetch', fetch)
    result = auto.checked_fetch()
    assert not result['changed']
    MyKeySyncResultResp(**result)
    fetch.assert_not_called()


def test_different_hash_fetches_with_edit_guard(monkeypatch, config):
    monkeypatch.setattr(auto, 'remote_fingerprint', lambda: 'a' * 64)
    fetch = Mock(return_value={'ok': True})
    monkeypatch.setattr(svc, 'sync_fetch', fetch)
    assert auto.checked_fetch()['changed']
    fetch.assert_called_once_with(expected_sha256=auto.fingerprint(config))


def test_probe_failure_does_not_fetch_or_expose_details(monkeypatch, config):
    monkeypatch.setattr(auto, 'remote_fingerprint', Mock(side_effect=RuntimeError('private-storage-path')))
    fetch = Mock()
    monkeypatch.setattr(svc, 'sync_fetch', fetch)
    with pytest.raises(svc.MykeyHttpError) as exc:
        auto.checked_fetch()
    assert 'private' not in str(exc.value.detail)
    fetch.assert_not_called()


@pytest.mark.parametrize(('failure', 'diagnostic'), [
    ('timeout', 'timed out'),
    ('invalid_json', 'invalid JSON output'),
    ('invalid_hash', 'invalid JSON output'),
    ('child_exit', 'helper exited unsuccessfully'),
])
def test_probe_failure_logs_only_safe_category(monkeypatch, config, caplog, failure, diagnostic):
    private = 'private-storage-path'
    monkeypatch.setattr(auto._paths, 'ga_mykey_sync_script', lambda: config)
    monkeypatch.setattr(svc, '_mykey_sync_python', lambda: 'synthetic-python')
    monkeypatch.setattr(svc, '_sync_base_url', lambda: 'https://synthetic.invalid')
    fetch = Mock()
    monkeypatch.setattr(svc, 'sync_fetch', fetch)

    def run(cmd, **kwargs):
        if failure == 'timeout':
            raise subprocess.TimeoutExpired(cmd, kwargs['timeout'], output=private, stderr=private)
        stdout = json.dumps({'sha256': private}) if failure == 'invalid_hash' else private
        return subprocess.CompletedProcess(cmd, 1 if failure == 'child_exit' else 0, stdout, private)

    monkeypatch.setattr(auto.subprocess, 'run', run)
    original = config.read_bytes()
    with pytest.raises(svc.MykeyHttpError) as exc:
        auto.checked_fetch()
    assert exc.value.status_code == 502
    assert private not in exc.value.detail
    assert diagnostic in caplog.text
    assert private not in caplog.text
    assert config.read_bytes() == original
    fetch.assert_not_called()


def test_schedule_noon_catchup_and_persisted_daily_dedup(monkeypatch, tmp_path):
    now = [datetime(2026, 11, 5, 11, 59, tzinfo=timezone.utc)]
    runtime = Mock()
    path = tmp_path / 'state.json'
    fetch = Mock(return_value={'changed': False})
    monkeypatch.setattr(auto, 'checked_fetch', fetch)
    service = auto.MykeyAutoSync(scheduler_runtime=runtime, path=path, now=lambda: now[0])
    service.start()
    runtime.add_job.assert_called_once()
    service.tick()
    fetch.assert_not_called()
    now[0] = now[0].replace(hour=12)
    service.tick()
    service.tick()
    fetch.assert_called_once()
    assert service.status()['result'] == 'unchanged'
    MyKeyAutoSyncStatus(**service.status())
    assert service.shutdown()
    restarted = auto.MykeyAutoSync(scheduler_runtime=runtime, path=path, now=lambda: now[0])
    restarted.start()
    restarted.tick()
    assert fetch.call_count == 1
    now[0] = now[0].replace(day=6, hour=16)
    restarted.tick()
    assert fetch.call_count == 2
    restarted.configure(False)
    restarted.shutdown()
    assert not auto.MykeyAutoSync(scheduler_runtime=runtime, path=path).state['enabled']


@pytest.mark.parametrize('outcome', ['updated', 'error'])
def test_updates_and_failure_status_are_persisted(monkeypatch, tmp_path, outcome):
    fetch = Mock(return_value={'changed': True}, side_effect=RuntimeError('secret') if outcome == 'error' else None)
    monkeypatch.setattr(auto, 'checked_fetch', fetch)
    service = auto.MykeyAutoSync(scheduler_runtime=Mock(), path=tmp_path / 'state.json',
                                now=lambda: datetime(2026, 11, 5, 16, tzinfo=timezone.utc))
    service.start()
    service.tick()
    service.tick()
    assert fetch.call_count == 1
    status = service.status()
    assert status['result'] == outcome and not status['running']
    assert bool(status['last_updated']) == (outcome == 'updated')
    assert 'secret' not in service.path.read_text('utf-8')


def test_disabled_stopped_and_inflight_do_not_start_work(monkeypatch, tmp_path):
    fetch = Mock()
    monkeypatch.setattr(auto, 'checked_fetch', fetch)
    service = auto.MykeyAutoSync(scheduler_runtime=Mock(), path=tmp_path / 'state.json',
                                now=lambda: datetime(2026, 11, 5, 16, tzinfo=timezone.utc))
    service.tick()
    service.start()
    service.configure(False)
    service.tick()
    service.configure(True)
    service.running = True
    service.tick()
    assert service.shutdown() is False
    fetch.assert_not_called()


def test_auto_routes_use_owned_service(tmp_path):
    service = auto.MykeyAutoSync(scheduler_runtime=Mock(), path=tmp_path / 'state.json')
    app = SimpleNamespace(state=SimpleNamespace(services=SimpleNamespace(mykey_sync=service)))
    request = Request({'type': 'http', 'app': app})
    assert asyncio.run(mykey.auto_sync_status(request))['enabled']
    assert not asyncio.run(mykey.auto_sync_settings(request, MyKeyAutoSyncSettings(enabled=False)))['enabled']
    app.state.services.mykey_sync = None
    with pytest.raises(HTTPException) as exc:
        asyncio.run(mykey.auto_sync_status(request))
    assert exc.value.status_code == 503


def test_concurrent_edit_during_fetch_is_not_overwritten(monkeypatch, config, tmp_path):
    original = auto.fingerprint(config)
    def worker(action):
        from pathlib import Path
        target = Path(action[action.index('--target') + 1])
        target.write_text("oai_config_cloud = {'name': 'Cloud'}\n", encoding='utf-8')
        config.write_text("oai_config_local = {'name': 'Local edit'}\n", encoding='utf-8')
        return {'returncode': 0, 'stdout': '', 'stderr': ''}
    monkeypatch.setattr(svc._paths, 'ADMIN_DATA', tmp_path)
    monkeypatch.setattr(svc, '_run_mykey_sync', worker)
    backup, reload = Mock(), Mock()
    monkeypatch.setattr(svc, '_backup_current', backup)
    monkeypatch.setattr(svc, '_trigger_reload', reload)
    with pytest.raises(svc.MykeyHttpError) as exc:
        svc.sync_fetch(expected_sha256=original)
    assert exc.value.status_code == 409
    assert 'Local edit' in config.read_text('utf-8')
    backup.assert_not_called()
    reload.assert_not_called()
