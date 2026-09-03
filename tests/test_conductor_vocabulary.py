"""Lock the pydantic Literals to the conductor status vocabulary.

conductor_vocabulary.py owns the strings; these tests make schema drift a
test failure instead of a silent UI mismatch (a new workflow state added to
the tracker without updating the response Literal — or vice versa — used to
be invisible until a page rendered it wrong).
"""
from __future__ import annotations

import typing

from server.schemas import ConductorSubagent, ConductorWorkflow, ConductorWorkflowWorker
from server.services import conductor_vocabulary as vocab
from server.services.conductor_workflow import workflow_stage
from server.services.conductor_workflow import (
    WorkerState,
    WorkflowState,
)
from server.services.conductor_vocabulary import subagent_stage


def _literal_args(model: type, field: str) -> set[str]:
    annotation = model.model_fields[field].annotation
    return {a for a in typing.get_args(annotation) if isinstance(a, str)}


def test_workflow_status_literal_matches_vocabulary():
    assert _literal_args(ConductorWorkflow, "status") == set(vocab.WORKFLOW_STATES)


def test_worker_state_literal_matches_vocabulary():
    assert _literal_args(ConductorWorkflowWorker, "state") == set(vocab.WORKER_STATES)


def test_vocabulary_sets_are_coherent():
    assert vocab.TERMINAL_WORKFLOW_STATES <= vocab.WORKFLOW_STATES
    assert vocab.RUNNING_WORKER_EVENTS | vocab.COMPLETION_WORKER_EVENTS <= vocab.WORKER_EVENTS
    assert vocab.WORKER_EVENT_ACCEPTED in vocab.WORKER_EVENTS
    assert vocab.WORKER_EVENT_TIMEOUT_TOTAL in vocab.WORKER_EVENTS
    assert vocab.TERMINAL_FAILURE_EVENTS == {
        vocab.WORKFLOW_CANCELLED, vocab.WORKFLOW_KILLED,
    }
    assert vocab.CLOSED_WORKER_STATES == {
        vocab.WORKER_ACCEPTED, vocab.WORKER_REJECTED,
    }


def test_subagent_stage_derivation():
    derive = lambda status, attempt=1, review="none": subagent_stage(
        status=status, attempt=attempt, review_status=review)

    assert derive("running") == vocab.STAGE_WORKER_RUNNING
    assert derive("running", attempt=2) == vocab.STAGE_WORKER_REWORKING
    assert derive("stopped", review="pending") == vocab.STAGE_WORKER_REVIEWING
    assert derive("stopped", review="accepted") == vocab.STAGE_WORKER_ACCEPTED
    assert derive("stopped") == vocab.STAGE_WORKER_STOPPED
    assert derive("stopped", review="rejected") == vocab.STAGE_WORKER_STOPPED


def test_workflow_stage_priority():
    def workflow(**kwargs) -> WorkflowState:
        wf = WorkflowState(request_id="r", **kwargs)
        return wf

    admitted = workflow(state="admitted")
    assert workflow_stage(admitted) == vocab.STAGE_PLANNING

    supervising = workflow(state="supervising", workers={"a": WorkerState(1)})
    assert workflow_stage(supervising) == vocab.STAGE_SUPERVISING

    # failed WITHOUT a terminal event stays recoverable
    recoverable = workflow(state="failed", workers={"a": WorkerState(1, "failed")})
    assert workflow_stage(recoverable) == vocab.STAGE_RECOVERABLE_FAILURE

    closed = workflow(state="failed", terminal_event="workflow_failed")
    assert workflow_stage(closed) == vocab.STAGE_FAILED
    completed = workflow(state="completed", terminal_event="workflow_completed")
    assert workflow_stage(completed) == vocab.STAGE_COMPLETED

    # every worker accepted but the final not yet submitted -> aggregating
    aggregating = workflow(state="awaiting_review", workers={"a": WorkerState(1, "accepted")})
    assert workflow_stage(aggregating) == vocab.STAGE_AGGREGATING

    # a second attempt in flight outranks a sibling waiting for review
    reworking = workflow(
        state="awaiting_review",
        workers={"a": WorkerState(1, "pending"), "b": WorkerState(2, "running")},
    )
    assert workflow_stage(reworking) == vocab.STAGE_REWORKING


def test_conductor_subagent_stage_field_is_declared():
    """The stage travels through the strict/allow response models."""
    assert "stage" in ConductorSubagent.model_fields
    assert "stage" in ConductorWorkflow.model_fields
