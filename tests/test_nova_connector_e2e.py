"""Real Nova server -> connector -> loopback HTTP and live WebSocket."""
import asyncio
import contextlib
import importlib.util
import os
import secrets
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from server.nova_component import NovaComponent
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
    spec.loader.exec_module(cloud)


@unittest.skipIf(cloud is None, 'Nova cloud checkout required; set NOVA_CLOUD_ROOT')
class ConnectorE2E(unittest.IsolatedAsyncioTestCase):
    async def test_real_http_live_and_disconnect(self):
        async def sessions(r):
            return web.json_response({'items': [{'id':'s1','title':'E2E'}]})
        async def live(r):
            ws = web.WebSocketResponse();await ws.prepare(r)
            await ws.send_json({'type':'snapshot','streams':[],'runtime':{'status':'running'}})
            async for _ in ws: pass
            return ws
        async def projection(self, frame, sid):
            return {'type':'progress','session_id':sid,'runtime':frame['runtime']}
        app = web.Application();app.router.add_get('/api/sessions',sessions);app.router.add_get('/ws/sessions/s1',live)
        backend = TestServer(app);await backend.start_server()
        with tempfile.TemporaryDirectory() as tmp:
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
                with patch.object(connector.LocalGateway,'project_progress',projection):
                    task=asyncio.create_task(connector.connect_once(str(client.make_url('')).rstrip('/'),device,token,str(backend.make_url('')).rstrip('/')))
                    for _ in range(100):
                        if device in nova.devices and nova.devices[device].ready:break
                        if task.done():await task
                        await asyncio.sleep(.05)
                    self.assertTrue(nova.devices[device].ready)
                    r=await client.get('/d/'+device+'/api/sessions',headers=auth)
                    self.assertEqual(r.status,200);self.assertEqual((await r.json())['items'][0]['title'],'E2E')
                    ws=await client.ws_connect('/d/'+device+'/api/sessions/s1/live',headers=auth)
                    msg=await ws.receive_json(timeout=10);self.assertEqual(msg['runtime']['status'],'running')
                    await ws.send_json({'type':'ping'});self.assertEqual((await ws.receive_json(timeout=5))['type'],'pong')
                    await ws.close()
                    task.cancel();await asyncio.gather(task,return_exceptions=True)
                    for _ in range(30):
                        if device not in nova.devices:break
                        await asyncio.sleep(.05)
                    r=await client.get('/v1/me',headers=auth)
                    self.assertFalse((await r.json())['devices'][0]['online'])
            finally:
                if task:task.cancel();await asyncio.gather(task,return_exceptions=True)
                await client.close()
                await backend.close()
