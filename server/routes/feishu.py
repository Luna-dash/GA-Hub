"""Feishu bot routes."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..services.feishu_service import FeishuService

router = APIRouter()


class FsSendReq(BaseModel):
    receive_id: str
    text: str
    receive_id_type: str = Field(default="open_id", pattern="^(open_id|chat_id|user_id|union_id|email)$")
    use_card: bool = False


class FsKeysReq(BaseModel):
    app_id: str = Field(min_length=1)
    app_secret: str = Field(min_length=1)
    allowed_users: str = ""


def svc() -> FeishuService:
    return FeishuService.instance()


@router.get("/api/feishu/status")
async def status():
    return svc().status()


@router.post("/api/feishu/check")
async def check(init_agent: bool = False):
    return svc().check(init_agent=init_agent)


@router.put("/api/feishu/keys")
async def save_keys(req: FsKeysReq):
    try:
        return svc().save_keys(req.app_id, req.app_secret, req.allowed_users)
    except Exception as e:
        raise HTTPException(400, str(e))


@router.post("/api/feishu/start")
async def start():
    try:
        return svc().start()
    except Exception as e:
        raise HTTPException(400, str(e))


@router.post("/api/feishu/stop")
async def stop():
    return svc().stop()


@router.get("/api/feishu/logs")
async def logs(tail: int = 300):
    return {"lines": svc().tail(tail), "file": str(svc().log_file())}


@router.post("/api/feishu/send")
async def send(req: FsSendReq):
    try:
        out = svc().send_text(req.receive_id, req.text, req.receive_id_type, req.use_card)
    except Exception as e:
        raise HTTPException(400, str(e))
    if not out.get("ok"):
        raise HTTPException(400, out)
    return out
