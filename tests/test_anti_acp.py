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
