"""Generic scheduled task routes."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ..schemas import EmailConfigReq, EmailTestReq, TaskScheduleUpsert
from ..services import email_service
from ..services.agent_service import AgentService
from ..services.task_scheduler import TaskScheduler

router = APIRouter(prefix="/api/tasks", tags=["tasks"])


def svc() -> TaskScheduler:
    return TaskScheduler.instance(AgentService.instance())


@router.get("/schedules")
async def list_schedules():
    return {"schedules": svc().list()}


@router.post("/schedules")
async def upsert_schedule(req: TaskScheduleUpsert):
    s = svc().upsert(req.model_dump())
    return s.to_dict()


@router.delete("/schedules/{sid}")
async def delete_schedule(sid: str):
    if not svc().delete(sid):
        raise HTTPException(404, "task schedule not found")
    return {"ok": True}


@router.post("/schedules/{sid}/trigger")
async def trigger_schedule(sid: str):
    try:
        return svc().trigger_now(sid)
    except KeyError:
        raise HTTPException(404, "task schedule not found")


@router.get("/runs")
async def list_runs(limit: int = 100):
    import asyncio
    runs = await asyncio.get_event_loop().run_in_executor(None, svc().list_runs, limit)
    return {"runs": runs}


@router.get("/email-config")
async def get_email_config():
    return email_service.load_config(public=True)


@router.put("/email-config")
async def put_email_config(req: EmailConfigReq):
    return email_service.save_config(req.model_dump())


@router.post("/email-test")
async def test_email(req: EmailTestReq):
    return email_service.test_email(req.to, req.subject, req.body)
