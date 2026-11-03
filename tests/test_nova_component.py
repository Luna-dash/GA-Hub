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
from server.nova_component import NovaComponent


class NovaComponentTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.component = NovaComponent()
        self.component.connector = SimpleNamespace(STATE=Path(self.tmp.name), identity=lambda: 'a'*24,
            win32cred=SimpleNamespace(CredDelete=Mock()), credential_target=lambda s: 'target')
        app = FastAPI()
        app.include_router(self.component.router())
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.tmp.cleanup()

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

    def test_remote_configuration_blocked(self):
        app=FastAPI();app.include_router(self.component.router())
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


class NovaLifecycleTest(unittest.IsolatedAsyncioTestCase):
    async def test_optional_import_failure_does_not_stop_hub(self):
        c=NovaComponent()
        with patch.object(c,'load',side_effect=ImportError):
            await c.start()
        self.assertEqual(c.error,'ImportError')
        await c.stop()

    async def test_configured_connector_starts_and_stops(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp);(path/'device.json').write_text('{}')
            running=asyncio.Event();stopped=asyncio.Event()
            async def run(backend):
                self.assertTrue(backend.startswith('http://127.0.0.1:'))
                running.set()
                try: await asyncio.Event().wait()
                finally: stopped.set()
            c=NovaComponent();c.connector=SimpleNamespace(STATE=path,run=run)
            await c.start();await asyncio.wait_for(running.wait(),2)
            await c.stop();self.assertTrue(stopped.is_set());self.assertIsNone(c.task)


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
