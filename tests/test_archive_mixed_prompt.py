"""Hub repairs human boundaries without changing GA or its native archives."""
import json

import pytest

from server import _paths
from server.services.archive_messages import (
    _archive_index, _extract_ui_messages_from_text, read_archive_messages,
    read_ui_messages,
)

pytestmark = pytest.mark.skipif(_paths.GA_ROOT is None, reason="requires configured GA_ROOT")


def _round(blocks, response, n):
    return (f"=== Prompt === 2026-11-08 10:00:{n:02d}\n"
            + json.dumps({"role": "user", "content": blocks}, ensure_ascii=False)
            + f"\n=== Response === 2026-11-08 10:00:{n:02d}\n"
            + repr(response) + "\n")


def _text(text):
    return {"type": "text", "text": text}


def _result(value=""):
    return {"type": "tool_result", "tool_use_id": "ask-1", "content": value}


def test_mixed_reply_keeps_human_round_tools_paging_and_timestamps(tmp_path):
    content = _round([_text("initial request")], [
        _text("asking"), {"type": "tool_use", "id": "ask-1", "name": "ask_user",
                           "input": {"question": "clarify?"}}], 0)
    content += _round([_result("retained tool output"), _text("刷新后没有了，可能是版本迭代中出错")],
                      [_text("clarification response")], 1)
    content += _round([_result(), _text("cwd = D:/study\n[Memory] injected")],
                      [_text("continued response")], 2)
    path = tmp_path / "mixed.txt"
    path.write_text(content, encoding="utf-8")
    full = read_archive_messages(path)
    items = full["items"]
    assert [item["role"] for item in items] == ["user", "assistant", "user", "assistant"]
    assert items[2]["content"] == "刷新后没有了，可能是版本迭代中出错"
    assert [len(item["turn_segs"]) for item in items if item["role"] == "assistant"] == [1, 2]
    assert "retained tool output" in items[1]["content"]
    assert "LLM Running (Turn 1)" in items[3]["turn_segs"][0]
    assert "LLM Running (Turn 2)" in items[3]["turn_segs"][1]
    assert [item["timestamp"] for item in items] == [
        "2026-11-08T10:00:00", "2026-11-08T10:00:00",
        "2026-11-08T10:00:01", "2026-11-08T10:00:01"]
    assert read_ui_messages(path) == _extract_ui_messages_from_text(content)
    tail = read_archive_messages(path, limit=2)
    head = read_archive_messages(path, limit=2, before=tail["next_before"])
    assert head["items"] + tail["items"] == items
    index = _archive_index(path.resolve())
    assert index.dialogue_count == 2
    assert path.read_text(encoding="utf-8") == content


@pytest.mark.parametrize("injected", [
    "", "\n", "cwd = D:/study\n[Memory] injected", "<global_memory>injected</global_memory>",
    "### [WORKING MEMORY]\n<history>injected</history>",
    "[GA_CONTINUE] Continue from the interruption. Do not repeat completed work.",
])
def test_tool_runtime_context_does_not_start_human_round(tmp_path, injected):
    content = _round([_text("human")], [_text("first")], 0)
    content += _round([_result(), _text(injected)], [_text("second")], 1)
    path = tmp_path / "auto.txt"
    path.write_text(content, encoding="utf-8")
    items = read_archive_messages(path)["items"]
    assert [item["role"] for item in items] == ["user", "assistant"]
    assert len(items[1]["turn_segs"]) == 2
