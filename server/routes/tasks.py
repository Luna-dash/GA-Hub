"""Generic scheduled task routes."""
from __future__ import annotations

import asyncio
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from ..schemas import (
    TaskMutationResp,
    TaskRunListResp,
    TaskScheduleListResp,
    TaskScheduleResp,
    TaskScheduleUpsert,
    TaskTriggerResp,
)
from ..services.session_lifecycle import SessionLifecycle, session_lifecycle_of
from ..services.task_scheduler import TaskScheduler

router = APIRouter(prefix="/api/tasks", tags=["tasks"])


def _request_lifecycle(request: Request) -> SessionLifecycle:
    return session_lifecycle_of(request.app)


# The session domain is owned by the composition root and bound to the app
# (server.main). Resolving it here is what retired the sibling-route import
# this module used to need for service location.
SessionDomain = Annotated[SessionLifecycle, Depends(_request_lifecycle)]


def svc(lifecycle: SessionLifecycle) -> TaskScheduler:
    return TaskScheduler.instance(
        lifecycle.system_channels().channel("scheduled_task")
    )


@router.get("/schedules", response_model=TaskScheduleListResp)
async def list_schedules(lifecycle: SessionDomain):
    return {"schedules": await asyncio.to_thread(lambda: svc(lifecycle).list())}


@router.post("/schedules", response_model=TaskScheduleResp)
async def upsert_schedule(lifecycle: SessionDomain, req: TaskScheduleUpsert):
    payload = req.model_dump()
    try:
        s = await asyncio.to_thread(lambda: svc(lifecycle).upsert(payload))
    except ValueError as exc:
        # Invalid cron expressions are rejected before persistence (they
        # used to answer 200 and then never fire).
        raise HTTPException(422, str(exc)) from exc
    return s.to_dict()


@router.delete("/schedules/{sid}", response_model=TaskMutationResp)
async def delete_schedule(lifecycle: SessionDomain, sid: str):
    deleted = await asyncio.to_thread(lambda: svc(lifecycle).delete(sid))
    if not deleted:
        raise HTTPException(404, "task schedule not found")
    return {"ok": True}


@router.post("/schedules/{sid}/trigger", response_model=TaskTriggerResp)
async def trigger_schedule(lifecycle: SessionDomain, sid: str):
    try:
        return await asyncio.to_thread(lambda: svc(lifecycle).trigger_now(sid))
    except KeyError:
        raise HTTPException(404, "task schedule not found")


@router.get("/runs", response_model=TaskRunListResp)
async def list_runs(
    lifecycle: SessionDomain, limit: int = Query(default=100, ge=1, le=1000)
):
    runs = await asyncio.to_thread(lambda: svc(lifecycle).list_runs(limit))
    return {"runs": runs}
