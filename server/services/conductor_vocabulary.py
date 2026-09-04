"""Single-source status vocabulary for the Conductor boundary.

``conductor_workflow.py`` owns the workflow state machine; this module owns
the STRINGS every layer shares — schema Literals, the service's terminal
sets, the timeout monitor, the pool mirror and the UI stage derivation all
read from here.  ``tests/test_conductor_vocabulary.py`` asserts the pydantic
Literals stay identical to these frozensets, so adding a state without
updating every consumer fails tests instead of silently drifting the UI.

UI stages are deliberately part of the vocabulary: the backend decides
*which stage a workflow/worker is in* (the tracker computes it), while the
page only maps stage -> label/tone copy.
"""
from __future__ import annotations

# ── engine subagent lifecycle (GET /subagent snapshot `status`) ─────────
SUBAGENT_RUNNING = "running"
SUBAGENT_STOPPED = "stopped"

# ── hub-side review verdicts (review_status) ────────────────────────────
REVIEW_NONE = "none"
REVIEW_PENDING = "pending"
REVIEW_ACCEPTED = "accepted"
REVIEW_REJECTED = "rejected"
# Verdicts that close a worker for good; the rejected delivery still needs
# the request to be delivered via a fresh dispatch.
REVIEW_CLOSED = frozenset({REVIEW_ACCEPTED, REVIEW_REJECTED})

# ── workflow status (WorkflowTracker workflow.state) ────────────────────
WORKFLOW_ADMITTED = "admitted"
WORKFLOW_SUPERVISING = "supervising"
WORKFLOW_REWORKING = "reworking"
WORKFLOW_AWAITING_REVIEW = "awaiting_review"
WORKFLOW_COMPLETED = "completed"
WORKFLOW_FAILED = "failed"
WORKFLOW_CANCELLED = "cancelled"
WORKFLOW_KILLED = "killed"
WORKFLOW_STATES = frozenset({
    WORKFLOW_ADMITTED, WORKFLOW_SUPERVISING, WORKFLOW_REWORKING,
    WORKFLOW_AWAITING_REVIEW, WORKFLOW_COMPLETED, WORKFLOW_FAILED,
    WORKFLOW_CANCELLED, WORKFLOW_KILLED,
})
# Only deliberate cancellation / reaping closes the whole workflow. A
# worker failure stays recoverable: the engine allows rework or a fresh
# dispatch, so ``failed`` without a terminal_event remains open.
TERMINAL_WORKFLOW_STATES = frozenset({
    WORKFLOW_COMPLETED, WORKFLOW_FAILED, WORKFLOW_CANCELLED, WORKFLOW_KILLED,
})
RECOVERABLE_FAILURE_STATE = WORKFLOW_FAILED

# ── worker states inside a workflow (WorkerState.state) ─────────────────
WORKER_RUNNING = "running"
WORKER_PENDING = "pending"
WORKER_ACCEPTED = "accepted"
WORKER_REJECTED = "rejected"
WORKER_TIMEOUT = "timeout"
WORKER_FAILED = "failed"
WORKER_CANCELLED = "cancelled"
WORKER_KILLED = "killed"
WORKER_STATES = frozenset({
    WORKER_RUNNING, WORKER_PENDING, WORKER_ACCEPTED, WORKER_REJECTED,
    WORKER_TIMEOUT, WORKER_FAILED, WORKER_CANCELLED, WORKER_KILLED,
})
CLOSED_WORKER_STATES = frozenset({WORKER_ACCEPTED, WORKER_REJECTED})

# ── worker lifecycle events (journal/SSE `conductor:subagent_*` payloads) ──
# Events that put (or keep) a worker on a live attempt.
RUNNING_WORKER_EVENTS = frozenset({"spawned", "started", "running", "reworked"})
# Events that hand the finished attempt to the review queue.
WORKER_EVENT_RUNNING = "running"
WORKER_EVENT_REWORKED = "reworked"
WORKER_EVENT_PENDING_REVIEW = "pending_review"
COMPLETION_WORKER_EVENTS = frozenset({"completed", WORKER_EVENT_PENDING_REVIEW})
WORKER_EVENT_ACCEPTED = "accepted"
WORKER_EVENT_REJECTED = "rejected"
WORKER_EVENT_TIMEOUT_TOTAL = "timeout_total"
WORKER_EVENT_FAILED = "failed"
WORKER_EVENTS = frozenset({
    WORKER_EVENT_RUNNING,
    *RUNNING_WORKER_EVENTS,
    *COMPLETION_WORKER_EVENTS,
    WORKER_EVENT_ACCEPTED, WORKER_EVENT_REJECTED,
    WORKER_EVENT_TIMEOUT_TOTAL, WORKER_EVENT_FAILED,
})
# Deliberate cancellation / idle reaping: the only worker events that close
# the whole workflow (``failed``/``timeout_total`` stay recoverable).
TERMINAL_FAILURE_EVENTS = frozenset({WORKFLOW_CANCELLED, WORKFLOW_KILLED})

# ── UI stages (backend-computed; the page only renders them) ────────────
STAGE_PLANNING = "planning"
STAGE_SUPERVISING = "supervising"
STAGE_REWORKING = "reworking"
STAGE_AWAITING_REVIEW = "awaiting_review"
STAGE_AGGREGATING = "aggregating"
STAGE_RECOVERABLE_FAILURE = "recoverable_failure"
STAGE_COMPLETED = "completed"
STAGE_FAILED = "failed"
# Terminal from the UI's point of view: nothing further will happen.
STAGE_WORKFLOW_CLOSED = frozenset({STAGE_COMPLETED, STAGE_FAILED})

STAGE_WORKER_RUNNING = "running"
STAGE_WORKER_REWORKING = "reworking"
STAGE_WORKER_REVIEWING = "reviewing"
STAGE_WORKER_ACCEPTED = "accepted"
STAGE_WORKER_STOPPED = "stopped"


def subagent_stage(*, status: str, attempt: int, review_status: str) -> str:
    """Derive the UI stage of one engine subagent snapshot.

    The tracker semantics this encodes: a running worker past its first
    attempt is a rework in flight; a stopped worker waits for a review
    verdict unless one already closed it.
    """
    if status == SUBAGENT_RUNNING:
        return STAGE_WORKER_REWORKING if attempt > 1 else STAGE_WORKER_RUNNING
    if review_status == REVIEW_PENDING:
        return STAGE_WORKER_REVIEWING
    if review_status == REVIEW_ACCEPTED:
        return STAGE_WORKER_ACCEPTED
    return STAGE_WORKER_STOPPED
