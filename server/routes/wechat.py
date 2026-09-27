"""WeChat bot routes."""
from __future__ import annotations

import asyncio
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from ..schemas import (
    WxAllowlistReq,
    WxAllowlistResp,
    WxAllowlistWriteResp,
    WxContactListResp,
    WxLogListResp,
    WxLogoutResp,
    WxPollStartResp,
    WxPollStopResp,
    WxQRState,
    WxSendReq,
    WxSendResp,
    WxStatusResp,
)
from ..services.session_lifecycle import SessionLifecycle, session_lifecycle_of
from ..services.wechat_service import WeChatService

router = APIRouter()


def _request_lifecycle(request: Request) -> SessionLifecycle:
    return session_lifecycle_of(request.app)


# The session domain is owned by the composition root and bound to the app
# (server.main). Resolving it here is what retired the sibling-route import
# this module used to need for service location.
SessionDomain = Annotated[SessionLifecycle, Depends(_request_lifecycle)]


def svc(lifecycle: SessionLifecycle) -> WeChatService:
    return WeChatService.instance(lifecycle.system_channels().channel("wechat"))


@router.get("/api/wechat/status")
def status(lifecycle: SessionDomain) -> WxStatusResp:
    return svc(lifecycle).status()


@router.post("/api/wechat/login")
def login(lifecycle: SessionDomain) -> WxQRState:
    """Begin QR login flow. Frontend should subscribe to /ws/events?prefix=wechat: for QR updates."""
    return svc(lifecycle).start_qr_login()


@router.post("/api/wechat/logout")
def logout(lifecycle: SessionDomain) -> WxLogoutResp:
    svc(lifecycle).logout()
    return {"ok": True}


@router.post("/api/wechat/poll/start")
def start_polling(lifecycle: SessionDomain) -> WxPollStartResp:
    return {"started": svc(lifecycle).start_polling()}


@router.post("/api/wechat/poll/stop")
def stop_polling(lifecycle: SessionDomain) -> WxPollStopResp:
    svc(lifecycle).stop_polling()
    return {"ok": True}


@router.get("/api/wechat/contacts")
def contacts(lifecycle: SessionDomain) -> WxContactListResp:
    return {"contacts": svc(lifecycle).list_contacts()}


@router.get("/api/wechat/messages")
def messages(
    lifecycle: SessionDomain,
    uid: str | None = None,
    limit: int = Query(default=200, ge=1, le=1000),
) -> WxLogListResp:
    return {"messages": svc(lifecycle).get_messages(uid=uid, limit=min(limit, 1000))}


@router.delete("/api/wechat/messages")
def clear_messages(lifecycle: SessionDomain) -> WxLogoutResp:
    svc(lifecycle).clear_log()
    return {"ok": True}


@router.post("/api/wechat/send")
async def send(req: WxSendReq, lifecycle: SessionDomain) -> WxSendResp:
    s = svc(lifecycle)
    if not s.bot.has_token:
        raise HTTPException(400, "wechat not logged in")
    if req.text:
        await asyncio.to_thread(s.send_text, req.uid, req.text, req.context_token)
    if req.file_path:
        await asyncio.to_thread(s.send_file, req.uid, req.file_path, req.context_token)
    if not req.text and not req.file_path:
        raise HTTPException(400, "text or file_path required")
    return {"ok": True}


@router.get("/api/wechat/allowlist")
def get_allowlist(lifecycle: SessionDomain) -> WxAllowlistResp:
    return {"allowlist": sorted(svc(lifecycle).allowlist) if svc(lifecycle).allowlist != {"*"} else ["*"]}


@router.put("/api/wechat/allowlist")
def put_allowlist(req: WxAllowlistReq, lifecycle: SessionDomain) -> WxAllowlistWriteResp:
    svc(lifecycle).set_allowlist(req.allowlist)
    return {"ok": True, "allowlist": sorted(svc(lifecycle).allowlist)}
