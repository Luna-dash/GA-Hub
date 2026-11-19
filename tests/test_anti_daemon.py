"""Local daemon lifecycle without launching the production CLI."""
import socket
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
import requests
from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.constants import ENV_ANTICLI_PORT
from server.routes import anti
from server.services import anti_daemon as svc
from server.services.service_registry import ServiceRegistry


class Process:
    pid = 321
    code = None

    def poll(self):
        return self.code


def make_client(monkeypatch):
    monkeypatch.setenv('GA_HUB_ANTICLI_PORT', '18877')
    monkeypatch.setattr(anti, 'daemon', svc.AntiDaemon())
    app = FastAPI()
    app.include_router(anti.router)
    return TestClient(app)


def test_manual_start_and_reuse(monkeypatch):
    client = make_client(monkeypatch)
    health = None
    starts, freed = [], []
    process = Process()

    def probe(self, method, path, **kwargs):
        assert (method, path) == ('GET', '/health')
        return health

    def closed(address, timeout):
        assert address == ('127.0.0.1', 18877)
        raise ConnectionRefusedError()

    def spawn(command, **kwargs):
        starts.append(command)
        assert kwargs['stdin'] == svc.subprocess.DEVNULL
        return process

    monkeypatch.setattr(svc.AntiAdapter, 'request', probe)
    monkeypatch.setattr(svc.socket, 'create_connection', closed)
    monkeypatch.setattr(svc.anti_component, 'executable', lambda: 'fake-anticli.exe')
    monkeypatch.setattr(svc.child_job, 'spawn', spawn)
    monkeypatch.setattr(svc.child_job, 'forget', freed.append)
    headers = {'X-GA-Hub-Action': 'start-anti'}
    assert client.get('/api/anti/status').json()['state'] == 'stopped'
    assert client.post('/api/anti/start').status_code == 403
    assert client.post('/api/anti/start', headers={**headers, 'Origin': 'https://outside.example'}).status_code == 403
    assert not starts
    health = {'status': 'ok', 'version': 'test', 'agy_binary': None, 'active_count': 0}
    assert client.post('/api/anti/start', headers=headers).json()['agy_available'] is False
    assert not starts
    health = None
    for _ in range(2):
        assert client.post('/api/anti/start', headers=headers).json()['state'] == 'starting'
    assert starts == [['fake-anticli.exe', 'serve', '--host', '127.0.0.1', '--port', '18877']]
    health = {'status': 'ok', 'version': 'test', 'agy_binary': 'agy', 'active_count': 2}
    assert client.get('/api/anti/status').json() == {
        'state': 'ready', 'detail': None, 'agy_available': True, 'active_count': 2, 'auth_state': None,
    }
    health, process.code = None, 3
    assert '3' in client.get('/api/anti/status').json()['detail']
    assert freed == [process.pid]


def test_windows_port_probe_allows_time_for_connection_refusal(monkeypatch):
    monkeypatch.setattr(svc, 'sys', SimpleNamespace(platform='win32'))
    monkeypatch.setattr(svc.AntiAdapter, 'request', lambda *args, **kwargs: None)

    def closed(address, timeout):
        assert address == ('127.0.0.1', 18877)
        assert timeout == 3.0
        raise ConnectionRefusedError()

    monkeypatch.setattr(svc.socket, 'create_connection', closed)
    assert svc.AntiDaemon()._status(18877).state == 'stopped'


def test_missing_cli_and_occupied_port(monkeypatch):
    client = make_client(monkeypatch)
    monkeypatch.setattr(svc.AntiAdapter, 'request', lambda *args, **kwargs: {'status': 'ok'})
    monkeypatch.setattr(svc.anti_component, 'executable', lambda: None)
    headers = {'X-GA-Hub-Action': 'start-anti'}

    def closed(*args, **kwargs):
        raise ConnectionRefusedError()

    monkeypatch.setattr(svc.socket, 'create_connection', closed)
    response = client.post('/api/anti/start', headers=headers)
    assert response.status_code == 503
    assert 'PATH' in response.json()['detail']

    from contextlib import nullcontext
    monkeypatch.setattr(svc.socket, 'create_connection', lambda *args, **kwargs: nullcontext())
    response = client.post('/api/anti/start', headers=headers)
    assert response.json()['state'] == 'unavailable'
    assert '18877' in response.json()['detail']


def test_auth_status_requested_only_by_ui_and_unavailable_on_legacy_daemon(monkeypatch):
    client = make_client(monkeypatch)
    calls = []
    auth_state = "checking"

    def probe(self, method, path, **kwargs):
        calls.append((method, path))
        if path == "/health":
            return {"status": "ok", "version": "test", "agy_binary": "agy", "active_count": 0}
        assert kwargs["headers"] == {"X-AntiCLI-Action": "verify-auth"}
        if auth_state is None:
            raise svc.AntiError(404, "Not Found")
        return {"state": auth_state}

    monkeypatch.setattr(svc.AntiAdapter, "request", probe)
    headers = {"X-GA-Hub-Action": "verify-anti-auth"}
    for h in ({}, {**headers, "Origin": "https://outside.example"}):
        assert client.get("/api/anti/status", headers=h).json()["auth_state"] is None
    assert calls == [("GET", "/health")] * 2
    for reported, expected in (("checking", "checking"), ("authenticated", "authenticated"),
                               ("login_required", "login_required"), ("surprise", "unverified"),
                               (None, "unverified")):
        auth_state = reported
        data = client.get("/api/anti/status", headers=headers).json()
        assert data["state"] == "ready"
        assert data["auth_state"] == expected


def test_agy_profile_rename_preserves_identity_and_selection(tmp_path, monkeypatch):
    client = make_client(monkeypatch)
    monkeypatch.setattr(svc.anti_profiles._paths, 'ADMIN_DATA', tmp_path)
    url = '/api/anti/profiles'
    headers = {'X-GA-Hub-Action': 'manage-agy-profiles'}
    work = client.post(url, headers=headers, json={'name': 'Work'}).json()
    assert client.post(url, headers=headers, json={'name': 'Personal'}).status_code == 200
    svc.anti_profiles.select(work['id'])
    target = f"{url}/{work['id']}"
    body = {'name': '  Office  '}
    assert client.patch(target, json=body).status_code == 403
    assert client.patch(target, json=body, headers=headers | {'Origin': 'https://outside.example'}).status_code == 403
    assert client.patch(target, json={'name': 'personal'}, headers=headers).status_code == 409
    assert client.patch(f'{url}/default', json=body, headers=headers).status_code == 409
    assert client.patch(f'{url}/missing', json=body, headers=headers).status_code == 404
    assert client.patch(target, json={'name': ' '}, headers=headers).status_code == 422
    renamed = client.patch(target, json=body, headers=headers)
    assert renamed.status_code == 200
    assert renamed.json() == {'id': work['id'], 'name': 'Office'}
    settings = client.get(url).json()
    assert settings['active'] == work['id']
    assert renamed.json() in settings['profiles']


@pytest.mark.parametrize("failure", [None, "spawn", "exit", "rollback"])
def test_agy_profiles_switch_idle_managed_gateway(tmp_path, monkeypatch, failure):
    client = make_client(monkeypatch)
    daemon = anti.daemon
    monkeypatch.setattr(svc.anti_profiles._paths, 'ADMIN_DATA', tmp_path)
    monkeypatch.setattr(svc.anti_profiles, 'agy_executable', lambda: 'official-agy.exe')
    monkeypatch.setattr(svc.anti_component, 'executable', lambda: 'fake-anticli.exe')
    monkeypatch.setattr(svc.anti_component, 'child_options', lambda exe: {'env': {'HOME': 'original'}})
    status = svc.AntiDaemonStatus(state='ready', active_count=0)
    spawned = []
    stopped = []

    def spawn(command, **kwargs):
        nonlocal status
        spawned.append((command, kwargs))
        process = Process()
        if command[1:2] == ['serve']:
            if kwargs['env']['HOME'] != 'original' and failure == 'spawn':
                raise OSError('spawn failure')
            if kwargs['env']['HOME'] != 'original' and failure == 'exit':
                process.code = 1
            else:
                status = svc.AntiDaemonStatus(state='ready', active_count=0)
        return process

    def stop(pid):
        nonlocal status
        stopped.append(pid)
        if failure == 'rollback' and len(stopped) == 2:
            return False
        status = svc.AntiDaemonStatus(state='stopped')
        return True

    monkeypatch.setattr(daemon, '_status', lambda *args, **kwargs: status)
    monkeypatch.setattr(svc.child_job, 'spawn', spawn)
    monkeypatch.setattr(svc.child_job, 'terminate_tree', stop)
    monkeypatch.setattr(svc.child_job, 'forget', lambda pid: None)
    url = '/api/anti/profiles'
    headers = {'X-GA-Hub-Action': 'manage-agy-profiles'}
    assert client.post(url, json={'name': 'Work'}).status_code == 403
    assert client.post(url, json={'name': 'Work'}, headers=headers | {'Origin': 'https://outside.example'}).status_code == 403
    assert client.get(url).json()['active'] == 'default'
    profile = client.post(url, json={'name': ' Work '}, headers=headers).json()
    assert profile['name'] == 'Work'
    switch = f"{url}/{profile['id']}/switch"
    assert client.post(switch, headers=headers).status_code == 409  # external gateway
    daemon._process = Process()
    status = svc.AntiDaemonStatus(state='ready', active_count=1)
    assert client.post(switch, headers=headers).status_code == 409
    assert not stopped and not spawned
    if svc.os.name == 'nt':
        login = f"{url}/{profile['id']}/login"
        assert client.post(login, headers=headers).status_code == 204
        command, options = spawned.pop()
        assert command == ['official-agy.exe']
        assert options['env']['HOME'] == options['env']['USERPROFILE']
        assert client.post(switch, headers=headers).status_code == 409
        daemon._login.code = 0
    status = svc.AntiDaemonStatus(state='ready', active_count=0)
    if failure == 'rollback':
        def fail_save(*args):
            raise svc.AntiError(503, '无法保存 Agy 账号设置')

        monkeypatch.setattr(svc.anti_profiles, '_save', fail_save)
    response = client.post(switch, headers=headers)
    if failure == 'rollback':
        assert response.status_code == 503
        assert '原网关未能恢复' in response.json()['detail']
        assert client.get(url).json()['active'] == 'default'
        assert len(spawned) == 1 and len(stopped) == 2
        assert client.get('/api/anti/status').json()['state'] == 'unavailable'
        assert client.get('/api/anti/models').status_code == 503
        start = {'X-GA-Hub-Action': 'start-anti'}
        assert client.post('/api/anti/start', headers=start).json()['state'] == 'unavailable'

        # A healthy response from an orphaned listener must not lift the block.
        daemon._process.code = 0
        assert client.get('/api/anti/status').json()['state'] == 'unavailable'
        assert client.get('/api/anti/models').status_code == 503

        status = svc.AntiDaemonStatus(state='stopped')
        assert client.post('/api/anti/start', headers=start).json()['state'] == 'starting'
        assert spawned[-1][1]['env']['HOME'] == 'original'
        with daemon.submission() as current:
            assert current == 'default'
        return
    if failure:
        assert response.status_code == 503
        assert '已恢复原网关' in response.json()['detail']
        assert client.get(url).json()['active'] == 'default'
        assert client.get('/api/anti/status').json()['state'] == 'ready'
        assert stopped == [Process.pid]
        assert len(spawned) == 2
        assert spawned[-1][1]['env']['HOME'] == 'original'
        with daemon.submission() as current:
            assert current == 'default'
        return
    assert response.json()['active'] == profile['id']
    assert stopped == [Process.pid]
    command, options = spawned[-1]
    assert command[1:4] == ['serve', '--host', '127.0.0.1']
    assert options['env']['HOME'] == str(tmp_path / 'agy-profiles' / profile['id'] / 'home')
    assert options['env']['ANTICLI_AGY_PATH'] == 'official-agy.exe'
    with daemon.submission() as current:
        assert current == profile['id']
    status = svc.AntiDaemonStatus(state='ready', active_count=0)
    assert client.post(f'{url}/default/switch', headers=headers).json()['active'] == 'default'
    assert spawned[-1][1]['env']['HOME'] == 'original'


def test_panel_status_is_read_only_nonblocking_and_respects_switch_recovery(monkeypatch):
    daemon = svc.AntiDaemon()
    calls = []

    class FakeAdapter:
        def request(self, method, path, **kwargs):
            calls.append((method, path, kwargs))
            try:
                raise ConnectionRefusedError()
            except ConnectionRefusedError as exc:
                raise svc.AntiTransportError(503, 'offline') from exc

    monkeypatch.setattr(svc, 'sys', SimpleNamespace(platform='linux'))
    monkeypatch.setattr(svc, 'AntiAdapter', FakeAdapter)
    monkeypatch.setattr(svc.anti_component, 'executable', lambda: (_ for _ in ()).throw(AssertionError('must not probe executable')))

    assert daemon.panel_status() == svc.AntiDaemonStatus(state='stopped', detail=None)
    assert calls == [('GET', '/health', {'connect_timeout': 0.15, 'read_timeout': 0.3})]

    # Contended lock (e.g. during account switch) degrades immediately instead of blocking.
    assert daemon._lock.acquire(timeout=1)
    try:
        assert daemon.panel_status().state == 'starting'
    finally:
        daemon._lock.release()

    # Healthy gateway without agy binary surfaces detail, and never hits /v1/auth.
    class ReadyNoAgyAdapter:
        def request(self, method, path, **kwargs):
            assert path == '/health'
            return {'status': 'ok', 'version': '1.0', 'agy_binary': None, 'active_count': 2}

    monkeypatch.setattr(svc, 'AntiAdapter', ReadyNoAgyAdapter)
    daemon._failure = 'previous failure'
    assert daemon.panel_status() == svc.AntiDaemonStatus(
        state='ready', agy_available=False, active_count=2, detail='AntiCLI 已启动，但找不到官方 agy CLI',
    )
    assert daemon._failure == 'previous failure'
    assert daemon.status().state == 'ready'
    assert daemon._failure is None

    # Switch-recovery lock keeps lingering listener marked unavailable.
    daemon._switch_recovery_required = True
    assert daemon.panel_status() == svc.AntiDaemonStatus(state='unavailable', detail=svc._SWITCH_RECOVERY)


@pytest.mark.parametrize(('http_status', 'body'), [(503, b'{}'), (200, b'not json'), (200, b'{"status":"ok"}')])
@pytest.mark.parametrize('switch_recovery', [False, True])
def test_panel_unhealthy_listener_needs_attention(monkeypatch, http_status, body, switch_recovery):
    daemon = svc.AntiDaemon()
    daemon._switch_recovery_required = switch_recovery
    monkeypatch.setattr(svc, 'daemon', daemon)
    response = requests.Response()
    response.status_code = http_status
    response._content = body
    monkeypatch.setattr(requests.Session, 'request', lambda *a, **kw: response)

    status = daemon.panel_status()
    assert status.state == 'unavailable'
    if switch_recovery:
        assert status.detail == svc._SWITCH_RECOVERY
    else:
        assert '健康检查未通过' in status.detail
    item = ServiceRegistry._anti()
    assert (item.state, item.health) == ('error', 'attention')


@pytest.mark.parametrize('error', [requests.ConnectTimeout(), requests.ReadTimeout()])
def test_panel_does_not_treat_timeout_as_connection_refused(monkeypatch, error):
    def timeout(*args, **kwargs):
        raise error

    monkeypatch.setattr(requests.Session, 'request', timeout)
    status = svc.AntiDaemon().panel_status()
    assert status.state == 'unavailable'
    assert '无法确认' in status.detail


def test_panel_reports_closed_loopback_port_as_stopped(monkeypatch):
    with socket.socket() as bound:
        bound.bind(('127.0.0.1', 0))  # Keep the port reserved without listening.
        monkeypatch.setenv(ENV_ANTICLI_PORT, str(bound.getsockname()[1]))
        assert svc.AntiDaemon().panel_status() == svc.AntiDaemonStatus(state='stopped')


def test_panel_reports_managed_exit_without_cleaning_registration(monkeypatch):
    daemon = svc.AntiDaemon()
    process = Process()
    process.code = 17
    daemon._process = process
    daemon._failure = 'previous failure'
    forget = MagicMock()
    monkeypatch.setattr(svc.child_job, 'forget', forget)

    def closed_connection(*args, **kwargs):
        raise ConnectionRefusedError()

    monkeypatch.setattr(requests.Session, 'request', closed_connection)
    monkeypatch.setattr(svc.socket, 'create_connection', closed_connection)
    status = daemon.panel_status()
    assert status == svc.AntiDaemonStatus(state='stopped', detail='AntiCLI 已退出（退出码 17）')
    assert daemon._process is process
    assert daemon._failure == 'previous failure'
    forget.assert_not_called()
    assert daemon.status() == status
    assert daemon._process is None
    forget.assert_called_once_with(process.pid)
