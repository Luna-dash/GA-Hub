"""Structured GA turns are presentation metadata, never a new identity source."""
import hashlib

import pytest
from server.services.archive_messages import _items_from_messages, read_archive_messages
from server.schemas import ConversationDetailResp, SessionMessagesResp


def test_turns_preserve_legacy_identity_and_content():
    message = {"role": "assistant", "content": "firstsecond", "turn_segs": ["first", "second"]}
    original = dict(message)
    item = _items_from_messages([message], ["2026-10-20 12:00:00"], 4)[0]
    assert item["id"] == "4:" + hashlib.sha256(str(original).encode()).hexdigest()[:16]
    assert item["content"] == original["content"]
    assert item["turn_segs"] == ["first", "second"]
    assert message == original
    assert item["ordinal"] == 4
    assert item["timestamp"] == "2026-10-20 12:00:00"


@pytest.mark.parametrize("value", [None, [], "text", ["ok", 1], ["ok", "  "], [None], ["different"]])
def test_invalid_turns_fall_back_as_a_whole(value):
    message = {"role": "assistant", "content": "unchanged", "turn_segs": value}
    item = _items_from_messages([message], [None])[0]
    assert not item.get("turn_segs")
    assert item["content"] == "unchanged"


def test_models_keep_valid_turns_but_not_user_turns():
    messages = [
        {"role": "user", "content": "question", "turn_segs": ["not a turn"]},
        {"role": "assistant", "content": "stepanswer", "turn_segs": ["step", "answer"]},
        {"role": "assistant", "content": "legacy", "turn_segs": ["step", 42]},
    ]
    detail = ConversationDetailResp(id="a", title="a", source="local", messages=messages).model_dump()
    assert detail["messages"][0].get("turn_segs") is None
    assert detail["messages"][1]["turn_segs"] == ["step", "answer"]
    assert detail["messages"][2].get("turn_segs") is None
    page = SessionMessagesResp(session_id="s", archive_bound=True, revision="r",
        items=_items_from_messages(messages, []))
    assert page.model_dump()["items"][1]["turn_segs"] == ["step", "answer"]


def test_native_paging_keeps_turns_and_identity(tmp_path):
    import json
    path = tmp_path / "archive.txt"
    blocks = []
    for n in range(3):
        blocks += [f"=== Prompt === 2026-10-20 10:00:0{n}\n" + json.dumps({"role": "user", "content": [{"type": "text", "text": f"q{n}"}]}),
                   f"=== Response === 2026-10-20 10:00:0{n}\n" + repr([{"type": "text", "text": f"answer {n}"}])]
    path.write_text("\n".join(blocks), encoding="utf-8")
    full = read_archive_messages(path)
    first = read_archive_messages(path, limit=2)
    second = read_archive_messages(path, limit=4, before=first["next_before"])
    assert second["items"] + first["items"] == full["items"]
    assert all(item.get("turn_segs") for item in full["items"] if item["role"] == "assistant")
