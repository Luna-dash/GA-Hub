"""Autonomous evolution routes."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException, Query

from ..schemas import (
    AutonomousMutationResp,
    AutonomousReportDetailResp,
    AutonomousReportListResp,
    AutonomousRunListResp,
    AutonomousScheduleListResp,
    AutonomousScheduleResp,
    AutonomousTriggerResp,
    ScheduleUpsert,
)
from ..services.agent_service import AgentService
from ..services.autonomous_scheduler import AutonomousScheduler

router = APIRouter()


def svc() -> AutonomousScheduler:
    return AutonomousScheduler.instance(AgentService.instance())


@router.get("/api/autonomous/schedules", response_model=AutonomousScheduleListResp)
async def list_schedules():
    return {"schedules": svc().list()}


@router.post("/api/autonomous/schedules", response_model=AutonomousScheduleResp)
async def upsert_schedule(req: ScheduleUpsert):
    s = svc().upsert(req.model_dump())
    return s.to_dict()


@router.delete("/api/autonomous/schedules/{sid}", response_model=AutonomousMutationResp)
async def delete_schedule(sid: str):
    if not svc().delete(sid):
        raise HTTPException(404, "schedule not found")
    return {"ok": True}


@router.post(
    "/api/autonomous/schedules/{sid}/trigger",
    response_model=AutonomousTriggerResp,
)
async def trigger_schedule(sid: str):
    try:
        return svc().trigger_now(sid)
    except KeyError:
        raise HTTPException(404, "schedule not found")


@router.get("/api/autonomous/runs", response_model=AutonomousRunListResp)
async def list_runs(limit: int = Query(default=100, ge=1, le=1000)):
    return {"runs": await asyncio.to_thread(svc().list_runs, limit=limit)}


@router.get("/api/autonomous/reports", response_model=AutonomousReportListResp)
async def list_reports():
    return {"reports": svc().list_reports()}


@router.get(
    "/api/autonomous/reports/{name}",
    response_model=AutonomousReportDetailResp,
)
async def read_report(name: str):
    try:
        content = await asyncio.to_thread(svc().read_report, name)
    except FileNotFoundError:
        raise HTTPException(404, "report not found")
    except ValueError:
        raise HTTPException(400, "bad name")
    return {"name": name, "content": content}
