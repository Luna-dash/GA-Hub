"""Client resume-cursor translation shared by the two WebSocket routes.

Both /ws/events and /ws/sessions/{id} accept an ``after_event_id`` query
param and must not let a malformed cursor break the handshake: an unparsable
or negative value subscribes from the live boundary, forces replay off and
stamps ``resync_reason="invalid_cursor"`` so the client rehydrates.
"""
from __future__ import annotations

from .event_bus import EventPrefixFilter, EventBus, EventSubscription


def parse_event_cursor(raw_after: str | None) -> tuple[int | None, bool]:
    """Parse the ``after_event_id`` query param into (cursor, valid).

    An unparsable or negative cursor is invalid: the caller resumes from the
    live boundary and flags a resync instead of failing the handshake.
    """
    if raw_after is None:
        return None, True
    try:
        cursor = int(raw_after)
    except ValueError:
        return None, False
    return (cursor, True) if cursor >= 0 else (None, False)


async def subscribe_with_cursor(
    bus: EventBus,
    raw_after: str | None,
    *,
    prefix: EventPrefixFilter = "",
    epoch: str | None = None,
    replay: int = 0,
) -> EventSubscription:
    """``bus.subscribe_after`` guarded against an invalid client cursor.

    The bus is an explicit argument: routes pass their module-level ``bus``
    so test patches on that name keep applying.
    """
    cursor, valid = parse_event_cursor(raw_after)
    subscription = await bus.subscribe_after(
        prefix,
        after_event_id=cursor,
        epoch=epoch,
        replay=0 if not valid else replay,
    )
    if not valid:
        subscription.resync_reason = "invalid_cursor"
    return subscription
