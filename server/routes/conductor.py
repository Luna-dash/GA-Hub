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
from ..services.conductor_service import ConductorService

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
    - An engine 503 (e.g. the conductor is stopping, admission refused) is
      relayed verbatim: it is the engine's own unavailability signal.
    - Other engine 5xx stay upstream failures: 502, never a hub-internal
      error.
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
    if status == 503:
        detail = exc.detail
        if isinstance(detail, dict):
            detail = detail.get("error") or detail
        return HTTPException(503, str(detail) or f"gahub_app engine error: {exc}")
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
        "auto_accept": service.auto_accept,
    }


# ── readme / docs ────────────────────────────────────────────────────────────
@router.get("/api/conductor/readme")
async def get_readme() -> ConductorTextResp:
    return {"content": svc().get_readme("api")}


@router.post("/api/conductor/settings")
async def update_conductor_settings(
    body: ConductorSettingsReq,
) -> ConductorStatusResp:
    """Update conductor automation policy (currently: auto-accept)."""
    service = svc()
    service.auto_accept = body.auto_accept
    return _status_payload(service)


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
    """Full worker dossier for human review.

    Engine GET /subagent/{id} is the source of the cleaned reply.  The hub
    list snapshot already carries prompt/manifest/verification and is filled
    in for any field the engine omits, so the UI can show what was asked,
    what landed, and what the machine thinks.
    """
    service = svc()
    detail = await _dispatch_through_engine(service.client.get_subagent, sid, max_len)
    mirrored = service.pool.get(sid)
    if mirrored is not None:
        for key in (
            "prompt", "created_at", "updated_at", "review_note",
            "completed_at", "accepted_at", "deliverables_missing",
            "deliverables_stale", "done_marker", "quality_checks",
            "manifest", "forced_accept", "force_reason", "forced_at",
        ):
            if key in detail and detail[key] not in (None, "", [], {}):
                continue
            value = getattr(mirrored, key, None)
            if value is not None:
                detail[key] = value
    detail.setdefault("prompt", "")
    detail.setdefault("created_at", 0)
    detail.setdefault("updated_at", 0)
    if "generation" not in detail:
        detail["generation"] = int(detail.get("active_generation") or 0)
    if not detail.get("request_id"):
        detail["request_id"] = service.workflow_tracker.request_for_subagent(sid)
    return detail


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
        # Contract B manifest: the engine requires goal + deliverables and
        # answers 422 without them; forward the declared fields verbatim.
        goal=body.goal,
        boundaries=body.boundaries,
        deliverables=[d.model_dump() for d in body.deliverables],
        done_when=body.done_when,
        checks=[c.model_dump() for c in body.checks],
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
    # Worker ownership (roadmap P0-B): resolve the owning request from the
    # workflow tracker and forward it so the engine enforces request_mismatch
    # on EVERY verb — not just accept/rework/input which carried it before.
    tracker = getattr(service, "workflow_tracker", None)
    owner = tracker.request_for_subagent(sid) if tracker is not None else None
    if action == "keyinfo":
        result = await _dispatch_through_engine(
            pool.keyinfo_subagent, sid, body.msg, request_id=owner)
        result["instruction"] = INSTR_KEYINFO
        return result
    if action == "accept":
        result = await _dispatch_through_engine(
            service.accept_subagent,
            sid,
            body.msg,
            request_id=body.request_id,
            force=body.force,
        )
        if "error" in result:
            # completion_unverified must carry the verification evidence the
            # engine computed — the UI renders it before offering force.
            raise HTTPException(409, result)
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
        return await _dispatch_through_engine(
            pool.abort_subagent, sid, request_id=owner)
    raise HTTPException(400, f"unknown action: {body.action}")


# ── status / log ─────────────────────────────────────────────────────────────
@router.get("/api/conductor/log")
async def get_conductor_log() -> ConductorLogResp:
    return {"log": svc().get_conductor_log()}


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
    status = _status_payload(service)
    if not stopped:
        raise HTTPException(503, "Conductor engine could not be stopped; check its health and logs.")
    return {"ok": True, **status}
