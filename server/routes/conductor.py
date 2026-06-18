"""Conductor routes — multi-agent orchestration REST API.

All endpoints prefixed with /api/conductor. Real-time updates flow through
the shared EventBus (/ws/events?prefix=conductor:), not a dedicated WS.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from ..schemas import (
    ConductorApproval,
    ConductorChatIn,
    ConductorStartReq,
    ConductorStartSubagent,
    ConductorSubagentAction,
)
from ..services.conductor_service import ConductorService, clean_log_text, short_id
from ..services.event_bus import bus

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


# ── readme / docs ────────────────────────────────────────────────────────────
@router.get("/api/conductor/readme")
async def get_readme():
    return {"content": svc().get_readme("api")}


@router.get("/api/conductor/readme/{topic}")
async def get_readme_topic(topic: str):
    content = svc().get_readme(topic)
    if content is None:
        available = ", ".join(svc().get_readmes().keys())
        raise HTTPException(404, f"Unknown topic: {topic}. Available: {available}")
    return {"content": content}


# ── chat ─────────────────────────────────────────────────────────────────────
@router.get("/api/conductor/chat")
async def get_chat(last: int = 20):
    return {"items": svc().get_chat_messages(last=last)}


@router.post("/api/conductor/chat")
async def post_chat(body: ConductorChatIn):
    return svc().add_chat_message(body.msg, role=body.role, llm_index=body.llm_index)


# ── subagents ────────────────────────────────────────────────────────────────
@router.get("/api/conductor/subagent")
async def list_subagents():
    return {"items": svc().pool.snapshot()}


@router.get("/api/conductor/subagent/{sid}")
async def get_subagent(sid: str, max_len: int = 5000):
    s = svc().pool.get(sid)
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
    }


@router.post("/api/conductor/subagent")
async def start_subagent(body: ConductorStartSubagent):
    result = svc().pool.start_subagent(body.prompt, llm_index=body.llm_index)
    result["instruction"] = INSTR_DISPATCHED
    return result


@router.post("/api/conductor/subagent/{sid}")
async def subagent_action(sid: str, body: ConductorSubagentAction):
    pool = svc().pool
    s = pool.get(sid)
    if not s:
        raise HTTPException(404, "subagent not found")
    action = body.action.lower().strip()
    if action == "keyinfo":
        result = pool.keyinfo_subagent(sid, body.msg)
        result["instruction"] = INSTR_KEYINFO
        return result
    if action in ("input", "reply", "append", "message", "msg"):
        result = pool.input_subagent(sid, body.msg)
        result["instruction"] = INSTR_DISPATCHED
        return result
    if action in ("abort", "stop"):
        return pool.abort_subagent(sid)
    raise HTTPException(400, f"unknown action: {body.action}")


# ── approval ─────────────────────────────────────────────────────────────────
@router.post("/api/conductor/approval")
async def post_approval(body: ConductorApproval):
    bus.publish(
        "conductor:approval",
        {"item": {"id": short_id(), "prompt": body.prompt, "source": body.source}},
    )
    return {"ok": True}


# ── status / log ─────────────────────────────────────────────────────────────
@router.get("/api/conductor/log")
async def get_conductor_log():
    return {"log": svc().get_conductor_log()}


@router.get("/api/conductor/status")
async def get_status():
    running, stopped = svc().pool.counts()
    return {
        "started": svc()._started,
        "subagents": {"running": running, "stopped": stopped},
        "chat_count": len(svc().chat_messages),
    }


@router.post("/api/conductor/start")
async def start_conductor(body: ConductorStartReq | None = None):
    """Start the conductor supervisor."""
    svc().start(llm_index=body.llm_index if body else None)
    return {"ok": True, "started": svc()._started}


@router.post("/api/conductor/stop")
async def stop_conductor():
    """Stop the conductor supervisor."""
    svc()._started = False
    return {"ok": True, "started": svc()._started}
