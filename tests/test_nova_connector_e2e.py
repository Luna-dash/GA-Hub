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
        async def messages(r):
            self.assertEqual(r.query.get('view'), 'compact')
            return web.json_response({'presentation_version':1,'session_id':'s1','items':[{'role':'assistant','compact':True,'progress':{'final_body':f'[report](<{report.as_posix()}:7>)'}}]})
        app = web.Application();app.router.add_get('/api/sessions',sessions);app.router.add_get('/ws/sessions/s1',live)
        app.router.add_get('/api/sessions/s1/messages', messages)
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
            if resource == 'sessions':
                return web.json_response([agy_session] if agy_session else [])
            if resource == 'sessions/a1' and r.method == 'PATCH':
                agy_session.update(await r.json())
                return web.json_response(agy_session)
            if resource == 'sessions/a1' and r.method == 'DELETE':
                agy_session.clear()
                return web.Response(status=204)
            if resource == 'sessions/a1/runs' and r.method == 'POST':
                body = await r.json()
                self.assertEqual((body['model'], body['effort']), ('model-1', 'high'))
                self.assertEqual(body['attachments'], [{'path': str(report), 'name': 'note.txt',
                                                        'size': 4, 'source': 'managed_upload'}])
                self.assertEqual(body['mode'], 'accept-edits')
                run = {'id': 'run-1', 'status': 'running', 'prompt': body['prompt'],
                       'mode': body['mode'], 'approval': approval}
                agy_runs.append(run)
                return web.json_response(run)
            if resource == 'sessions/a1/runs/run-1':
                return web.json_response(agy_runs[0])
            if resource == 'sessions/a1/runs/run-1/approval':
                self.assertEqual(r.method, 'POST')
                self.assertEqual(r.headers['Origin'], str(backend.make_url('/')).rstrip('/'))
                self.assertEqual(r.headers['X-GA-Hub-Action'], 'approve-agy')
                self.assertEqual(await r.json(), {'approval_id': approval['id'], 'decision': 'reject'})
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
            self.assertEqual(part.filename, 'note.txt')
            self.assertEqual(await part.read(), b'note')
            return web.json_response({'path': str(report), 'name': part.filename, 'size': 4})

        app.router.add_route('*', '/api/anti/{resource:.*}', anti)
        app.router.add_post('/api/upload', upload)
        backend = TestServer(app);await backend.start_server()
        with tempfile.TemporaryDirectory() as tmp:
            report = Path(tmp) / '验收 report.txt'
            report.write_bytes(b'relay artifact verified')
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
                    r=await client.get('/d/'+device+'/api/sessions',headers=auth)
                    self.assertEqual(r.status,200);self.assertEqual((await r.json())['items'][0]['title'],'E2E')
                    r = await client.get('/d/'+device+'/api/sessions/s1/messages?view=compact', headers=auth)
                    self.assertEqual(r.status, 200)
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
                    r = await client.patch(agy + '/sessions/a1', json={'title': 'Renamed'}, headers=auth)
                    self.assertEqual(r.status, 200, await r.text())
                    form = FormData()
                    form.add_field('file', b'note', filename='note.txt')
                    r = await client.post(agy + '/sessions/a1/upload', data=form, headers=auth)
                    self.assertEqual(r.status, 200, await r.text())
                    body = {'text': 'Summarize', 'request_id': str(uuid.uuid4()),
                            'upload_ids': [(await r.json())['upload_id']], 'model': 'model-1', 'effort': 'high',
                            'mode': 'accept-edits'}
                    r = await client.post(agy + '/sessions/other/runs', json=body, headers=auth)
                    self.assertEqual(r.status, 400, await r.text())
                    r = await client.post(agy + '/sessions/a1/runs', json=body, headers=auth)
                    self.assertEqual(r.status, 200, await r.text())
                    run_path = agy + '/sessions/a1/runs/run-1'
                    r = await client.get(run_path, headers=auth)
                    self.assertEqual((await r.json())['approval'], approval)
                    r = await client.get(agy + '/sessions/a1/runs', headers=auth)
                    self.assertNotIn('approval', (await r.json())[0])
                    decision = {'approval_id': approval['id'], 'decision': 'reject'}
                    r = await client.post(run_path + '/approval', json={**decision, 'decision': 'allow_always'}, headers=auth)
                    self.assertEqual(r.status, 400, await r.text())
                    r = await client.post(run_path + '/approval', json=decision, headers=auth)
                    self.assertEqual((await r.json())['status'], 'success')
                    r = await client.post(run_path + '/approval', json=decision, headers=auth)
                    self.assertEqual(r.status, 409, await r.text())
                    history = '/api/agy/sessions/a1/runs?view=compact&limit=40'
                    for path in ('/api/agy/sessions', history):
                        r = await client.get('/d/' + device + path, headers=auth)
                        self.assertEqual(r.status, 200, await r.text())
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
