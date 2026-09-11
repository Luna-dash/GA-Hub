"""Durable projection from engine journal events to the Conductor 动态 timeline.

The page's 动态 tab used to be a pure in-memory SSE projection: any reload, app
restart or engine resync dropped every row, so a task reopened from history
showed "暂无动态" while its dossier still held the result. The facts were never
lost — the engine's append-only journal has them — but nothing folded them into
a queryable history.

This module is the single mapping from a journal event to a timeline row. The
recovery consumer persists rows through it *and* injects the very same dict into
the published SSE payload, so the live path and the hydrated path agree on both
the stable ``id`` and the rendered copy. Two independent mappings would drift;
one mapping cannot.

Kind vocabulary is a wire contract with ``ActivityTimeline.KIND_TONE``: every
kind returned here needs a colour there, or the row renders without a dot.
"""
from __future__ import annotations

# ── worker lifecycle ─────────────────────────────────────────────
# Journal worker-event name → (kind, copy). Two names are deliberately absent:
#   `completed` — the engine emits it together with `pending_review` in the same
#     instant, and only the latter is worth a row; recording both would double
#     every delivery.
#   `running` — the engine's journal emits `started` for the same transition, so
#     mapping both would print "子代理开工" twice per worker. The page's live feed
#     never had a `running` entry either, so dropping it also keeps the live and
#     hydrated timelines identical.
WORKER_ACTIVITY: dict[str, tuple[str, str]] = {
    "spawned": ("worker_spawned", "子代理已派出"),
    "started": ("worker_started", "子代理开工"),
    "reworked": ("worker_reworked", "按返工意见重新处理"),
    "pending_review": ("worker_pending_review", "子代理交付，等待验收"),
    "accepted": ("worker_accepted", "子代理验收通过"),
    "rejected": ("worker_rejected", "子代理被打回"),
    "timeout_total": ("worker_timeout", "子代理执行超时"),
    "failed": ("worker_failed", "子代理执行失败"),
    "cancelled": ("worker_cancelled", "子代理已取消"),
    "killed": ("worker_killed", "子代理已终止"),
}

# ── workflow terminal transitions ────────────────────────────────
# These are tracker-derived, not journal events, so they are recorded from the
# publish site rather than from the catch-up fold.
WORKFLOW_ACTIVITY: dict[str, str] = {
    "workflow_completed": "任务完成",
    "workflow_failed": "任务失败",
    "workflow_cancelled": "任务已取消",
    "workflow_killed": "任务已终止",
}

# ── supervisor turn outcomes ─────────────────────────────────────
# `yielded` is deliberately absent: it fires once per supervisor turn and only
# means "waiting for the workers", so a row per turn would bury the worker rows
# it is waiting on. The page made the same call live, and dropping it here keeps
# live and hydrated timelines identical.
OUTCOME_OK = ("turn_completed", "Conductor 完成一轮处理")
OUTCOME_FAILED = ("turn_failed", "Conductor 本轮处理失败")

# Killed workers carry the reap reason; it is the difference between "the user
# stopped it" and "it went idle and was collected", which is the one thing a
# reader wants from a termination row.
KILL_REASON_SUFFIX = {
    "idle_timeout": "空闲超时回收",
}


def _row(event_id: str, request_id: str, kind: str, text: str, at: float,
         worker_id: str | None = None) -> dict:
    stamp = float(at) if isinstance(at, (int, float)) and at > 0 else 0.0
    return {
        "id": event_id,
        "request_id": request_id,
        "kind": kind,
        "at": stamp,
        "atMs": int(round(stamp * 1000)),
        "text": text,
        "worker_id": worker_id,
    }


def journal_activity(kind: str, event: dict, *, event_id: str, ts: float) -> dict | None:
    """Timeline row for one journal event, or None when it earns no row.

    ``event_id`` must be derived from the journal epoch and seq by the caller:
    the bus assigns a fresh ``event_id`` to every publish, so a replayed event
    would otherwise duplicate its own history.
    """
    request_id = event.get("request_id")
    if not isinstance(request_id, str) or not request_id:
        return None

    if kind == "request_outcome":
        status = str(event.get("status") or "")
        if status == "yielded":
            return None
        # Anything that is not a clean turn is reported as a failed one: an
        # unrecognised status is an anomaly, and letting it pass silently would
        # make a dead turn read like a clean finish.
        spec = OUTCOME_OK if status == "ok" else OUTCOME_FAILED
        return _row(event_id, request_id, spec[0], spec[1], ts)

    if not kind.startswith("subagent_"):
        return None
    name = kind[len("subagent_"):]

    if name == "milestone":
        desc = str(event.get("desc") or "").strip()
        if not desc:
            return None
        reached = str(event.get("status") or "") == "reached"
        text = f"里程碑 · {desc}" if reached else f"里程碑未达成 · {desc}"
        worker_id = event.get("id")
        return _row(event_id, request_id, "worker_milestone", text, ts,
                    worker_id if isinstance(worker_id, str) else None)

    # Force-accept is the escape hatch a human should always see: it means the
    # mechanical gate was overridden on purpose.
    if name == "force_accept":
        worker_id = event.get("id")
        return _row(event_id, request_id, "worker_force_accepted", "强制验收通过", ts,
                    worker_id if isinstance(worker_id, str) else None)

    spec = WORKER_ACTIVITY.get(name)
    if spec is None:
        return None
    text = spec[1]
    if name == "killed":
        suffix = KILL_REASON_SUFFIX.get(str(event.get("reason") or ""))
        if suffix:
            text = f"{text}（{suffix}）"
    worker_id = event.get("id")
    return _row(event_id, request_id, spec[0], text, ts,
                worker_id if isinstance(worker_id, str) else None)


def workflow_activity(kind: str, request_id: str, *, event_id: str, ts: float) -> dict | None:
    """Timeline row for a workflow terminal transition."""
    text = WORKFLOW_ACTIVITY.get(kind)
    if text is None or not request_id:
        return None
    return _row(event_id, request_id, kind, text, ts)
