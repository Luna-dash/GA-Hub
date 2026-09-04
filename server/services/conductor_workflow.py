"""Request-scoped Conductor workflow state for the GA-Hub adapter."""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from .conductor_vocabulary import (
    CLOSED_WORKER_STATES,
    COMPLETION_WORKER_EVENTS,
    RECOVERABLE_FAILURE_STATE,
    RUNNING_WORKER_EVENTS,
    STAGE_AGGREGATING,
    STAGE_AWAITING_REVIEW,
    STAGE_COMPLETED,
    STAGE_FAILED,
    STAGE_PLANNING,
    STAGE_RECOVERABLE_FAILURE,
    STAGE_REWORKING,
    STAGE_SUPERVISING,
    TERMINAL_FAILURE_EVENTS,
    WORKER_ACCEPTED,
    WORKER_EVENT_ACCEPTED,
    WORKER_FAILED,
    WORKER_PENDING,
    WORKER_REJECTED,
    WORKER_TIMEOUT,
    WORKER_EVENT_FAILED,
    WORKER_EVENT_REJECTED,
    WORKER_EVENT_TIMEOUT_TOTAL,
    WORKER_RUNNING,
    WORKFLOW_ADMITTED,
    WORKFLOW_AWAITING_REVIEW,
    WORKFLOW_COMPLETED,
    WORKFLOW_FAILED,
    WORKFLOW_REWORKING,
    WORKFLOW_SUPERVISING,
)


Clock = Callable[[], float]


@dataclass
class WorkerState:
    generation: int
    state: str = WORKER_RUNNING


@dataclass
class WorkflowState:
    request_id: str
    state: str = WORKFLOW_ADMITTED
    workers: dict[str, WorkerState] = field(default_factory=dict)
    final_item: dict[str, Any] | None = None
    created_at: float = 0.0
    completed_at: float | None = None
    terminal_event: str | None = None
    # Failure context, persisted so recovery snapshots (snapshots()/snapshot())
    # keep naming WHY a workflow closed — the live transition event carries it
    # once, but a page opened later must still see the reason.
    phase: str | None = None
    error: str | None = None
    failed_agent_id: str | None = None


def workflow_stage(workflow: WorkflowState) -> str:
    """Derive the UI stage of a workflow (the page only renders it).

    Priority mirrors what the page must show, most specific first: a closed
    workflow is done or dead; a ``failed`` state without a terminal event is
    a recoverable worker failure; an all-accepted round is being finalized;
    a rework attempt outranks siblings waiting for review.
    """
    if workflow.terminal_event is not None:
        return (STAGE_COMPLETED if workflow.state == WORKFLOW_COMPLETED
                else STAGE_FAILED)
    if workflow.state == RECOVERABLE_FAILURE_STATE:
        return STAGE_RECOVERABLE_FAILURE
    workers = workflow.workers.values()
    if workers and all(w.state == WORKER_ACCEPTED for w in workers):
        return STAGE_AGGREGATING
    if (workflow.state == WORKFLOW_REWORKING
            or any(w.generation > 1 and w.state == WORKER_RUNNING
                   for w in workers)):
        return STAGE_REWORKING
    if workflow.state == WORKFLOW_AWAITING_REVIEW:
        return STAGE_AWAITING_REVIEW
    if workflow.state == WORKFLOW_SUPERVISING:
        return STAGE_SUPERVISING
    return STAGE_PLANNING


class WorkflowTracker:
    """Track explicit request-to-worker ownership and terminal workflow events."""

    def __init__(self, *, clock: Clock = time.time, max_workflows: int = 256) -> None:
        self._clock = clock
        self._max_workflows = max(1, max_workflows)
        self._lock = threading.RLock()
        self._workflows: dict[str, WorkflowState] = {}
        self._owners: dict[str, str] = {}

    def admit(self, request_id: str) -> None:
        with self._lock:
            self._workflows.setdefault(
                request_id,
                WorkflowState(request_id=request_id, created_at=self._clock()),
            )
            self._prune_terminal()

    def has_request(self, request_id: str) -> bool:
        with self._lock:
            return request_id in self._workflows

    def request_for_subagent(self, agent_id: str) -> str | None:
        with self._lock:
            return self._owners.get(agent_id)

    def bind_subagent(
        self, request_id: str, agent_id: str, generation: int
    ) -> dict[str, Any] | None:
        """Bind a committed worker generation to one admitted request."""
        with self._lock:
            workflow = self._require(request_id)
            if workflow.terminal_event is not None:
                raise ValueError(f"workflow {request_id} is already terminal")
            self._owners[agent_id] = request_id
            current = workflow.workers.get(agent_id)
            # A same-generation completion can race the HTTP dispatch return.
            # Preserve its pending/accepted state instead of resetting it.
            if current is None or generation > current.generation:
                workflow.workers[agent_id] = WorkerState(generation=generation)
                workflow.state = WORKFLOW_SUPERVISING
            elif current.state == WORKER_RUNNING:
                workflow.state = WORKFLOW_SUPERVISING
            return self._complete_if_ready(workflow)

    def record_subagent_event(
        self,
        agent_id: str,
        event: str,
        *,
        generation: int | None = None,
        request_id: str | None = None,
        error: str = "",
    ) -> tuple[str | None, tuple[str, dict[str, Any]] | None]:
        """Apply one lifecycle event and return an optional workflow bus event."""
        with self._lock:
            owner = self._owners.get(agent_id)
            if request_id is not None:
                workflow = self._require(request_id)
                if owner is not None and owner != request_id:
                    previous = self._workflows.get(owner)
                    if previous is None or previous.terminal_event is None:
                        raise ValueError(
                            f"subagent {agent_id} belongs to request {owner}, not {request_id}"
                        )
                if workflow.terminal_event is not None:
                    # Never adopt a subagent onto a terminal workflow: the
                    # request already closed, so the ownership overwrite would
                    # orphan the worker's remaining lifecycle events.
                    return request_id, None
                self._owners[agent_id] = request_id
                owner = request_id
            if owner is None:
                return None, None

            workflow = self._workflows.get(owner)
            if workflow is None:
                return None, None
            worker = workflow.workers.get(agent_id)
            event_generation = generation if generation is not None else 0
            if worker is None:
                worker = WorkerState(generation=event_generation)
                workflow.workers[agent_id] = worker
            elif generation is not None and generation < worker.generation:
                return owner, None
            elif generation is not None and generation > worker.generation:
                worker.generation = generation
                worker.state = WORKER_RUNNING

            if workflow.terminal_event is not None:
                return owner, None
            if event in RUNNING_WORKER_EVENTS:
                worker.state = WORKER_RUNNING
                workflow.state = (WORKFLOW_REWORKING
                                  if event == "reworked" else WORKFLOW_SUPERVISING)
            elif event in COMPLETION_WORKER_EVENTS:
                worker.state = WORKER_PENDING
                workflow.state = WORKFLOW_AWAITING_REVIEW
            elif event == WORKER_EVENT_ACCEPTED:
                worker.state = WORKER_ACCEPTED
            elif event == WORKER_EVENT_REJECTED:
                # Terminal verdict for THIS worker only: the delivery was
                # refused without a new attempt. The workflow stays open until
                # a fresh dispatch (or an already-accepted sibling) delivers.
                worker.state = WORKER_REJECTED
            elif event == WORKER_EVENT_TIMEOUT_TOTAL:
                # The watchdog killed the attempt, but the engine keeps the
                # worker reviewable as "timeout" (rework opens a new attempt),
                # so the workflow waits for the supervisor's decision.
                worker.state = WORKER_TIMEOUT
                workflow.state = WORKFLOW_AWAITING_REVIEW
            elif event == WORKER_EVENT_FAILED:
                # A dispatch failure is recoverable (engine rework or a fresh
                # dispatch for the same goal); only user cancellation and
                # idle reaping close the workflow outright.
                worker.state = WORKER_FAILED
                workflow.state = WORKFLOW_FAILED
                return owner, (
                    "conductor:worker_failed",
                    self._payload(workflow, error=error, failed_agent_id=agent_id),
                )
            elif event in TERMINAL_FAILURE_EVENTS:
                worker.state = event
                workflow.state = event
                workflow.completed_at = self._clock()
                workflow.terminal_event = "workflow_failed"
                workflow.error = error or None
                workflow.failed_agent_id = agent_id or None
                return owner, (
                    "conductor:workflow_failed",
                    self._payload(workflow, error=error, failed_agent_id=agent_id),
                )

            completed = self._complete_if_ready(workflow)
            if completed is not None:
                return owner, ("conductor:workflow_completed", completed)
            return owner, None

    def record_final(
        self, request_id: str, item: dict[str, Any]
    ) -> tuple[str, dict[str, Any]] | None:
        with self._lock:
            workflow = self._require(request_id)
            self._assert_ready_for_final(workflow)
            workflow.final_item = item
            completed = self._complete_if_ready(workflow)
            if completed is None:
                return None
            return "conductor:workflow_completed", completed

    def assert_ready_for_final(self, request_id: str) -> None:
        with self._lock:
            self._assert_ready_for_final(self._require(request_id))

    def fail_supervisor(
        self, request_id: str, *, phase: str, error: str
    ) -> tuple[str, dict[str, Any]] | None:
        with self._lock:
            workflow = self._workflows.get(request_id)
            if workflow is None or workflow.terminal_event is not None:
                return None
            workflow.state = WORKFLOW_FAILED
            workflow.completed_at = self._clock()
            workflow.terminal_event = "workflow_failed"
            workflow.phase = phase or None
            workflow.error = error or None
            return (
                "conductor:workflow_failed",
                self._payload(workflow, phase=phase, error=error),
            )

    def snapshot(self, request_id: str) -> dict[str, Any] | None:
        with self._lock:
            workflow = self._workflows.get(request_id)
            return self._payload(workflow) if workflow is not None else None

    def snapshots(self, limit: int = 20) -> list[dict[str, Any]]:
        """Return recent workflows in creation order for UI recovery."""
        with self._lock:
            workflows = sorted(
                self._workflows.values(),
                key=lambda workflow: workflow.created_at,
            )[-max(1, limit):]
            return [self._payload(workflow) for workflow in workflows]

    def stranded_admitted(self, limit: int = 5) -> list[dict[str, Any]]:
        """Non-terminal workflows stuck in ``admitted`` with zero workers.

        A request can end up here when the stop drain only sweeps engine-side
        work (a dispatch that 422'd, a message queued behind a busy conductor,
        or a user message discarded with the queue). The workflow never sees a
        worker event, so it stays open forever and a conductor restart finds
        nothing to resume. ``redispatch_stranded_workflows`` re-relays these
        original user messages on (re)start; anything already supervising
        workers or terminal is deliberately left alone.
        """
        with self._lock:
            stranded = sorted(
                (
                    workflow
                    for workflow in self._workflows.values()
                    if workflow.terminal_event is None
                    and workflow.state == WORKFLOW_ADMITTED
                    and not workflow.workers
                ),
                key=lambda workflow: workflow.created_at,
            )
            return [self._payload(workflow) for workflow in stranded[-max(1, limit):]]

    def abandon_stranded(
            self, *, reason: str) -> list[tuple[str, dict[str, Any]]]:
        """Terminal-fail every stranded ``admitted`` workflow (manual stop).

        Manual stop means the user gave up on the task, so the cold-start
        redispatch must not resurrect these on the next start. Returns the
        published workflow_failed transitions; once terminal, the workflows
        no longer count as stranded. Only workerless ``admitted`` workflows
        are swept — supervising/awaiting_review workflows keep their own
        terminal path via worker CANCELLED events.
        """
        with self._lock:
            transitions: list[tuple[str, dict[str, Any]]] = []
            for workflow in list(self._workflows.values()):
                if (workflow.terminal_event is not None
                        or workflow.state != WORKFLOW_ADMITTED
                        or workflow.workers):
                    continue
                workflow.state = WORKFLOW_FAILED
                workflow.completed_at = self._clock()
                workflow.terminal_event = "workflow_failed"
                workflow.phase = "stopped_by_user"
                workflow.error = reason or None
                transitions.append((
                    "conductor:workflow_failed",
                    self._payload(workflow, phase="stopped_by_user",
                                  error=reason),
                ))
            return transitions

    def _require(self, request_id: str) -> WorkflowState:
        workflow = self._workflows.get(request_id)
        if workflow is None:
            raise ValueError(f"unknown conductor request_id: {request_id}")
        return workflow

    @staticmethod
    def _assert_ready_for_final(workflow: WorkflowState) -> None:
        if workflow.terminal_event is not None:
            raise ValueError(f"workflow {workflow.request_id} is already terminal")
        if not workflow.workers:
            # Workerless final: the supervisor explicitly closes a request
            # that needed no execution at all (housekeeping/acknowledgement).
            # Without this escape hatch such requests strand in "admitted"
            # forever (live E2E 2026-08-30 finding); the engine boundary only
            # admits a workerless final for a request it actually saw.
            return
        open_workers = [
            agent_id
            for agent_id, worker in workflow.workers.items()
            if worker.state not in CLOSED_WORKER_STATES
        ]
        if open_workers:
            detail = ", ".join(
                f"{agent_id}:{workflow.workers[agent_id].state}"
                for agent_id in sorted(open_workers)
            )
            raise ValueError(
                "cannot finalize before every subagent is accepted or "
                f"rejected (open: {detail})"
            )
        if not any(
            worker.state == WORKER_ACCEPTED for worker in workflow.workers.values()
        ):
            raise ValueError(
                "cannot finalize without at least one accepted subagent"
            )

    def _prune_terminal(self) -> None:
        overflow = len(self._workflows) - self._max_workflows
        if overflow <= 0:
            return
        terminal = sorted(
            (
                workflow
                for workflow in self._workflows.values()
                if workflow.terminal_event is not None
            ),
            key=lambda workflow: workflow.completed_at or workflow.created_at,
        )
        removed = {workflow.request_id for workflow in terminal[:overflow]}
        for request_id in removed:
            self._workflows.pop(request_id, None)
        if removed:
            self._owners = {
                agent_id: owner
                for agent_id, owner in self._owners.items()
                if owner not in removed
            }

    def _complete_if_ready(self, workflow: WorkflowState) -> dict[str, Any] | None:
        if workflow.terminal_event is not None or workflow.final_item is None:
            return None
        if workflow.workers and any(
            worker.state not in CLOSED_WORKER_STATES
            for worker in workflow.workers.values()
        ):
            return None
        if workflow.workers and not any(
            worker.state == WORKER_ACCEPTED for worker in workflow.workers.values()
        ):
            return None
        workflow.state = WORKFLOW_COMPLETED
        workflow.completed_at = self._clock()
        workflow.terminal_event = "workflow_completed"
        return self._payload(workflow)

    @staticmethod
    def _payload(workflow: WorkflowState, **extra: Any) -> dict[str, Any]:
        states = {
            agent_id: {
                "generation": worker.generation,
                "state": worker.state,
            }
            for agent_id, worker in workflow.workers.items()
        }
        payload: dict[str, Any] = {
            "request_id": workflow.request_id,
            "status": workflow.state,
            # UI stage decided by the tracker; the page only renders it.
            "stage": workflow_stage(workflow),
            # None while the workflow can still recover (worker failure,
            # rework, a fresh dispatch); set once it is terminal.
            "terminal_event": workflow.terminal_event,
            "subagents": states,
            "created_at": workflow.created_at,
            "completed_at": workflow.completed_at,
            # Persisted failure context (None until a failure names it).
            "phase": workflow.phase,
            "error": workflow.error,
            "failed_agent_id": workflow.failed_agent_id,
        }
        if workflow.final_item is not None:
            payload["item"] = workflow.final_item
        payload.update({key: value for key, value in extra.items() if value})
        return payload
