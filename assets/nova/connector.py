"""Windows GA-Hub connector. Credentials stay in Windows Credential Manager."""
import argparse
import asyncio
import base64
import contextlib
import hashlib
import json
import os
from pathlib import Path
import secrets
import sys
from urllib.parse import urlsplit

import aiohttp
from aiohttp import web, WSMsgType
import win32cred

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent / 'remote_access'))
import gateway

STATE = Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'GAHubNova'
CRED_PREFIX = 'GAHub.Nova.'


class LocalGateway(gateway.Gateway):
    def __init__(self):
        # Intentionally bypass legacy gateway password/CredRead and reuse only its
        # allowlisted API implementation, attachments and compact rendering.
        self.signing = secrets.token_bytes(32)
        self.failures = gateway.defaultdict(gateway.deque)
        self.target = None
        self.checked = 0
        self.http = None
        self.submissions = {}
        self.uploads = {}
        self.artifacts = gateway.ArtifactStore()
        self.upload_slots = asyncio.Semaphore(2)
        self.progress_hub = gateway.ProgressHub(self)
        self.local_secret = secrets.token_urlsafe(32)

    def authenticated(self, request):
        return secrets.compare_digest(request.headers.get('Authorization', ''), 'Bearer ' + self.local_secret)

    async def backend(self):
        if getattr(self, "fixed_backend", None): return self.fixed_backend
        return await super().backend()

    async def handle(self, request):
        if not request.path.startswith('/api/') or not self.authenticated(request):
            raise web.HTTPForbidden()
        return await super().handle(request)


def credential_target(server):
    return CRED_PREFIX + hashlib.sha256(server.encode()).hexdigest()[:20]


def identity():
    STATE.mkdir(parents=True, exist_ok=True)
    path = STATE / 'identity.json'
    try:
        value = json.loads(path.read_text(encoding='utf-8'))['device']
    except FileNotFoundError:
        config = STATE / 'device.json'
        value = json.loads(config.read_text(encoding='utf-8'))['device'] if config.exists() else secrets.token_hex(12)
        # Exclusive creation prevents two first-start processes choosing different IDs.
        try:
            with path.open('x', encoding='utf-8') as f: json.dump({'device': value}, f)
        except FileExistsError:
            value = json.loads(path.read_text(encoding='utf-8'))['device']
    if len(value) != 24 or any(c not in '0123456789abcdef' for c in value):
        raise ValueError('Invalid local device identity')
    return value


def save_pair(server, device, name, token):
    STATE.mkdir(parents=True, exist_ok=True)
    win32cred.CredWrite({'Type': 1, 'TargetName': credential_target(server), 'UserName': device, 'CredentialBlob': token, 'Persist': 2}, 0)
    path = STATE / 'device.json'
    staged = path.with_suffix('.new')
    staged.write_text(json.dumps({'server': server, 'device': device, 'name': name}, ensure_ascii=False, indent=2), encoding='utf-8')
    staged.replace(path)


async def pair(server, name, confirm=False):
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as http:
        async with http.post(server + '/v1/agent/pair/start', json={'name': name}) as r:
            r.raise_for_status(); data = await r.json()
        print('请在浏览器登录 ' + data['confirm_url'], flush=True)
        print('配对码：' + data['code'] + '（10分钟有效）', flush=True)
        for _ in range(200):
            await asyncio.sleep(3)
            async with http.post(server + '/v1/agent/pair/poll', json={'code': data['code'], 'secret': data['secret']}) as r:
                r.raise_for_status(); status = await r.json()
            if status['status'] != 'approved': continue
            if not confirm and input('浏览器已批准配对。允许该账号远程操作这台电脑上的 GA-Hub？输入 YES 确认：').strip() != 'YES':
                raise RuntimeError('Pairing cancelled locally')
            token = secrets.token_urlsafe(48)
            async with http.post(server + '/v1/agent/pair/finish', json={'code': data['code'], 'secret': data['secret'], 'token': token, 'device_id': identity()}) as r:
                r.raise_for_status(); done = await r.json()
            save_pair(server, done['device'], name, token)
            print('已绑定：' + name + '。凭证已保存到 Windows 凭据管理器。', flush=True)
            return
        raise RuntimeError('Pair expired')


async def connect_once(server, device, token, backend=None):
    local = LocalGateway()
    local.fixed_backend = backend
    local.http = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=120))
    app = web.Application(client_max_size=26 * 1024 * 1024)
    app.router.add_route('*', '/{tail:.*}', local.handle)
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    site = web.TCPSite(runner, '127.0.0.1', 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    tasks = {}
    sockets = {}
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None, sock_connect=30)) as http:
        async def process(ws, data):
            rid = data['id']
            try:
                path = str(data['path'])
                if not path.startswith('/api/') or path.startswith('//') or '\\' in path or '#' in path or '\r' in path or '\n' in path:
                    raise ValueError('Invalid path')
                # Never accept an origin, destination, local port or Authorization from cloud.
                headers = {'Authorization': 'Bearer ' + local.local_secret, 'Origin': 'https://' + gateway.PUBLIC}
                source = data.get('headers', {})
                if source.get('Content-Type'): headers['Content-Type'] = source['Content-Type']
                if source.get('Range'): headers['Range'] = source['Range']
                # Stable, opaque per-browser owner; don't forward cloud session credential.
                owner = str(source.get('X-Nova-Owner', ''))
                if len(owner) != 64 or any(c not in '0123456789abcdef' for c in owner): raise ValueError('Invalid owner')
                headers['Cookie'] = gateway.COOKIE + '=' + owner
                if data.get('kind') == 'ws_open':
                    import re
                    if not re.fullmatch(r'/api/sessions/[A-Za-z0-9_-]+/live', path): raise ValueError('Invalid live path')
                    async with http.ws_connect(f'http://127.0.0.1:{port}' + path, headers=headers, heartbeat=20, max_msg_size=4*1024*1024) as live:
                        sockets[rid] = live
                        await ws.send_json({'kind': 'ws_opened', 'id': rid})
                        async for event in live:
                            if event.type == WSMsgType.TEXT:
                                await ws.send_json({'kind': 'ws_text', 'id': rid, 'data': event.data})
                        await ws.send_json({'kind': 'ws_closed', 'id': rid})
                    return
                body = base64.b64decode(data.get('body', ''), validate=True)
                if len(body) > 26 * 1024 * 1024: raise ValueError('Body too large')
                async with http.request(data['method'], f'http://127.0.0.1:{port}' + path, data=body, headers=headers, allow_redirects=False) as response:
                    await ws.send_json({'kind': 'headers', 'id': rid, 'status': response.status,
                                        'headers': {k: v for k, v in response.headers.items() if k.lower() in {'content-type', 'content-disposition', 'content-range', 'accept-ranges'}}})
                    async for chunk in response.content.iter_chunked(64 * 1024):
                        await ws.send_json({'kind': 'chunk', 'id': rid, 'data': base64.b64encode(chunk).decode()})
                    await ws.send_json({'kind': 'end', 'id': rid})
            except asyncio.CancelledError:
                raise
            except Exception as e:
                with contextlib.suppress(Exception):
                    await ws.send_json({'kind': 'error', 'id': rid, 'error': 'Local request failed: ' + type(e).__name__})
            finally:
                sockets.pop(rid, None)
                tasks.pop(rid, None)
        async def heartbeat(ws):
            while True:
                ready = False
                try:
                    base = await local.backend()
                    async with http.get(base + '/api/sessions', headers={'Origin': base}, timeout=aiohttp.ClientTimeout(total=4)) as check:
                        ready = check.status == 200
                except (aiohttp.ClientError, OSError, asyncio.TimeoutError, web.HTTPException): pass
                await ws.send_json({'kind': 'ping', 'ready': ready})
                await asyncio.sleep(5)
        pulse = None
        try:
            async with http.ws_connect(server + '/v1/agent/connect', headers={'Authorization': 'Bearer ' + token, 'X-Nova-Device': device}, heartbeat=25, max_msg_size=55 * 1024 * 1024, compress=0) as ws:
                pulse = asyncio.create_task(heartbeat(ws))
                print('Nova 已连接，设备：' + device, flush=True)
                async for msg in ws:
                    if msg.type != WSMsgType.TEXT: break
                    data = json.loads(msg.data)
                    if data['kind'] in ('request', 'ws_open'):
                        if len(tasks) >= 12:
                            await ws.send_json({'kind': 'error', 'id': data['id'], 'error': 'Device busy'})
                        else:
                            task = asyncio.create_task(process(ws, data))
                            tasks[data['id']] = task
                    elif data['kind'] == 'ws_text':
                        live = sockets.get(data['id'])
                        if live and json.loads(data.get('data', '{}')) == {'type': 'ping'}:
                            await live.send_json({'type': 'ping'})
                    elif data['kind'] == 'cancel':
                        task = tasks.get(data['id'])
                        if task: task.cancel()
        finally:
            active = list(tasks.values()) + ([pulse] if pulse else [])
            for task in active: task.cancel()
            await asyncio.gather(*active, return_exceptions=True)
            await runner.cleanup()
            await local.close()


async def run(backend=None):
    config = json.loads((STATE / 'device.json').read_text(encoding='utf-8'))
    server = config['server']
    blob = win32cred.CredRead(credential_target(server), 1)['CredentialBlob']
    token = blob.decode('utf-16-le')
    delay = 2
    while True:
        try:
            await connect_once(server, config['device'], token, backend)
            delay = 2
        except aiohttp.WSServerHandshakeError as e:
            if e.status in (401, 403): raise RuntimeError('设备已撤销或凭证无效，请重新配对。') from e
            print('连接暂不可用：' + type(e).__name__, flush=True)
        except (aiohttp.ClientError, OSError, asyncio.TimeoutError) as e:
            print('连接中断：' + type(e).__name__, flush=True)
        await asyncio.sleep(delay)
        delay = min(60, delay * 2)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Nova GA-Hub 远程连接器')
    parser.add_argument('command', choices=['pair', 'run'])
    parser.add_argument('--server', default='https://nova.lunadash.me')
    parser.add_argument('--name', default=os.environ.get('COMPUTERNAME', 'GA-Hub'))
    parser.add_argument('--confirm-local', action='store_true', help='explicit local administrator confirmation for unattended setup')
    args = parser.parse_args()
    if urlsplit(args.server).scheme != 'https': parser.error('HTTPS required')
    try:
        asyncio.run(pair(args.server.rstrip('/'), args.name, args.confirm_local) if args.command == 'pair' else run())
    except (KeyboardInterrupt, EOFError): pass
