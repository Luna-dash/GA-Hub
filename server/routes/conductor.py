"""Conductor routes — multi-agent orchestration REST API.

All endpoints prefixed with /api/conductor. Real-time updates flow through
the shared EventBus (/ws/events?prefix=conductor:), not a dedicated WS.
"""
from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, HTTPException, Query

from ..schemas import (
    ConductorChatIn,
    ConductorChatListResp,
    ConductorChatMessage,
    ConductorLifecycleResp,
    ConductorLogResp,
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
from ..services.conductor_service import ConductorService, clean_log_text

log = logging.getLogger(__name__)
router = APIRouter()

INSTR_DISPATCHED = (
    "Task received. I'll handle THIS TASK from here. "
    "You MUST to do other task or end your reply."
)
INSTR_KEYINFO = (
    "Received. I'll incorporate this. "
    "You MUST to do other task or end your reply."
)


def svc() -> ConductorService:
    return ConductorService.instance()


def _engine_http_error(exc: "conductor_client_module.GahubProcessError") -> HTTPException:
    """Map an engine HTTP failure onto a hub status instead of a blind 500.

    - Engine 4xx are domain rejections (contract, terminal states, budgets):
      pass the status through so callers see the real cause.
    - Unreachable/unhealthy engines degrade to 503 with recovery hints.
    - Engine 5xx stay upstream failures: 502, never a hub-internal error.
    """
    status = exc.status_code
    if status is not None and 400 <= status < 500:
        detail = exc.detail
        if isinstance(detail, list):
            # FastAPI validation payload: keep only the human-readable msgs.
            detail = "; ".join(
                str(item.get("msg", ""))
                for item in detail
                if isinstance(item, dict) and item.get("msg")
            ) or detail
        return HTTPException(status, str(detail) or str(exc))
    if status is None:
        return HTTPException(
            503,
            "gahub_app engine unreachable — it will be respawned on demand "
            "(see %TEMP%\\gahub_app.log)",
        )
    return HTTPException(502, f"gahub_app engine error: {exc}")


async def _dispatch_through_engine(func, /, *args, **kwargs):
    """Run one engine-forwarding service call with engine-aware mapping."""
    try:
        return await asyncio.to_thread(func, *args, **kwargs)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except conductor_client_module.GahubProcessError as exc:
        raise _engine_http_error(exc) from exc


def _status_payload(service: ConductorService) -> dict:
    running, stopped = service.pool.counts()
    return {
        **service.lifecycle_status(),
        "subagents": {"running": running, "stopped": stopped},
        "chat_count": len(service.chat_messages),
    }


# ── readme / docs ────────────────────────────────────────────────────────────
@router.get("/api/conductor/readme")
async def get_readme() -> ConductorTextResp:
    return {"content": svc().get_readme("api")}


@router.get("/api/conductor/readme/{topic}")
async def get_readme_topic(topic: str) -> ConductorTextResp:
    content = svc().get_readme(topic)
    if content is None:
        available = ", ".join(svc().get_readmes().keys())
        raise HTTPException(404, f"Unknown topic: {topic}. Available: {available}")
    return {"content": content}


# ── chat ─────────────────────────────────────────────────────────────────────
@router.get("/api/conductor/chat")
async def get_chat(last: int = Query(default=20, ge=1, le=200)) -> ConductorChatListResp:
    return {"items": svc().get_chat_messages(last=last)}


@router.post("/api/conductor/chat")
async def post_chat(body: ConductorChatIn) -> ConductorChatMessage:
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
        conductor_reasoning_effort=body.conductor_reasoning_effort,
    )


# ── subagents ────────────────────────────────────────────────────────────────
@router.get("/api/conductor/subagent")
async def list_subagents() -> ConductorSubagentListResp:
    return {"items": svc().get_subagent_snapshot()}


@router.get("/api/conductor/workflow")
async def list_workflows(
    last: int = Query(default=20, ge=1, le=100),
) -> ConductorWorkflowListResp:
    return {"items": svc().get_workflow_snapshot(limit=last)}


@router.get("/api/conductor/subagent/{sid}")
async def get_subagent(
    sid: str, max_len: int = Query(default=5000, ge=1, le=1_000_000)
) -> ConductorSubagent:
    service = svc()
    s = service.pool.get(sid)
    if not s:
        raise HTTPException(404, "subagent not found")
    cleaned = clean_log_text(s.reply or "")
    return {
        "id": s.id,
        "prompt": s.prompt,
        "status": s.status,
        "reply": cleaned[-max_len:] if len(cleaned) > max_len else cleaned,
        "created_at": s.created_at,
        "updated_at": s.updated_at,
        "review_status": getattr(s, "review_status", "none"),
        "review_note": getattr(s, "review_note", ""),
        "attempt": getattr(s, "attempt", 1),
        "completed_at": getattr(s, "completed_at", None),
        "accepted_at": getattr(s, "accepted_at", None),
        "generation": getattr(s, "active_generation", 0),
        "request_id": service.workflow_tracker.request_for_subagent(s.id),
    }


@router.post("/api/conductor/subagent")
async def start_subagent(body: ConductorStartSubagent) -> ConductorSubagentInstructionResp:
    workflow = {"request_id": body.request_id} if body.request_id is not None else {}
    result = await _dispatch_through_engine(
        svc().start_subagent,
        body.prompt,
        **workflow,
        llm_index=body.llm_index,
        conductor_llm_index=body.conductor_llm_index,
        subagent_llm_index=body.subagent_llm_index,
        subagent_model_policy=body.subagent_model_policy,
    )
    result["instruction"] = INSTR_DISPATCHED
    return result


@router.post("/api/conductor/subagent/{sid}")
async def subagent_action(
    sid: str, body: ConductorSubagentAction
) -> ConductorSubagentActionResp:
    service = svc()
    pool = service.pool
    s = pool.get(sid)
    if not s:
        raise HTTPException(404, "subagent not found")
    action = body.action.lower().strip()
    if action == "keyinfo":
        result = await _dispatch_through_engine(pool.keyinfo_subagent, sid, body.msg)
        result["instruction"] = INSTR_KEYINFO
        return result
    if action == "accept":
        result = await _dispatch_through_engine(
            service.accept_subagent,
            sid,
            body.msg,
            request_id=body.request_id,
        )
        if "error" in result:
            raise HTTPException(409, result["error"])
        return result
    if action == "rework":
        result = await _dispatch_through_engine(
            service.rework_subagent,
            sid,
            body.msg,
            request_id=body.request_id,
            llm_index=body.llm_index,
            conductor_llm_index=body.conductor_llm_index,
            subagent_llm_index=body.subagent_llm_index,
            subagent_model_policy=body.subagent_model_policy,
        )
        if "error" in result:
            raise HTTPException(409, result["error"])
        result["instruction"] = INSTR_DISPATCHED
        return result
    if action in ("input", "reply", "append", "message", "msg"):
        workflow = {"request_id": body.request_id} if body.request_id is not None else {}
        result = await _dispatch_through_engine(
            service.input_subagent,
            sid,
            body.msg,
            **workflow,
            llm_index=body.llm_index,
            conductor_llm_index=body.conductor_llm_index,
            subagent_llm_index=body.subagent_llm_index,
            subagent_model_policy=body.subagent_model_policy,
        )
        result["instruction"] = INSTR_DISPATCHED
        return result
    if action in ("abort", "stop"):
        return await _dispatch_through_engine(pool.abort_subagent, sid)
    raise HTTPException(400, f"unknown action: {body.action}")


# ── status / log ─────────────────────────────────────────────────────────────
@router.get("/api/conductor/log")
async def get_conductor_log() -> ConductorLogResp:
    return {"log": svc().get_conductor_log()}


@router.get("/api/conductor/status")
async def get_status() -> ConductorStatusResp:
    service = svc()
    return _status_payload(service)


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
    status = _status_payload(service)
    return {"ok": started or status["started"], **status}


@router.post("/api/conductor/stop")
async def stop_conductor() -> ConductorLifecycleResp:
    """Stop the conductor supervisor."""
    service = svc()
    stopped = await asyncio.to_thread(service.stop)
    return {"ok": stopped, **_status_payload(service)}
