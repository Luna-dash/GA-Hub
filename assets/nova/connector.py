"""Windows GA-Hub connector. Credentials stay in Windows Credential Manager."""
import argparse
import asyncio
import base64
import contextlib
import hashlib
import json
import os
import random
import re
from pathlib import Path
import secrets
import sys
import time
from urllib.parse import urlsplit
import zlib

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

CONNECTOR_VERSION = '2.0.0'
PROTOCOL_VERSION = 2
FRAME_MAGIC = b'NV'
FRAME_REQ_CHUNK = 1
FRAME_RESP_CHUNK = 2
FLAG_GZIP = 1
CAPABILITIES = (
    'binary',
    'credit_flow',
    'gzip',
    'extended_transfers',
    'image_previews',
    'agy_stream',
    'agy_acp_v2',
)


class ConnectorAuthError(RuntimeError):
    pass


class ConnectorConflictError(RuntimeError):
    pass


def pack_frame(frame_type: int, rid_hex: str, payload: bytes, flags: int = 0) -> bytes:
    return FRAME_MAGIC + bytes((frame_type, flags)) + bytes.fromhex(rid_hex) + payload


def unpack_frame(raw: bytes) -> tuple[int, int, str, bytes]:
    if len(raw) < 20 or raw[:2] != FRAME_MAGIC:
        raise ValueError('Invalid binary relay frame')
    return raw[2], raw[3], raw[4:20].hex(), raw[20:]


def _is_hex_rid(value) -> bool:
    return isinstance(value, str) and len(value) == 32 and all(c in '0123456789abcdefABCDEF' for c in value)


def acquire_instance_lock(state_dir=None):
    root = Path(state_dir) if state_dir is not None else STATE
    root.mkdir(parents=True, exist_ok=True)
    lock_path = root / 'connector.lock'
    handle = lock_path.open('a+b')
    try:
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b'1')
            handle.flush()
        handle.seek(0)
        if os.name == 'nt':
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return handle
    except OSError as exc:
        with contextlib.suppress(Exception):
            handle.close()
        raise ConnectorConflictError('检测到另一个 Nova 连接器正在运行，请先关闭重复实例。') from exc


def release_instance_lock(handle):
    if handle is None:
        return
    try:
        if os.name == 'nt':
            import msvcrt
            with contextlib.suppress(OSError):
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            with contextlib.suppress(OSError):
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    finally:
        with contextlib.suppress(Exception):
            handle.close()


_STEP_KEYS = ('index', 'kind', 'state', 'tool', 'duration_seconds', 'text_delta', 'detail', 'command', 'exit_code', 'diff')
_USAGE_KEYS = ('input_tokens', 'output_tokens', 'cache_read_tokens', 'thinking_tokens')
_SESSION_KEYS = ('id', 'project', 'title', 'updated_at', 'active_run_id', 'acp_connected', 'has_conversation')
_APPROVAL_KEYS = ('id', 'title', 'details', 'diff', 'prompt_type', 'allow_always', 'security_warning', 'question')
_QUOTA_KEYS = ('model_group', 'display_name', 'status', 'cooldown_remaining_seconds',
               'window_5h_pct', 'window_7d_pct', 'calibrated_remaining_pct')


def _public_dict(raw, keys):
    return {k: raw[k] for k in keys if k in raw} if isinstance(raw, dict) else None


def _public_agy_event(row):
    if not isinstance(row, dict):
        return None
    out = {k: row[k] for k in ('seq', 'type', 'text', 'status', 'error') if k in row}
    step = _public_dict(row.get('step'), _STEP_KEYS)
    if step:
        out['step'] = step
    approval = _public_dict(row.get('approval'), _APPROVAL_KEYS)
    if approval:
        out['approval'] = approval
    return out


def _public_session(row):
    return {k: row.get(k) for k in _SESSION_KEYS if k in row or k in ('id', 'project', 'title', 'updated_at', 'active_run_id')}


def _public_profile(row):
    usage = row.get('usage') if isinstance(row.get('usage'), dict) else {}
    out = {
        'id': row.get('id'),
        'name': row.get('name'),
        'has_credentials': bool(row.get('has_credentials')),
        'auth_state': row.get('auth_state'),
    }
    if isinstance(row.get('cooldown_seconds'), int) and row['cooldown_seconds'] > 0:
        out['cooldown_seconds'] = row['cooldown_seconds']
    if isinstance(usage.get('min_remaining_pct'), (int, float)):
        out['min_remaining_pct'] = usage['min_remaining_pct']
    return out


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
        self.agy_creations = {}
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

    async def anti_json(self, method, path, payload=None, *, action=None):
        base = await self.backend()
        headers = {'Origin': base}
        if action:
            headers['X-GA-Hub-Action'] = action
        try:
            async with self.http.request(method, base + '/api/anti' + path, json=payload,
                                         headers=headers, allow_redirects=False,
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
        if (method, path) in {('GET', '/daemon'), ('POST', '/daemon/start'), ('POST', '/daemon/stop')}:
            if request.can_read_body:
                raise web.HTTPBadRequest(text='Agy 启停接口不接受请求正文')
            target, action = {
                '/daemon': ('/status', None),
                '/daemon/start': ('/start', 'start-anti'),
                '/daemon/stop': ('/stop', 'stop-anti'),
            }[path]
            result = await self.anti_json(method, target, action=action)
            return web.json_response({key: result.get(key) for key in ('state', 'managed', 'active_count')})
        if method == 'GET' and path == '/models':
            result = await self.anti_json('GET', path)
            return web.json_response({'items': [{k: row[k] for k in ('id', 'display_name')} for row in result['items']]})
        if method == 'GET' and path == '/profiles':
            result = await self.anti_json('GET', '/profiles')
            return web.json_response({
                'active': result.get('active'),
                'profiles': [_public_profile(row) for row in result.get('profiles', []) if isinstance(row, dict)],
            })
        if method == 'GET' and path == '/quota':
            rows = await self.anti_json('GET', '/quota')
            return web.json_response([_public_dict(row, _QUOTA_KEYS) for row in rows if isinstance(row, dict)])
        if method == 'GET' and path == '/projects':
            try:
                catalog = await self.project_catalog()
            except (aiohttp.ClientError, asyncio.TimeoutError, ValueError):
                raise web.HTTPBadGateway(text='项目列表读取失败')
            return web.json_response({'items': [{'id': k, 'name': v['label']} for k, v in catalog.items()]})
        if path == '/sessions' and method == 'GET':
            rows = await self.anti_json('GET', path)
            return web.json_response([_public_session(row) for row in rows])
        if method == 'POST' and path == '/sessions':
            body = await self.agy_body(request, {'project_id', 'request_id'})
            catalog = await self.project_catalog()
            project = catalog.get(body['project_id']) if isinstance(body['project_id'], str) else None
            if not project:
                raise web.HTTPBadRequest(text='请选择已登记项目')
            # Coalesce an uncertain response within the lifetime of this connector
            # without sharing Gateway.submissions' 3-tuple chat submission schema.
            now = time.monotonic()
            self.agy_creations = {
                k: v for k, v in self.agy_creations.items()
                if not v[2].done() or now - v[0] < gateway.TTL
            }
            key = (request.cookies.get(gateway.COOKIE), body['request_id'])
            if key not in self.agy_creations:
                if len(self.agy_creations) >= 512:
                    self.agy_creations.pop(next(iter(self.agy_creations)))
                task = asyncio.create_task(self.anti_json('POST', path, {'project': project['name']}))
                self.agy_creations[key] = (now, body['project_id'], task)
            _, project_id, task = self.agy_creations[key]
            if project_id != body['project_id']:
                raise web.HTTPConflict(text='创建请求与原项目不一致')
            try:
                row = await asyncio.shield(task)
            except BaseException:
                if task.done() and self.agy_creations.get(key, (None, None, None))[2] is task:
                    self.agy_creations.pop(key, None)
                raise
            return web.json_response({'id': row['id']})
        session = re.fullmatch(r'/sessions/([A-Za-z0-9_-]{1,128})(/upload|/reset)?', path)
        if session:
            sid, suffix = session.groups()
            if suffix == '/upload' and method == 'POST':
                return await self.upload(request, scope=('agy', sid))
            if suffix == '/reset' and method == 'POST':
                if request.can_read_body:
                    raise web.HTTPBadRequest(text='Agy 重连接口不接受请求正文')
                row = await self.anti_json('POST', path)
                return web.json_response(_public_session(row))
            if not suffix and method == 'PATCH':
                body = await self.agy_body(request, {'title'})
                title = body['title']
                if not isinstance(title, str) or not 1 <= len(title.strip()) <= 160:
                    raise web.HTTPBadRequest(text='请输入 1–160 字的会话名称')
                await self.anti_json('PATCH', path, {'title': title.strip()})
                return web.json_response({'title': title.strip()})
            if not suffix and method == 'DELETE':
                await self.anti_json('DELETE', path)
                return web.Response(status=204)
            raise web.HTTPForbidden()
        match = re.fullmatch(r'/sessions/([A-Za-z0-9_-]{1,128})/runs(?:/([A-Za-z0-9_-]{1,128})(/events|/cancel|/approval)?)?', path)
        if not match:
            raise web.HTTPForbidden()
        sid, rid, action = match.groups()
        payload = None
        if method == 'POST' and not rid:
            body = await self.agy_body(request, {'text', 'request_id'}, {'upload_ids', 'model', 'effort', 'mode', 'permission_mode'})
            text, ids = body['text'], body.get('upload_ids', [])
            if not isinstance(ids, list) or len(ids) > 8 or any(not isinstance(x, str) for x in ids) or len(set(ids)) != len(ids):
                raise web.HTTPBadRequest(text='附件列表无效')
            if not isinstance(text, str) or len(text) > 6000 or not (text.strip() or ids):
                raise web.HTTPBadRequest(text='请输入指令（最多 6000 字）或添加附件')
            payload = {'prompt': text, 'operation': body['request_id']}
            if 'mode' in body:
                if body['mode'] not in ('plan', 'accept-edits'):
                    raise web.HTTPBadRequest(text='Agy 模式无效')
                payload['mode'] = body['mode']
            if 'permission_mode' in body:
                if body['permission_mode'] not in ('approval-required', 'auto-accept-edits', 'auto', 'full-access'):
                    raise web.HTTPBadRequest(text='Agy 权限策略无效')
                payload['permission_mode'] = body['permission_mode']
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
        elif method == 'POST' and action == '/approval':
            body = await self.agy_body(request, {'approval_id', 'decision'}, {'option_id'})
            if (not isinstance(body['approval_id'], str) or not re.fullmatch(r'[a-f0-9]{32}', body['approval_id'])
                    or body['decision'] not in ('allow', 'allow_always', 'reject')):
                raise web.HTTPBadRequest(text='审批参数无效')
            payload = {'approval_id': body['approval_id'], 'decision': body['decision']}
            if 'option_id' in body:
                opt = body['option_id']
                if not isinstance(opt, str) or not 1 <= len(opt) <= 256 or any(ord(c) < 32 for c in opt):
                    raise web.HTTPBadRequest(text='审批选项无效')
                payload['option_id'] = opt
        elif not (method == 'GET' and action not in ('/cancel', '/approval') or method == 'POST' and action == '/cancel'):
            raise web.HTTPForbidden()
        upstream = path + '?' + request.query_string if event_query else path
        data = await self.anti_json(method, upstream, payload, **({"action": "approve-agy"} if action == "/approval" else {}))

        def public_run(row):
            out = {k: row[k] for k in ('id', 'status', 'prompt', 'answer', 'error', 'created_at', 'mode', 'permission_mode') if k in row}
            usage = _public_dict(row.get('usage'), _USAGE_KEYS)
            if usage:
                out['usage'] = usage
            if rid and isinstance(row.get('approval'), dict):
                out['approval'] = _public_dict(row['approval'], _APPROVAL_KEYS)
            return out

        public = _public_agy_event if action == '/events' else public_run
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
    async with aiohttp.ClientSession(trust_env=True, timeout=aiohttp.ClientTimeout(total=30)) as http:
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


class LocalGatewayRuntime:
    """Persistent local gateway and loopback HTTP pool shared across WS reconnects."""

    def __init__(self, backend=None):
        self.backend = backend
        self.local = LocalGateway()
        self.local.fixed_backend = backend
        self.local.http = None
        self.local_http = None
        self.runner = None
        self.site = None
        self.port = None

    async def start(self):
        if self.port is not None:
            return
        self.local.http = aiohttp.ClientSession(
            trust_env=False,
            timeout=aiohttp.ClientTimeout(total=120),
        )
        self.local_http = aiohttp.ClientSession(
            trust_env=False,
            read_bufsize=1024 * 1024,
            connector=aiohttp.TCPConnector(limit=64),
            timeout=aiohttp.ClientTimeout(total=None, sock_connect=10),
        )
        app = web.Application(client_max_size=26 * 1024 * 1024)
        app.router.add_route('*', '/{tail:.*}', self.local.handle)
        self.runner = web.AppRunner(app, access_log=None)
        await self.runner.setup()
        self.site = web.TCPSite(self.runner, '127.0.0.1', 0)
        await self.site.start()
        self.port = self.site._server.sockets[0].getsockname()[1]

    async def close(self):
        if self.local_http is not None:
            await self.local_http.close()
            self.local_http = None
        if self.runner is not None:
            await self.runner.cleanup()
            self.runner = None
            self.site = None
            self.port = None
        if self.local.http is not None:
            await self.local.close()
            self.local.http = None
        else:
            await self.local.progress_hub.close()


async def connect_once(
    server,
    device,
    token,
    backend=None,
    *,
    on_connection=None,
    local_runtime=None,
    on_heartbeat=None,
):
    owns_runtime = local_runtime is None
    runtime = LocalGatewayRuntime(backend) if owns_runtime else local_runtime
    await runtime.start()
    local = runtime.local
    local_http = runtime.local_http
    port = runtime.port
    http_tasks = {}
    ws_tasks = {}
    open_streams = set()
    req_queues = {}
    out_credits = {}
    negotiated = 1
    health_supported = True
    ping_sent_at = None
    last_ready = False

    async def probe_ready():
        nonlocal health_supported
        try:
            base = await local.backend()
            if health_supported:
                async with local_http.get(
                    base + '/api/health',
                    headers={'Origin': base},
                    timeout=aiohttp.ClientTimeout(total=4),
                ) as check:
                    if check.status == 200:
                        info = await check.json()
                        return info.get('status') != 'unavailable'
                    if check.status == 404:
                        health_supported = False
            async with local_http.get(
                base + '/api/sessions',
                headers={'Origin': base},
                timeout=aiohttp.ClientTimeout(total=4),
            ) as check:
                return check.status == 200
        except (aiohttp.ClientError, OSError, asyncio.TimeoutError, ValueError, web.HTTPException):
            return False

    try:
        async with aiohttp.ClientSession(
            trust_env=True,
            timeout=aiohttp.ClientTimeout(total=None, sock_connect=30),
        ) as cloud_http:
            async def process(ws, data, req_queue=None):
                rid = data['id']
                is_ws = data.get('kind') == 'ws_open'
                try:
                    path = str(data['path'])
                    if not path.startswith('/api/') or path.startswith('//') or '\\' in path or '#' in path or '\r' in path or '\n' in path:
                        raise ValueError('Invalid path')
                    # Never accept an origin, destination, local port or Authorization from cloud.
                    headers = {'Authorization': 'Bearer ' + local.local_secret, 'Origin': 'https://' + gateway.PUBLIC}
                    source = data.get('headers', {})
                    if source.get('Content-Type'): headers['Content-Type'] = source['Content-Type']
                    if source.get('Range'): headers['Range'] = source['Range']
                    if data.get('method') == 'GET' and source.get('If-None-Match'):
                        headers['If-None-Match'] = source['If-None-Match']
                    # Stable, opaque per-browser owner; don't forward cloud session credential.
                    owner = str(source.get('X-Nova-Owner', ''))
                    if len(owner) != 64 or any(c not in '0123456789abcdef' for c in owner): raise ValueError('Invalid owner')
                    headers['Cookie'] = gateway.COOKIE + '=' + owner

                    if is_ws:
                        chat_live = re.fullmatch(r'/api/sessions/([A-Za-z0-9_-]+)/live', path)
                        agy_live = re.fullmatch(
                            r'/api/agy/sessions/([A-Za-z0-9_-]{1,128})/runs/([A-Za-z0-9_-]{1,128})/live(?:\?after=([0-9]{1,15}))?',
                            path,
                        )
                        if chat_live:
                            import copy
                            sid = chat_live.group(1)
                            base = await local.backend()
                            channel = await local.progress_hub.get(base, sid)
                            queue = asyncio.Queue(maxsize=1)
                            channel.listeners.add(queue)
                            open_streams.add(rid)
                            try:
                                await ws.send_json({'kind': 'ws_opened', 'id': rid})

                                async def push_snapshot(frame):
                                    payload = copy.deepcopy(frame)
                                    local.artifacts.decorate(payload, sid, owner)
                                    await ws.send_json({'kind': 'ws_text', 'id': rid, 'data': json.dumps(payload)})

                                await push_snapshot(channel.latest)
                                while True:
                                    update = await queue.get()
                                    if update is None:
                                        break
                                    await push_snapshot(update)
                            finally:
                                open_streams.discard(rid)
                                channel.listeners.discard(queue)
                                channel.last_used = time.monotonic()
                            with contextlib.suppress(Exception):
                                await ws.send_json({'kind': 'ws_closed', 'id': rid})
                            return

                        if agy_live:
                            sid, run_id, after = agy_live.groups()
                            base = await local.backend()
                            stream_url = f'{base}/api/anti/sessions/{sid}/runs/{run_id}/events/stream'
                            if after and int(after) > 0:
                                stream_url += f'?after={int(after)}'
                            async with local_http.get(stream_url, headers={'Origin': base}) as sse_resp:
                                if sse_resp.status != 200:
                                    raise ValueError(f'SSE status {sse_resp.status}')
                                open_streams.add(rid)
                                try:
                                    await ws.send_json({'kind': 'ws_opened', 'id': rid})
                                    data_lines = []
                                    async for raw_line in sse_resp.content:
                                        line = raw_line.decode('utf-8', errors='replace').rstrip('\r\n')
                                        if not line:
                                            if data_lines:
                                                raw_json = '\n'.join(data_lines)
                                                data_lines.clear()
                                                try:
                                                    evt = _public_agy_event(json.loads(raw_json))
                                                except ValueError:
                                                    evt = None
                                                if evt:
                                                    await ws.send_json({'kind': 'ws_text', 'id': rid, 'data': json.dumps(evt)})
                                        elif line.startswith('data:'):
                                            data_lines.append(line[5:].lstrip(' '))
                                    if data_lines:
                                        try:
                                            evt = _public_agy_event(json.loads('\n'.join(data_lines)))
                                        except ValueError:
                                            evt = None
                                        if evt:
                                            await ws.send_json({'kind': 'ws_text', 'id': rid, 'data': json.dumps(evt)})
                                finally:
                                    open_streams.discard(rid)
                            with contextlib.suppress(Exception):
                                await ws.send_json({'kind': 'ws_closed', 'id': rid})
                            return

                        raise ValueError('Invalid live path')

                    use_binary = negotiated >= 2 and _is_hex_rid(rid)
                    credit_state = None
                    if use_binary:
                        init_credits = max(1, int(data.get('credits', 8)))
                        ev = asyncio.Event()
                        ev.set()
                        credit_state = {'count': init_credits, 'event': ev}
                        out_credits[rid] = credit_state

                    async def send_resp_chunk(chunk_bytes: bytes, flags: int = 0):
                        if not use_binary:
                            await ws.send_json({'kind': 'chunk', 'id': rid, 'data': base64.b64encode(chunk_bytes).decode()})
                            return
                        offset = 0
                        total = len(chunk_bytes)
                        while offset < total:
                            piece = chunk_bytes[offset:offset + 65536]
                            offset += len(piece)
                            while credit_state['count'] <= 0:
                                credit_state['event'].clear()
                                if credit_state['count'] <= 0:
                                    await credit_state['event'].wait()
                            credit_state['count'] -= 1
                            if credit_state['count'] <= 0:
                                credit_state['event'].clear()
                            await ws.send_bytes(pack_frame(FRAME_RESP_CHUNK, rid, piece, flags))

                    if req_queue is not None:
                        async def body_stream():
                            total = 0
                            acked = 0
                            while True:
                                item = await req_queue.get()
                                if item is None:
                                    break
                                total += len(item)
                                if total > 26 * 1024 * 1024:
                                    raise ValueError('Body too large')
                                yield item
                                acked += 1
                                if acked >= 4:
                                    acked = 0
                                    with contextlib.suppress(Exception):
                                        await ws.send_json({'kind': 'window_ack', 'id': rid, 'credits': 4})

                        req_data = body_stream()
                    else:
                        body = base64.b64decode(data.get('body', ''), validate=True)
                        if len(body) > 26 * 1024 * 1024:
                            raise ValueError('Body too large')
                        req_data = body

                    async with local_http.request(
                        data['method'],
                        f'http://127.0.0.1:{port}' + path,
                        data=req_data,
                        headers=headers,
                        allow_redirects=False,
                    ) as response:
                        await ws.send_json({
                            'kind': 'headers',
                            'id': rid,
                            'status': response.status,
                            'headers': {
                                k: v for k, v in response.headers.items()
                                if k.lower() in {'content-type', 'content-disposition', 'content-range', 'accept-ranges', 'etag', 'content-length'}
                            },
                        })
                        is_file_resp = path.startswith('/api/sessions/') and '/artifacts/' in path
                        ctype = response.headers.get('Content-Type', '').lower()
                        cenc = response.headers.get('Content-Encoding', '').lower()
                        want_gzip = (
                            use_binary
                            and bool(data.get('accept_gzip'))
                            and not is_file_resp
                            and 'gzip' not in cenc
                            and ctype.startswith(('application/json', 'text/'))
                        )
                        if not want_gzip:
                            async for chunk in response.content.iter_chunked(64 * 1024):
                                await send_resp_chunk(chunk, 0)
                        else:
                            first = None
                            comp = None
                            async for chunk in response.content.iter_chunked(64 * 1024):
                                if first is None:
                                    first = chunk
                                    continue
                                if comp is None:
                                    comp = zlib.compressobj(level=4, wbits=16 + zlib.MAX_WBITS)
                                    compressed = comp.compress(first)
                                    if compressed:
                                        await send_resp_chunk(compressed, FLAG_GZIP)
                                compressed = comp.compress(chunk)
                                if compressed:
                                    await send_resp_chunk(compressed, FLAG_GZIP)
                            if first is not None:
                                if comp is None and len(first) <= 1024:
                                    await send_resp_chunk(first, 0)
                                else:
                                    if comp is None:
                                        comp = zlib.compressobj(level=4, wbits=16 + zlib.MAX_WBITS)
                                        compressed = comp.compress(first)
                                    else:
                                        compressed = b''
                                    tail = compressed + comp.flush()
                                    if tail:
                                        await send_resp_chunk(tail, FLAG_GZIP)
                        await ws.send_json({'kind': 'end', 'id': rid})
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    with contextlib.suppress(Exception):
                        await ws.send_json({'kind': 'error', 'id': rid, 'error': 'Local request failed: ' + type(e).__name__})
                finally:
                    req_queues.pop(rid, None)
                    out_credits.pop(rid, None)
                    open_streams.discard(rid)
                    if is_ws:
                        ws_tasks.pop(rid, None)
                    else:
                        http_tasks.pop(rid, None)

            async def heartbeat(ws):
                nonlocal ping_sent_at, last_ready
                while True:
                    ready = await probe_ready()
                    last_ready = ready
                    ping_sent_at = time.monotonic()
                    await ws.send_json({'kind': 'ping', 'ready': ready})
                    await asyncio.sleep(5)

            pulse = None
            try:
                async with cloud_http.ws_connect(
                    server + '/v1/agent/connect',
                    headers={
                        'Authorization': 'Bearer ' + token,
                        'X-Nova-Device': device,
                        'X-Nova-Protocol': str(PROTOCOL_VERSION),
                    },
                    heartbeat=25,
                    max_msg_size=55 * 1024 * 1024,
                    compress=0,
                ) as ws:
                    if on_connection is not None:
                        on_connection(True)
                    pulse = asyncio.create_task(heartbeat(ws))
                    print('Nova 已连接，设备：' + device, flush=True)
                    async for msg in ws:
                        if msg.type == WSMsgType.BINARY:
                            try:
                                ftype, _flags, rid_hex, payload = unpack_frame(msg.data)
                            except ValueError:
                                continue
                            if ftype == FRAME_REQ_CHUNK:
                                q = req_queues.get(rid_hex)
                                if q is not None:
                                    try:
                                        q.put_nowait(payload)
                                    except asyncio.QueueFull:
                                        task = http_tasks.get(rid_hex)
                                        if task:
                                            task.cancel()
                            continue
                        if msg.type != WSMsgType.TEXT:
                            break
                        data = json.loads(msg.data)
                        kind = data.get('kind')
                        if kind == 'hello':
                            negotiated = min(PROTOCOL_VERSION, int(data.get('protocol', 1)))
                            if negotiated >= 2:
                                initial_ready = await probe_ready()
                                last_ready = initial_ready
                                await ws.send_json({
                                    'kind': 'hello_ack',
                                    'protocol': negotiated,
                                    'connector_version': CONNECTOR_VERSION,
                                    'platform': sys.platform,
                                    'ready': initial_ready,
                                    'capabilities': list(CAPABILITIES),
                                })
                        elif kind == 'pong':
                            if ping_sent_at is not None and on_heartbeat is not None:
                                rtt_ms = max(0, int((time.monotonic() - ping_sent_at) * 1000))
                                on_heartbeat(ready=last_ready, rtt_ms=rtt_ms)
                                ping_sent_at = None
                        elif kind == 'window_ack':
                            state = out_credits.get(data.get('id'))
                            if state is not None:
                                state['count'] += int(data.get('credits', 0))
                                if state['count'] > 0:
                                    state['event'].set()
                        elif kind == 'ws_open':
                            if len(ws_tasks) >= 16:
                                await ws.send_json({'kind': 'error', 'id': data['id'], 'error': 'Device busy'})
                            else:
                                ws_tasks[data['id']] = asyncio.create_task(process(ws, data))
                        elif kind in ('request', 'request_start'):
                            if len(http_tasks) >= 24:
                                await ws.send_json({'kind': 'error', 'id': data['id'], 'error': 'Device busy'})
                            else:
                                rq = None
                                if kind == 'request_start':
                                    rq = asyncio.Queue(maxsize=16)
                                    req_queues[data['id']] = rq
                                http_tasks[data['id']] = asyncio.create_task(process(ws, data, req_queue=rq))
                        elif kind == 'request_end':
                            q = req_queues.get(data.get('id'))
                            if q is not None:
                                with contextlib.suppress(asyncio.QueueFull):
                                    q.put_nowait(None)
                        elif kind == 'ws_text':
                            rid = data.get('id')
                            if rid in open_streams:
                                with contextlib.suppress(ValueError, TypeError):
                                    if json.loads(data.get('data', '{}')) == {'type': 'ping'}:
                                        await ws.send_json({'kind': 'ws_text', 'id': rid, 'data': '{"type":"pong"}'})
                        elif kind == 'cancel':
                            rid = data.get('id')
                            task = http_tasks.get(rid) or ws_tasks.get(rid)
                            if task:
                                task.cancel()
            finally:
                if on_connection is not None:
                    on_connection(False)
                active = list(http_tasks.values()) + list(ws_tasks.values()) + ([pulse] if pulse else [])
                for task in active:
                    task.cancel()
                await asyncio.gather(*active, return_exceptions=True)
    finally:
        if owns_runtime:
            await runtime.close()


async def run(backend=None, *, on_connection=None, on_heartbeat=None, state_dir=None):
    base_state = Path(state_dir) if state_dir is not None else STATE
    lock_handle = acquire_instance_lock(base_state)
    runtime = LocalGatewayRuntime(backend)
    try:
        config = json.loads((base_state / 'device.json').read_text(encoding='utf-8'))
        server = config['server']
        blob = win32cred.CredRead(credential_target(server), 1)['CredentialBlob']
        token = blob.decode('utf-16-le')
        delay = 2
        while True:
            connected_at = None

            def handle_conn(state: bool):
                nonlocal connected_at
                if state:
                    connected_at = time.monotonic()
                if on_connection is not None:
                    on_connection(state)

            try:
                await connect_once(
                    server,
                    config['device'],
                    token,
                    backend,
                    on_connection=handle_conn,
                    local_runtime=runtime,
                    on_heartbeat=on_heartbeat,
                )
            except aiohttp.WSServerHandshakeError as e:
                if e.status in (401, 403):
                    raise ConnectorAuthError('设备已撤销或凭证无效，请重新配对。') from e
                print('连接暂不可用：' + type(e).__name__, flush=True)
            except asyncio.CancelledError:
                raise
            except (aiohttp.ClientError, OSError, asyncio.TimeoutError) as e:
                print('连接中断：' + type(e).__name__, flush=True)
            except Exception as e:
                print('连接异常，稍后重试：' + type(e).__name__, flush=True)

            if connected_at is not None and time.monotonic() - connected_at >= 10.0:
                delay = 2
            await asyncio.sleep(random.uniform(delay * 0.5, delay))
            delay = min(60, delay * 2)
    finally:
        await runtime.close()
        release_instance_lock(lock_handle)


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
