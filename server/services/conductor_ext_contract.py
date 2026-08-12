"""Hub-only task contracts and evidence-based acceptance evaluation.

This module deliberately stays independent from the GA core.  It provides a
small in-memory policy layer that GA-Hub can attach to its conductor without
changing the standalone Conductor lifecycle or public API.
"""
from __future__ import annotations

from collections.abc import Callable
from typing import Any

from pydantic import BaseModel, Field


EventPublisher = Callable[[str, dict[str, Any]], None]


class TaskContract(BaseModel):
    """Expected deliverables and deterministic acceptance criteria."""

    deliverables: list[str] = Field(default_factory=list)
    acceptance_criteria: list[str] = Field(default_factory=list)
    evidence_required: dict[str, str] = Field(default_factory=dict)


class Evidence(BaseModel):
    """Evidence attached to one criterion (criterion IDs are zero-based strings)."""

    criterion_id: str
    content: str
    timestamp: float
    confidence: float = Field(ge=0.0, le=1.0)


class AcceptanceResult(BaseModel):
    """Deterministic evidence-coverage result for a task contract."""

    passed: bool
    score: float = Field(ge=0.0, le=1.0)
    missing_criteria: list[str] = Field(default_factory=list)
    evidence_map: dict[str, Evidence] = Field(default_factory=dict)


class ConductorContractExt:
    """In-memory GA-Hub extension for task contracts and evidence.

    ``core`` is retained as an integration anchor but is intentionally not
    called: contract policy must not leak into or constrain GA core behavior.
    ``publish`` is optional so the module remains easy to unit test and can be
    connected to GA-Hub's EventBus by the service adapter.
    """

    def __init__(self, core: Any, publish: EventPublisher | None = None):
        self.core = core
        self.contracts: dict[str, TaskContract] = {}
        self.evidences: dict[str, list[Evidence]] = {}
        self._publish = publish

    def _emit(self, event: str, payload: dict[str, Any]) -> None:
        if self._publish is not None:
            self._publish(f"conductor:contract_{event}", payload)

    def create_contract(self, agent_id: str, contract: TaskContract) -> None:
        """Create or replace an agent's contract and reset its stale evidence."""
        self.contracts[agent_id] = contract
        self.evidences[agent_id] = []
        self._emit("created", {"id": agent_id, "contract": contract.model_dump()})

    def get_contract(self, agent_id: str) -> TaskContract | None:
        return self.contracts.get(agent_id)

    def add_evidence(self, agent_id: str, evidence: Evidence) -> None:
        """Record evidence for an existing contract.

        Unknown criterion IDs are rejected rather than inflating the coverage
        score.  IDs follow the design contract: ``"0"``, ``"1"``, ... in the
        same order as ``acceptance_criteria``.
        """
        contract = self.contracts.get(agent_id)
        if contract is None:
            raise KeyError(f"no task contract for agent {agent_id!r}")
        valid_ids = {str(i) for i in range(len(contract.acceptance_criteria))}
        if evidence.criterion_id not in valid_ids:
            raise ValueError(
                f"unknown criterion_id {evidence.criterion_id!r} for agent {agent_id!r}"
            )
        self.evidences.setdefault(agent_id, []).append(evidence)
        self._emit("evidence_added", {"id": agent_id, "evidence": evidence.model_dump()})

    def evaluate_acceptance(self, agent_id: str, output: str = "") -> AcceptanceResult:
        """Evaluate acceptance from valid evidence coverage.

        ``output`` is reserved for a future LLM judge; C.1 intentionally uses
        deterministic evidence completeness only.  Duplicate evidence for a
        criterion uses the latest item in ``evidence_map`` and counts once.
        """
        del output
        contract = self.contracts.get(agent_id)
        if contract is None:
            result = AcceptanceResult(
                passed=False, score=0.0, missing_criteria=[], evidence_map={}
            )
            self._emit("evaluated", {"id": agent_id, "result": result.model_dump()})
            return result

        valid_ids = {str(i) for i in range(len(contract.acceptance_criteria))}
        evidence_map = {
            evidence.criterion_id: evidence
            for evidence in self.evidences.get(agent_id, [])
            if evidence.criterion_id in valid_ids
        }
        missing = [
            criterion
            for index, criterion in enumerate(contract.acceptance_criteria)
            if str(index) not in evidence_map
        ]
        total = len(contract.acceptance_criteria)
        score = len(evidence_map) / total if total else 0.0
        result = AcceptanceResult(
            passed=score >= 0.8,
            score=score,
            missing_criteria=missing,
            evidence_map=evidence_map,
        )
        self._emit("evaluated", {"id": agent_id, "result": result.model_dump()})
        return result
