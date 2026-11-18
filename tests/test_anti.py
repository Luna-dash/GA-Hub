"""Behavioral tests for the project-scoped Anti HTTP adapter."""
import hashlib
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.routes import anti
from server.services import anti_engine as engine


class FakeDaemon:
    def __init__(self):
        self.calls = []
        self.status = {}
        self.settings = []

    def submit(self, run, workspace, conversation):
        self.calls.append((workspace, conversation))
        self.settings.append((run['model'], run['effort']))
        self.status[run['id']] = 'running'

    def request(self, method, path, **kwargs):
        if path == '/v1/models':
            assert method == 'GET'
            return [{'id': 'alternate', 'display_name': 'Alternative'}]
        _, _, _, rid, *suffix = path.split('/')
        if not suffix:
            return {'status': self.status[rid], 'conversation_id': 'c1'}
        if suffix == ['answer']:
            return {'answer': '完整结果'}
        if suffix == ['cancel']:
            assert method == 'POST'
            self.status[rid] = 'cancelled'
            return {'status': 'cancelled'}
        assert suffix == ['events?include_raw=true']
        return [
            {'seq': 1, 'event_type': 'init', 'raw_json': '{}'},
            {'seq': 2, 'event_type': 'step_update', 'raw_json': '{"step_update":{"text_delta":"好","tool_arguments":"hidden"}}'},
        ]


def test_project_scoped_anti_round_trip(tmp_path, monkeypatch):
    workspace = tmp_path / 'workspace'
    artifacts = tmp_path / 'project_artifacts' / 'project' / 'anti'
    daemon = FakeDaemon()
    db = tmp_path / 'anti.sqlite'
    monkeypatch.setattr(engine, 'project', lambda name: (workspace, artifacts))
    monkeypatch.setattr(anti, 'AntiSessions', lambda: engine.AntiSessions(db, daemon))
    app = FastAPI()
    app.include_router(anti.router)
    with TestClient(app) as client:
        assert client.get('/api/anti/models').json() == {'items': [
            {'id': 'alternate', 'display_name': 'Alternative'},
        ]}
        sessions = '/api/anti/sessions'
        session = client.post(sessions, json={'project': 'project'}).json()
        assert session['engine'] == 'anti'
        assert session['workspace'] == str(workspace)
        runs = f"{sessions}/{session['id']}/runs"
        body = {'operation': 'message1', 'prompt': 'check structure'}
        run = client.post(runs, json=body).json()
        path = f"{runs}/{run['id']}"
        assert client.post(runs, json=body).json()['id'] == run['id']
        assert client.post(runs, json=body | {'prompt': 'changed'}).status_code == 409
        assert client.post(runs, json=body | {'operation': 'message2'}).status_code == 409
        assert client.post(runs, json=body | {'model': 'alternate'}).status_code == 409
        assert client.post(runs, json=body | {'effort': 'low'}).status_code == 409
        assert client.post(runs, json=body | {'effort': 'invalid'}).status_code == 422
        assert daemon.calls == [(workspace, None)]
        assert daemon.settings == [(engine.DEFAULT_MODEL, 'high')]
        assert client.get(path + '/events').json() == [{'seq': 2, 'type': 'message.delta', 'text': '好'}]
        assert client.get(path + '/events?after=2').json() == []
        assert client.get(f"{sessions}/other/runs/{run['id']}").status_code == 404
        daemon.status[run['id']] = 'success'
        completed = client.get(path).json()
        data = (artifacts / f"{run['id']}.md").read_bytes()
        assert data.decode() == completed['answer'] == '完整结果'
        assert completed['sha256'] == hashlib.sha256(data).hexdigest()
        second = client.post(runs, json=body | {'operation': 'message2', 'model': 'alternate', 'effort': 'low'}).json()
        assert daemon.calls[-1] == (workspace, 'c1')
        assert daemon.settings[-1] == ('alternate', 'low')
        assert client.post(f"{runs}/{second['id']}/cancel").json()['status'] == 'cancelled'
        assert [r['status'] for r in client.get(runs).json()] == ['success', 'cancelled']


def test_model_catalog_is_available_without_daemon(tmp_path, monkeypatch):
    class StoppedDaemon:
        def request(self, method, path, **kwargs):
            assert (method, path) == ('GET', '/v1/models')
            raise engine.AntiError(503, 'unavailable')

    monkeypatch.setattr(engine.shutil, 'which', lambda name: 'anticli' if name == 'anticli' else None)

    def list_models(argv, **kwargs):
        assert argv == ['anticli', 'models', '--json']
        assert kwargs['check'] and kwargs['timeout'] > 0
        return SimpleNamespace(stdout='[{"id":"model-medium","display_name":"Model (Medium)"}]')

    monkeypatch.setattr(engine.subprocess, 'run', list_models)
    monkeypatch.setattr(anti, 'AntiSessions', lambda: engine.AntiSessions(tmp_path / 'anti.sqlite', StoppedDaemon()))
    app = FastAPI()
    app.include_router(anti.router)
    with TestClient(app) as client:
        response = client.get('/api/anti/models')
        assert response.status_code == 200
        assert response.json() == {'items': [{'id': 'model-medium', 'display_name': 'Model (Medium)'}]}
