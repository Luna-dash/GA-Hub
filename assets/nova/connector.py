"""Windows GA-Hub connector. Credentials stay in Windows Credential Manager."""
import argparse
import asyncio
import base64
import contextlib
import hashlib
import json
import os
import re
from pathlib import Path
import secrets
import sys
import time
from urllib.parse import urlsplit

import aiohttp
from aiohttp import web, WSMsgType
import win32cred
import win32timezone  # pywin32: CredRead implicitly converts LastWritten

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent / 'remote_access'))
import gateway

STATE = Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'GAHubNova'
CRED_PREFIX = 'GAHub.Nova.'
ARTIFACT_ROOTS = None  # Set by the desktop host; standalone keeps legacy roots.


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
        self.artifacts = gateway.ArtifactStore(ARTIFACT_ROOTS)
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
        if request.path.startswith('/api/agy/'):
            if not self.origin_ok(request):
                raise web.HTTPForbidden()
            return await self.handle_agy(request)
        return await super().handle(request)

    async def anti_json(self, method, path, payload=None):
        base = await self.backend()
        try:
            async with self.http.request(method, base + '/api/anti' + path, json=payload,
                                         headers={'Origin': base}, allow_redirects=False,
                                         timeout=aiohttp.ClientTimeout(total=65)) as response:
                if response.status == 204:
                    return None
                failure = {400:web.HTTPBadRequest, 404:web.HTTPNotFound, 409:web.HTTPConflict,
                           422:web.HTTPBadRequest, 429:web.HTTPTooManyRequests}.get(response.status)
                if failure:
                    raise failure(text='本机 Agy 未接受此操作')
                if not 200 <= response.status < 300:
                    raise web.HTTPBadGateway(text='本机 Agy 请求未完成')
                return await response.json()
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError):
            raise web.HTTPBadGateway(text='本机 Agy 请求未确认')

    async def handle_agy(self, request):
        path = request.path.removeprefix('/api/agy')
        method = request.method
        event_query = (method == 'GET' and re.fullmatch(r'/sessions/[A-Za-z0-9_-]{1,128}/runs/[A-Za-z0-9_-]{1,128}/events', path)
                       and re.fullmatch(r'after=[0-9]{1,15}', request.query_string))
        compact = (method == 'GET' and request.query_string == 'view=compact&limit=40'
                   and re.fullmatch(r'/sessions/[A-Za-z0-9_-]{1,128}/runs', path))
        if (request.query_string and not (event_query or compact)) or request.headers.get('Upgrade'):
            raise web.HTTPForbidden()
        if method == 'GET' and path == '/models':
            result = await self.anti_json('GET', path)
            return web.json_response({'items': [{k: row[k] for k in ('id', 'display_name')} for row in result['items']]})
        if method == 'GET' and path == '/projects':
            try:
                catalog = await self.project_catalog()
            except (aiohttp.ClientError, asyncio.TimeoutError, ValueError):
                raise web.HTTPBadGateway(text='项目列表读取失败')
            return web.json_response({'items': [{'id': k, 'name': v['label']} for k, v in catalog.items()]})
        if path == '/sessions' and method == 'GET':
            rows = await self.anti_json('GET', path)
            return web.json_response([{k: row.get(k) for k in ('id', 'project', 'title', 'updated_at', 'active_run_id')} for row in rows])
        if method == 'POST' and path == '/sessions':
            body = await self.agy_body(request, {'project_id', 'request_id'})
            catalog = await self.project_catalog()
            project = catalog.get(body['project_id']) if isinstance(body['project_id'], str) else None
            if not project:
                raise web.HTTPBadRequest(text='请选择已登记项目')
            # Coalesce an uncertain response within the lifetime of this connector.
            key = ('agy-create', request.cookies.get(gateway.COOKIE), body['request_id'])
            if key not in self.submissions:
                if len(self.submissions) >= 512:
                    self.submissions.pop(next(iter(self.submissions)))
                task = asyncio.create_task(self.anti_json('POST', path, {'project': project['name']}))
                self.submissions[key] = (body['project_id'], task)
            project_id, task = self.submissions[key]
            if project_id != body['project_id']:
                raise web.HTTPConflict(text='创建请求与原项目不一致')
            row = await asyncio.shield(task)
            return web.json_response({'id': row['id']})
        session = re.fullmatch(r'/sessions/([A-Za-z0-9_-]{1,128})(/upload)?', path)
        if session:
            sid, upload = session.groups()
            if upload and method == 'POST':
                return await self.upload(request, scope=('agy', sid))
            if not upload and method == 'PATCH':
                body = await self.agy_body(request, {'title'})
                title = body['title']
                if not isinstance(title, str) or not 1 <= len(title.strip()) <= 160:
                    raise web.HTTPBadRequest(text='请输入 1–160 字的会话名称')
                await self.anti_json('PATCH', path, {'title': title.strip()})
                return web.json_response({'title': title.strip()})
            if not upload and method == 'DELETE':
                await self.anti_json('DELETE', path)
                return web.Response(status=204)
            raise web.HTTPForbidden()
        match = re.fullmatch(r'/sessions/([A-Za-z0-9_-]{1,128})/runs(?:/([A-Za-z0-9_-]{1,128})(/events|/cancel)?)?', path)
        if not match:
            raise web.HTTPForbidden()
        sid, rid, action = match.groups()
        payload = None
        if method == 'POST' and not rid:
            body = await self.agy_body(request, {'text', 'request_id'}, {'upload_ids', 'model', 'effort'})
            text, ids = body['text'], body.get('upload_ids', [])
            if not isinstance(ids, list) or len(ids) > 8 or any(not isinstance(x, str) for x in ids) or len(set(ids)) != len(ids):
                raise web.HTTPBadRequest(text='附件列表无效')
            if not isinstance(text, str) or len(text) > 6000 or not (text.strip() or ids):
                raise web.HTTPBadRequest(text='请输入指令（最多 6000 字）或添加附件')
            payload = {'prompt': text, 'operation': body['request_id']}
            if 'model' in body:
                model = body['model']
                if not isinstance(model, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,127}', model):
                    raise web.HTTPBadRequest(text='模型无效')
                payload['model'] = model
            if 'effort' in body:
                effort = body['effort']
                if effort not in ('low', 'medium', 'high', 'xhigh', 'max'):
                    raise web.HTTPBadRequest(text='推理强度无效')
                payload['effort'] = effort
            if ids:
                now, owner = time.monotonic(), request.cookies.get(gateway.COOKIE)
                refs = []
                for uid in ids:
                    entry = self.uploads.get((('agy', sid), uid))
                    if not owner or not entry or now - entry[0] >= gateway.TTL or entry[1] != owner:
                        raise web.HTTPBadRequest(text='附件已过期或不属于此会话，请重新上传')
                    refs.append(entry[2])
                payload['attachments'] = refs
        elif not (method == 'GET' and action != '/cancel' or method == 'POST' and action == '/cancel'):
            raise web.HTTPForbidden()
        upstream = path + '?' + request.query_string if event_query else path
        data = await self.anti_json(method, upstream, payload)
        keys = (('seq', 'type', 'text') if action == '/events'
                else ('id', 'status', 'prompt', 'answer', 'error', 'created_at'))
        public = lambda row: {k: row[k] for k in keys if k in row}
        if compact:
            offset = max(0, len(data) - 40)
            return web.json_response({'items': [public(row) for row in data[offset:]], 'offset': offset})
        return web.json_response([public(row) for row in data] if isinstance(data, list) else public(data))

    @staticmethod
    async def agy_body(request, keys, optional=frozenset()):
        try:
            raw = await request.content.readexactly(request.content_length or 0) if 0 < (request.content_length or 0) <= 32768 else b''
            data = json.loads(raw)
            if request.content_type != 'application/json' or not isinstance(data, dict) or not keys <= data.keys() <= keys | optional:
                raise ValueError()
            if 'request_id' in keys and (not isinstance(data['request_id'], str) or not re.fullmatch(r'[a-f0-9-]{36}', data['request_id'])):
                raise ValueError()
            return data
        except (ValueError, asyncio.IncompleteReadError):
            raise web.HTTPBadRequest(text='Invalid Agy request')


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


async def connect_once(server, device, token, backend=None, *, on_connection=None):
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
                if on_connection is not None:
                    on_connection(True)
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
            if on_connection is not None:
                on_connection(False)
            active = list(tasks.values()) + ([pulse] if pulse else [])
            for task in active: task.cancel()
            await asyncio.gather(*active, return_exceptions=True)
            await runner.cleanup()
            await local.close()


async def run(backend=None, *, on_connection=None):
    config = json.loads((STATE / 'device.json').read_text(encoding='utf-8'))
    server = config['server']
    blob = win32cred.CredRead(credential_target(server), 1)['CredentialBlob']
    token = blob.decode('utf-16-le')
    delay = 2
    while True:
        try:
            await connect_once(server, config['device'], token, backend, on_connection=on_connection)
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
