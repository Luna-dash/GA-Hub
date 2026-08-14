"""Global event WebSocket — fans out EventBus to subscribers."""
from __future__ import annotations

import ipaddress
import logging
from urllib.parse import urlsplit

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from ..schemas import EventRecentResp
from ..services.event_bus import bus

log = logging.getLogger(__name__)
router = APIRouter()


def _is_allowed_origin(origin: str | None) -> bool:
    """Allow non-browser clients and browser pages served from loopback only."""
    if origin is None:
        return True
    try:
        parsed = urlsplit(origin)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path
            or parsed.query
            or parsed.fragment
        ):
            return False
        # Accessing ``port`` also rejects malformed/out-of-range values.
        parsed.port
        host = parsed.hostname.rstrip(".").lower()
        if host == "localhost":
            return True
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


@router.websocket("/ws/events")
async def ws_events(ws: WebSocket):
    """Stream bus events to clients from the local GA-Hub UI."""
    origin = ws.headers.get("origin")
    if not _is_allowed_origin(origin):
        log.warning("Rejected EventBus WebSocket from origin %r", origin)
        await ws.close(code=1008, reason="Forbidden origin")
        return
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
