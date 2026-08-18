"""Global event WebSocket — fans out EventBus to subscribers."""
from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from ..origin_policy import is_allowed_ui_origin
from ..schemas import EventRecentResp
from ..services.event_bus import Event, bus

log = logging.getLogger(__name__)
router = APIRouter()


def _event_frame(event: Event) -> dict:
    return {
        "topic": event.topic,
        "payload": event.payload,
        "ts": event.ts,
        "event_id": event.event_id,
        "epoch": bus.epoch,
    }


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
    replay_n = max(0, replay_n)

    raw_after = ws.query_params.get("after_event_id")
    cursor_enabled = ws.query_params.get("cursor") == "1" or raw_after is not None
    if not cursor_enabled:
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
        return

    after_event_id: int | None = None
    invalid_cursor = False
    if raw_after is not None:
        try:
            after_event_id = int(raw_after)
            invalid_cursor = after_event_id < 0
        except ValueError:
            invalid_cursor = True

    subscription = await bus.subscribe_after(
        prefix_filter,
        after_event_id=None if invalid_cursor else after_event_id,
        epoch=ws.query_params.get("epoch"),
        replay=0 if invalid_cursor else replay_n,
    )
    if invalid_cursor:
        subscription.resync_reason = "invalid_cursor"

    try:
        if subscription.resync_reason is not None:
            await ws.send_json({
                "type": "resync_required",
                "reason": subscription.resync_reason,
                "epoch": bus.epoch,
            })

        for event in subscription.replay:
            await ws.send_json(_event_frame(event))

        await ws.send_json({
            "type": "replay_done",
            "event_id": subscription.boundary_id,
            "epoch": bus.epoch,
        })

        async def forward_events() -> None:
            async for event in subscription.live():
                await ws.send_json(_event_frame(event))
            if subscription.live_resync_reason is not None:
                await ws.send_json({
                    "type": "resync_required",
                    "reason": subscription.live_resync_reason,
                    "epoch": bus.epoch,
                })
                await ws.close(code=1013, reason="resync required")

        forward_task = asyncio.create_task(forward_events())
        try:
            while True:
                message = await ws.receive_json()
                if message.get("type") == "ping":
                    await ws.send_json({"type": "pong"})
        except WebSocketDisconnect:
            pass
        finally:
            forward_task.cancel()
            try:
                await forward_task
            except asyncio.CancelledError:
                pass
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.exception("ws_events crashed: %s", e)
        try:
            await ws.close()
        except Exception:
            pass
    finally:
        await subscription.close()


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
