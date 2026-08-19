"""Conductor-owned subagent model routing policy tests."""
from __future__ import annotations

import json
import os
import queue
import threading
from types import SimpleNamespace
from unittest.mock import Mock, patch

from server.services.conductor_service import (
    ConductorService,
    CoreSubagentPool,
    HubConductorCallbacks,
    READMES,
)


def _service(
    *,
    main: int | None = 1,
    worker: int | None = None,
    policy: str = "follow_main",
) -> ConductorService:
    service = object.__new__(ConductorService)
    service._conductor_llm_index = main
    service._subagent_llm_index = worker
    service._subagent_model_policy = policy
    service._model_lock = threading.RLock()
    service.pool = Mock()
    service.pool.start_subagent.return_value = {"id": "worker-1"}
    service.pool.input_subagent.return_value = {"id": "worker-1"}
    service.pool.snapshot.return_value = []
    service.callbacks = HubConductorCallbacks(service)
    return service


def test_default_policy_allows_explicit_dispatch_override():
    service = _service(worker=5, policy="default")

    assert service.resolve_subagent_model(3) == 3
    assert service.resolve_subagent_model() == 5


def test_locked_policy_ignores_explicit_dispatch_override():
    service = _service(worker=5, policy="locked")

    assert service.resolve_subagent_model(3) == 5


def test_follow_main_policy_uses_conductor_then_global_preference():
    service = _service(main=1)
    assert service.resolve_subagent_model() == 1

    service._conductor_llm_index = None
    with patch(
        "server.services.conductor_service._get_preferred_llm",
        return_value=7,
    ):
        assert service.resolve_subagent_model() == 7


def test_omitted_configuration_does_not_reset_existing_default():
    service = _service(worker=5, policy="default")

    service.configure_models(llm_index=2)

    assert service.model_policy_snapshot() == {
        "llm_index": 2,
        "subagent_llm_index": 5,
        "subagent_model_policy": "default",
    }


def test_explicit_follow_main_clears_default_worker_model():
    service = _service(worker=5, policy="locked")

    service.configure_models(subagent_model_policy="follow_main")

    assert service.model_policy_snapshot()["subagent_llm_index"] is None
    assert service.resolve_subagent_model() == 1


def test_dispatch_entrypoint_applies_same_locked_policy():
    service = _service(worker=5, policy="locked")
    prompt = "检查中文路径 D:\\项目\\资料 🚀"

    result = service.start_subagent(prompt, llm_index=3)

    service.pool.start_subagent.assert_called_once_with(prompt, llm_index=5)
    assert result["llm_index"] == 5
    assert result["model_policy"] == "locked"


def test_resume_entrypoint_applies_same_locked_policy():
    service = _service(worker=5, policy="locked")

    result = service.input_subagent("worker-1", "retry", llm_index=3)

    service.pool.input_subagent.assert_called_once_with(
        "worker-1", "retry", llm=5
    )
    assert result["llm_index"] == 5


def test_resume_entrypoint_publishes_committed_snapshot_only_on_success():
    service = _service(worker=5, policy="locked")

    with patch(
        "server.services.conductor_service.push_subagent_cards"
    ) as publish:
        service.input_subagent("worker-1", "retry")
        publish.assert_called_once_with([])

        service.pool.input_subagent.return_value = {"error": "enqueue failed"}
        service.input_subagent("worker-1", "retry again")

    publish.assert_called_once_with([])


def test_resume_success_survives_snapshot_observer_failure():
    service = _service(worker=5, policy="locked")

    with patch(
        "server.services.conductor_service.push_subagent_cards",
        side_effect=RuntimeError("event bus unavailable"),
    ):
        result = service.input_subagent("worker-1", "retry")

    assert result["id"] == "worker-1"
    service.pool.input_subagent.assert_called_once()


def test_dispatch_result_uses_the_admitted_policy_snapshot():
    service = _service(worker=5, policy="default")

    def update_policy_after_admission(*_args, **_kwargs):
        service.configure_models(
            subagent_llm_index=8,
            subagent_model_policy="locked",
        )
        return {"id": "worker-1"}

    service.pool.start_subagent.side_effect = update_policy_after_admission

    result = service.start_subagent("inspect", llm_index=3)

    service.pool.start_subagent.assert_called_once_with("inspect", llm_index=3)
    assert result["llm_index"] == 3
    assert result["model_policy"] == "default"
    assert service.model_policy_snapshot()["subagent_model_policy"] == "locked"


def test_default_and_locked_policies_require_a_worker_model():
    service = _service()

    for policy in ("default", "locked"):
        try:
            service.configure_models(subagent_model_policy=policy)
        except ValueError as exc:
            assert "subagent_llm_index is required" in str(exc)
        else:
            raise AssertionError(f"{policy} should require subagent_llm_index")


def test_conductor_prompt_has_no_replacement_question_marks():
    service = _service(main=1)
    service.pool.counts.return_value = (1, 2)
    service.chat_messages = [{
        "role": "user",
        "read": False,
        "request_id": "req-1",
        "msg": "检查中文路径 D:\\项目并计算 17*19 🚀",
    }]
    service.callbacks = SimpleNamespace()

    with patch.dict(
        os.environ,
        {
            "GA_HUB_RUNTIME_HOST": "127.0.0.1",
            "GA_HUB_RUNTIME_PORT": "35204",
        },
    ):
        prompt = service._build_prompt([
            {
                "type": "user_message",
                "request_id": "req-1",
                "msg": "检查中文路径 D:\\项目并计算 17*19 🚀",
            }
        ])

    assert "You are the Conductor supervisor" in prompt
    assert "API base: http://127.0.0.1:35204/api/conductor" in prompt
    assert "Never scan alternate ports" in prompt
    assert '"role": "conductor"' in prompt
    assert "Never use role=user" in prompt
    assert "Preserve Unicode task text exactly" in prompt
    assert '"type":"user_message"' in prompt
    wake_events = json.loads(
        prompt.split("<wake_events>", 1)[1].split("</wake_events>", 1)[0]
    )
    assert wake_events[0]["msg"] == "检查中文路径 D:\\项目并计算 17*19 🚀"
    assert "??" not in prompt


def test_conductor_readme_reserves_user_role_for_real_user_input():
    api_docs = READMES["api"]
    user_flow = READMES["usermsg"]
    completion_flow = READMES["subagent"]

    assert '"role": "conductor"' in api_docs
    assert "role=user" in api_docs
    assert "role=conductor" in user_flow
    assert "role=conductor" in completion_flow


def test_conductor_prompt_only_marks_the_current_request_as_read():
    service = _service(main=1)
    service.pool.counts.return_value = (0, 1)
    current = {
        "role": "user",
        "read": False,
        "request_id": "req-current",
    }
    queued = {
        "role": "user",
        "read": False,
        "request_id": "req-queued",
    }
    service.chat_messages = [current, queued]

    prompt = service._build_prompt([
        {
            "type": "user_message",
            "request_id": "req-current",
            "msg": "current task",
        }
    ])

    assert current["read"] is True
    assert queued["read"] is False
    assert '"msg":"current task"' in prompt
    assert "1 unread user messages" in prompt


def test_conductor_prompt_without_request_id_marks_only_one_matching_message():
    service = _service(main=1)
    service.pool.counts.return_value = (0, 0)
    matching = {"role": "user", "read": False, "msg": "current task"}
    queued = {"role": "user", "read": False, "msg": "queued task"}
    service.chat_messages = [matching, queued]

    service._build_prompt([{"type": "user_message", "msg": "current task"}])

    assert matching["read"] is True
    assert queued["read"] is False


def test_conductor_prompt_includes_completed_subagent_result():
    service = _service(main=1)
    service.pool.counts.return_value = (0, 1)
    service.chat_messages = []

    prompt = service._build_prompt([
        {
            "type": "subagent_done",
            "id": "worker-1",
            "generation": 1,
            "reply": "323",
        }
    ])

    assert '"type":"subagent_done"' in prompt
    assert '"id":"worker-1"' in prompt
    assert '"reply":"323"' in prompt
    assert "1 completed events" in prompt


def test_conductor_prompt_bounds_large_completion_batches():
    service = _service(main=1)
    service.pool.counts.return_value = (0, 100)
    service.chat_messages = []
    events = [
        {
            "type": "subagent_done",
            "id": f"worker-{index}",
            "generation": 1,
            "reply": "\\" * 16_000,
        }
        for index in range(100)
    ]

    prompt = service._build_prompt(events)
    payload_text = prompt.split("<wake_events>", 1)[1].split(
        "</wake_events>", 1
    )[0]
    payload = json.loads(payload_text)

    assert len(payload_text) <= 32_000
    assert payload[-1]["type"] == "events_omitted"
    assert payload[-1]["count"] == 84
    assert "100 completed events" in prompt


def test_core_pool_put_task_preserves_unicode_prompt():
    prompt = "分析 C:\\资料\\项目，保留中文、emoji 🚀 和符号 €"
    calls = []

    class Agent:
        def put_task(self, msg, *, source):
            calls.append((msg, source))
            return queue.Queue()

    pool = object.__new__(CoreSubagentPool)
    pool.lock = threading.RLock()
    pool.subagents = {
        "worker-1": SimpleNamespace(
            agent=Agent(),
            active_generation=0,
            terminal_event=None,
        )
    }
    pool._start_monitor = Mock()

    result = pool._send_msg("worker-1", prompt)

    assert result == {"id": "worker-1", "status": "running"}
    assert calls == [(prompt, "subagent:worker-1")]
