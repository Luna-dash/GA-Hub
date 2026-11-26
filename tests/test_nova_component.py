"""Local-only Nova setup and connector lifecycle contracts."""
import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from server.routes.nova import build_nova_router
from server.services.nova_service import NovaService


class NovaComponentTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.component = NovaService()
        self.component.connector = SimpleNamespace(STATE=Path(self.tmp.name), identity=lambda: 'a'*24,
            win32cred=SimpleNamespace(CredDelete=Mock()), credential_target=lambda s: 'target')
        app = FastAPI()
        app.include_router(build_nova_router(self.component))
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.tmp.cleanup()

    def test_frozen_artifact_roots_use_configured_deliverables_not_bundle(self):
        import server._paths as paths
        connector = SimpleNamespace()
        component = NovaService()
        configured = Path(self.tmp.name) / 'actual-ga' / 'temp'
        with patch('server.services.nova_service.importlib.import_module', return_value=connector), \
             patch.object(paths, 'conductor_deliverables_dir', return_value=configured), \
             patch.object(sys, 'frozen', True, create=True), \
             patch.object(sys, '_MEIPASS', str(Path(self.tmp.name) / 'bundle'), create=True), \
             patch.object(sys, 'path', list(sys.path)):
            self.assertIs(component.load(), connector)
        self.assertEqual(connector.ARTIFACT_ROOTS, (configured,))

    def test_local_page_status_and_csrf(self):
        r = self.client.get('/nova')
        self.assertEqual(r.status_code, 200)
        self.assertIn(self.component.nonce, r.text)
        self.assertEqual(r.headers['cache-control'], 'no-store')
        self.assertEqual(self.client.get('/nova/status').json()['device'], 'a'*24)
        self.assertEqual(self.client.post('/nova/pair/start', json={}).status_code, 403)
        self.assertEqual(self.client.post('/nova/pair/start', json={}, headers={
            'Origin': 'https://evil.example', 'X-Nova-Local': self.component.nonce}).status_code, 403)
        headers={'Origin':'http://testserver','X-Nova-Local':self.component.nonce}
        self.assertEqual(self.client.post('/nova/pair/finish',json={},headers=headers).status_code,409)

    def test_pair_start_checks_existing_binding_before_reading_request_body(self):
        (Path(self.tmp.name) / 'device.json').touch()
        headers = {
            'Origin': 'http://testserver',
            'X-Nova-Local': self.component.nonce,
            'Content-Type': 'application/json',
        }
        with TestClient(self.client.app, raise_server_exceptions=False) as client:
            for body in ('{}', '', 'null'):
                with self.subTest(body=body):
                    response = client.post('/nova/pair/start', content=body, headers=headers)
                    self.assertEqual(response.status_code, 409, response.text)
                    self.assertEqual(response.json(), {
                        'detail': 'Already paired; revoke the device in Nova before rebinding',
                    })

    def test_remote_configuration_blocked(self):
        app=FastAPI();app.include_router(build_nova_router(self.component))
        with TestClient(app, client=('203.0.113.7',5000)) as client:
            self.assertEqual(client.get('/nova').status_code,403)
            self.assertEqual(client.get('/nova/status').status_code,403)

    def test_unpair_preserves_identity(self):
        path=Path(self.tmp.name)/'device.json'
        path.write_text(json.dumps({'server':'https://nova.lunadash.me'}))
        headers={'Origin':'http://testserver','X-Nova-Local':self.component.nonce}
        r=self.client.post('/nova/unpair',json={},headers=headers)
        self.assertEqual(r.status_code,200)
        self.assertFalse(path.exists())
        self.assertEqual(r.json()['device'],'a'*24)
        self.component.connector.win32cred.CredDelete.assert_called_once_with('target',1)


    def test_unpair_retries_credential_failure_and_accepts_missing_credential(self):
        class CredentialError(Exception):
            def __init__(self, winerror):
                self.winerror = winerror

        path = Path(self.tmp.name) / 'device.json'
        path.write_text(json.dumps({'server': 'https://nova.lunadash.me'}))
        delete = self.component.connector.win32cred.CredDelete
        delete.side_effect = [CredentialError(5), CredentialError(1168)]
        headers = {'Origin': 'http://testserver', 'X-Nova-Local': self.component.nonce}
        first = self.client.post('/nova/unpair', json={}, headers=headers)
        self.assertEqual(first.status_code, 502, first.text)
        self.assertTrue(path.exists())
        retry = self.client.post('/nova/unpair', json={}, headers=headers)
        self.assertEqual(retry.status_code, 200, retry.text)
        self.assertFalse(path.exists())

    def test_optional_connector_unavailable_returns_503_on_mutation(self):
        self.component.connector = None
        headers = {'Origin': 'http://testserver', 'X-Nova-Local': self.component.nonce}
        with patch('server.services.nova_service.sys.platform', 'linux'), patch.object(self.component, 'load') as load:
            response = self.client.post('/nova/unpair', json={}, headers=headers)
        self.assertEqual(response.status_code, 503, response.text)
        load.assert_not_called()


class NovaLifecycleTest(unittest.IsolatedAsyncioTestCase):
    async def test_optional_import_failure_does_not_stop_hub(self):
        c=NovaService()
        with patch.object(c,'load',side_effect=ImportError):
            await c.start()
        self.assertEqual(c.error,'ImportError')
        await c.stop()

    async def test_panel_tracks_connection_without_starting_connector(self):
        from server.services.service_registry import ServiceRegistry

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)
            online = asyncio.Event()
            disconnect = asyncio.Event()
            offline = asyncio.Event()
            fail = asyncio.Event()

            async def run(backend, *, on_connection):
                self.assertTrue(backend.startswith('http://127.0.0.1:'))
                on_connection(True)
                online.set()
                await disconnect.wait()
                on_connection(False)
                offline.set()
                await fail.wait()
                raise RuntimeError('sensitive connection details')

            c = NovaService()
            registry = ServiceRegistry(nova=c)

            def panel_entry():
                return next(item for item in registry.panel()['services'] if item['id'] == 'nova')

            with patch.object(c, 'load', side_effect=AssertionError('unexpected load')) as load:
                self.assertEqual(panel_entry()['health'], 'unknown')
                load.assert_not_called()
            c.connector = SimpleNamespace(STATE=path, run=run)
            self.assertEqual(panel_entry()['summary'], '未绑定 Nova 账号')
            self.assertEqual(panel_entry()['health'], 'healthy')
            self.assertIsNone(c.task)
            (path / 'device.json').write_text('{}', encoding='utf-8')
            self.assertEqual(panel_entry()['summary'], '已绑定，连通器未运行')
            await c.start()
            try:
                self.assertEqual(panel_entry()['summary'], '正在连接或重试')
                await asyncio.wait_for(online.wait(), 2)
                self.assertEqual(panel_entry()['summary'], '已连接 Nova 云端')
                self.assertEqual(panel_entry()['health'], 'healthy')
                disconnect.set()
                await asyncio.wait_for(offline.wait(), 2)
                self.assertFalse(c.runtime_status()['connected'])
                self.assertEqual(panel_entry()['summary'], '正在连接或重试')
                fail.set()
                await asyncio.gather(c.task, return_exceptions=True)
                entry = panel_entry()
                self.assertEqual(entry['health'], 'attention')
                self.assertIn('连通器异常', entry['summary'])
                self.assertNotIn('sensitive connection details', str(entry))
            finally:
                await c.stop()
            self.assertIsNone(c.task)
            self.assertFalse(c.runtime_status()['connected'])


class IdentityTest(unittest.TestCase):
    def test_identity_survives_unpair_and_uses_legacy_id(self):
        sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'assets'/'nova'))
        import connector
        with tempfile.TemporaryDirectory() as tmp, patch.object(connector,'STATE',Path(tmp)):
            p=Path(tmp)/'device.json';p.write_text(json.dumps({'device':'b'*24}))
            self.assertEqual(connector.identity(),'b'*24)
            p.unlink();self.assertEqual(connector.identity(),'b'*24)
        with tempfile.TemporaryDirectory() as tmp, patch.object(connector,'STATE',Path(tmp)):
            value=connector.identity();self.assertEqual(len(value),24)
            self.assertEqual(connector.identity(),value)


class EmbeddedSettingsTest(unittest.TestCase):
    def test_settings_protection_and_explicit_confirmation(self):
        app=FastAPI(); component=NovaService(); app.include_router(build_nova_router(component))
        with tempfile.TemporaryDirectory() as tmp:
            component.connector=SimpleNamespace(STATE=Path(tmp), identity=lambda:'d'*24)
            client=TestClient(app,base_url='http://localhost',client=('127.0.0.1',5000))
            response=client.get('/nova/settings')
            self.assertEqual(response.status_code,200)
            self.assertEqual(response.headers['cache-control'],'no-store')
            nonce=response.json()['local_token']
            body={'username':'example','password':'example-password','confirm':False}
            for headers in ({}, {'Origin':'https://evil.example','X-Nova-Local':nonce}):
                self.assertEqual(client.post('/nova/associate',json=body,headers=headers).status_code,403)
            headers={'Origin':'tauri://localhost','X-Nova-Local':nonce}
            self.assertEqual(client.post('/nova/associate',json=body,headers=headers).status_code,400)
            remote=TestClient(app,base_url='http://localhost',client=('203.0.113.3',5000))
            self.assertEqual(remote.get('/nova/settings').status_code,403)

    def test_identity_survives_module_reload_and_relocation(self):
        import importlib.util
        source=Path(__file__).resolve().parents[1]/'assets'/'nova'/'connector.py'
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); state=root/'user-state'
            ids=[]
            for version in ('old-package','new-package'):
                dest=root/version/'connector.py'; dest.parent.mkdir(); dest.write_bytes(source.read_bytes())
                spec=importlib.util.spec_from_file_location('connector_'+version.replace('-','_'),dest)
                module=importlib.util.module_from_spec(spec)
                with patch.dict(sys.modules,{'gateway':SimpleNamespace(Gateway=object)}):
                    spec.loader.exec_module(module)
                module.STATE=state
                ids.append(module.identity())
            self.assertEqual(ids[0],ids[1]); self.assertEqual(len(ids[0]),24)


class ConnectorAgyParityTest(unittest.IsolatedAsyncioTestCase):
    async def test_agy_gateway_supports_acp_parity_and_read_only_profiles_quota(self):
        from aiohttp import web
        from aiohttp.test_utils import make_mocked_request

        connector_dir = str(Path(__file__).resolve().parents[1] / 'assets' / 'nova')
        remote_dir = str(Path(__file__).resolve().parents[1] / 'assets' / 'remote_access')
        sys.path.insert(0, connector_dir)
        sys.path.insert(0, remote_dir)
        try:
            import connector
        finally:
            if connector_dir in sys.path:
                sys.path.remove(connector_dir)
            if remote_dir in sys.path:
                sys.path.remove(remote_dir)

        gw = connector.LocalGateway()
        calls = []

        async def fake_anti(method, path, payload=None, *, action=None):
            calls.append((method, path, payload, action))
            if path == '/profiles':
                return {
                    'active': 'p1',
                    'profiles': [{
                        'id': 'p1',
                        'name': 'Work',
                        'has_credentials': True,
                        'auth_state': 'authenticated',
                        'cooldown_seconds': 25,
                        'secret_path': 'C:/should-not-leak',
                        'usage': {'min_remaining_pct': 70.0},
                    }],
                }
            if path == '/quota':
                return [{'model_group': 'gemini-4', 'display_name': 'Gemini 4',
                         'status': 'cooling_down', 'cooldown_remaining_seconds': 25, 'internal': 'hidden'}]
            if path == '/sessions/s1/reset':
                return {'id': 's1', 'project': 'demo', 'title': 'Demo',
                        'acp_connected': False, 'has_conversation': True, 'workspace': 'C:/secret'}
            if path == '/sessions/s1/runs' and method == 'POST':
                return {'id': 'r1', 'status': 'running', 'prompt': 'hi', 'mode': 'accept-edits',
                        'permission_mode': payload.get('permission_mode')}
            if path == '/sessions/s1/runs/r1/approval':
                return {'id': 'r1', 'status': 'running', 'prompt': 'hi'}
            if path.startswith('/sessions/s1/runs/r1/events'):
                return [{'seq': 1, 'type': 'step.update',
                         'step': {'index': 0, 'kind': 'tool_call', 'tool': 'read_file', 'state': 'DONE', 'cwd': 'C:/secret'}}]
            raise AssertionError((method, path))

        gw.anti_json = fake_anti
        headers = {'Origin': 'https://' + connector.gateway.PUBLIC}

        r_prof = await gw.handle_agy(make_mocked_request('GET', '/api/agy/profiles', headers=headers))
        prof_body = json.loads(r_prof.text)
        self.assertEqual(prof_body['profiles'][0]['cooldown_seconds'], 25)
        self.assertEqual(prof_body['profiles'][0]['min_remaining_pct'], 70.0)
        self.assertNotIn('secret_path', prof_body['profiles'][0])

        r_quota = await gw.handle_agy(make_mocked_request('GET', '/api/agy/quota', headers=headers))
        quota_body = json.loads(r_quota.text)
        self.assertEqual(quota_body[0]['cooldown_remaining_seconds'], 25)
        self.assertNotIn('internal', quota_body[0])

        r_reset = await gw.handle_agy(make_mocked_request('POST', '/api/agy/sessions/s1/reset', headers=headers))
        reset_body = json.loads(r_reset.text)
        self.assertTrue(reset_body['has_conversation'])
        self.assertNotIn('workspace', reset_body)

        # Feed request JSON via StreamReader to exercise agy_body parsing directly
        from aiohttp import streams

        def stream_req(method, path, body):
            raw = json.dumps(body).encode()
            protocol = type('Proto', (), {'_reading_paused': False, 'pause_reading': lambda self: None, 'resume_reading': lambda self: None})()
            reader = streams.StreamReader(protocol, 2**16, loop=asyncio.get_running_loop())
            reader.feed_data(raw)
            reader.feed_eof()
            return make_mocked_request(
                method,
                path,
                headers={**headers, 'Content-Type': 'application/json', 'Content-Length': str(len(raw))},
                payload=reader,
            )

        r_run = await gw.handle_agy(stream_req('POST', '/api/agy/sessions/s1/runs', {
            'text': 'go',
            'request_id': '11111111-1111-1111-1111-111111111111',
            'mode': 'accept-edits',
            'permission_mode': 'auto',
        }))
        self.assertEqual(json.loads(r_run.text)['permission_mode'], 'auto')

        with self.assertRaises(web.HTTPBadRequest):
            await gw.handle_agy(stream_req('POST', '/api/agy/sessions/s1/runs', {
                'text': 'go',
                'request_id': '22222222-2222-2222-2222-222222222222',
                'permission_mode': 'invalid-perm',
            }))

        await gw.handle_agy(stream_req('POST', '/api/agy/sessions/s1/runs/r1/approval', {
            'approval_id': 'a' * 32,
            'decision': 'allow_always',
            'option_id': 'opt-dev',
        }))
        self.assertEqual(calls[-1][2], {'approval_id': 'a' * 32, 'decision': 'allow_always', 'option_id': 'opt-dev'})

        r_evt = await gw.handle_agy(make_mocked_request('GET', '/api/agy/sessions/s1/runs/r1/events?after=0', headers=headers))
        evts = json.loads(r_evt.text)
        self.assertEqual(evts[0]['step'], {'index': 0, 'kind': 'tool_call', 'state': 'DONE', 'tool': 'read_file'})

    async def test_agy_session_create_does_not_poison_chat_submit_on_same_connector(self):
        from aiohttp import streams, web
        from aiohttp.test_utils import make_mocked_request

        connector_dir = str(Path(__file__).resolve().parents[1] / 'assets' / 'nova')
        remote_dir = str(Path(__file__).resolve().parents[1] / 'assets' / 'remote_access')
        sys.path.insert(0, connector_dir)
        sys.path.insert(0, remote_dir)
        try:
            import connector
        finally:
            if connector_dir in sys.path:
                sys.path.remove(connector_dir)
            if remote_dir in sys.path:
                sys.path.remove(remote_dir)

        gw = connector.LocalGateway()
        gw.fixed_backend = 'http://127.0.0.1:18765'
        cookie_val = gw.token()
        common_headers = {
            'Host': connector.gateway.PUBLIC,
            'Origin': 'https://' + connector.gateway.PUBLIC,
            'Authorization': 'Bearer ' + gw.local_secret,
            'Cookie': f'{connector.gateway.COOKIE}={cookie_val}',
        }

        class FakeResp:
            def __init__(self, status, payload):
                self.status = status
                self._payload = payload

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

            async def json(self):
                return self._payload

            async def read(self):
                return json.dumps(self._payload).encode()

        class FakeHttp:
            def get(self, url, **kwargs):
                if url.endswith('/api/projects'):
                    return FakeResp(200, {'items': [{'name': 'demo', 'path': 'D:/demo', 'dangling': False}]})
                raise AssertionError(url)

            def post(self, url, **kwargs):
                if url.endswith('/api/sessions/chat-1/runs'):
                    return FakeResp(200, {'run_id': 'chat-run-1', 'accepted': True})
                raise AssertionError(url)

        gw.http = FakeHttp()
        create_attempts = {'count': 0, 'fail_once': True}

        async def fake_anti(method, path, payload=None, *, action=None):
            if method == 'POST' and path == '/sessions':
                create_attempts['count'] += 1
                if create_attempts['fail_once']:
                    create_attempts['fail_once'] = False
                    raise web.HTTPBadGateway(text='transient upstream error')
                return {'id': 'agy-created-1', 'project': payload['project'], 'title': 'Agy'}
            raise AssertionError((method, path))

        gw.anti_json = fake_anti

        def json_req(method, path, body):
            raw = json.dumps(body).encode()
            protocol = type(
                'Proto',
                (),
                {'_reading_paused': False, 'pause_reading': lambda self: None, 'resume_reading': lambda self: None},
            )()
            reader = streams.StreamReader(protocol, 2**16, loop=asyncio.get_running_loop())
            reader.feed_data(raw)
            reader.feed_eof()
            return make_mocked_request(
                method,
                path,
                headers={**common_headers, 'Content-Type': 'application/json', 'Content-Length': str(len(raw))},
                payload=reader,
            )

        catalog = await gw.project_catalog()
        project_id = next(iter(catalog))

        # A failed Agy creation must be evicted so retrying the same request_id can succeed.
        agy_req_id = '33333333-3333-3333-3333-333333333333'
        with self.assertRaises(web.HTTPBadGateway):
            await gw.handle(json_req('POST', '/api/agy/sessions', {
                'project_id': project_id,
                'request_id': agy_req_id,
            }))

        created = await gw.handle(json_req('POST', '/api/agy/sessions', {
            'project_id': project_id,
            'request_id': agy_req_id,
        }))
        self.assertEqual(created.status, 200)
        self.assertEqual(json.loads(created.text), {'id': 'agy-created-1'})

        # Repeating the succeeded request_id coalesces onto the cached creation.
        coalesced = await gw.handle(json_req('POST', '/api/agy/sessions', {
            'project_id': project_id,
            'request_id': agy_req_id,
        }))
        self.assertEqual(json.loads(coalesced.text), {'id': 'agy-created-1'})
        self.assertEqual(create_attempts['count'], 2)

        # Submitting a normal Chat message on the same LocalGateway instance must not IndexError.
        chat_resp = await gw.handle(json_req('POST', '/api/sessions/chat-1/runs', {
            'text': 'hello after agy create',
            'request_id': '44444444-4444-4444-4444-444444444444',
        }))
        self.assertEqual(chat_resp.status, 200)
        self.assertEqual(json.loads(chat_resp.body.decode()), {'run_id': 'chat-run-1', 'accepted': True})


class ConnectorHardeningTests(unittest.IsolatedAsyncioTestCase):
    def test_single_instance_lock_rejects_duplicate_and_releases(self):
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'assets' / 'nova'))
        import connector
        with tempfile.TemporaryDirectory() as tmp:
            handle = connector.acquire_instance_lock(tmp)
            try:
                with self.assertRaises(connector.ConnectorConflictError):
                    connector.acquire_instance_lock(tmp)
            finally:
                connector.release_instance_lock(handle)
            reacquired = connector.acquire_instance_lock(tmp)
            connector.release_instance_lock(reacquired)

    async def test_loopback_ignores_proxy_and_runtime_persists_state(self):
        from aiohttp import web
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'assets' / 'nova'))
        import connector

        app = web.Application()
        app.router.add_get('/api/health', lambda r: web.json_response({'status': 'healthy'}))
        app.router.add_get('/api/sessions', lambda r: web.json_response({'items': []}))
        from aiohttp.test_utils import TestServer
        srv = TestServer(app)
        await srv.start_server()
        runtime = connector.LocalGatewayRuntime(str(srv.make_url('')).rstrip('/'))
        try:
            with patch.dict('os.environ', {'HTTP_PROXY': 'http://127.0.0.1:1', 'HTTPS_PROXY': 'http://127.0.0.1:1'}):
                await runtime.start()
                base = await runtime.local.backend()
                async with runtime.local_http.get(base + '/api/health') as resp:
                    self.assertEqual(resp.status, 200)
                runtime.local.uploads['u-persist'] = (10**12, 'owner', {'name': 'a.txt'})
                self.assertIn('u-persist', runtime.local.uploads)
        finally:
            await runtime.close()
            await srv.close()

    async def test_pause_resume_and_auth_error_detail(self):
        import httpx
        from server.services.service_registry import ServiceRegistry

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)
            (path / 'device.json').write_text(json.dumps({'name': 'Studio PC'}), encoding='utf-8')
            started = asyncio.Event()
            stop_evt = asyncio.Event()

            class ConnectorAuthError(RuntimeError):
                pass

            fail_auth = False

            async def run(backend, *, on_connection, on_heartbeat=None):
                on_connection(True)
                if on_heartbeat:
                    on_heartbeat(ready=True, rtt_ms=19)
                started.set()
                if fail_auth:
                    raise ConnectorAuthError('设备已撤销或凭证无效，请重新配对。')
                await stop_evt.wait()

            svc = NovaService()
            svc.connector = SimpleNamespace(
                STATE=path,
                identity=lambda: 'e' * 24,
                CONNECTOR_VERSION='2.0.0',
                run=run,
            )
            registry = ServiceRegistry(nova=svc)
            app = FastAPI()
            app.include_router(build_nova_router(svc))
            transport = httpx.ASGITransport(app=app, client=('127.0.0.1', 5000))
            async with httpx.AsyncClient(transport=transport, base_url='http://testserver') as client:
                try:
                    await svc.start()
                    await asyncio.wait_for(started.wait(), 2)
                    st = (await client.get('/nova/status')).json()
                    self.assertTrue(st['connected'])
                    self.assertEqual(st['rtt_ms'], 19)
                    self.assertEqual(st['device_name'], 'Studio PC')
                    self.assertFalse(st['paused'])

                    headers = {'Origin': 'http://testserver', 'X-Nova-Local': svc.nonce}
                    paused = (await client.post('/nova/pause', headers=headers)).json()
                    self.assertTrue(paused['paused'])
                    self.assertFalse(paused['running'])
                    panel_item = next(i for i in registry.panel()['services'] if i['id'] == 'nova')
                    self.assertEqual(panel_item['summary'], '已暂停连接 Nova 云端')

                    started.clear()
                    fail_auth = True
                    resumed = (await client.post('/nova/resume', headers=headers)).json()
                    self.assertFalse(resumed['paused'])
                    await asyncio.wait_for(started.wait(), 2)
                    await asyncio.gather(svc.task, return_exceptions=True)
                    err_st = (await client.get('/nova/status')).json()
                    self.assertEqual(err_st['error'], 'ConnectorAuthError')
                    self.assertIn('设备已撤销', err_st['error_detail'])
                finally:
                    stop_evt.set()
                    await svc.stop()

    async def test_heartbeat_probes_health_and_falls_back_on_404(self):
        from aiohttp import web
        from aiohttp.test_utils import TestServer
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'assets' / 'nova'))
        import connector

        health_mode = {'status': 'unavailable'}
        seen_paths = []

        async def health(r):
            seen_paths.append('/api/health')
            if health_mode['status'] == 404:
                return web.Response(status=404)
            return web.json_response({'status': health_mode['status']})

        async def sessions(r):
            seen_paths.append('/api/sessions')
            return web.json_response({'items': []})

        backend_app = web.Application()
        backend_app.router.add_get('/api/health', health)
        backend_app.router.add_get('/api/sessions', sessions)
        backend = TestServer(backend_app)
        await backend.start_server()

        pings = []

        async def agent_ws(r):
            ws = web.WebSocketResponse()
            await ws.prepare(r)
            await ws.send_json({'kind': 'hello', 'protocol': 2})
            async for msg in ws:
                if msg.type == web.WSMsgType.TEXT:
                    data = json.loads(msg.data)
                    if data.get('kind') in ('hello_ack', 'ping'):
                        pings.append(data.get('ready'))
                        if data.get('kind') == 'ping':
                            await ws.send_json({'kind': 'pong'})
                        if len(pings) == 2:
                            health_mode['status'] = 'healthy'
                        elif len(pings) == 4:
                            health_mode['status'] = 404
                        elif len(pings) >= 6:
                            await ws.close()
            return ws

        cloud_app = web.Application()
        cloud_app.router.add_get('/v1/agent/connect', agent_ws)
        cloud_srv = TestServer(cloud_app)
        await cloud_srv.start_server()
        heartbeats = []
        real_sleep = asyncio.sleep

        async def yield_sleep(_delay):
            await real_sleep(0)

        try:
            with patch.object(asyncio, 'sleep', side_effect=yield_sleep):
                await connector.connect_once(
                    str(cloud_srv.make_url('')).rstrip('/'),
                    'f' * 24,
                    'tok',
                    str(backend.make_url('')).rstrip('/'),
                    on_heartbeat=lambda **kw: heartbeats.append(kw),
                )
            self.assertFalse(pings[0])
            self.assertIn(True, pings)
            self.assertIn('/api/sessions', seen_paths)
            self.assertTrue(heartbeats)
            self.assertIsInstance(heartbeats[0]['rtt_ms'], int)
        finally:
            await cloud_srv.close()
            await backend.close()
