"""Conductor routes — multi-agent orchestration REST API.

All endpoints prefixed with /api/conductor. Real-time updates flow through
the shared EventBus (/ws/events?prefix=conductor:), not a dedicated WS.
"""
from __future__ import annotations

import asyncio
import logging
import sqlite3

from fastapi import APIRouter, HTTPException, Query

from ..schemas import (
    ConductorActivityListResp,
    ConductorChatIn,
    ConductorChatListResp,
    ConductorChatMessage,
    ConductorLifecycleResp,
    ConductorLogResp,
    ConductorOperationResp,
    ConductorSettingsReq,
    ConductorStartReq,
    ConductorStartSubagent,
    ConductorStatusResp,
    ConductorSubagent,
    ConductorSubagentActionResp,
    ConductorSubagentAction,
    ConductorSubagentInstructionResp,
    ConductorSubagentListResp,
    ConductorTextResp,
    ConductorWorkflowListResp,
)
from ..services import conductor_client as conductor_client_module
from ..services.conductor_store import OperationConflict
from ..services.conductor_service import (
    SUBAGENT_VERBS,
    ConductorNotRunning,
    ConductorService,
)

log = logging.getLogger(__name__)
router = APIRouter()


def svc() -> ConductorService:
    return ConductorService.instance()


def _engine_http_error(exc: "conductor_client_module.GahubProcessError") -> HTTPException:
    """Map an engine HTTP failure onto a hub status instead of a blind 500.

    - Engine 4xx are domain rejections (contract, terminal states, budgets):
      pass the status through so callers see the real cause.
    - Unreachable/unhealthy engines degrade to 503 with recovery hints.
    - An engine 503 (e.g. the conductor is stopping, admission refused) is
      relayed verbatim: it is the engine's own unavailability signal.
    - Other engine 5xx stay upstream failures: 502, never a hub-internal
      error.
    """
    status = exc.status_code
    if status is None:
        return HTTPException(
            503,
            exc.detail or ("gahub_app engine unreachable - it will be respawned on demand "
                           f"(see %TEMP%\\gahub_app.log): {exc}"),
        )
    detail = exc.detail
    if isinstance(detail, dict) and set(detail) == {"detail"}:
        # Avoid nesting FastAPI's envelope; domain evidence stays intact.
        detail = detail["detail"]
    if detail is None or detail == "":
        detail = str(exc)
    mapped_status = status if 400 <= status < 500 or status == 503 else 502
    return HTTPException(mapped_status, detail)


async def _dispatch_through_engine(func, /, *args, **kwargs):
    """Run one engine-forwarding service call with engine-aware mapping."""
    try:
        return await asyncio.to_thread(func, *args, **kwargs)
    except OperationConflict as exc:
        raise HTTPException(409, {"error": "operation_id_conflict", "message": str(exc)}) from exc
    except sqlite3.Error as exc:
        log.exception("Conductor persistence failed")
        raise HTTPException(503, {"error": "storage_unavailable", "operation_id": kwargs.get("operation_id")}) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except ConductorNotRunning as exc:
        # Unified lifecycle admission (2026-09 audit P1): subagent
        # operations never cold-start the supervisor; the UI shows the
        # start hint instead of a blind 500.
        raise HTTPException(409, str(exc)) from exc
    except conductor_client_module.GahubProcessError as exc:
        raise _engine_http_error(exc) from exc


def _status_payload(service: ConductorService) -> dict:
    running, stopped = service.pool.counts()
    return {
        **service.lifecycle_status(),
        "subagents": {"running": running, "stopped": stopped},
        "chat_count": len(service.chat_messages),
        "auto_accept": service.auto_accept,
    }


# ── readme / docs ────────────────────────────────────────────────────────────
@router.get("/api/conductor/readme")
async def get_readme() -> ConductorTextResp:
    """Return the conductor API README (OpenAPI-documented)."""
    return {"content": svc().get_readme("api")}


@router.post("/api/conductor/settings")
async def update_conductor_settings(
    body: ConductorSettingsReq,
) -> ConductorStatusResp:
    """Update conductor automation policy (currently: auto-accept)."""
    service = svc()
    service.auto_accept = body.auto_accept
    return await _dispatch_through_engine(_status_payload, service)


@router.get("/api/conductor/readme/{topic}")
async def get_readme_topic(topic: str) -> ConductorTextResp:
    """Return one conductor README topic (OpenAPI-documented)."""
    content = svc().get_readme(topic)
    if content is None:
        available = ", ".join(svc().get_readmes().keys())
        raise HTTPException(404, f"Unknown topic: {topic}. Available: {available}")
    return {"content": content}


# ── chat ─────────────────────────────────────────────────────────────────────
@router.get("/api/conductor/chat")
async def get_chat(last: int = Query(default=20, ge=1, le=200)) -> ConductorChatListResp:
    """Return the last N conductor chat messages for hydration."""
    return {"items": await _dispatch_through_engine(svc().get_chat_messages, last=last)}


@router.post("/api/conductor/chat")
async def post_chat(body: ConductorChatIn) -> ConductorChatMessage:
    """Admit one chat message for the conductor and broadcast it.

    A user message whose ``request_id`` names an open workflow appends to
    that workflow (conversation continuity); unknown or closed ids fall back
    to admitting a fresh task.
    """
    workflow = {}
    if body.request_id is not None:
        workflow["request_id"] = body.request_id
    if body.final:
        workflow["kind"] = "final"
    return await _dispatch_through_engine(
        svc().add_chat_message,
        body.msg,
        role=body.role,
        **workflow,
        llm_index=body.llm_index,
        subagent_llm_index=body.subagent_llm_index,
        subagent_model_policy=body.subagent_model_policy,
        operation_id=body.operation_id,
    )


# ── subagents ────────────────────────────────────────────────────────────────
@router.get("/api/conductor/subagent")
async def list_subagents() -> ConductorSubagentListResp:
    """Return the subagent pool snapshot the UI renders."""
    service = svc()
    return (service.get_subagent_envelope() if service.recovery is not None
            else {"items": service.get_subagent_snapshot()})


@router.get("/api/conductor/operations/{operation_id}")
async def get_operation(operation_id: str) -> ConductorOperationResp:
    return await _dispatch_through_engine(svc().get_operation, operation_id)


@router.get("/api/conductor/workflow")
async def list_workflows(
    last: int = Query(default=20, ge=1, le=100),
) -> ConductorWorkflowListResp:
    """Return the workflow tracker snapshot for the UI board."""
    return {"items": svc().get_workflow_snapshot(limit=last)}


@router.get("/api/conductor/activity")
async def get_activity(
    request_id: str = Query(min_length=1, max_length=128),
    limit: int = Query(default=200, ge=1, le=1000),
    before_ms: int | None = Query(default=None, ge=0),
) -> ConductorActivityListResp:
    """Return one workflow's durable 动态 timeline.

    The page's 动态 tab used to be a live-only SSE projection, so a task
    reopened from history showed nothing. This is the read that makes the
    timeline durable; ``before_ms`` pages backwards for scroll-up.
    """
    return svc().get_activity(request_id, limit=limit, before_ms=before_ms)


@router.delete("/api/conductor/workflow/{request_id}")
async def delete_workflow(request_id: str) -> dict:
    """Remove a terminal workflow from the board (tombstoned, irreversible)."""
    try:
        svc().forget_workflow(request_id)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    return {"ok": True, "request_id": request_id}


@router.get("/api/conductor/subagent/{sid}")
async def get_subagent(
    sid: str, max_len: int = Query(default=5000, ge=1, le=1_000_000)
) -> ConductorSubagent:
    """Full worker dossier for human review (engine reply + mirror facts)."""
    return await _dispatch_through_engine(svc().subagent_dossier, sid, max_len)


@router.post("/api/conductor/subagent")
async def start_subagent(body: ConductorStartSubagent) -> ConductorSubagentInstructionResp:
    """Dispatch a new subagent through the service policy boundary."""
    workflow = {"request_id": body.request_id} if body.request_id is not None else {}
    result = await _dispatch_through_engine(
        svc().start_subagent,
        body.prompt,
        **workflow,
        llm_index=body.llm_index,
        conductor_llm_index=body.conductor_llm_index,
        subagent_llm_index=body.subagent_llm_index,
        subagent_model_policy=body.subagent_model_policy,
        # Contract B manifest: the engine requires goal + deliverables and
        # answers 422 without them; forward the declared fields verbatim.
        goal=body.goal,
        boundaries=body.boundaries,
        deliverables=[d.model_dump() for d in body.deliverables],
        done_when=body.done_when,
        checks=[c.model_dump() for c in body.checks],
        # P0 idempotency: forward the caller's id; the service mints one
        # when absent so a retried dispatch cannot spawn a second worker.
        operation_id=body.operation_id,
    )
    return result


@router.post("/api/conductor/subagent/{sid}")
async def subagent_action(
    sid: str, body: ConductorSubagentAction
) -> ConductorSubagentActionResp:
    """Apply one verb (keyinfo/accept/rework/input/abort/...) to a worker."""
    service = svc()
    action = body.action.lower().strip()
    if action not in SUBAGENT_VERBS:
        raise HTTPException(400, f"unknown action: {body.action}")
    # Dispatch, instructions, and tracker-owner forwarding all live in the
    # service; only HTTP status mapping stays here.
    result = await _dispatch_through_engine(
        service.apply_subagent_action,
        sid,
        action,
        body.msg,
        request_id=body.request_id,
        force=body.force,
        llm_index=body.llm_index,
        conductor_llm_index=body.conductor_llm_index,
        subagent_llm_index=body.subagent_llm_index,
        subagent_model_policy=body.subagent_model_policy,
        operation_id=body.operation_id,
        **{key: value for key, value in {
            "expected_boot_id": body.expected_boot_id,
            "expected_generation": body.expected_generation,
            "expected_command_revision": body.expected_command_revision,
        }.items() if value is not None},
    )
    if action == "accept" and "error" in result:
        # completion_unverified must carry the verification evidence the
        # engine computed — the UI renders it before offering force.
        raise HTTPException(409, result)
    if action == "rework" and "error" in result:
        raise HTTPException(409, result["error"])
    return result


# ── status / log ─────────────────────────────────────────────────────────────
@router.get("/api/conductor/log")
async def get_conductor_log() -> ConductorLogResp:
    """Return the conductor engine event log."""
    return {"log": await _dispatch_through_engine(svc().get_conductor_log)}


@router.get("/api/conductor/journal")
async def get_conductor_journal(
    after_seq: int = Query(default=0, ge=0),
    limit: int = Query(default=500, ge=1, le=5000),
):
    """Catch-up read of the engine's durable run journal (P2-A).

    SSE stays the live hint; clients that dropped events re-sync from the
    journal instead of guessing.  Disabled journals pass through the
    engine's explicit `disabled` payload unchanged.
    """
    return await _dispatch_through_engine(
        svc().client.journal, after_seq, limit)


@router.get("/api/conductor/status")
async def get_status() -> ConductorStatusResp:
    """Return the conductor lifecycle plus pool counters."""
    service = svc()
    return await _dispatch_through_engine(_status_payload, service)


@router.post("/api/conductor/start")
async def start_conductor(body: ConductorStartReq | None = None) -> ConductorLifecycleResp:
    """Start the conductor supervisor."""
    service = svc()
    try:
        started = await asyncio.to_thread(
            service.start,
            llm_index=body.llm_index if body else None,
            subagent_llm_index=body.subagent_llm_index if body else None,
            subagent_model_policy=body.subagent_model_policy if body else None,
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except conductor_client_module.GahubProcessError as exc:
        # Spawn/probe/health failures must reach the UI as 503 + diagnostics,
        # not a blind 500 (live 2026-09-07: a hung interpreter probe surfaced
        # as "Internal Server Error" with no hint at %TEMP%\gahub_app.log).
        raise _engine_http_error(exc) from exc
    status = await _dispatch_through_engine(_status_payload, service)
    return {"ok": started or status["started"], **status}


@router.post("/api/conductor/workflow/{request_id}/resume")
async def resume_workflow(request_id: str) -> ConductorLifecycleResp:
    """Resume exactly ONE open workflow (per-task 恢复此任务).

    The blanket redispatch formerly hidden behind POST /start was removed by
    user ruling (2026-09: a stopped task is not implicitly wanted back), so
    this endpoint is the only relay path an explicit click takes — it brings
    the supervisor up and re-delivers just this request's original message."""
    service = svc()
    try:
        resumed = await asyncio.to_thread(service.resume_workflow, request_id)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except conductor_client_module.GahubProcessError as exc:
        # Subclass of RuntimeError — must stay above the bare-RuntimeError
        # handler or it would lose _engine_http_error's diagnostics mapping.
        raise _engine_http_error(exc) from exc
    except RuntimeError as exc:
        # Engine refused the relay (stopping/unavailable): the click failed
        # for a reason the user can act on — surface it, not a blind 500.
        raise HTTPException(503, str(exc)) from exc
    status = await _dispatch_through_engine(_status_payload, service)
    return {"ok": resumed or status["started"], **status}


@router.post("/api/conductor/stop")
async def stop_conductor() -> ConductorLifecycleResp:
    """Stop the conductor supervisor."""
    service = svc()
    stopped = await asyncio.to_thread(service.stop)
    status = await _dispatch_through_engine(_status_payload, service)
    if not stopped:
        raise HTTPException(503, "Conductor engine could not be stopped; check its health and logs.")
    return {"ok": True, **status}
