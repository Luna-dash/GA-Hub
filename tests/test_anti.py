"""Behavioral tests for the project-scoped Anti HTTP adapter."""
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.routes import anti, upload
from server.services import anti_engine as engine
from server.services import file_transfer as transfer


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
    monkeypatch.setattr(transfer._paths, 'ADMIN_DATA', tmp_path / 'data')
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
        original_request = daemon.request
        trace_rows = [
            {'seq': 3, 'event_type': 'step_update', 'step_index': 0, 'step_type': 'user_input',
             'raw_json': '{"step_update":{"text_delta":"hidden prompt"}}'},
            {'seq': 4, 'event_type': 'step_update', 'step_index': 1, 'step_type': 'tool_call',
             'state': 'ACTIVE', 'tool_name': 'view_file', 'summary': 'hidden diagnostics',
             'raw_json': '{"step_update":{"text_delta":"hidden output","tool_arguments":"hidden path"}}'},
            {'seq': 5, 'event_type': 'step_update', 'step_index': 1, 'step_type': 'tool_call',
             'state': 'DONE', 'duration_seconds': 0.25},
            {'seq': 6, 'event_type': 'step_update',
             'raw_json': '{"step_update":{"step_index":2,"step_type":"planner_response","state":"DONE","text_delta":"先查看目录"}}'},
            {'seq': 7, 'event_type': 'step_update', 'step_index': 3, 'step_type': 'agent_response',
             'state': 'ACTIVE', 'raw_json': '{"step_update":{"text_delta":"正文"}}'},
            {'seq': 8, 'event_type': 'step_update', 'raw_json': 'invalid json'},
        ]

        def request_with_trace(method, remote_path, *args, **kwargs):
            response = original_request(method, remote_path, *args, **kwargs)
            return response + trace_rows if remote_path.endswith('/events?include_raw=true') else response

        monkeypatch.setattr(daemon, 'request', request_with_trace)
        trace = [
            {'seq': 4, 'type': 'step.update', 'step': {'index': 1, 'kind': 'tool_call', 'state': 'ACTIVE', 'tool': 'view_file'}},
            {'seq': 5, 'type': 'step.update', 'step': {'index': 1, 'kind': 'tool_call', 'state': 'DONE', 'duration_seconds': 0.25}},
            {'seq': 6, 'type': 'step.update', 'step': {'index': 2, 'kind': 'planner_response', 'state': 'DONE', 'text_delta': '先查看目录'}},
            {'seq': 7, 'type': 'message.delta', 'text': '正文', 'step': {'index': 3, 'kind': 'agent_response', 'state': 'ACTIVE'}},
        ]
        assert client.get(path + '/events?after=2').json() == trace
        assert client.get(path + '/events?after=4').json() == trace[1:]
        assert client.get(f"{sessions}/other/runs/{run['id']}").status_code == 404
        daemon.status[run['id']] = 'success'
        completed = client.get(path).json()
        assert completed['answer'] == '完整结果'
        assert completed['artifact'] is None and completed['sha256'] is None
        assert not artifacts.exists()
        second = client.post(runs, json=body | {'operation': 'message2', 'model': 'alternate', 'effort': 'low'}).json()
        assert daemon.calls[-1] == (workspace, 'c1')
        assert daemon.settings[-1] == ('alternate', 'low')
        assert client.post(f"{runs}/{second['id']}/cancel").json()['status'] == 'cancelled'
        assert [r['status'] for r in client.get(runs).json()] == ['success', 'cancelled']
        assert transfer.FileTransfer().list() == []


def test_anti_file_resolution_uses_session_workspace(tmp_path, monkeypatch):
    workspace = tmp_path / 'workspace'
    workspace.mkdir()
    citation = workspace / 'anti-citation.md'
    citation.touch()
    monkeypatch.setattr(engine._paths, 'ADMIN_DATA', tmp_path / 'data')
    monkeypatch.setattr(engine, 'project', lambda name: (workspace, tmp_path / 'artifacts'))
    session = engine.AntiSessions().create('project')
    app = FastAPI()
    app.include_router(upload.router)
    with TestClient(app) as client:
        body = {'engine': 'anti', 'session_id': session['id'], 'path': citation.name}
        resolved = client.post('/api/files/resolve', json=body)
        assert resolved.status_code == 200
        assert resolved.json()['resolved'] == str(citation.resolve())
        missing = client.post('/api/files/resolve', json=body | {'session_id': 'missing'})
        assert missing.status_code == 404
        assert missing.json()['detail'] == 'Anti session not found'


def test_model_catalog_is_available_without_daemon(tmp_path, monkeypatch):
    class StoppedDaemon:
        def request(self, method, path, **kwargs):
            assert (method, path) == ('GET', '/v1/models')
            raise engine.AntiError(503, 'unavailable')

    monkeypatch.setattr(engine.anti_component, 'executable', lambda: 'anticli')

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


def test_anti_session_management(tmp_path, monkeypatch):
    import sqlite3

    db = tmp_path / 'anti.sqlite'
    workspace = tmp_path / 'workspace'
    artifacts = tmp_path / 'artifacts'
    daemon = FakeDaemon()
    monkeypatch.setattr(engine, 'project', lambda name: (workspace / name, artifacts / name))
    monkeypatch.setattr(anti, 'AntiSessions', lambda: engine.AntiSessions(db, daemon))
    app = FastAPI()
    app.include_router(anti.router)
    with TestClient(app) as client:
        base = '/api/anti/sessions'
        first = client.post(base, json={'project': 'alpha'}).json()
        second = client.post(base, json={'project': 'beta'}).json()
        assert first['title'] == ''
        assert first['updated_at']
        assert first['active_run_id'] is None
        sid = first['id']
        path = f'{base}/{sid}'
        run = client.post(path + '/runs', json={'operation': 'one', 'prompt': ' A   first prompt '}).json()
        assert {item['project']: item['title'] for item in client.get(base).json()} == {
            'alpha': 'A first prompt', 'beta': '',
        }
        renamed = client.patch(path, json={'title': '  Renamed  '}).json()
        assert renamed['title'] == 'Renamed'
        assert renamed['active_run_id'] == run['id']
        assert client.patch(path, json={'title': '  '}).status_code == 422
        assert next(row for row in client.get(base).json() if row['id'] == sid)['active_run_id'] == run['id']
        assert client.delete(path).status_code == 409
        daemon.status[run['id']] = 'success'
        assert client.get(f"{path}/runs/{run['id']}").json()['status'] == 'success'
        assert client.patch(path, json={'title': 'Renamed'}).json()['active_run_id'] is None
        artifact = artifacts / 'alpha' / f"{run['id']}.md"
        assert not artifact.exists()
        artifact.parent.mkdir(parents=True)
        artifact.write_text('legacy reply', encoding='utf8')
        another = client.post(path + '/runs', json={'operation': 'two', 'prompt': 'More'}).json()
        assert {item['id']: item['title'] for item in client.get(base).json()}[sid] == 'Renamed'
        daemon.status[another['id']] = 'cancelled'
        client.get(f"{path}/runs/{another['id']}").raise_for_status()
        assert client.delete(path).status_code == 204
        assert client.get(path + '/runs').status_code == 404
        assert client.delete(path).status_code == 404
        assert client.get(base).json() == [second]
        assert artifact.read_text(encoding='utf8') == 'legacy reply'
    with sqlite3.connect(db) as conn:
        assert conn.execute('SELECT count(*) FROM runs WHERE session_id=?', (sid,)).fetchone()[0] == 0


def test_legacy_anti_sessions_get_first_prompt_title(tmp_path):
    import sqlite3

    db = tmp_path / 'legacy.sqlite'
    with sqlite3.connect(db) as conn:
        conn.executescript("""
            CREATE TABLE sessions (id TEXT PRIMARY KEY, project TEXT, workspace TEXT, title TEXT, conversation_id TEXT);
            CREATE TABLE runs (id TEXT PRIMARY KEY, session_id TEXT, prompt TEXT, model TEXT, effort TEXT, status TEXT);
            INSERT INTO sessions VALUES ('one', 'p', '/p', 'Anti', NULL),
                                        ('two', 'p', '/p', 'Anti', NULL),
                                        ('three', 'p', '/p', 'Custom', NULL);
            INSERT INTO runs VALUES ('r', 'one', 'Read the   workspace', 'm', 'high', 'completed');
        """)
    sessions = engine.AntiSessions(db)
    for _ in range(2):
        assert {row['id']: row['title'] for row in sessions.list()} == {
            'one': 'Read the workspace', 'two': '', 'three': 'Custom',
        }
        historical, = sessions.history('one')
        assert (historical['status'], historical['model'], historical['effort']) == ('completed', 'm', 'high')
        assert historical['error_detail'] is None



def test_selected_references(tmp_path, monkeypatch):
    workspace = tmp_path / 'project'; workspace.mkdir()
    artifacts = tmp_path / 'artifacts'
    local = workspace / '项目笔记.txt'; local.write_text('inside', encoding='utf-8')
    external = tmp_path / '外部笔记.txt'; external.write_text('outside', encoding='utf-8')
    (tmp_path / 'not-selected.txt').write_text('not selected', encoding='utf-8')
    monkeypatch.setattr(transfer._paths, 'ADMIN_DATA', tmp_path / 'data')
    monkeypatch.setattr(engine, 'project', lambda name: (workspace.resolve(), artifacts.resolve()))
    indexed = transfer.FileTransfer()
    for file in (local, external):
        indexed.add(str(file), "chat", "s", None)
    posted = []
    adapter = engine.AntiAdapter()
    monkeypatch.setattr(adapter, 'request', lambda method, path, **kw: posted.append((method,path,kw['json'])))
    monkeypatch.setattr(anti, 'AntiSessions', lambda: engine.AntiSessions(tmp_path / 'anti.sqlite', adapter))
    app = FastAPI(); app.include_router(anti.router)
    with TestClient(app) as client:
        base = '/api/anti/sessions'
        sid = client.post(base, json={'project': 'project'}).json()['id']
        url = f'{base}/{sid}/runs'
        body = {'operation': 'attachment-test', 'prompt': 'read files',
                'references': [{'id': 1, 'path': str(local)}, {'id': 2, 'path': str(external)}]}
        bad = body | {'references': [{'id': 2, 'path': str(local)}]}
        assert client.post(url, json=bad).status_code == 422
        assert not posted and not artifacts.exists()
        response = client.post(url, json=body)
        assert response.status_code == 200, response.text
        run = response.json()
        assert run['prompt'] == 'read files'
        staging = artifacts / 'references' / run['id']
        copy, = staging.iterdir()
        assert copy.read_text(encoding='utf-8') == 'outside'
        method, path, payload = posted[0]
        assert method == 'POST' and path == '/v1/runs?async_mode=true'
        assert payload['mode'] == 'plan' and payload['add_dirs'] == [str(staging)]
        assert local.as_posix() in payload['prompt'] and copy.as_posix() in payload['prompt']
        assert external.as_posix() not in payload['prompt']
        external.unlink()
        assert client.post(url, json=body).json()['id'] == run['id']
        assert client.post(url, json=body | {'references': []}).status_code == 409
        assert len(posted) == 1



def test_anti_adapter_only_passes_effort_for_plain_model(tmp_path, monkeypatch):
    sent = []
    adapter = engine.AntiAdapter()
    monkeypatch.setattr(adapter, 'request', lambda method, path, **kw: sent.append(kw['json']))
    for model in ('gemini-4-hydrogen-high', 'alternate-XHIGH', 'alternate'):
        adapter.submit({'id': 'run', 'prompt': 'test', 'model': model, 'effort': 'high'}, tmp_path, None)
    assert [payload['model'] for payload in sent] == ['gemini-4-hydrogen-high', 'alternate-XHIGH', 'alternate']
    assert all('effort' not in payload for payload in sent[:2])
    assert sent[2]['effort'] == 'high'


def test_anti_safe_error_details_persist_in_history(tmp_path, monkeypatch):
    daemon = FakeDaemon()
    monkeypatch.setattr(engine, 'project', lambda name: (tmp_path, tmp_path / 'artifacts'))
    sessions = engine.AntiSessions(tmp_path / 'anti.sqlite', daemon)
    sid = sessions.create('demo')['id']
    raw_marker = 'do-not-expose-raw-cli-context'
    cases = [
        ('AUTH_ERROR', raw_marker, '请先使用官方 Antigravity CLI 登录，再重试。'),
        ('CLI_ERROR', 'invalid model selection: --effort is not supported for model ' + raw_marker,
         '此模型不支持单独传入思考档位，请尝试选择其他模型或档位。'),
        ('CLI_ERROR', raw_marker, None),
    ]
    for i, (code, upstream, expected) in enumerate(cases):
        rid = sessions.submit(sid, f'op{i}', 'hello')['id']
        remote = {'status': 'cli_error', 'error_code': code, 'error_message': upstream}
        monkeypatch.setattr(daemon, 'request', lambda *args: remote)
        run = sessions.refresh(sid, rid)
        assert run['error'] == code
        assert run['error_detail'] == expected
        assert raw_marker not in str(run)
        assert engine.AntiSessions(sessions.db, daemon).history(sid)[-1] == run


def test_conversation_resume_is_per_agy_profile(tmp_path, monkeypatch):
    monkeypatch.setattr(engine, 'project', lambda name: (tmp_path, tmp_path / 'artifacts'))
    daemon = FakeDaemon()
    request = daemon.request

    def remote(method, path, **kwargs):
        result = request(method, path, **kwargs)
        if 'conversation_id' in result:
            result['conversation_id'] = path.rsplit('/', 1)[1]
        return result

    daemon.request = remote
    sessions = engine.AntiSessions(tmp_path / 'anti.sqlite', daemon)
    sid = sessions.create('project')['id']
    resumes = {}
    for index, profile in enumerate(('default', 'alpha', 'beta', 'alpha', 'default', 'beta')):
        run = sessions.submit(sid, f'op{index}', 'hello', profile_id=profile)
        assert daemon.calls[-1][1] == resumes.get(profile)
        daemon.status[run['id']] = 'success'
        assert sessions.refresh(sid, run['id'])['status'] == 'success'
        resumes[profile] = run['id']


def test_events_stream_sse_proxy(tmp_path, monkeypatch):
    monkeypatch.setattr(engine, 'project', lambda name: (tmp_path, tmp_path / 'artifacts'))
    daemon = FakeDaemon()
    sessions = engine.AntiSessions(tmp_path / 'anti.sqlite', daemon)
    sid = sessions.create('project')['id']
    run = sessions.submit(sid, 'sse-op', 'stream me')

    class FakeSseResp:
        status_code = 200

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def iter_lines(self, decode_unicode=True):
            yield 'data: {"seq": 1, "event_type": "step_update", "step_type": "agent_response", "raw_json": "{\\"step_update\\": {\\"text_delta\\": \\"hello sse\\"}}"}'

    monkeypatch.setattr(engine.requests.Session, 'get', lambda *a, **kw: FakeSseResp())
    monkeypatch.setattr(anti, 'AntiSessions', lambda: sessions)
    app = FastAPI()
    app.include_router(anti.router)
    client = TestClient(app)

    resp = client.get(f'/api/anti/sessions/{sid}/runs/{run["id"]}/events/stream')
    assert resp.status_code == 200
    assert 'text/event-stream' in resp.headers['content-type']
    assert 'hello sse' in resp.text
