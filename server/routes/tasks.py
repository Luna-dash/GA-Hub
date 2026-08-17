"""Generic scheduled task routes."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException, Query

from ..schemas import (
    EmailConfigReq,
    EmailConfigResp,
    EmailTestReq,
    EmailTestResp,
    TaskMutationResp,
    TaskRunListResp,
    TaskScheduleListResp,
    TaskScheduleResp,
    TaskScheduleUpsert,
    TaskTriggerResp,
)
from ..services import email_service
from ..services.email_config_store import EmailConfigFormatError
from ..services.agent_service import AgentService
from ..services.task_scheduler import TaskScheduler

router = APIRouter(prefix="/api/tasks", tags=["tasks"])


def svc() -> TaskScheduler:
    return TaskScheduler.instance(AgentService.instance())


@router.get("/schedules", response_model=TaskScheduleListResp)
async def list_schedules():
    return {"schedules": svc().list()}


@router.post("/schedules", response_model=TaskScheduleResp)
async def upsert_schedule(req: TaskScheduleUpsert):
    s = svc().upsert(req.model_dump())
    return s.to_dict()


@router.delete("/schedules/{sid}", response_model=TaskMutationResp)
async def delete_schedule(sid: str):
    if not svc().delete(sid):
        raise HTTPException(404, "task schedule not found")
    return {"ok": True}


@router.post("/schedules/{sid}/trigger", response_model=TaskTriggerResp)
async def trigger_schedule(sid: str):
    try:
        return svc().trigger_now(sid)
    except KeyError:
        raise HTTPException(404, "task schedule not found")


@router.get("/runs", response_model=TaskRunListResp)
async def list_runs(limit: int = Query(default=100, ge=1, le=1000)):
    runs = await asyncio.to_thread(svc().list_runs, limit)
    return {"runs": runs}


@router.get("/email-config", response_model=EmailConfigResp)
async def get_email_config():
    try:
        return email_service.load_config(public=True)
    except EmailConfigFormatError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.put("/email-config", response_model=EmailConfigResp)
async def put_email_config(req: EmailConfigReq):
    try:
        return email_service.save_config(req.model_dump())
    except EmailConfigFormatError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/email-test", response_model=EmailTestResp)
async def test_email(req: EmailTestReq):
    return await asyncio.to_thread(email_service.test_email, req.to, req.subject, req.body)
