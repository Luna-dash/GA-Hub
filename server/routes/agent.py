"""Agent + LLM routes."""
from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, HTTPException

from ..schemas import (
    AgentTitleReq,
    BtwReq,
    BtwResp,
    ChatRetryConfigReq,
    LLMSwitch,
    RewindReq,
    RewindResp,
)
from ..services.agent_service import AgentService
from ..services.chat_retry import load_chat_retry_config, save_chat_retry_config

log = logging.getLogger(__name__)
router = APIRouter()


def svc() -> AgentService:
    return AgentService.instance()


@router.get("/api/agent/status")
async def status():
    return svc().status().__dict__


@router.put("/api/agent/title")
async def set_agent_title(req: AgentTitleReq):
    title = svc().set_title(req.title)
    return {"ok": True, "title": title}


@router.post("/api/agent/abort")
async def abort():
    svc().abort()
    return {"ok": True}


@router.post("/api/agent/new")
async def new_conv():
    msg = svc().new_conversation()
    return {"ok": True, "message": msg}


@router.post("/api/agent/btw", response_model=BtwResp)
async def btw(req: BtwReq):
    """Run a side question against current agent history without touching chat stream."""
    q = (req.text or "").strip()
    if not q:
        raise HTTPException(status_code=400, detail="empty btw question")
    try:
        return BtwResp(ok=True, content=await asyncio.to_thread(svc().btw, q))
    except Exception as e:
        log.exception("btw failed: %s", e)
        return BtwResp(ok=False, error=str(e))


@router.post("/api/agent/rewind", response_model=RewindResp)
async def rewind(req: RewindReq):
    """Drop the most-recent completed turn(s) from live LLM history.

    Body: ``{"sid": "..."}`` (preferred) or ``{"n": 1}``.
    Refuses while agent is running. Broadcasts ``chat:rewound`` on the bus
    for multi-tab sync.
    """
    if not req.sid and not req.n:
        raise HTTPException(status_code=400, detail="provide sid or n")
    try:
        # rewind_turns parses the whole native archive — worker thread, same
        # as the session-scoped rewind route.
        return await asyncio.to_thread(svc().rewind_turns, sid=req.sid, n=req.n)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))


@router.get("/api/agent/history")
async def history():
    return {"history": svc().get_history()}


@router.get("/api/agent/chat-retry-config")
async def get_chat_retry_config():
    return await asyncio.to_thread(lambda: load_chat_retry_config().to_dict())


@router.put("/api/agent/chat-retry-config")
async def put_chat_retry_config(req: ChatRetryConfigReq):
    return await asyncio.to_thread(lambda: save_chat_retry_config(req.model_dump()).to_dict())


@router.get("/api/agent/sessions")
async def sessions():
    """Recoverable model_responses snapshots (used by /continue).

    Reads go through the shared archive catalogue (services.archive_messages)
    so list, point lookup and search observe one enumeration + cache instead
    of racing a second raw scan of GA's log directory.
    """
    from ..services.archive_messages import list_archive_sessions
    out = await asyncio.to_thread(list_archive_sessions)
    return {
        "sessions": [
            {"path": p, "mtime": int(m), "preview": preview, "rounds": n}
            for (p, m, preview, n) in out
        ]
    }


@router.post("/api/agent/sessions/{idx}/restore")
async def restore_session(idx: int):
    s = svc()
    restored = await asyncio.to_thread(_restore_session_sync, s, idx)
    if restored is None:
        raise HTTPException(404, "session index out of range")
    msg, full = restored
    # Reset live chat snapshots — the agent's history is now a different
    # conversation, so any in-flight UI bubbles would be misleading.
    s.reset_live_snapshots("session_restored")
    return {"ok": True, "message": msg, "full": full}


def _restore_session_sync(service: AgentService, idx: int) -> tuple[str, str] | None:
    from frontends.continue_cmd import restore

    from ..services.archive_messages import list_archive_sessions

    sessions = list_archive_sessions()
    if idx < 0 or idx >= len(sessions):
        return None
    return restore(service.agent, sessions[idx][0])


# ── LLMs ─────────────────────────────────────────────────────────
@router.get("/api/llms")
async def list_llms():
    # list_llms reloads mykey.py and rebuilds LLM clients — worker thread.
    return {"llms": await asyncio.to_thread(svc().list_llms)}


@router.post("/api/llms/switch")
async def switch_llm(req: LLMSwitch):
    try:
        return await asyncio.to_thread(svc().switch_llm, req.index)
    except RuntimeError as e:
        raise HTTPException(409, str(e))




# ── chat WebSocket tombstone ─────────────────────────────────────
# /ws/chat (the legacy global-agent chat socket) was removed: no frontend page
# ever connected to it (the webui submits through POST /api/sessions/{id}/runs
# and receives on /ws/sessions/{id}). Background producers moved onto system
# sessions through SessionCoordinator. Every route above in this file is live
# on the current UI — do not prune them because of this note.
