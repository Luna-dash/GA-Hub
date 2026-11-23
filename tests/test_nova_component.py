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
