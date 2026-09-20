"""Request-scoped Conductor workflow state for the GA-Hub adapter."""
from __future__ import annotations

import threading
import time
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from typing import Any, Callable

from ..event_topics import (
    CONDUCTOR_WORKER_FAILED,
    CONDUCTOR_WORKFLOW_COMPLETED,
    CONDUCTOR_WORKFLOW_FAILED,
    CONDUCTOR_WORKFLOW_REOPENED,
)
from .conductor_vocabulary import (
    WORKER_EVENT_REWORKED,
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
    title: str | None = None
    admission_state: str = "admitted"
    boot_id: str | None = None
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
        self.tombstones: set[str] = set()
        self.store = None

    @contextmanager
    def transaction(self):
        with self.store.transaction() if self.store is not None else self._lock:
            yield

    def export_state(self) -> list[dict]:
        with self._lock:
            return [asdict(workflow) for workflow in self._workflows.values()]

    def _touch(self, request_id: str) -> None:
        if self.store is not None:
            self.store.track_workflow(request_id)

    def restore_state(self, items: list[dict]) -> None:
        with self._lock:
            self._workflows = {}
            self._owners = {}
            for item in items:
                workflow = self._decode_state(item)
                self._workflows[workflow.request_id] = workflow
                for sid in workflow.workers:
                    self._owners[sid] = workflow.request_id

    @staticmethod
    def _decode_state(item: dict) -> WorkflowState:
        data = dict(item)
        workers = {sid: WorkerState(**value) for sid, value in data.pop("workers", {}).items()}
        return WorkflowState(**data, workers=workers)

    def _get(self, request_id: str) -> WorkflowState | None:
        workflow = self._workflows.get(request_id)
        if workflow is None and self.store is not None:
            saved = self.store.workflow(request_id)
            if saved is not None:
                workflow = self._decode_state(saved)
        return workflow

    def set_title(self, request_id: str, title: str) -> None:
        with self.transaction():
            workflow = self._require(request_id)
            if not workflow.title:
                workflow.title = title[:5000]

    def admit(self, request_id: str, *, admission_state: str = "admitted",
              boot_id: str | None = None) -> None:
        if request_id in self.tombstones:
            # A deleted history row must not resurrect from the engine still
            # tracking the request in memory (late journal events, a cursor
            # reset, or a supervisor retry can all re-report it). The set is
            # seeded from the store on attach and grown by forget_workflow.
            return
        with self.transaction():
            existing = self._get(request_id)
            if existing is not None:
                self._workflows[request_id] = existing
            self._touch(request_id)
            self._workflows.setdefault(
                request_id,
                WorkflowState(request_id=request_id, created_at=self._clock(),
                              admission_state=admission_state, boot_id=boot_id),
            )
            self._prune_terminal()

    def forget_workflow(self, request_id: str, *,
                        allow_active: bool = False) -> None:
        """Drop one workflow from the board at the user's request.

        Refuses workflows that are still live while the conductor runs: a
        live run still receives journal events and would immediately
        re-create the projection. Terminal workflows and paused sessions
        (conductor stopped — nothing is executing, and the tombstone guard
        blocks re-admission after the next start) are tombstoned so late
        events, engine retries or a consumer-cursor reset cannot resurrect
        the deleted row (see admit's tombstone guard).
        """
        with self.transaction():
            workflow = self._get(request_id)
            if (workflow is not None and workflow.terminal_event is None
                    and not allow_active):
                raise ValueError("cannot delete an active workflow; stop it first")
            if self.store is not None:
                self.store.forget_workflow(request_id)
            self.tombstones.add(request_id)
            self._workflows.pop(request_id, None)
            self._owners = {agent_id: owner for agent_id, owner in self._owners.items()
                            if owner != request_id}

    def confirm_admission(self, request_id: str, boot_id: str | None) -> None:
        if request_id in self.tombstones:
            return
        with self.transaction():
            self.admit(request_id, boot_id=boot_id)
            workflow = self._require(request_id)
            workflow.admission_state = "admitted"
            if boot_id:
                workflow.boot_id = boot_id

    def has_request(self, request_id: str) -> bool:
        with self._lock:
            return self._get(request_id) is not None

    def is_open(self, request_id: str) -> bool:
        """True when the workflow exists and has not reached a terminal event.

        Recoverable failures count as open: the workflow can still gain a
        rework or fresh dispatch, so a user follow-up belongs to it.
        """
        with self._lock:
            workflow = self._get(request_id)
            return workflow is not None and workflow.terminal_event is None

    def reopen(self, request_id: str) -> dict[str, Any] | None:
        """Re-arm a terminal workflow so a user follow-up reuses its identity.

        Clears the terminal marker and the completed round's bookkeeping so
        the workflow counts as open again (``is_open`` → True) and the next
        dispatch is not swallowed by ``_complete_if_ready``'s stale
        ``final_item``.  Returns the reopen event payload, or None when the
        workflow is unknown, tombstoned, or still open (no reopen needed).
        """
        if request_id in self.tombstones:
            return None
        with self.transaction():
            self._touch(request_id)
            workflow = self._get(request_id)
            if workflow is None or workflow.terminal_event is None:
                return None
            workflow.terminal_event = None
            workflow.final_item = None
            workflow.completed_at = None
            workflow.state = WORKFLOW_SUPERVISING
            workflow.phase = "reopened"
            workflow.error = None
            workflow.failed_agent_id = None
            for worker in workflow.workers.values():
                if worker.state in CLOSED_WORKER_STATES:
                    worker.state = WORKER_RUNNING
            return self._payload(workflow, phase="reopened")

    def request_for_subagent(self, agent_id: str) -> str | None:
        with self._lock:
            return self._owners.get(agent_id) or (self.store.worker_owner(agent_id) if self.store is not None else None)

    def bind_subagent(
        self, request_id: str, agent_id: str, generation: int
    ) -> dict[str, Any] | None:
        """Bind a committed worker generation to one admitted request."""
        with self.transaction():
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
        with self.transaction():
            owner = self.request_for_subagent(agent_id)
            if request_id is not None:
                workflow = self._require(request_id)
                if owner is not None and owner != request_id:
                    previous = self._get(owner)
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
            self._touch(owner)
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
                                  if event == WORKER_EVENT_REWORKED else WORKFLOW_SUPERVISING)
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
                    CONDUCTOR_WORKER_FAILED,
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
                    CONDUCTOR_WORKFLOW_FAILED,
                    self._payload(workflow, error=error, failed_agent_id=agent_id),
                )

            completed = self._complete_if_ready(workflow)
            if completed is not None:
                return owner, (CONDUCTOR_WORKFLOW_COMPLETED, completed)
            return owner, None

    def record_final(
        self, request_id: str, item: dict[str, Any]
    ) -> tuple[str, dict[str, Any]] | None:
        with self.transaction():
            workflow = self._require(request_id)
            if workflow.final_item is not None and workflow.final_item.get("id") == item.get("id"):
                return None
            self._assert_ready_for_final(workflow)
            workflow.final_item = item
            completed = self._complete_if_ready(workflow)
            if completed is None:
                return None
            return CONDUCTOR_WORKFLOW_COMPLETED, completed

    def assert_ready_for_final(self, request_id: str) -> None:
        with self._lock:
            self._assert_ready_for_final(self._require(request_id))

    def fail_supervisor(
        self, request_id: str, *, phase: str, error: str
    ) -> tuple[str, dict[str, Any]] | None:
        with self.transaction():
            workflow = self._workflows.get(request_id)
            if workflow is None or workflow.terminal_event is not None:
                return None
            self._touch(request_id)
            workflow.state = WORKFLOW_FAILED
            workflow.completed_at = self._clock()
            workflow.terminal_event = "workflow_failed"
            workflow.phase = phase or None
            workflow.error = error or None
            return (
                CONDUCTOR_WORKFLOW_FAILED,
                self._payload(workflow, phase=phase, error=error),
            )

    def snapshot(self, request_id: str) -> dict[str, Any] | None:
        with self._lock:
            workflow = self._get(request_id)
            return self._payload(workflow) if workflow is not None else None

    def snapshots(self, limit: int = 20) -> list[dict[str, Any]]:
        """Return recent workflows in creation order for UI recovery."""
        with self._lock:
            candidates = {}
            if self.store is not None:
                candidates = {item["request_id"]: self._decode_state(item) for item in self.store.recent_workflows(limit)}
            candidates.update(self._workflows)
            deleted = self.store.tombstones() if self.store is not None else set()
            workflows = sorted(
                (workflow for request_id, workflow in candidates.items() if request_id not in deleted),
                key=lambda workflow: workflow.created_at,
            )[-max(1, limit):]
            return [self._payload(workflow) for workflow in workflows]

    def stranded_admitted(self, limit: int = 5) -> list[dict[str, Any]]:
        """Non-terminal workflows stuck in ``admitted`` with zero workers.

        A request can end up here when the stop drain only sweeps engine-side
        work (a dispatch that 422'd, a message queued behind a busy conductor,
        or a user message discarded with the queue). The workflow never sees a
        worker event, so it stays open forever.

        Diagnostic surface only — no production caller since the batch
        redispatch was removed: recovery is a per-task user decision via
        ``ConductorService.resume_workflow``, so nothing re-relays these
        automatically any more. Kept for the tests that pin the stranded
        predicate and for future monitoring; its sibling ``abandon_stranded``
        is still the live manual-stop path.
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
        recovery must not resurrect these on the next start. Returns the
        published workflow_failed transitions; once terminal, the workflows
        no longer count as stranded. Only workerless ``admitted`` workflows
        are swept — supervising/awaiting_review workflows keep their own
        terminal path via worker CANCELLED events.
        """
        with self.transaction():
            transitions: list[tuple[str, dict[str, Any]]] = []
            for workflow in list(self._workflows.values()):
                if (workflow.terminal_event is not None
                        or workflow.state != WORKFLOW_ADMITTED
                        or workflow.workers):
                    continue
                self._touch(workflow.request_id)
                workflow.state = WORKFLOW_FAILED
                workflow.completed_at = self._clock()
                workflow.terminal_event = "workflow_failed"
                workflow.phase = "stopped_by_user"
                workflow.error = reason or None
                transitions.append((
                    CONDUCTOR_WORKFLOW_FAILED,
                    self._payload(workflow, phase="stopped_by_user",
                                  error=reason),
                ))
            return transitions

    def _require(self, request_id: str) -> WorkflowState:
        workflow = self._get(request_id)
        if workflow is None:
            raise ValueError(f"unknown conductor request_id: {request_id}")
        self._workflows[request_id] = workflow
        self._touch(request_id)
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

    def _prune_terminal(self, *, committed: bool = False) -> None:
        if self.store is not None and not committed:
            return
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
            "title": workflow.title,
            "admission_state": workflow.admission_state,
            "boot_id": workflow.boot_id,
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
