"""Real Nova server -> connector -> loopback HTTP and live WebSocket."""
import asyncio
import contextlib
import importlib.util
import json
import os
import secrets
import sys
import tempfile
import unittest
import uuid
from aiohttp import FormData
from pathlib import Path
from unittest.mock import patch
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from server.routes.nova import NovaAccountRequest, build_nova_router
from server.services.nova_service import NovaService, NovaServiceError
connector_path = str(ROOT / 'assets/nova')
sys.path.insert(0, connector_path)
import connector
sys.path.remove(connector_path)
# Set NOVA_CLOUD_ROOT when the private cloud repo is not a sibling checkout.
cloud_root = Path(os.environ.get('NOVA_CLOUD_ROOT', str(ROOT.parent / 'GA-Hub-Nova-Cloud')))
cloud = None
if (cloud_root / 'server.py').is_file():
    spec = importlib.util.spec_from_file_location('nova_cloud_e2e', cloud_root / 'server.py')
    cloud = importlib.util.module_from_spec(spec)
    # Cloud-local modules (for example snapshots.py) are not installed packages.
    sys.path.insert(0, str(cloud_root))
    try:
        spec.loader.exec_module(cloud)
    finally:
        sys.path.remove(str(cloud_root))


@unittest.skipIf(cloud is None, 'Nova cloud checkout required; set NOVA_CLOUD_ROOT')
class ConnectorE2E(unittest.IsolatedAsyncioTestCase):
    async def test_real_http_live_and_disconnect(self):
        async def sessions(r):
            return web.json_response({'items': [{'id':'s1','title':'E2E'}]})
        async def live(r):
            self.assertEqual(r.query.get('view'), 'compact')
            ws = web.WebSocketResponse();await ws.prepare(r)
            await ws.send_json({'type':'progress','session_id':'s1','presentation_version':1,
                                'items':[], 'runtime':{'status':'running'}})
            async for _ in ws: pass
            return ws
        history_etag = 'W/"hub-history-' + 'a' * 64 + '"'
        history_validators = []

        async def messages(r):
            self.assertEqual(r.query.get('view'), 'compact')
            validator = r.headers.get('If-None-Match')
            plain = r.query.get('limit') == '4'
            if plain:
                history_validators.append(validator)
                if validator == history_etag:
                    return web.Response(status=304, headers={'ETag': history_etag})
            body = 'Plain history' if plain else f'[report](<{report.as_posix()}:7>)'
            etag = history_etag if plain else 'W/"hub-history-' + 'b' * 64 + '"'
            return web.json_response({'presentation_version':1,'session_id':'s1','items':[{'role':'assistant','compact':True,'progress':{'final_body':body}}]}, headers={'ETag': etag})
        app = web.Application();app.router.add_get('/api/sessions',sessions);app.router.add_get('/ws/sessions/s1',live)
        app.router.add_get('/api/sessions/s1/messages', messages)
        async def projects(_r):
            return web.json_response({'items': [{'name': 'test', 'path': str(report.parent), 'dangling': False}]})
        app.router.add_get('/api/projects', projects)
        chat_runs = []
        async def submit_chat(r):
            body = await r.json()
            chat_runs.append(body)
            return web.json_response({'run_id': 'c-run-1', 'accepted': True})
        app.router.add_post('/api/sessions/s1/runs', submit_chat)
        agy_session = {'id': 'a1', 'title': 'Agy', 'project': 'test'}
        agy_runs = []
        approval = {"id": "a" * 32, "title": "Edit note", "details": "note.txt"}
        daemon = {'state': 'stopped', 'managed': None, 'active_count': None}
        daemon_calls = []

        async def anti(r):
            resource = r.match_info['resource']
            if resource in {'status', 'start', 'stop'}:
                daemon_calls.append(resource)
                self.assertEqual(r.headers['Origin'], str(backend.make_url('/')).rstrip('/'))
                if resource == 'status':
                    self.assertEqual(r.method, 'GET')
                    self.assertNotIn('X-GA-Hub-Action', r.headers)
                else:
                    self.assertEqual(r.method, 'POST')
                    self.assertEqual(r.headers['X-GA-Hub-Action'], resource + '-anti')
                    self.assertFalse(await r.read())
                if resource == 'start':
                    daemon.update(state='ready', managed=True, active_count=0)
                if resource == 'stop':
                    if not daemon['managed'] or daemon['active_count']:
                        return web.json_response({'detail': 'local-only diagnostic'}, status=409)
                    daemon.update(state='stopped', managed=None, active_count=None)
                return web.json_response({**daemon, 'port': 54321, 'detail': 'local-only diagnostic'})
            if resource == 'models':
                return web.json_response({'items': [{'id': 'model-1', 'display_name': 'Model 1'}]})
            if resource == 'sessions' and r.method == 'POST':
                created_body = await r.json()
                return web.json_response({'id': 'a2', 'title': 'Agy Created', 'project': created_body['project']})
            if resource == 'sessions':
                return web.json_response([agy_session] if agy_session else [])
            if resource == 'sessions/a1' and r.method == 'PATCH':
                agy_session.update(await r.json())
                return web.json_response(agy_session)
            if resource == 'sessions/a1/reset' and r.method == 'POST':
                agy_session.update(acp_connected=False, has_conversation=True)
                return web.json_response(agy_session)
            if resource == 'sessions/a1' and r.method == 'DELETE':
                agy_session.clear()
                return web.Response(status=204)
            if resource == 'profiles' and r.method == 'GET':
                return web.json_response({
                    'active': 'p1',
                    'profiles': [{'id': 'p1', 'name': 'Work', 'has_credentials': True,
                                  'auth_state': 'authenticated', 'cooldown_seconds': 30,
                                  'usage': {'checked_at': '2026-11-23T00:00:00Z', 'min_remaining_pct': 65.0, 'rows': []}}],
                })
            if resource == 'quota' and r.method == 'GET':
                return web.json_response([{'model_group': 'gemini-4', 'display_name': 'Gemini 4',
                                           'status': 'normal', 'cooldown_remaining_seconds': 0}])
            if resource == 'sessions/a1/runs' and r.method == 'POST':
                body = await r.json()
                self.assertEqual((body['model'], body['effort']), ('model-1', 'high'))
                self.assertEqual(body['attachments'], [{'path': str(report), 'name': 'note.txt',
                                                        'size': 4, 'source': 'managed_upload'}])
                self.assertEqual(body['mode'], 'accept-edits')
                self.assertEqual(body.get('permission_mode'), 'auto-accept-edits')
                run = {'id': 'run-1', 'status': 'running', 'prompt': body['prompt'],
                       'mode': body['mode'], 'permission_mode': body['permission_mode'], 'approval': approval}
                agy_runs.append(run)
                return web.json_response(run)
            if resource == 'sessions/a1/runs/run-1':
                return web.json_response(agy_runs[0])
            if resource == 'sessions/a1/runs/run-1/events':
                return web.json_response([{'seq': 1, 'type': 'step.update',
                                           'step': {'index': 0, 'kind': 'tool_call', 'tool': 'read_file', 'state': 'DONE'}},
                                          {'seq': 2, 'type': 'message.delta', 'text': 'hi'}])
            if resource == 'sessions/a1/runs/run-1/events/stream':
                resp = web.StreamResponse(status=200, headers={'Content-Type': 'text/event-stream'})
                await resp.prepare(r)
                await resp.write(b'event: step.update\ndata: {"seq": 3, "type": "step.update", "step": {"index": 1, "kind": "tool_call", "tool": "grep", "state": "DONE", "cwd": "C:/secret"}}\n\n')
                await resp.write(b'event: message.delta\ndata: {"seq": 4, "type": "message.delta", "text": "streamed"}\n\n')
                await resp.write_eof()
                return resp
            if resource == 'sessions/a1/runs/run-1/approval':
                self.assertEqual(r.method, 'POST')
                self.assertEqual(r.headers['Origin'], str(backend.make_url('/')).rstrip('/'))
                self.assertEqual(r.headers['X-GA-Hub-Action'], 'approve-agy')
                payload = await r.json()
                self.assertEqual(payload, {'approval_id': approval['id'], 'decision': 'allow_always', 'option_id': 'opt-1'})
                run = agy_runs[0]
                if run.pop('approval', None) is None:
                    return web.json_response({'detail': 'stale'}, status=409)
                run.update(status='success', answer='done')
                return web.json_response(run)
            if resource == 'sessions/a1/runs':
                return web.json_response(agy_runs)
            raise web.HTTPNotFound()

        async def upload(r):
            part = await (await r.multipart()).next()
            content = await part.read()
            if part.filename == 'note.txt':
                self.assertEqual(content, b'note')
                return web.json_response({'path': str(report), 'name': part.filename, 'size': 4})
            big_path = report.parent / part.filename
            big_path.write_bytes(content)
            return web.json_response({'path': str(big_path), 'name': part.filename, 'size': len(content)})

        app.router.add_route('*', '/api/anti/{resource:.*}', anti)
        app.router.add_post('/api/upload', upload)
        backend = TestServer(app);await backend.start_server()
        with tempfile.TemporaryDirectory() as tmp:
            report = Path(tmp) / '验收 report.txt'
            report.write_bytes(b'relay artifact verified')
            large_file = Path(tmp) / 'big.bin.txt'
            large_payload = (b'0123456789abcdef' * (128 * 1024))  # 2 MiB
            large_file.write_bytes(large_payload)
            nova = cloud.Nova(Path(tmp)/'e2e.db')
            client = TestClient(TestServer(nova.app()));await client.start_server()
            task = None
            try:
                r=await client.post('/register',data={'name':'e2e','password':secrets.token_urlsafe(24),'invite':nova.store.invite()},headers={'Origin':nova.public},allow_redirects=False)
                self.assertEqual(r.status,303)
                auth={'Origin':nova.public,'Cookie':cloud.COOKIE+'='+r.cookies[cloud.COOKIE].value}
                pair=await (await client.post('/v1/agent/pair/start',json={'name':'E2E'})).json()
                r=await client.post('/v1/pair/approve',json={'code':pair['code']},headers=auth);self.assertEqual(r.status,200)
                token=secrets.token_urlsafe(32);device='e'*24
                r=await client.post('/v1/agent/pair/finish',json={**pair,'token':token,'device_id':device});self.assertEqual(r.status,200)
                connection_states = []
                with patch.object(connector, 'ARTIFACT_ROOTS', (Path(tmp),)):
                    task = asyncio.create_task(connector.connect_once(
                        str(client.make_url('')).rstrip('/'), device, token,
                        str(backend.make_url('')).rstrip('/'), on_connection=connection_states.append,
                    ))
                    for _ in range(100):
                        if device in nova.devices and nova.devices[device].ready:break
                        if task.done():await task
                        await asyncio.sleep(.05)
                    self.assertTrue(nova.devices[device].ready)
                    self.assertEqual(connection_states, [True])
                    me_info = await (await client.get('/v1/me', headers=auth)).json()
                    self.assertEqual(me_info['devices'][0]['protocol'], 2)
                    self.assertIn('credit_flow', me_info['devices'][0]['capabilities'])
                    self.assertIn('agy_stream', me_info['devices'][0]['capabilities'])
                    r=await client.get('/d/'+device+'/api/sessions',headers=auth)
                    self.assertEqual(r.status,200);self.assertEqual((await r.json())['items'][0]['title'],'E2E')
                    history = '/d/'+device+'/api/sessions/s1/messages?view=compact&limit=4'
                    r = await client.get(history, headers=auth)
                    self.assertEqual(r.status, 200)
                    self.assertEqual(r.headers.get('ETag'), history_etag)
                    self.assertEqual((await r.json())['items'][0]['progress']['final_body'], 'Plain history')
                    r = await client.get(history, headers={**auth, 'If-None-Match': history_etag})
                    self.assertEqual(r.status, 304, await r.text())
                    self.assertEqual(r.headers.get('ETag'), history_etag)
                    self.assertEqual(await r.read(), b'')
                    self.assertEqual(history_validators, [None, history_etag])
                    r = await client.get(history[:-1] + '40', headers=auth)
                    self.assertEqual(r.status, 200)
                    self.assertFalse(r.headers.get('ETag', '').startswith('W/"hub-history-'))
                    files = (await r.json())['items'][0]['artifacts']
                    self.assertEqual(files[0]['name'], report.name)
                    r = await client.get('/d/'+device+files[0]['url'], headers=auth)
                    self.assertEqual(r.status, 200)
                    self.assertEqual(await r.read(), report.read_bytes())
                    self.assertIn('attachment;', r.headers['Content-Disposition'])
                    ws=await client.ws_connect('/d/'+device+'/api/sessions/s1/live',headers=auth)
                    msg=await ws.receive_json(timeout=10);self.assertEqual(msg['runtime']['status'],'running')
                    await ws.send_json({'type':'ping'});self.assertEqual((await ws.receive_json(timeout=5))['type'],'pong')
                    await ws.close()
                    api = '/d/' + device + '/api'
                    agy = api + '/agy'
                    lifecycle = agy + '/daemon'
                    r = await client.get(lifecycle, headers=auth)
                    self.assertEqual(r.status, 200, await r.text())
                    self.assertEqual(await r.json(), daemon)
                    r = await client.post(lifecycle + '/start', headers={**auth, 'Origin': 'https://example.invalid'})
                    self.assertEqual(r.status, 403)
                    r = await client.post(lifecycle + '/start', headers=auth, json={'profile': 'other'})
                    self.assertEqual(r.status, 400)
                    self.assertEqual(daemon_calls, ['status'])
                    r = await client.post(lifecycle + '/start', headers=auth)
                    self.assertEqual(r.status, 200, await r.text())
                    self.assertEqual(await r.json(), {'state':'ready', 'managed':True, 'active_count':0})
                    for managed, count in [(False, 0), (True, 1)]:
                        daemon.update(managed=managed, active_count=count)
                        r = await client.post(lifecycle + '/stop', headers=auth)
                        self.assertEqual(r.status, 409, await r.text())
                        self.assertNotIn('local-only diagnostic', await r.text())
                    daemon.update(managed=True, active_count=0)
                    r = await client.post(lifecycle + '/stop', headers=auth)
                    self.assertEqual(r.status, 200, await r.text())
                    self.assertEqual((await r.json())['state'], 'stopped')
                    self.assertEqual(daemon_calls, ['status', 'start', 'stop', 'stop', 'stop'])
                    r = await client.get(agy + '/models', headers=auth)
                    self.assertEqual(r.status, 200, await r.text())
                    self.assertEqual((await r.json())['items'][0]['id'], 'model-1')
                    r = await client.get(agy + '/projects', headers=auth)
                    self.assertEqual(r.status, 200, await r.text())
                    agy_pid = (await r.json())['items'][0]['id']
                    r = await client.post(agy + '/sessions', json={'project_id': agy_pid, 'request_id': str(uuid.uuid4())}, headers=auth)
                    self.assertEqual(r.status, 200, await r.text())
                    self.assertEqual(await r.json(), {'id': 'a2'})
                    r = await client.post(api + '/sessions/s1/runs', json={'text': 'Chat after Agy create', 'request_id': str(uuid.uuid4())}, headers=auth)
                    self.assertEqual(r.status, 200, await r.text())
                    self.assertEqual(chat_runs[-1]['text'], 'Chat after Agy create')
                    r = await client.patch(agy + '/sessions/a1', json={'title': 'Renamed'}, headers=auth)
                    self.assertEqual(r.status, 200, await r.text())
                    form = FormData()
                    form.add_field('file', b'note', filename='note.txt')
                    r = await client.post(agy + '/sessions/a1/upload', data=form, headers=auth)
                    self.assertEqual(r.status, 200, await r.text())
                    body = {'text': 'Summarize', 'request_id': str(uuid.uuid4()),
                            'upload_ids': [(await r.json())['upload_id']], 'model': 'model-1', 'effort': 'high',
                            'mode': 'accept-edits', 'permission_mode': 'auto-accept-edits'}
                    r = await client.post(agy + '/sessions/other/runs', json=body, headers=auth)
                    self.assertEqual(r.status, 400, await r.text())
                    r = await client.post(agy + '/sessions/a1/runs', json=body, headers=auth)
                    self.assertEqual(r.status, 200, await r.text())
                    run_path = agy + '/sessions/a1/runs/run-1'
                    r = await client.get(run_path, headers=auth)
                    self.assertEqual((await r.json())['approval'], approval)
                    r = await client.get(run_path + '/events?after=0', headers=auth)
                    self.assertEqual(r.status, 200, await r.text())
                    evts = await r.json()
                    self.assertEqual(evts[0]['step']['tool'], 'read_file')
                    r = await client.get(agy + '/sessions/a1/runs', headers=auth)
                    self.assertNotIn('approval', (await r.json())[0])
                    decision = {'approval_id': approval['id'], 'decision': 'allow_always', 'option_id': 'opt-1'}
                    r = await client.post(run_path + '/approval', json={**decision, 'decision': 'bogus'}, headers=auth)
                    self.assertEqual(r.status, 400, await r.text())
                    r = await client.post(run_path + '/approval', json=decision, headers=auth)
                    self.assertEqual((await r.json())['status'], 'success')
                    r = await client.post(run_path + '/approval', json=decision, headers=auth)
                    self.assertEqual(r.status, 409, await r.text())
                    r = await client.post(agy + '/sessions/a1/reset', headers=auth)
                    self.assertEqual(r.status, 200, await r.text())
                    self.assertTrue((await r.json())['has_conversation'])
                    r = await client.get(agy + '/profiles', headers=auth)
                    self.assertEqual(r.status, 200, await r.text())
                    self.assertEqual((await r.json())['profiles'][0]['cooldown_seconds'], 30)
                    r = await client.get(agy + '/quota', headers=auth)
                    self.assertEqual(r.status, 200, await r.text())
                    self.assertEqual((await r.json())[0]['model_group'], 'gemini-4')
                    history = '/api/agy/sessions/a1/runs?view=compact&limit=40'
                    for path in ('/api/agy/sessions', history):
                        r = await client.get('/d/' + device + path, headers=auth)
                        self.assertEqual(r.status, 200, await r.text())

                    # Protocol v2 Agy SSE live stream over WS
                    agy_ws = await client.ws_connect('/d/' + device + '/api/agy/sessions/a1/runs/run-1/live?after=0', headers=auth)
                    ev1 = await agy_ws.receive_json(timeout=5)
                    self.assertEqual(ev1['step'], {'index': 1, 'kind': 'tool_call', 'tool': 'grep', 'state': 'DONE'})
                    ev2 = await agy_ws.receive_json(timeout=5)
                    self.assertEqual(ev2['text'], 'streamed')
                    await agy_ws.close()

                    # Protocol v2 streaming upload (> 256 KiB) and early-rejection wakeup (> 8 * 64 KiB credits)
                    big_upload = b'U' * (300 * 1024)
                    uform = FormData()
                    uform.add_field('file', big_upload, filename='streamed.txt')
                    ur = await client.post(api + '/upload', data=uform, headers=auth)
                    self.assertEqual(ur.status, 200, await ur.text())
                    self.assertEqual((await ur.json())['size'], len(big_upload))

                    bad_form = FormData()
                    bad_form.add_field('file', b'X' * (700 * 1024), filename='bad.exe')
                    bad_resp = await asyncio.wait_for(client.post(api + '/upload', data=bad_form, headers=auth), timeout=5)
                    self.assertEqual(bad_resp.status, 415)

                    # Register artifact token via chat messages path containing large_file
                    original_bytes = report.read_bytes()
                    report.write_bytes(large_payload)
                    try:
                        ref_page = await (await client.get('/d/' + device + '/api/sessions/s1/messages?view=compact&limit=40', headers=auth)).json()
                        big_url = ref_page['items'][0]['artifacts'][0]['url']
                        async with client.get('/d/' + device + big_url, headers=auth) as dr:
                            self.assertEqual(dr.status, 200)
                            received = bytearray()
                            # Concurrent request mid-stream proves no HOL/disconnect
                            concurrent = asyncio.create_task(client.get('/d/' + device + '/api/sessions', headers=auth))
                            while True:
                                chunk = await dr.content.read(32 * 1024)
                                if not chunk:
                                    break
                                received.extend(chunk)
                                await asyncio.sleep(0.002)
                            cr = await concurrent
                            self.assertEqual(cr.status, 200)
                            self.assertEqual(bytes(received), large_payload)
                        self.assertTrue(nova.devices[device].ready)
                    finally:
                        report.write_bytes(original_bytes)

                    task.cancel();await asyncio.gather(task,return_exceptions=True)
                    self.assertEqual(connection_states, [True, False])
                    for _ in range(30):
                        if device not in nova.devices:break
                        await asyncio.sleep(.05)
                    r=await client.get('/v1/me',headers=auth)
                    self.assertFalse((await r.json())['devices'][0]['online'])
                    r = await client.get(api + '/nova-snapshot', params={'path': history}, headers=auth)
                    self.assertEqual((await r.json())['data']['items'][0]['answer'], 'done')
                    r = await client.get(api + '/nova-snapshot', params={'path': '/api/agy/sessions'}, headers=auth)
                    self.assertEqual((await r.json())['data'][0]['title'], 'Renamed')
            finally:
                if task:task.cancel();await asyncio.gather(task,return_exceptions=True)
                await client.close()
                await backend.close()


@unittest.skipIf(cloud is None, 'Nova cloud checkout required')
class SettingsAccountE2E(unittest.IsolatedAsyncioTestCase):
    async def test_register_associate_revoke_and_retry(self):
        import aiohttp
        from types import SimpleNamespace
        from unittest.mock import Mock, AsyncMock
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            nova = cloud.Nova(root/'cloud.sqlite', 'http://localhost')
            app = web.Application(); app.router.add_route('*', '/{tail:.*}', nova.handle)
            server = TestServer(app, host='localhost'); await server.start_server()
            public = str(server.make_url('')).rstrip('/')
            nova.public = public
            original_session = aiohttp.ClientSession
            def session(**kwargs):
                # Production uses HTTPS secure cookies; this isolated server uses HTTP.
                return original_session(cookie_jar=aiohttp.CookieJar(unsafe=True, treat_as_secure_origin=[public]), **kwargs)
            component = NovaService()
            state = root/'state'; state.mkdir()
            def save(server, device, name, token):
                (state/'device.json').write_text(json.dumps({'server':server,'device':device,'name':name}))
            delete = Mock()
            component.connector = SimpleNamespace(STATE=state, identity=lambda:'c'*24,
                aiohttp=aiohttp, save_pair=save, credential_target=lambda s:'test-target',
                win32cred=SimpleNamespace(CredDelete=delete))
            component.start = AsyncMock(); component.stop = AsyncMock()
            account = dict(username='settingsuser', password='settings-password', confirm=True)
            def call(req: NovaAccountRequest, *, unlink=False):
                return component.account_action(
                    username=req.username,
                    password=req.password.get_secret_value(),
                    name=req.name,
                    invite=req.invite.get_secret_value() if req.invite else None,
                    confirm=req.confirm,
                    unlink=unlink,
                )
            try:
                with patch('server.services.nova_service.PUBLIC', public), patch.object(aiohttp, 'ClientSession', session):
                    invite = nova.store.invite()
                    result = await call(NovaAccountRequest(**account, invite=invite))
                    self.assertTrue(result['paired']); self.assertEqual(result['device'], 'c'*24)
                    self.assertEqual(nova.store.one('SELECT count(*) AS n FROM sessions')['n'], 0)
                    with self.assertRaises(NovaServiceError) as conflict:
                        await call(NovaAccountRequest(**account))
                    self.assertEqual(conflict.exception.status,409)
                    delete.side_effect = OSError('simulated credential failure')
                    with self.assertRaises(NovaServiceError):
                        await call(NovaAccountRequest(**account), unlink=True)
                    self.assertTrue((state/'device.json').exists())
                    self.assertEqual(nova.store.one('SELECT revoked FROM devices')['revoked'], 1)
                    delete.side_effect = None
                    result = await call(NovaAccountRequest(**account), unlink=True)
                    self.assertFalse(result['paired']); self.assertEqual(result['device'], 'c'*24)
                    self.assertEqual(nova.store.one('SELECT count(*) AS n FROM sessions')['n'], 0)
                    result = await call(NovaAccountRequest(**account))
                    self.assertTrue(result['paired'])
                    self.assertEqual(nova.store.one('SELECT revoked FROM devices')['revoked'], 0)
            finally:
                await server.close()
                nova.store.db.close()
                nova.snapshots.db.close()

    async def test_control_events_and_token_rotation_e2e(self):
        event_subscribers = set()

        async def ws_events(r):
            ws = web.WebSocketResponse()
            await ws.prepare(r)
            event_subscribers.add(ws)
            try:
                async for _ in ws:
                    pass
            finally:
                event_subscribers.discard(ws)
            return ws

        app = web.Application()
        app.router.add_get('/api/health', lambda r: web.json_response({'status': 'healthy'}))
        app.router.add_get('/api/sessions', lambda r: web.json_response({'items': []}))
        app.router.add_get('/ws/events', ws_events)
        backend = TestServer(app)
        await backend.start_server()

        with tempfile.TemporaryDirectory() as tmp:
            nova = cloud.Nova(Path(tmp) / 'ctrl.db')
            client = TestClient(TestServer(nova.app()))
            await client.start_server()
            task = None
            try:
                r = await client.post(
                    '/register',
                    data={'name': 'ctrluser', 'password': secrets.token_urlsafe(24), 'invite': nova.store.invite()},
                    headers={'Origin': nova.public},
                    allow_redirects=False,
                )
                self.assertEqual(r.status, 303)
                auth = {'Origin': nova.public, 'Cookie': cloud.COOKIE + '=' + r.cookies[cloud.COOKIE].value}
                pair = await (await client.post('/v1/agent/pair/start', json={'name': 'CtrlPC'})).json()
                await client.post('/v1/pair/approve', json={'code': pair['code']}, headers=auth)
                token = secrets.token_urlsafe(32)
                device = 'f' * 24
                await client.post('/v1/agent/pair/finish', json={**pair, 'token': token, 'device_id': device})

                rotated_tokens = []
                task = asyncio.create_task(connector.connect_once(
                    str(client.make_url('')).rstrip('/'),
                    device,
                    token,
                    str(backend.make_url('')).rstrip('/'),
                    on_token_rotated=rotated_tokens.append,
                ))
                for _ in range(100):
                    if device in nova.devices and nova.devices[device].ready and event_subscribers:
                        break
                    await asyncio.sleep(0.05)
                self.assertTrue(event_subscribers)

                # Subscribe to cloud /d/<id>/api/events WS
                ev_ws = await client.ws_connect('/d/' + device + '/api/events', headers=auth)
                status_ev = await ev_ws.receive_json(timeout=3)
                self.assertEqual(status_ev['event'], 'device.status')

                # Publish local EventBus events (both allowlisted and blocked)
                local_sub = next(iter(event_subscribers))
                await local_sub.send_json({'topic': 'conductor:log', 'payload': {'secret': 'hide-me'}})
                await local_sub.send_json({
                    'topic': 'session:runtime',
                    'payload': {'session_id': 's-ctrl', 'status': 'idle', 'completed_run_id': 'r-done', 'cwd': 'C:/nope'},
                })
                await local_sub.send_json({
                    'topic': 'anti:runtime',
                    'payload': {'session_id': 'a-ctrl', 'status': 'running', 'run_id': 'ar-1'},
                })
                got1 = await ev_ws.receive_json(timeout=5)
                got2 = await ev_ws.receive_json(timeout=5)
                self.assertEqual(got1, {'event': 'session.runtime', 'data': {'session_id': 's-ctrl', 'status': 'idle', 'completed_run_id': 'r-done'}})
                self.assertEqual(got2, {'event': 'agy.runtime', 'data': {'session_id': 'a-ctrl', 'status': 'running', 'run_id': 'ar-1'}})
                await ev_ws.close()

                # Rotate device token live while connected
                rot_resp = await client.post('/v1/devices/' + device + '/rotate-token', json={}, headers=auth)
                self.assertEqual(rot_resp.status, 200, await rot_resp.text())
                self.assertEqual(len(rotated_tokens), 1)
                new_token = rotated_tokens[0]

                # Shut down old connector and verify new_token authenticates
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                task = asyncio.create_task(connector.connect_once(
                    str(client.make_url('')).rstrip('/'),
                    device,
                    new_token,
                    str(backend.make_url('')).rstrip('/'),
                ))
                for _ in range(100):
                    if device in nova.devices and nova.devices[device].ready:
                        break
                    await asyncio.sleep(0.05)
                self.assertTrue(nova.devices[device].ready)
            finally:
                if task:
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
                await client.close()
                await backend.close()
