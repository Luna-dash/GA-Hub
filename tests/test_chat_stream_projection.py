from __future__ import annotations

import pytest

from server.services.chat_stream_projection import ChatSnapshot, ChatStreamProjection


def snapshot(stream_id: str, *, session_id: str = "session-a") -> ChatSnapshot:
    return ChatSnapshot(
        stream_id=stream_id,
        source="webui",
        query=f"query {stream_id}",
        started_at=1.0,
        session_id=session_id,
    )


def test_projection_keeps_insertion_order_and_bounded_capacity() -> None:
    projection = ChatStreamProjection(capacity=2)
    projection.add(snapshot("s1"))
    projection.add(snapshot("s2"))
    projection.add(snapshot("s3"))

    assert [item.stream_id for item in projection.values()] == ["s2", "s3"]


def test_projection_updates_snapshot_copy_safely() -> None:
    projection = ChatStreamProjection()
    projection.add(snapshot("s1"))

    projection.update("s1", content="answer", done=True, finished_at=2.0)
    item = projection.get("s1")
    assert item is not None
    assert item.content == "answer"
    assert item.done is True


def test_projection_requires_positive_capacity() -> None:
    with pytest.raises(ValueError, match="positive"):
        ChatStreamProjection(capacity=0)
