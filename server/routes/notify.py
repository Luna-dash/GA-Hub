"""Desktop notification endpoint.

The webui POSTs ``{title, body}`` here when something noteworthy happens
(agent task done, wechat new message, etc.). We shell out to the OS native
notifier — see ``server/services/notify_service.py``.

Throttling + visibility-aware suppression already happen on the frontend;
the backend has its own 800ms throttle as a backstop.
"""
from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..services import notify_service

router = APIRouter(prefix="/api/notify", tags=["notify"])


class NotifyReq(BaseModel):
    title: str = Field("", max_length=120)
    body: str = Field("", max_length=400)


@router.post("")
async def post_notify(req: NotifyReq):
    """Fire an OS notification. Always 200 — failures are reported in body."""
    return notify_service.send(req.title, req.body)


@router.get("/info")
async def info():
    """Tells the Settings panel which native backend is wired up so it can
    render copy like 'macOS · osascript'."""
    return {"backend": notify_service.backend_name()}
