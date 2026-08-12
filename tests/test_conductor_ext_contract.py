"""Focused tests for the Hub-only Conductor contract extension (Phase C.1)."""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from server.services.conductor_ext_contract import (
    ConductorContractExt,
    Evidence,
    TaskContract,
)
from server.services.event_bus import EventBus


def contract(*criteria: str) -> TaskContract:
    return TaskContract(
        deliverables=["report"],
        acceptance_criteria=list(criteria),
        evidence_required={str(i): "text" for i in range(len(criteria))},
    )


def evidence(criterion_id: str, content: str = "ok") -> Evidence:
    return Evidence(
        criterion_id=criterion_id,
        content=content,
        timestamp=1.0,
        confidence=0.9,
    )


def test_evaluation_uses_unique_criterion_coverage_and_latest_evidence():
    ext = ConductorContractExt(core=object())
    ext.create_contract("a", contract("one", "two", "three", "four", "five"))
    ext.add_evidence("a", evidence("0", "old"))
    ext.add_evidence("a", evidence("0", "new"))
    ext.add_evidence("a", evidence("1"))
    ext.add_evidence("a", evidence("2"))
    ext.add_evidence("a", evidence("3"))

    result = ext.evaluate_acceptance("a", output="reserved")

    assert result.passed is True
    assert result.score == pytest.approx(0.8)
    assert result.missing_criteria == ["five"]
    assert result.evidence_map["0"].content == "new"


def test_missing_or_empty_contract_does_not_pass():
    ext = ConductorContractExt(core=object())
    assert ext.evaluate_acceptance("missing").model_dump() == {
        "passed": False,
        "score": 0.0,
        "missing_criteria": [],
        "evidence_map": {},
    }
    ext.create_contract("empty", contract())
    assert ext.evaluate_acceptance("empty").passed is False


def test_invalid_evidence_is_rejected_and_replacing_contract_resets_evidence():
    ext = ConductorContractExt(core=object())
    with pytest.raises(KeyError):
        ext.add_evidence("missing", evidence("0"))

    ext.create_contract("a", contract("one"))
    with pytest.raises(ValueError):
        ext.add_evidence("a", evidence("1"))
    ext.add_evidence("a", evidence("0"))
    assert ext.evaluate_acceptance("a").passed is True

    ext.create_contract("a", contract("replacement"))
    assert ext.evaluate_acceptance("a").score == 0.0


def test_confidence_is_bounded():
    with pytest.raises(ValidationError):
        Evidence(criterion_id="0", content="bad", timestamp=1, confidence=1.1)


def test_events_are_published_to_real_event_bus_with_serialized_payloads():
    event_bus = EventBus(history=20)
    ext = ConductorContractExt(core=object(), publish=event_bus.publish)
    ext.create_contract("a", contract("one"))
    ext.add_evidence("a", evidence("0"))
    ext.evaluate_acceptance("a")

    events = event_bus.history(prefix="conductor:contract_")
    assert [event.topic for event in events] == [
        "conductor:contract_created",
        "conductor:contract_evidence_added",
        "conductor:contract_evaluated",
    ]
    assert events[0].payload["id"] == "a"
    assert events[1].payload["evidence"]["criterion_id"] == "0"
    assert events[2].payload["result"]["passed"] is True
