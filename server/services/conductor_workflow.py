"""Request-scoped Conductor workflow state for the GA-Hub adapter."""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable


Clock = Callable[[], float]


@dataclass
class WorkerState:
    generation: int
    state: str = "running"


@dataclass
class WorkflowState:
    request_id: str
    state: str = "admitted"
    workers: dict[str, WorkerState] = field(default_factory=dict)
    final_item: dict[str, Any] | None = None
    created_at: float = 0.0
    completed_at: float | None = None
    terminal_event: str | None = None


class WorkflowTracker:
    """Track explicit request-to-worker ownership and terminal workflow events."""

    _FAILURE_EVENTS = frozenset({"failed", "cancelled", "killed"})

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
                workflow.state = "supervising"
            elif current.state == "running":
                workflow.state = "supervising"
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
                worker.state = "running"

            if workflow.terminal_event is not None:
                return owner, None
            if event in {"spawned", "started", "running", "reworked"}:
                worker.state = "running"
                workflow.state = "reworking" if event == "reworked" else "supervising"
            elif event in {"completed", "pending_review"}:
                worker.state = "pending"
                workflow.state = "awaiting_review"
            elif event == "accepted":
                worker.state = "accepted"
            elif event in self._FAILURE_EVENTS:
                worker.state = event
                workflow.state = event
                workflow.completed_at = self._clock()
                workflow.terminal_event = "workflow_failed"
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
            workflow.state = "failed"
            workflow.completed_at = self._clock()
            workflow.terminal_event = "workflow_failed"
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
            raise ValueError("cannot finalize before dispatching a subagent")
        if any(worker.state != "accepted" for worker in workflow.workers.values()):
            raise ValueError("cannot finalize before every subagent is accepted")

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
        if not workflow.workers or any(
            worker.state != "accepted" for worker in workflow.workers.values()
        ):
            return None
        workflow.state = "completed"
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
            "subagents": states,
            "created_at": workflow.created_at,
            "completed_at": workflow.completed_at,
        }
        if workflow.final_item is not None:
            payload["item"] = workflow.final_item
        payload.update({key: value for key, value in extra.items() if value})
        return payload
