"""mykey HTTP 适配层 — 业务全部在 services/mykey_service.py。

路由只做三件事：请求模型、线程投递（文件 IO / 子进程都不占事件循环）、
把服务层的 :class:`MykeyHttpError` 一对一翻译成 HTTPException。
"""
from __future__ import annotations

import asyncio
import functools
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..schemas import (
    MyKeyBackupListResp,
    MyKeyDataResp,
    MyKeyOpenResp,
    MyKeySessionTestResp,
    MyKeySyncResultResp,
    MyKeyWriteResp,
    RawWriteReq,
    SessionUpsertReq,
)
from ..services import mykey_service

router = APIRouter(prefix="/api/mykey", tags=["mykey"])


# ── pydantic models ────────────────────────────────────────────────────


def _translated(fn):
    """Re-raise the service's MykeyHttpError as an equivalent HTTPException."""
    @functools.wraps(fn)
    async def wrapper(*args, **kwargs):
        try:
            return await fn(*args, **kwargs)
        except mykey_service.MykeyHttpError as e:
            raise HTTPException(e.status_code, e.detail) from e
    return wrapper


# ── routes ─────────────────────────────────────────────────────────────
@router.get("")
@_translated
async def get_mykey() -> MyKeyDataResp:
    return await asyncio.to_thread(mykey_service.read_mykey)


@router.put("/raw")
@_translated
async def put_raw(req: RawWriteReq) -> MyKeyWriteResp:
    return await asyncio.to_thread(mykey_service.write_raw, req.raw)


@router.post("/sessions")
@_translated
async def upsert_session(req: SessionUpsertReq) -> MyKeyWriteResp:
    return await asyncio.to_thread(mykey_service.upsert_session, req.var, req.fields)


@router.delete("/sessions/{var}")
@_translated
async def delete_session(var: str) -> MyKeyWriteResp:
    return await asyncio.to_thread(mykey_service.delete_session, var)


@router.post("/sessions/{var}/test")
@_translated
async def test_session(var: str) -> MyKeySessionTestResp:
    """Ping a single mykey session by variable name.

    This avoids fragile /api/llms index mapping: mykey cards know their
    assignment variable, so resolve a fresh client directly from mykey.py.
    Mixin routes are intentionally not tested here.
    """
    return await asyncio.to_thread(mykey_service.test_session_sync, var)


@router.get("/backups")
@_translated
async def list_backups() -> MyKeyBackupListResp:
    return await asyncio.to_thread(mykey_service.list_backups)


@router.post("/backups/{name}/restore")
@_translated
async def restore_backup(name: str) -> MyKeyWriteResp:
    return await asyncio.to_thread(mykey_service.restore_backup, name)


@router.post("/sync/upload")
@_translated
async def sync_upload_mykey() -> MyKeySyncResultResp:
    """Encrypt and upload current GA_ROOT/mykey.py to the configured sync server."""
    return await asyncio.to_thread(mykey_service.sync_upload)


@router.post("/sync/fetch")
@_translated
async def sync_fetch_mykey() -> MyKeySyncResultResp:
    """Fetch, decrypt and replace GA_ROOT/mykey.py from the configured sync server."""
    return await asyncio.to_thread(mykey_service.sync_fetch)


@router.post("/open")
@_translated
async def open_mykey_file() -> MyKeyOpenResp:
    """Open mykey.py in system default editor."""
    return await asyncio.to_thread(mykey_service.open_mykey_file)
