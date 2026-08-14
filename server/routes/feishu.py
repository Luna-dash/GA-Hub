"""Feishu bot routes."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from ..schemas import (
    FsCheckResp,
    FsKeysReq,
    FsKeysResp,
    FsSendReq,
    FsSendResp,
    FsStartResp,
    FsStatusResp,
    FsStopResp,
    LogLinesResp,
)
from ..services.feishu_service import FeishuService

router = APIRouter()


def svc() -> FeishuService:
    return FeishuService.instance()


@router.get("/api/feishu/status")
async def status() -> FsStatusResp:
    return svc().status()


@router.post("/api/feishu/check")
async def check(init_agent: bool = False) -> FsCheckResp:
    return svc().check(init_agent=init_agent)


@router.put("/api/feishu/keys")
async def save_keys(req: FsKeysReq) -> FsKeysResp:
    try:
        return svc().save_keys(req.app_id, req.app_secret, req.allowed_users)
    except Exception as e:
        raise HTTPException(400, str(e))


@router.post("/api/feishu/start")
async def start() -> FsStartResp:
    try:
        return svc().start()
    except Exception as e:
        raise HTTPException(400, str(e))


@router.post("/api/feishu/stop")
async def stop() -> FsStopResp:
    return svc().stop()


@router.get("/api/feishu/logs")
async def logs(tail: int = Query(default=300, ge=1, le=5000)) -> LogLinesResp:
    return {"lines": svc().tail(tail), "file": str(svc().log_file())}


@router.post("/api/feishu/send")
async def send(req: FsSendReq) -> FsSendResp:
    try:
        out = svc().send_text(req.receive_id, req.text, req.receive_id_type, req.use_card)
    except Exception as e:
        raise HTTPException(400, str(e))
    if not out.get("ok"):
        raise HTTPException(400, out)
    return out
