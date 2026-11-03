"""Opt-in Nova connector, owned by the Hub lifespan; legacy tunnel is untouched."""
from __future__ import annotations
import asyncio
import contextlib
import importlib
import json
import secrets
import sys
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel, Field, SecretStr
from .origin_policy import TAURI_UI_ORIGINS

PUBLIC = 'https://nova.lunadash.me'


class NovaAccountRequest(BaseModel):
    username: str = Field(min_length=3, max_length=100)
    password: SecretStr = Field(min_length=10, max_length=256)
    name: str = Field(default='GA-Hub', min_length=1, max_length=80)
    invite: SecretStr | None = None
    confirm: bool = False



class NovaComponent:
    def __init__(self):
        self.connector = None
        self.task = None
        self.pending = None
        self.lock = asyncio.Lock()
        self.nonce = secrets.token_urlsafe(32)
        self.error = None

    def load(self):
        if self.connector is None:
            root = Path(getattr(sys, '_MEIPASS', Path(__file__).resolve().parents[1]))
            sys.path.insert(0, str(root / 'assets' / 'nova'))
            self.connector = importlib.import_module('connector')
        return self.connector

    async def start(self):
        # An unavailable optional connector must never prevent Hub startup.
        try:
            c = self.load()
            if (c.STATE / 'device.json').exists():
                from .runtime_endpoint import runtime_http_origin
                from .constants import DEFAULT_WEBUI_PORT
                self.task = asyncio.create_task(c.run(backend=runtime_http_origin('127.0.0.1', DEFAULT_WEBUI_PORT)), name='nova-connector')
                self.task.add_done_callback(self._done)
        except Exception as exc:
            self.error = type(exc).__name__

    def _done(self, task):
        if not task.cancelled() and task.exception():
            self.error = type(task.exception()).__name__

    async def stop(self):
        if self.task:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
            self.task = None

    def guard(self, r: Request):
        if not r.client or r.client.host not in ('127.0.0.1', '::1', 'testclient'):
            raise HTTPException(403, 'Local configuration only')
        if r.method != 'GET':
            origin = r.headers.get('origin', '')
            if origin not in {str(r.base_url).rstrip('/'), *TAURI_UI_ORIGINS} or not secrets.compare_digest(r.headers.get('x-nova-local', ''), self.nonce):
                raise HTTPException(403, 'Open /nova on this computer to confirm')

    def snapshot(self):
        try:
            c = self.load()
            return {'device': c.identity(), 'paired': (c.STATE / 'device.json').exists(),
                    'running': bool(self.task and not self.task.done()), 'error': self.error, 'server': PUBLIC}
        except Exception as exc:
            return {'error': type(exc).__name__, 'running': False}

    async def account_action(self, body: NovaAccountRequest, unlink=False):
        if not body.confirm:
            raise HTTPException(400, '请先确认远程操作授权或撤销操作')
        async with self.lock:
            c = self.load()
            config = c.STATE / 'device.json'
            if config.exists() != unlink:
                raise HTTPException(409, '请先撤销已有绑定' if not unlink else '本机尚未绑定')
            async with c.aiohttp.ClientSession(timeout=c.aiohttp.ClientTimeout(total=30)) as http:
                async def post(path, *, form=None, payload=None, json_result=False):
                    async with http.post(PUBLIC + path, data=form, json=payload,
                                         headers={'Origin': PUBLIC}, allow_redirects=False) as response:
                        if response.status not in (200, 302, 303):
                            raise HTTPException(502, 'Nova请求失败，请检查账号密码、邀请码、网络或稍后重试')
                        if path in ('/login', '/register') and response.status == 200:
                            raise HTTPException(401, '账号登录或注册未成功')
                        return await response.json() if json_result else None
                try:
                    auth = {'name': body.username.strip(), 'password': body.password.get_secret_value()}
                    if body.invite and not unlink:
                        auth['invite'] = body.invite.get_secret_value()
                    await post('/register' if 'invite' in auth else '/login', form=auth)
                    if unlink:
                        async with http.get(PUBLIC + '/v1/me') as response:
                            response.raise_for_status()
                            devices = await response.json()
                        rows = devices.get('devices', [])
                        data = json.loads(config.read_text(encoding='utf-8'))
                        owned = next((d for d in rows if d.get('id') == c.identity()), None)
                        # Persist confirmed cloud revocation before touching Credential Manager.
                        # /v1/me hides revoked devices; this marker permits a same-owner retry.
                        already_revoked = data.get('revoked_owner') == devices['name']
                        if owned is None and not already_revoked:
                            raise HTTPException(403, '此账号不拥有当前设备，未清除本机绑定')
                        if owned is not None:
                            await post('/v1/devices/' + c.identity() + '/revoke', form={})
                            data['revoked_owner'] = devices['name']
                            staged = config.with_suffix('.new')
                            staged.write_text(json.dumps(data), encoding='utf-8')
                            staged.replace(config)
                        await self.stop()
                        # If credential deletion fails, retain configuration for a safe retry.
                        c.win32cred.CredDelete(c.credential_target(data['server']), 1)
                        config.unlink()
                    else:
                        pending = await post('/v1/agent/pair/start', payload={'name': body.name}, json_result=True)
                        await post('/v1/pair/approve', payload={'code': pending['code']})
                        token = secrets.token_urlsafe(48)
                        done = await post('/v1/agent/pair/finish', payload={
                            'code': pending['code'], 'secret': pending['secret'],
                            'token': token, 'device_id': c.identity()}, json_result=True)
                        c.save_pair(PUBLIC, done['device'], body.name, token)
                        self.error = None
                        await self.stop()
                        await self.start()
                    self.pending = None
                    if unlink:
                        self.error = None
                    return self.snapshot()
                except HTTPException:
                    raise
                except Exception as exc:
                    raise HTTPException(502, 'Nova操作未完成，请检查网络或本机凭据服务') from exc
                finally:
                    with contextlib.suppress(Exception):
                        await post('/logout', form={})

    def router(self):
        router = APIRouter()

        @router.get('/nova', response_class=HTMLResponse)
        async def page(r: Request):
            self.guard(r)
            return HTMLResponse(PAGE.replace('__NONCE__', self.nonce), headers={'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'"})

        @router.get('/nova/status')
        async def status(r: Request):
            self.guard(r)
            try:
                c = self.load()
                config = c.STATE / 'device.json'
                return {'device': c.identity(), 'paired': config.exists(), 'running': bool(self.task and not self.task.done()), 'error': self.error, 'server': PUBLIC}
            except Exception as exc:
                return {'error': type(exc).__name__, 'running': False}

        @router.post('/nova/unpair')
        async def unpair(r: Request):
            self.guard(r)
            async with self.lock:
                c = self.load()
                await self.stop()
                config = c.STATE / 'device.json'
                if config.exists():
                    data = json.loads(config.read_text(encoding='utf-8'))
                    with contextlib.suppress(Exception):
                        c.win32cred.CredDelete(c.credential_target(data['server']), 1)
                    config.unlink()
                self.pending = None
                self.error = None
                return {'paired': False, 'device': c.identity()}

        @router.post('/nova/pair/start')
        async def start_pair(r: Request):
            self.guard(r)
            async with self.lock:
                c = self.load()
                if (c.STATE / 'device.json').exists():
                    raise HTTPException(409, 'Already paired; revoke the device in Nova before rebinding')
                body = await r.json()
                name = str(body.get('name', 'GA-Hub'))[:80].strip() or 'GA-Hub'
                async with c.aiohttp.ClientSession(timeout=c.aiohttp.ClientTimeout(total=20)) as http:
                    async with http.post(PUBLIC + '/v1/agent/pair/start', json={'name': name}) as response:
                        response.raise_for_status()
                        data = await response.json()
                self.pending = {**data, 'name': name}
                return {'code': data['code'], 'confirm_url': PUBLIC + '/devices', 'device': c.identity()}

        @router.post('/nova/pair/finish')
        async def finish_pair(r: Request):
            self.guard(r)
            async with self.lock:
                c = self.load()
                if not self.pending:
                    raise HTTPException(409, 'Start pairing first')
                p = self.pending
                async with c.aiohttp.ClientSession(timeout=c.aiohttp.ClientTimeout(total=20)) as http:
                    async with http.post(PUBLIC + '/v1/agent/pair/poll', json={'code': p['code'], 'secret': p['secret']}) as response:
                        response.raise_for_status()
                        approved = await response.json()
                    if approved.get('status') != 'approved':
                        raise HTTPException(409, 'Approve the pairing code in your Nova account first')
                    token = secrets.token_urlsafe(48)
                    async with http.post(PUBLIC + '/v1/agent/pair/finish', json={'code': p['code'], 'secret': p['secret'], 'token': token, 'device_id': c.identity()}) as response:
                        if response.status != 200:
                            raise HTTPException(response.status, (await response.text())[:200])
                        done = await response.json()
                c.save_pair(PUBLIC, done['device'], p['name'], token)
                self.pending = None
                self.error = None
                await self.stop()
                await self.start()
                return {'paired': True, 'device': done['device']}

        @router.get('/nova/settings')
        async def settings(r: Request):
            self.guard(r)
            return JSONResponse({**self.snapshot(), 'local_token': self.nonce}, headers={'Cache-Control': 'no-store'})

        @router.post('/nova/associate')
        async def associate(r: Request, body: NovaAccountRequest):
            self.guard(r)
            return await self.account_action(body)

        @router.post('/nova/revoke')
        async def revoke(r: Request, body: NovaAccountRequest):
            self.guard(r)
            return await self.account_action(body, unlink=True)

        @router.post('/nova/reconnect')
        async def reconnect(r: Request):
            self.guard(r)
            async with self.lock:
                await self.stop()
                self.error = None
                await self.start()
                return self.snapshot()

        return router


PAGE = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nova 连接设置</title><style>body{font:16px system-ui;max-width:720px;margin:40px auto;padding:20px;background:#111827;color:#e5e7eb}button,input{font:inherit;padding:10px;margin:8px 0}a{color:#93c5fd}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>Nova 远程连接</h1><p>此配置入口仅限本机。旧隧道和手机操作页面保持不变。</p><pre id="state">加载中…</pre><p><a href="https://nova.lunadash.me/devices" target="_blank" rel="noopener">打开 Nova 账号与设备页</a></p><input id="name" placeholder="电脑名称" value="GA-Hub"><br><button id="start">1. 生成配对码</button><pre id="pair"></pre><p>在 Nova 登录账号并批准配对码后，确认允许该账号远程操作本机：</p><button id="finish">2. 我确认授权，完成绑定</button><pre id="message"></pre><p>更换账号前，请先在云端撤销设备，再清除本机绑定。固定编码不会改变。</p><button id="unpair">清除本机绑定</button><script>
const $=id=>document.getElementById(id);
async function call(path,data){const r=await fetch('/nova/'+path,data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-Nova-Local':'__NONCE__'},body:JSON.stringify(data)});const result=await r.json();if(!r.ok)throw Error(JSON.stringify(result));return result;}
async function status(){try{const s=await call('status');$('state').textContent='固定编码：'+(s.device||'不可用')+'\\n已绑定：'+!!s.paired+'\\n连接器运行：'+!!s.running+'\\n'+(s.error||'')+'\\n实际在线状态请查看 Nova 设备页';$('start').disabled=!!s.paired;}catch(e){$('state').textContent=e.message;}}
$('start').onclick=async()=>{try{const s=await call('pair/start',{name:$('name').value});$('pair').textContent='配对码：'+s.code+'（10 分钟有效）\\n请在 Nova 账号页面批准。';}catch(e){$('message').textContent=e.message;}};
$('finish').onclick=async()=>{try{await call('pair/finish',{});$('message').textContent='绑定完成。以后随 GA-Hub 自动启动。';await status();}catch(e){$('message').textContent=e.message;}};
$('unpair').onclick=async()=>{if(!confirm('先确认云端已撤销设备。清除本机绑定并停止 Nova？'))return;try{await call('unpair',{});await status();$('message').textContent='本机绑定已清除，固定编码保留。';}catch(e){$('message').textContent=e.message;}};
status();setInterval(status,5000);
</script></html>'''
