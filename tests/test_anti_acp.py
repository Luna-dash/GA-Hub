"""Tests for T3 Code-aligned Agy ACP protocol, policy, read containment, and normalizer."""
from pathlib import Path

from server.services import agy_protocol as proto


def test_session_mode_and_permission_policy_decoupling(tmp_path):
    workspace = tmp_path / "ws"
    workspace.mkdir()
    outside = tmp_path / "outside.txt"
    outside.write_text("secret", encoding="utf-8")
    inside = workspace / "app.py"
    inside.write_text("x = 1\n", encoding="utf-8")

    # Plan mode uses ACP 'plan'; edit modes keep ACP 'default' unless native 'auto' is selected & advertised.
    assert proto.session_mode_for_policy("plan", "approval-required") == "plan"
    assert proto.session_mode_for_policy("accept-edits", "auto-accept-edits") == "default"
    assert proto.session_mode_for_policy("accept-edits", "full-access") == "default"
    assert proto.session_mode_for_policy("accept-edits", "auto", [{"id": "default"}, {"id": "auto"}]) == "auto"
    assert proto.session_mode_for_policy("accept-edits", "auto", [{"id": "default"}]) == "default"

    grants = proto.RuntimeGrants()
    read_req = {"toolCall": {"toolCallId": "t1", "kind": "read", "locations": [{"path": str(inside)}]}}
    edit_inside = {"toolCall": {"toolCallId": "t2", "kind": "edit", "locations": [{"path": str(inside)}]}}
    edit_outside = {"toolCall": {"toolCallId": "t3", "kind": "edit", "locations": [{"path": str(outside)}]}}
    exec_req = {"toolCall": {"toolCallId": "t4", "kind": "execute", "rawInput": {"CommandLine": "pytest"}}}
    question_req = {"toolCall": {"toolCallId": "interaction_1", "kind": "other", "title": "Pick one"}}

    # Read always allowed; edits ask under approval-required, auto-allow inside workspace under auto-accept-edits.
    assert proto.evaluate_permission("accept-edits", "approval-required", read_req, grants, workspace) == "allow"
    assert proto.evaluate_permission("accept-edits", "approval-required", edit_inside, grants, workspace) == "ask"
    assert proto.evaluate_permission("accept-edits", "auto-accept-edits", edit_inside, grants, workspace) == "allow"
    assert proto.evaluate_permission("accept-edits", "auto-accept-edits", edit_outside, grants, workspace) == "ask"
    assert proto.evaluate_permission("accept-edits", "auto-accept-edits", exec_req, grants, workspace) == "ask"
    assert proto.evaluate_permission("accept-edits", "full-access", exec_req, grants, workspace) == "allow"
    # Native interaction_* questions ALWAYS ask the user even under full-access.
    assert proto.evaluate_permission("accept-edits", "full-access", question_req, grants, workspace) == "ask"

    # Session allow_always grant sticks by kind.
    grants.record("execute")
    assert proto.evaluate_permission("accept-edits", "approval-required", exec_req, grants, workspace) == "allow"


def test_extract_permission_prompt_approval_and_question(tmp_path):
    target = tmp_path / "note.txt"
    target.write_text("line1\nold line\nline3\n", encoding="utf-8")

    approval_params = {
        "sessionId": "s1",
        "toolCall": {
            "toolCallId": "call_1",
            "kind": "edit",
            "title": "Edit note",
            "locations": [{"path": str(target), "line": 2}],
            "rawInput": {"TargetContent": "old line\n", "ReplacementContent": "new line\n", "StartLine": 2},
        },
        "options": [
            {"kind": "allow_once", "optionId": "yes"},
            {
                "kind": "allow_always",
                "optionId": "always",
                "_meta": {"agy.security.warning": {"message": "Will allow future edits without asking"}},
            },
            {"kind": "reject_once", "optionId": "no"},
        ],
    }
    prompt = proto.extract_permission_prompt(approval_params, proto.read_pre_edit_file)
    assert prompt["prompt_type"] == "approval"
    assert prompt["allow_always"] is True
    assert "Will allow future edits" in prompt["security_warning"]
    assert "-old line" in prompt["diff"] and "+new line" in prompt["diff"]
    assert prompt["option_map"] == {"allow": "yes", "allow_always": "always", "reject": "no"}

    question_params = {
        "sessionId": "s1",
        "toolCall": {"toolCallId": "interaction_99", "title": "Choose target branch"},
        "options": [
            {"optionId": "opt_a", "name": "main"},
            {"optionId": "opt_b", "name": "dev"},
        ],
    }
    q = proto.extract_permission_prompt(question_params)
    assert q["prompt_type"] == "question"
    assert q["question"] == {
        "question": "Choose target branch",
        "options": [{"id": "opt_a", "label": "main"}, {"id": "opt_b", "label": "dev"}],
    }


def test_read_text_file_containment_and_read_repair(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    doc = ws / "readme.txt"
    doc.write_text("a\nb\nc\nd\n", encoding="utf-8")
    outside = tmp_path / "secret.txt"
    outside.write_text("nope", encoding="utf-8")

    ok, err = proto.handle_read_text_file({"path": str(doc), "line": 2, "limit": 2}, [ws])
    assert err is None and ok == {"content": "b\nc"}

    bad, err2 = proto.handle_read_text_file({"path": str(outside)}, [ws])
    assert bad is None and err2["code"] == -32602

    repair = proto.ReadRepair()
    repair.attempted(str(doc), True)
    updated = repair.track_update({
        "sessionUpdate": "tool_call_update",
        "toolCallId": "r1",
        "title": "Running client_view_file",
        "locations": [{"path": str(doc)}],
        "status": "failed",
        "rawOutput": "unrelated failure",
    })
    assert updated["status"] == "completed" and "rawOutput" not in updated


def test_session_update_normalizer_and_model_calls():
    norm = proto.SessionUpdateNormalizer()
    ev1 = norm.normalize({"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "thinking..."}})
    ev2 = norm.normalize({
        "sessionUpdate": "tool_call",
        "toolCallId": "tc1",
        "kind": "execute",
        "title": "run_command",
        "status": "in_progress",
        "rawInput": {"CommandLine": "git status", "Cwd": "/repo"},
    })
    ev3 = norm.normalize({
        "sessionUpdate": "tool_call_update",
        "toolCallId": "tc1",
        "status": "completed",
        "rawOutput": {"combinedOutput": "clean", "exitCode": 0},
    })
    ev4 = norm.normalize({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "All done"}})
    ev5 = norm.normalize({"sessionUpdate": "usage_update", "inputTokens": 100, "outputTokens": 25, "cachedReadTokens": 40})
    end = norm.finish_turn()

    assert ev1[0]["step"]["kind"] == "thought"
    assert ev2[0]["step"]["command"] == "git status"
    assert ev3[0]["step"]["state"] == "DONE" and ev3[0]["step"]["exit_code"] == 0
    msg_ev = next(e for e in ev4 if e["type"] == "message.delta")
    assert msg_ev["text"] == "All done"
    assert ev5 == [] and norm.usage == {"input_tokens": 100, "output_tokens": 25, "cache_read_tokens": 40}
    assert any(e["step"]["kind"] == "agent_response" and e["step"]["state"] == "DONE" for e in end)

    setup = {
        "configOptions": [
            {"id": "model", "type": "select", "options": [{"value": "gemini-4-hydrogen", "name": "Gemini 4"}]},
            {"id": "thought", "category": "thought_level", "type": "select", "options": [{"value": "low"}, {"value": "high"}]},
        ]
    }
    calls = proto.select_model_and_effort_calls(setup, "gemini-4-hydrogen-low", "high")
    assert calls == [
        ("session/set_model", {"modelId": "gemini-4-hydrogen"}),
        ("session/set_config_option", {"configId": "thought", "value": "low"}),
    ]


def test_extract_usage_fields_handles_nested_prompt_results_and_updates():
    usage: dict[str, int] = {}
    proto.extract_usage_fields({"usage": {"promptTokens": 80, "completionTokens": 20, "cachedContentTokenCount": 30}}, usage)
    assert usage == {"input_tokens": 80, "output_tokens": 20, "cache_read_tokens": 30}

    meta_usage: dict[str, int] = {}
    proto.extract_usage_fields({"_meta": {"usage": {"input_tokens": 50, "output_tokens": 12, "thoughtTokens": 7}}}, meta_usage)
    assert meta_usage == {"input_tokens": 50, "output_tokens": 12, "thinking_tokens": 7}


def test_session_update_normalizer_splits_progress_messages_and_final_answer():
    norm = proto.SessionUpdateNormalizer()
    e1 = norm.normalize({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "阶段一：先看代码"}})
    e2 = norm.normalize({
        "sessionUpdate": "tool_call",
        "toolCallId": "tc1",
        "kind": "read",
        "title": "view_file",
        "status": "in_progress",
    })
    norm.normalize({"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "继续分析"}})
    e3 = norm.normalize({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "阶段二：继续检查"}})
    norm.normalize({
        "sessionUpdate": "tool_call",
        "toolCallId": "tc2",
        "kind": "execute",
        "title": "run_command",
        "status": "in_progress",
    })
    e4 = norm.normalize({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "最终结论：已完成"}})
    # Late update for an earlier tool call must not demote the newer final answer.
    norm.normalize({
        "sessionUpdate": "tool_call_update",
        "toolCallId": "tc1",
        "status": "completed",
    })
    norm.finish_turn()

    assert norm.progress_messages == ["阶段一：先看代码", "阶段二：继续检查"]
    assert norm.final_answer == "最终结论：已完成"
    idx1 = e1[0]["step"]["index"]
    idx3 = e3[0]["step"]["index"]
    idx4 = e4[0]["step"]["index"]
    assert idx1 < idx3 < idx4
    assert e2[0]["step"]["index"] == idx1
    assert e2[0]["step"]["kind"] == "agent_response"
    assert e2[0]["step"]["state"] == "DONE"


def test_terminal_streaming_utf8_boundaries_linking_and_throttle():
    import base64

    now = [10.0]
    norm = proto.SessionUpdateNormalizer(clock=lambda: now[0])

    # Split UTF-8 "中文\n" across two base64 chunks so first frame cuts mid-character.
    raw = "中文\n".encode("utf-8")
    norm.normalize({"sessionUpdate": "terminal_update", "terminalId": "t1", "command": "npm test", "cwd": "/ws"})

    e_first = norm.normalize({
        "sessionUpdate": "terminal_output_chunk",
        "terminalId": "t1",
        "data": base64.b64encode(raw[:4]).decode("ascii"),
    })
    assert len(e_first) == 1
    assert e_first[0]["step"]["output"] == "中"
    assert e_first[0]["step"]["state"] == "ACTIVE"

    now[0] = 10.05
    e_throttled = norm.normalize({
        "sessionUpdate": "terminal_output_chunk",
        "terminalId": "t1",
        "data": base64.b64encode(raw[4:]).decode("ascii"),
    })
    assert e_throttled == []

    # Linking a real tool_call adopts the terminal buffer and suppresses duplicate synthetic state.
    linked = norm.normalize({
        "sessionUpdate": "tool_call",
        "toolCallId": "tc-exec",
        "kind": "execute",
        "title": "run_command",
        "status": "in_progress",
        "content": [{"type": "terminal", "terminalId": "t1"}],
    })
    assert linked[0]["step"]["command"] == "npm test"
    assert linked[0]["step"]["output"] == "中文\n"
    assert norm.has_active_tools() is True
    assert norm.has_outliving_background_work() is True

    now[0] = 10.35
    e_tail = norm.normalize({
        "sessionUpdate": "terminal_output_chunk",
        "terminalId": "t1",
        "data": base64.b64encode(b"done\n").decode("ascii"),
    })
    assert e_tail and e_tail[0]["step"]["index"] == linked[0]["step"]["index"]
    assert e_tail[0]["step"]["output"] == "中文\ndone\n"

    norm.normalize({"sessionUpdate": "terminal_update", "terminalId": "t1", "exitStatus": {"exitCode": 0}})
    norm.normalize({"sessionUpdate": "tool_call_update", "toolCallId": "tc-exec", "status": "completed"})
    assert norm.has_active_tools() is False
    assert norm.has_outliving_background_work() is False

    # UTF-8 tail trim must never leave leading continuation bytes.
    trimmed = proto._trim_utf8_tail("界" * 10, 8)
    assert trimmed == "界界"


def test_emit_steer_and_background_tool_classification():
    norm = proto.SessionUpdateNormalizer()
    norm.normalize({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "阶段分析"}})
    steer_events = norm.emit_steer("请改成 B 方案")
    assert norm.progress_messages == ["阶段分析"]
    assert norm.final_answer == ""
    assert any(
        e["type"] == "step.update" and e["step"]["kind"] == "user_steer" and e["step"]["detail"] == "请改成 B 方案"
        for e in steer_events
    )

    norm.normalize({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "B 方案结果"}})
    norm.finish_turn()
    assert norm.final_answer == "B 方案结果"

    assert proto.is_background_outliving_tool({"status": "in_progress", "kind": "execute", "title": "run_command"}) is False
    assert proto.is_background_outliving_tool({
        "status": "in_progress",
        "kind": "execute",
        "title": "run_command",
        "rawInput": {"CommandLine": "npm run dev", "IsDaemon": True},
    }) is True
    assert proto.is_background_outliving_tool({"status": "in_progress", "kind": "other", "title": "invoke_subagent"}) is True
    assert proto.is_background_outliving_tool({"status": "completed", "kind": "other", "title": "invoke_subagent"}) is False


def test_runtime_grants_snapshot_and_clear():
    grants = proto.RuntimeGrants()
    assert grants.snapshot() == []

    grants.allow_all_kinds.update({"read", "edit"})
    assert grants.snapshot() == ["edit", "read"]

    grants.clear("read")
    assert grants.snapshot() == ["edit"]

    grants.allow_all_session = True
    assert grants.snapshot() == ["*"]

    grants.clear()
    assert grants.snapshot() == []
    assert grants.allow_all_session is False
    assert grants.allow_all_kinds == set()


def test_select_model_and_effort_calls_validate():
    import pytest

    setup_family = {
        "models": {
            "availableModels": [
                {"modelId": "gemini-4-hydrogen"},
            ],
            "currentModelId": "gemini-4-hydrogen",
        }
    }
    valid_family_calls = proto.select_model_and_effort_calls(setup_family, "gemini-4-hydrogen-high", "high", validate=True)
    assert any(method == "session/set_model" and params["modelId"] == "gemini-4-hydrogen" for method, params in valid_family_calls)

    setup_variant = {
        "models": {
            "availableModels": [
                {"modelId": "gemini-4-hydrogen-low"},
                {"modelId": "gemini-4-hydrogen-high"},
            ],
            "currentModelId": "gemini-4-hydrogen-low",
        }
    }
    valid_exact_calls = proto.select_model_and_effort_calls(setup_variant, "gemini-4-hydrogen-high", "high", validate=True)
    assert any(method == "session/set_model" and params["modelId"] == "gemini-4-hydrogen-high" for method, params in valid_exact_calls)

    with pytest.raises(proto.AgyModelSelectionError) as exc_info:
        proto.select_model_and_effort_calls(setup_variant, "nonexistent-model", "high", validate=True)
    assert exc_info.value.status == 422

    # Empty model catalog skips strict validation instead of false-rejecting.
    proto.select_model_and_effort_calls({}, "nonexistent-model", "high", validate=True)


def test_resolve_model_target_orchestrator_and_live_effort_selection():
    import pytest

    setup = {
        "configOptions": [
            {
                "id": "model",
                "category": "model",
                "type": "select",
                "currentValue": "gemini-4-neon",
                "options": [
                    {"value": "gemini-4-neon", "name": "Gemini 4 Neon"},
                    {"value": "gemini-4-carbon", "name": "Gemini 4 Carbon"},
                    {"value": "gemini-pro-orchestrator-neon", "name": "Orchestrator (Neon)"},
                ],
            },
            {
                "id": "thought_level",
                "category": "thought_level",
                "type": "select",
                "currentValue": "high",
                "options": [
                    {"value": "low", "name": "Low"},
                    {"value": "medium", "name": "Medium"},
                    {"value": "high", "name": "High"},
                    {"value": "xhigh", "name": "Extra"},
                ],
            },
        ],
        "models": {
            "currentModelId": "gemini-4-neon-high",
            "availableModels": [
                {"modelId": "gemini-4-neon-low", "name": "Gemini 4 Neon (Low)"},
                {"modelId": "gemini-4-neon-high", "name": "Gemini 4 Neon (High)"},
                {"modelId": "gemini-4-neon-xhigh", "name": "Gemini 4 Neon (XHigh)"},
                {"modelId": "gemini-4-carbon-high", "name": "Gemini 4 Carbon (High)"},
                {"modelId": "gemini-pro-orchestrator-neon", "name": "Orchestrator (Neon)"},
            ],
        },
    }

    enriched = proto.extract_enriched_model_catalog_from_setup(setup)
    neon_item = next(m for m in enriched if m["id"] == "gemini-4-neon")
    carbon_item = next(m for m in enriched if m["id"] == "gemini-4-carbon")
    orch_item = next(m for m in enriched if m["id"] == "gemini-pro-orchestrator-neon")
    assert neon_item["efforts"] == ["low", "high", "xhigh"]
    assert carbon_item["efforts"] == ["high"]
    assert neon_item.get("is_default") is True
    assert orch_item.get("is_orchestrator") is True
    assert "efforts" not in orch_item

    aliased = proto.resolve_model_target(
        setup, "legacy-hybrid", "medium",
        aliases={"legacy-hybrid": "gemini-4-neon"},
        default_model="gemini-4-carbon-high",
    )
    assert aliased["alias_from"] == "legacy-hybrid"
    assert aliased["target_model"] == "gemini-4-neon"
    assert aliased["use_config_option_id"] == "model"

    fb = proto.resolve_model_target(
        setup, "removed-model", "high",
        default_model="gemini-4-carbon-high",
        allow_auto_fallback=True,
    )
    assert fb["target_model"] == "gemini-4-carbon"
    assert fb["fallback_reason"] is not None

    with pytest.raises(proto.AgyModelSelectionError):
        proto.resolve_model_target(setup, "removed-model", "high", allow_auto_fallback=False)

    # Orchestrator skips thought_level even if stale configOptions still carries it.
    assert proto.select_effort_call_for_config(setup["configOptions"], "gemini-pro-orchestrator-neon", "high") == (None, None)

    # Non-orchestrator omits thought_level cleanly when absent after model switch, and adjusts unsupported effort clearly.
    post_no_thought = [setup["configOptions"][0]]
    assert proto.select_effort_call_for_config(post_no_thought, "gemini-4-neon", "high") == (None, None)

    limited_thought = [{
        "id": "thought_level",
        "category": "thought_level",
        "type": "select",
        "currentValue": "high",
        "options": [{"value": "low"}, {"value": "medium"}, {"value": "high"}],
    }]
    call, notice = proto.select_effort_call_for_config(limited_thought, "gemini-4-carbon", "xhigh")
    assert call == ("session/set_config_option", {"configId": "thought_level", "value": "high"})
    assert notice and "xhigh" in notice and "high" in notice


