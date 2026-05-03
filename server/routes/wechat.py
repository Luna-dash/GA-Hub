"""WeChat bot routes."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ..schemas import WxAllowlistReq, WxSendReq
from ..services.agent_service import AgentService
from ..services.wechat_service import WeChatService

router = APIRouter()


def svc() -> WeChatService:
    return WeChatService.instance(AgentService.instance())


@router.get("/api/wechat/status")
async def status():
    return svc().status()


@router.post("/api/wechat/login")
async def login():
    """Begin QR login flow. Frontend should subscribe to /ws/events?prefix=wechat: for QR updates."""
    return svc().start_qr_login()


@router.post("/api/wechat/logout")
async def logout():
    svc().logout()
    return {"ok": True}


@router.post("/api/wechat/poll/start")
async def start_polling():
    return {"started": svc().start_polling()}


@router.post("/api/wechat/poll/stop")
async def stop_polling():
    svc().stop_polling()
    return {"ok": True}


@router.get("/api/wechat/contacts")
async def contacts():
    return {"contacts": svc().list_contacts()}


@router.get("/api/wechat/messages")
async def messages(uid: str | None = None, limit: int = 200):
    return {"messages": svc().get_messages(uid=uid, limit=min(limit, 1000))}


@router.post("/api/wechat/send")
async def send(req: WxSendReq):
    s = svc()
    if not s.bot.has_token:
        raise HTTPException(400, "wechat not logged in")
    if req.text:
        s.send_text(req.uid, req.text, req.context_token)
    if req.file_path:
        s.send_file(req.uid, req.file_path, req.context_token)
    if not req.text and not req.file_path:
        raise HTTPException(400, "text or file_path required")
    return {"ok": True}


@router.get("/api/wechat/allowlist")
async def get_allowlist():
    return {"allowlist": sorted(svc().allowlist) if svc().allowlist != {"*"} else ["*"]}


@router.put("/api/wechat/allowlist")
async def put_allowlist(req: WxAllowlistReq):
    svc().set_allowlist(req.allowlist)
    return {"ok": True, "allowlist": sorted(svc().allowlist)}
