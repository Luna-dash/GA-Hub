"""Global event WebSocket — fans out EventBus to subscribers."""
from __future__ import annotations

import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..services.event_bus import bus

log = logging.getLogger(__name__)
router = APIRouter()


@router.websocket("/ws/events")
async def ws_events(ws: WebSocket):
    """Stream all bus events. Optional ?prefix= to filter."""
    await ws.accept()
    prefix = ws.query_params.get("prefix", "")
    try:
        replay_n = int(ws.query_params.get("replay", "0"))
    except ValueError:
        replay_n = 0
    try:
        async for evt in bus.subscribe(prefix=prefix, replay=replay_n):
            await ws.send_json({
                "topic": evt.topic,
                "payload": evt.payload,
                "ts": evt.ts,
            })
    except WebSocketDisconnect:
        return
    except Exception as e:
        log.exception("ws_events crashed: %s", e)
        try:
            await ws.close()
        except Exception:
            pass


@router.get("/api/events/recent")
async def recent_events(prefix: str = "", limit: int = 100):
    return {
        "events": [
            {"topic": e.topic, "payload": e.payload, "ts": e.ts}
            for e in bus.history(prefix=prefix, limit=limit)
        ]
    }
