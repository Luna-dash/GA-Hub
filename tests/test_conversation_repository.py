"""Tests for the versioned ConversationRepository and v1→v2 migration.

These don't touch the real GA repo or the real ADMIN_DATA store: every test
builds a fresh repository inside a TemporaryDirectory and (for migration) fakes
the legacy chat_history.json path.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

_REPO = Path(__file__).resolve().parent.parent
if str(_REPO) not in sys.path:
    sys.path.insert(0, str(_REPO))

import pytest  # noqa: E402

from server.services.conversation_repository import (  # noqa: E402
    Conversation,
    ConversationNotFound,
    ConversationRepository,
    Message,
    RevisionConflict,
    STATUS_RUNNING,
    STATUS_IDLE,
    MSG_COMPLETE,
)


def _msg(mid: str, role: str = "user") -> Message:
    return Message(id=mid, role=role, content=f"c-{mid}", created_at=0)


def test_create_and_get():
    with TemporaryDirectory() as d:
        repo = ConversationRepository(base_dir=Path(d))
        c = repo.create(title="hi", model_index=3)
        assert c.id and c._revision == 0 and c.title == "hi"
        got = repo.get(c.id)
        assert got.title == "hi" and got.model_index == 3


def test_append_increments_revision():
    with TemporaryDirectory() as d:
        repo = ConversationRepository(base_dir=Path(d))
        c = repo.create()
        c = repo.append_message(c.id, _msg("m1"))
        assert c._revision == 1 and len(c.messages) == 1
        c = repo.append_message(c.id, _msg("m2", "assistant"))
        assert c._revision == 2 and len(c.messages) == 2


def test_stale_revision_conflict():
    with TemporaryDirectory() as d:
        repo = ConversationRepository(base_dir=Path(d))
        c = repo.create()
        repo.append_message(c.id, _msg("m1"))  # rev -> 1
        with pytest.raises(RevisionConflict):
            repo.update_meta(c.id, title="x", expected_revision=0)


def test_delete_refused_while_running():
    with TemporaryDirectory() as d:
        repo = ConversationRepository(base_dir=Path(d))
        c = repo.create()
        repo.set_status(c.id, STATUS_RUNNING, last_stream_id="s1")
        with pytest.raises(RevisionConflict):
            repo.delete(c.id)
        # force works
        repo.delete(c.id, force=True)
        with pytest.raises(ConversationNotFound):
            repo.get(c.id)


def test_list_summaries_and_pagination():
    with TemporaryDirectory() as d:
        repo = ConversationRepository(base_dir=Path(d))
        for i in range(5):
            repo.create(title=f"t{i}")
        page = repo.list_summaries(offset=0, limit=2)
        assert page["total"] == 5
        assert len(page["items"]) == 2
        page2 = repo.list_summaries(offset=2, limit=2)
        assert len(page2["items"]) == 2


def test_messages_after():
    with TemporaryDirectory() as d:
        repo = ConversationRepository(base_dir=Path(d))
        c = repo.create()
        repo.append_message(c.id, _msg("a"))
        repo.append_message(c.id, _msg("b", "assistant"))
        repo.append_message(c.id, _msg("c"))
        after = repo.messages_after(c.id, after_message_id="a")
        assert [m.id for m in after] == ["b", "c"]


def test_atomic_write_no_tmp_leftover():
    with TemporaryDirectory() as d:
        repo = ConversationRepository(base_dir=Path(d))
        repo.create()
        leftovers = [p for p in Path(d).iterdir() if ".tmp-" in p.name]
        assert leftovers == []


def test_persistence_across_reopen():
    with TemporaryDirectory() as d:
        r1 = ConversationRepository(base_dir=Path(d))
        c = r1.create(title="persist")
        r1.append_message(c.id, _msg("m1"))
        # reopen a new instance pointed at the same dir
        r2 = ConversationRepository(base_dir=Path(d))
        got = r2.get(c.id)
        assert got.title == "persist" and got._revision == 1
        assert len(got.messages) == 1


# ── migration ──────────────────────────────────────────────────────
def test_migration_imports_and_is_idempotent(monkeypatch):
    from server.services import conversations_migration as mig

    with TemporaryDirectory() as d:
        repo = ConversationRepository(base_dir=Path(d))
        # fake legacy file
        legacy = [{"id": "leg1", "title": "old", "messages": [
            {"role": "user", "content": "q"}, {"role": "assistant", "content": "a"}],
            "created_at": 100, "updated_at": 200}]
        legdir = Path(d) / "legacy"
        legdir.mkdir()
        legfile = legdir / "chat_history.json"
        legfile.write_text(json.dumps(legacy), encoding="utf-8")

        monkeypatch.setattr(mig, "_legacy_chat_history_path", lambda: legfile)

        s1 = mig.run_migration(repo)
        assert s1["imported"] == 1 and s1["failed"] == 0
        c = repo.get("leg1")
        assert c.title == "old" and len(c.messages) == 2
        assert all(m.status == MSG_COMPLETE for m in c.messages)

        # idempotent via marker
        s2 = mig.run_migration(repo)
        assert s2["skipped"] is True

        # force rerun -> already present
        s3 = mig.run_migration(repo, force=True)
        assert s3["already_present"] == 1 and s3["imported"] == 0


def test_migration_skips_when_no_ga_root(monkeypatch):
    from server.services import conversations_migration as mig
    with TemporaryDirectory() as d:
        repo = ConversationRepository(base_dir=Path(d))
        monkeypatch.setattr(mig, "_legacy_chat_history_path", lambda: None)
        s = mig.run_migration(repo)
        assert s["imported"] == 0
