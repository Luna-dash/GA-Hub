"""Read-only status endpoint for the generic IM adapter registry."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Request

from ..schemas import IMStatusResp
from ..services.im_adapter import IMRegistry, im_registry

router = APIRouter()


def _registry_of(request: Request) -> IMRegistry:
    reg = getattr(request.app.state, "im_registry", None)
    return reg if isinstance(reg, IMRegistry) else im_registry


@router.get("/api/im/status", response_model=IMStatusResp)
async def status(request: Request) -> IMStatusResp:
    reg = _registry_of(request)
    if not reg.has_adapters():
        return IMStatusResp(configured=False, adapters=[])
    snapshot = await asyncio.to_thread(reg.status_snapshot)
    return IMStatusResp(**snapshot)
