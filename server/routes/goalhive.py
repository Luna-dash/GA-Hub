"""Goal/Hive WebSocket routes."""
from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..services.goalhive_service import get_goalhive_service

log = logging.getLogger(__name__)
router = APIRouter()


@router.websocket("/ws/goalhive")
async def ws_goalhive(ws: WebSocket):
    """Independent Goal/Hive chat WebSocket.
    
    Protocol:
        IN:  {"type": "submit", "text": "...", "mode": "goal"|"hive", "llm_index": int|null}
             {"type": "abort"}
             {"type": "reset"}
        OUT: {"type": "snapshot", "messages": [...]}
             {"type": "update", "messages": [...]}
    """
    await ws.accept()
    service = get_goalhive_service()
    
    # Send initial snapshot
    try:
        await ws.send_json({
            "type": "snapshot",
            "messages": service.get_messages(),
        })
    except Exception as e:
        log.warning("failed to send initial snapshot: %s", e)
        return
    
    # Spawn update broadcaster
    update_task = asyncio.create_task(_broadcast_updates(ws, service))
    
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = __import__("json").loads(raw)
            except Exception:
                continue
            
            msg_type = msg.get("type")
            
            if msg_type == "submit":
                text = msg.get("text", "")
                mode = msg.get("mode", "goal")
                llm_index = msg.get("llm_index")
                service.submit(text, mode=mode, llm_index=llm_index)
            
            elif msg_type == "abort":
                service.abort()
            
            elif msg_type == "reset":
                service.reset()
                await ws.send_json({
                    "type": "snapshot",
                    "messages": service.get_messages(),
                })
    
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.exception("ws_goalhive error: %s", e)
    finally:
        update_task.cancel()
        try:
            await update_task
        except Exception:
            pass


async def _broadcast_updates(ws: WebSocket, service):
    """Poll and broadcast message updates."""
    last_state = ""
    while True:
        await asyncio.sleep(0.2)
        try:
            messages = service.get_messages()
            state = __import__("json").dumps(messages, ensure_ascii=False)
            if state != last_state:
                last_state = state
                await ws.send_json({"type": "update", "messages": messages})
        except Exception:
            break
