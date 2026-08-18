"""Global event WebSocket — fans out EventBus to subscribers."""
from __future__ import annotations

import logging

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from ..origin_policy import is_allowed_ui_origin
from ..schemas import EventRecentResp
from ..services.event_bus import bus

log = logging.getLogger(__name__)
router = APIRouter()

@router.websocket("/ws/events")
async def ws_events(ws: WebSocket):
    """Stream bus events to clients from the local GA-Hub UI."""
    origin = ws.headers.get("origin")
    if not is_allowed_ui_origin(origin):
        log.warning("Rejected EventBus WebSocket from origin %r", origin)
        await ws.close(code=1008, reason="Forbidden origin")
        return
    await ws.accept()
    prefixes = ws.query_params.getlist("prefix")
    prefix_filter: str | tuple[str, ...]
    if not prefixes:
        prefix_filter = ""
    elif len(prefixes) == 1:
        prefix_filter = prefixes[0]
    else:
        prefix_filter = tuple(prefixes)
    try:
        replay_n = int(ws.query_params.get("replay", "0"))
    except ValueError:
        replay_n = 0
    try:
        async for evt in bus.subscribe(prefix=prefix_filter, replay=replay_n):
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
async def recent_events(
    prefix: str = "",
    limit: int = Query(default=100, ge=1, le=1000),
) -> EventRecentResp:
    return {
        "events": [
            {"topic": e.topic, "payload": e.payload, "ts": e.ts}
            for e in bus.history(prefix=prefix, limit=limit)
        ]
    }
