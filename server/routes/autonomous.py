"""Autonomous evolution routes."""
from __future__ import annotations

import asyncio
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request

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
from ..services.autonomous_scheduler import AutonomousScheduler
from ..services.session_lifecycle import SessionLifecycle, session_lifecycle_of

router = APIRouter()


def _request_lifecycle(request: Request) -> SessionLifecycle:
    return session_lifecycle_of(request.app)


# The session domain is owned by the composition root and bound to the app
# (server.main). Resolving it here is what retired the sibling-route import
# this module used to need for service location.
SessionDomain = Annotated[SessionLifecycle, Depends(_request_lifecycle)]


def svc(lifecycle: SessionLifecycle) -> AutonomousScheduler:
    return AutonomousScheduler.instance(
        lifecycle.system_channels().channel("autonomous")
    )


@router.get("/api/autonomous/schedules", response_model=AutonomousScheduleListResp)
async def list_schedules(lifecycle: SessionDomain):
    return {"schedules": await asyncio.to_thread(lambda: svc(lifecycle).list())}


@router.post("/api/autonomous/schedules", response_model=AutonomousScheduleResp)
async def upsert_schedule(lifecycle: SessionDomain, req: ScheduleUpsert):
    payload = req.model_dump()
    try:
        s = await asyncio.to_thread(lambda: svc(lifecycle).upsert(payload))
    except ValueError as exc:
        # Invalid cron expressions are rejected before persistence (they
        # used to answer 200 and then never fire).
        raise HTTPException(422, str(exc)) from exc
    return s.to_dict()


@router.delete("/api/autonomous/schedules/{sid}", response_model=AutonomousMutationResp)
async def delete_schedule(lifecycle: SessionDomain, sid: str):
    deleted = await asyncio.to_thread(lambda: svc(lifecycle).delete(sid))
    if not deleted:
        raise HTTPException(404, "schedule not found")
    return {"ok": True}


@router.post(
    "/api/autonomous/schedules/{sid}/trigger",
    response_model=AutonomousTriggerResp,
)
async def trigger_schedule(lifecycle: SessionDomain, sid: str):
    try:
        return await asyncio.to_thread(lambda: svc(lifecycle).trigger_now(sid))
    except KeyError:
        raise HTTPException(404, "schedule not found")


@router.get("/api/autonomous/runs", response_model=AutonomousRunListResp)
async def list_runs(
    lifecycle: SessionDomain, limit: int = Query(default=100, ge=1, le=1000)
):
    return {"runs": await asyncio.to_thread(lambda: svc(lifecycle).list_runs(limit=limit))}


@router.get("/api/autonomous/reports", response_model=AutonomousReportListResp)
async def list_reports(lifecycle: SessionDomain):
    return {"reports": await asyncio.to_thread(lambda: svc(lifecycle).list_reports())}


@router.get(
    "/api/autonomous/reports/{name}",
    response_model=AutonomousReportDetailResp,
)
async def read_report(lifecycle: SessionDomain, name: str):
    try:
        content = await asyncio.to_thread(lambda: svc(lifecycle).read_report(name))
    except FileNotFoundError:
        raise HTTPException(404, "report not found")
    except ValueError:
        raise HTTPException(400, "bad name")
    return {"name": name, "content": content}
