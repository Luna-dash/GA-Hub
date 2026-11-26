"""Local-only HTTP routes for the opt-in Nova connector."""
from __future__ import annotations

import asyncio
import secrets

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel, Field, SecretStr

from ..origin_policy import TAURI_UI_ORIGINS
from ..services.nova_service import NovaService, NovaServiceError


class NovaAccountRequest(BaseModel):
    username: str = Field(min_length=3, max_length=100)
    password: SecretStr = Field(min_length=10, max_length=256)
    name: str = Field(default="GA-Hub", min_length=1, max_length=80)
    invite: SecretStr | None = None
    confirm: bool = False


class NovaStatusResp(BaseModel):
    model_config = {"extra": "allow"}

    device: str | None = None
    device_name: str | None = None
    paired: bool | None = None
    running: bool = False
    connected: bool = False
    paused: bool = False
    rtt_ms: int | None = None
    last_connected_at: float | None = None
    error: str | None = None
    error_detail: str | None = None
    connector_version: str | None = None
    server: str | None = None
    local_token: str | None = None


def _guard(request: Request, nonce: str) -> None:
    if not request.client or request.client.host not in ("127.0.0.1", "::1", "testclient"):
        raise HTTPException(403, "Local configuration only")
    if request.method != "GET":
        origin = request.headers.get("origin", "")
        if origin not in {str(request.base_url).rstrip("/"), *TAURI_UI_ORIGINS} or not secrets.compare_digest(
            request.headers.get("x-nova-local", ""),
            nonce,
        ):
            raise HTTPException(403, "Open /nova on this computer to confirm")


async def _run(coro):
    try:
        return await coro
    except NovaServiceError as exc:
        raise HTTPException(exc.status, exc.detail) from exc


def build_nova_router(service: NovaService) -> APIRouter:
    router = APIRouter()

    @router.get("/nova", response_class=HTMLResponse)
    async def page(r: Request):
        _guard(r, service.nonce)
        return HTMLResponse(
            PAGE.replace("__NONCE__", service.nonce),
            headers={
                "Cache-Control": "no-store",
                "X-Frame-Options": "DENY",
                "Content-Security-Policy": (
                    "default-src 'none'; script-src 'unsafe-inline'; "
                    "style-src 'unsafe-inline'; connect-src 'self'; "
                    "form-action 'none'; frame-ancestors 'none'"
                ),
            },
        )

    @router.get("/nova/status")
    async def status(r: Request):
        _guard(r, service.nonce)
        return await asyncio.to_thread(service.snapshot)

    @router.post("/nova/unpair")
    async def unpair(r: Request):
        _guard(r, service.nonce)
        return await _run(service.unpair())

    @router.post("/nova/pair/start")
    async def start_pair(r: Request):
        _guard(r, service.nonce)

        async def read_name() -> str:
            body = await r.json()
            return str(body.get("name", "GA-Hub"))[:80].strip() or "GA-Hub"

        return await _run(service.start_pair(read_name))

    @router.post("/nova/pair/finish")
    async def finish_pair(r: Request):
        _guard(r, service.nonce)
        return await _run(service.finish_pair())

    @router.get("/nova/settings", response_model=NovaStatusResp)
    async def settings(r: Request):
        _guard(r, service.nonce)
        return JSONResponse(
            {**(await asyncio.to_thread(service.snapshot)), "local_token": service.nonce},
            headers={"Cache-Control": "no-store"},
        )

    @router.post("/nova/associate", response_model=NovaStatusResp)
    async def associate(r: Request, body: NovaAccountRequest):
        _guard(r, service.nonce)
        return await _run(
            service.account_action(
                username=body.username,
                password=body.password.get_secret_value(),
                name=body.name,
                invite=body.invite.get_secret_value() if body.invite else None,
                confirm=body.confirm,
            )
        )

    @router.post("/nova/revoke", response_model=NovaStatusResp)
    async def revoke(r: Request, body: NovaAccountRequest):
        _guard(r, service.nonce)
        return await _run(
            service.account_action(
                username=body.username,
                password=body.password.get_secret_value(),
                name=body.name,
                confirm=body.confirm,
                unlink=True,
            )
        )

    @router.post("/nova/reconnect", response_model=NovaStatusResp)
    async def reconnect(r: Request):
        _guard(r, service.nonce)
        return await _run(service.reconnect())

    @router.post("/nova/pause", response_model=NovaStatusResp)
    async def pause(r: Request):
        _guard(r, service.nonce)
        return await _run(service.pause())

    @router.post("/nova/resume", response_model=NovaStatusResp)
    async def resume(r: Request):
        _guard(r, service.nonce)
        return await _run(service.resume())

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
