"""Local daemon lifecycle without launching the production CLI."""
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.routes import anti
from server.services import anti_daemon as svc


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
