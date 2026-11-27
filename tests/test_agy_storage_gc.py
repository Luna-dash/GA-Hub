"""Unit tests for tiered Agy archive storage GC (L0/L1/L2/L3) and delete hooks."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import sqlite3

from server.services import agy_profile, agy_storage_gc
from server.services.anti_engine import AntiSessions


def _set_mtime(path: Path, dt: datetime) -> None:
    ts = dt.timestamp()
    if path.is_dir():
        for f in path.rglob("*"):
            os.utime(f, (ts, ts))
    os.utime(path, (ts, ts))


def _init_summaries_db(cli_dir: Path, rows: list[tuple[str, str, str, int, int, str]]) -> None:
    """Create a minimal conversation_summaries.db matching Agy CLI schema."""
    sdb = cli_dir / "conversation_summaries.db"
    sdb.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(sdb)
    with conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS conversation_summaries (
                conversation_id TEXT PRIMARY KEY,
                parent_conversation_id TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT '',
                not_fully_idle INTEGER NOT NULL DEFAULT 0,
                killed INTEGER NOT NULL DEFAULT 0,
                last_modified_time TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS conversation_parents (
                conversation_id TEXT PRIMARY KEY,
                parent_id TEXT NOT NULL
            );
        """)
        for cid, pid, status, not_idle, killed, mtime in rows:
            conn.execute(
                "INSERT OR REPLACE INTO conversation_summaries VALUES (?,?,?,?,?,?)",
                (cid, pid, status, not_idle, killed, mtime),
            )
            if pid:
                conn.execute(
                    "INSERT OR REPLACE INTO conversation_parents VALUES (?,?)",
                    (cid, pid),
                )
    conn.close()


def _make_conv_files(
    cli_dir: Path,
    cid: str,
    *,
    db_bytes: int = 4096,
    mtime: datetime,
    artifact_name: str | None = None,
    with_redundant: bool = False,
) -> Path:
    conv_dir = cli_dir / "conversations"
    conv_dir.mkdir(parents=True, exist_ok=True)
    db_file = conv_dir / f"{cid}.db"
    db_file.write_bytes(b"d" * db_bytes)
    _set_mtime(db_file, mtime)

    brain = cli_dir / "brain" / cid
    sysgen = brain / ".system_generated"
    logs = sysgen / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    tr = logs / "transcript.jsonl"
    tr.write_text('{"type":"PLANNER_RESPONSE"}\n', encoding="utf-8")
    _set_mtime(tr, mtime)

    msgs = sysgen / "messages"
    msgs.mkdir(parents=True, exist_ok=True)
    (msgs / "read.json").write_text("{}", encoding="utf-8")
    subs = sysgen / "subagents"
    subs.mkdir(parents=True, exist_ok=True)

    if artifact_name:
        art = brain / artifact_name
        art.write_text("# important artifact\n", encoding="utf-8")
        _set_mtime(art, mtime)

    if with_redundant:
        tasks = sysgen / "tasks"
        tasks.mkdir(parents=True, exist_ok=True)
        tlog = tasks / "task-1.log"
        tlog.write_bytes(b"t" * 8192)
        _set_mtime(tlog, mtime)

        chunks = logs / "chunks"
        chunks.mkdir(parents=True, exist_ok=True)
        cf = chunks / "chunk-1.json"
        cf.write_bytes(b"k" * 4096)
        _set_mtime(cf, mtime)

        full_tr = logs / "transcript_full.jsonl"
        full_tr.write_bytes(b"f" * 6144)
        _set_mtime(full_tr, mtime)

        step_dir = sysgen / "steps" / "10"
        step_dir.mkdir(parents=True, exist_ok=True)
        sout = step_dir / "output.txt"
        sout.write_bytes(b"s" * 3072)
        _set_mtime(sout, mtime)

        scratch = brain / "scratch"
        scratch.mkdir(parents=True, exist_ok=True)
        sf = scratch / "tmp.log"
        sf.write_bytes(b"x" * 2048)
        _set_mtime(sf, mtime)

    _set_mtime(brain, mtime)
    return brain


def _seed_hub_db(
    db_path: Path,
    sessions: list[tuple[str, str | None, str]],
    runs: list[tuple[str, str, str, str | None]] | None = None,
) -> None:
    svc = AntiSessions(db=db_path)
    with svc.connect() as conn, conn:
        for sid, conv, updated_at in sessions:
            conn.execute(
                "INSERT INTO sessions (id, project, workspace, title, conversation, updated_at) VALUES (?,?,?,?,?,?)",
                (sid, "demo", str(db_path.parent), sid, conv, updated_at),
            )
            if conv:
                conn.execute(
                    "INSERT INTO profile_conversations (session_id, profile_id, conversation) VALUES (?,?,?)",
                    (sid, "default", conv),
                )
        for rid, sid, status, finished_at in (runs or []):
            conn.execute(
                "INSERT INTO runs (id, session_id, operation, prompt, status, answer, started_at, finished_at) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (rid, sid, rid, "hello", status, "world", finished_at or "", finished_at),
            )
            conn.execute(
                "INSERT INTO run_events (run_id, seq, payload_json) VALUES (?,?,?)",
                (rid, 1, json.dumps({"seq": 1, "type": "message.delta", "text": "x" * 1024})),
            )


class _DummyRuntime:
    def __init__(self, active_turns: int = 0) -> None:
        self._lock = agy_storage_gc.threading.RLock()
        self._workers: dict = {}
        self._retiring: dict = {}
        self._active_turns: dict = {
            (Path("."), f"r{i}"): type("W", (), {"active_turn": object()})()
            for i in range(active_turns)
        }
        self.closed: list[tuple[str, str]] = []

    def close_session(self, db_key: str, sid: str, *, force: bool = False) -> None:  # noqa: ARG002
        self.closed.append((db_key, sid))

    def forget_session_grants(self, db_key: str, sid: str) -> None:  # noqa: ARG002
        pass


def test_tiered_scan_and_cleanup_l0_l1_l2_l3(tmp_path: Path, monkeypatch) -> None:
    cli_dir = tmp_path / "cli"
    monkeypatch.setattr(agy_storage_gc._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_profile, "workspace_app_data_dir", lambda: cli_dir)

    now = datetime(2026, 11, 27, 12, 0, tzinfo=timezone.utc)
    db_path = tmp_path / "anti_sessions.sqlite3"
    rt = _DummyRuntime()

    # Conversations:
    # 1. live_root_active: active recent root with redundant L1 files (10 days old steps/scratch, 2 days old tasks/chunks)
    # 2. live_root_cold: 45 days old idle root -> eligible for L3 demotion
    # 3. child_killed_old: killed 48h ago under live_root_active -> eligible for L2 (with artifact preserved!)
    # 4. child_killed_recent: killed 2h ago -> protected (inside 24h grace)
    # 5. child_unreported: idle 10 days ago, but listed in parent subagents/ without inbox report -> protected!
    # 6. orphan_old: deleted session 2 days ago -> L0
    # 7. orphan_brand_new: unmapped DB 2 min old -> protected by 10 min race guard!
    _seed_hub_db(
        db_path,
        sessions=[
            ("hub-active", "root-active", (now - timedelta(hours=12)).isoformat()),
            ("hub-cold", "root-cold", (now - timedelta(days=45)).isoformat()),
        ],
        runs=[
            ("run-old", "hub-active", "success", (now - timedelta(days=40)).isoformat()),
            ("run-new", "hub-active", "success", (now - timedelta(days=2)).isoformat()),
        ],
    )

    _make_conv_files(
        cli_dir,
        "root-active",
        db_bytes=10_000,
        mtime=now - timedelta(days=10),
        artifact_name="design.md",
        with_redundant=True,
    )
    _make_conv_files(
        cli_dir,
        "root-cold",
        db_bytes=20_000,
        mtime=now - timedelta(days=45),
        artifact_name="cold-report.md",
        with_redundant=True,
    )
    _make_conv_files(
        cli_dir,
        "child-killed-old",
        db_bytes=30_000,
        mtime=now - timedelta(hours=48),
        artifact_name="sub-notes.md",
        with_redundant=True,
    )
    _make_conv_files(
        cli_dir,
        "child-killed-recent",
        db_bytes=12_000,
        mtime=now - timedelta(hours=2),
    )
    _make_conv_files(
        cli_dir,
        "child-unreported",
        db_bytes=14_000,
        mtime=now - timedelta(days=10),
    )
    # Register child-unreported in parent's subagents/ without reporting in messages/
    (cli_dir / "brain" / "root-active" / ".system_generated" / "subagents" / "child-unreported.json").write_text(
        json.dumps({"conversationId": "child-unreported", "state": "SUBAGENT_STATE_RUNNING"}),
        encoding="utf-8",
    )

    _make_conv_files(cli_dir, "orphan-old", db_bytes=16_000, mtime=now - timedelta(days=2))
    _make_conv_files(cli_dir, "orphan-new", db_bytes=5_000, mtime=now - timedelta(minutes=2))

    # Expired + recent CLI logs & crash file
    (cli_dir / "log").mkdir(parents=True, exist_ok=True)
    old_log = cli_dir / "log" / "old.log"
    old_log.write_bytes(b"L" * 2048)
    _set_mtime(old_log, now - timedelta(days=10))
    new_log = cli_dir / "log" / "new.log"
    new_log.write_bytes(b"N" * 1024)
    _set_mtime(new_log, now - timedelta(hours=1))
    (cli_dir / "crashes").mkdir(parents=True, exist_ok=True)
    crash = cli_dir / "crashes" / "dump.dmp"
    crash.write_bytes(b"C" * 512)

    _init_summaries_db(
        cli_dir,
        [
            ("root-active", "", "CASCADE_RUN_STATUS_IDLE", 0, 0, (now - timedelta(hours=12)).isoformat()),
            ("root-cold", "", "CASCADE_RUN_STATUS_IDLE", 0, 0, (now - timedelta(days=45)).isoformat()),
            ("child-killed-old", "root-active", "CASCADE_RUN_STATUS_IDLE", 0, 1, (now - timedelta(hours=48)).isoformat()),
            ("child-killed-recent", "root-active", "CASCADE_RUN_STATUS_IDLE", 0, 1, (now - timedelta(hours=2)).isoformat()),
            ("child-unreported", "root-active", "CASCADE_RUN_STATUS_IDLE", 0, 0, (now - timedelta(days=10)).isoformat()),
            ("orphan-old", "", "CASCADE_RUN_STATUS_IDLE", 0, 0, (now - timedelta(days=2)).isoformat()),
            ("orphan-new", "", "CASCADE_RUN_STATUS_IDLE", 0, 0, (now - timedelta(minutes=2)).isoformat()),
        ],
    )

    report = agy_storage_gc.scan_storage(cli_dir=cli_dir, db_path=db_path, runtime=rt, now=now)
    assert report.l0.item_count == 1
    assert report.l0.bytes >= 16_000 + 2048 + 512
    assert report.l1.item_count == 1
    assert report.l1.bytes >= 8192 + 4096 + 6144 + 3072 + 2048
    assert report.l2.item_count == 1
    assert report.l2.bytes >= 30_000
    assert report.l3.item_count == 1
    assert report.l3.bytes >= 20_000
    assert report.protected_child_count == 2  # child-killed-recent + child-unreported

    # Run scheduled GC (defaults: L0 + L1 + L2 enabled, L3 disabled)
    res = agy_storage_gc.run_scheduled_gc(cli_dir=cli_dir, db_path=db_path, runtime=rt, now=now)
    assert res is not None
    assert res["reclaimed_bytes"] > 0
    assert res["failed_entries"] == 0

    # L0 verified
    assert not (cli_dir / "conversations" / "orphan-old.db").exists()
    assert not (cli_dir / "brain" / "orphan-old").exists()
    assert not old_log.exists()
    assert not crash.exists()
    assert new_log.exists()
    assert (cli_dir / "conversations" / "orphan-new.db").exists()  # race-guarded!

    # L1 verified: redundant files gone, essential root files intact!
    root_brain = cli_dir / "brain" / "root-active"
    assert (cli_dir / "conversations" / "root-active.db").exists()
    assert (root_brain / "design.md").exists()
    assert (root_brain / ".system_generated" / "logs" / "transcript.jsonl").exists()
    assert (root_brain / ".system_generated" / "messages" / "read.json").exists()
    assert not (root_brain / ".system_generated" / "logs" / "transcript_full.jsonl").exists()
    assert not (root_brain / ".system_generated" / "logs" / "chunks").exists()
    assert not (root_brain / ".system_generated" / "tasks" / "task-1.log").exists()
    assert not (root_brain / "scratch" / "tmp.log").exists()

    # L2 verified: old killed child cleaned while preserving top-level artifact; recent & unreported kept!
    assert not (cli_dir / "conversations" / "child-killed-old.db").exists()
    assert not (cli_dir / "brain" / "child-killed-old" / ".system_generated").exists()
    assert (cli_dir / "brain" / "child-killed-old" / "sub-notes.md").exists()
    assert (cli_dir / "conversations" / "child-killed-recent.db").exists()
    assert (cli_dir / "conversations" / "child-unreported.db").exists()

    # L3 must NOT have run during default scheduled GC!
    assert (cli_dir / "conversations" / "root-cold.db").exists()

    # Scheduled GC should not re-run immediately within interval_hours
    assert agy_storage_gc.is_scheduled_gc_due(now=now + timedelta(hours=1)) is False
    assert agy_storage_gc.is_scheduled_gc_due(now=now + timedelta(hours=25)) is True

    # Now explicitly run L3 cleanup
    res_l3 = agy_storage_gc.run_cleanup(["l3"], cli_dir=cli_dir, db_path=db_path, runtime=rt, now=now)
    assert res_l3["reclaimed_bytes"] >= 20_000
    assert not (cli_dir / "conversations" / "root-cold.db").exists()
    assert not (cli_dir / "brain" / "root-cold" / ".system_generated").exists()
    # Top-level artifact and Hub chat history MUST remain intact!
    assert (cli_dir / "brain" / "root-cold" / "cold-report.md").exists()
    conn = sqlite3.connect(db_path)
    cold_row = conn.execute("SELECT conversation FROM sessions WHERE id='hub-cold'").fetchone()
    assert cold_row is not None and cold_row[0] is None
    assert conn.execute("SELECT COUNT(*) FROM run_events WHERE run_id='run-old'").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM run_events WHERE run_id='run-new'").fetchone()[0] == 1
    assert conn.execute("SELECT answer FROM runs WHERE id='run-old'").fetchone()[0] == "world"
    conn.close()


def test_delete_session_cascades_native_subtree_only(tmp_path: Path, monkeypatch) -> None:
    cli_dir = tmp_path / "cli"
    monkeypatch.setattr(agy_storage_gc._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_profile, "workspace_app_data_dir", lambda: cli_dir)

    now = datetime(2026, 11, 27, 12, 0, tzinfo=timezone.utc)
    db_path = tmp_path / "anti_sessions.sqlite3"
    rt = _DummyRuntime()

    _seed_hub_db(
        db_path,
        sessions=[
            ("sid-del", "conv-del-root", now.isoformat()),
            ("sid-keep", "conv-keep-root", now.isoformat()),
        ],
    )
    for cid in ("conv-del-root", "conv-del-child", "conv-del-grandchild", "conv-keep-root", "conv-keep-child"):
        _make_conv_files(cli_dir, cid, db_bytes=4096, mtime=now)

    _init_summaries_db(
        cli_dir,
        [
            ("conv-del-root", "", "CASCADE_RUN_STATUS_IDLE", 0, 0, now.isoformat()),
            ("conv-del-child", "conv-del-root", "CASCADE_RUN_STATUS_IDLE", 0, 0, now.isoformat()),
            ("conv-del-grandchild", "conv-del-child", "CASCADE_RUN_STATUS_IDLE", 0, 0, now.isoformat()),
            ("conv-keep-root", "", "CASCADE_RUN_STATUS_IDLE", 0, 0, now.isoformat()),
            ("conv-keep-child", "conv-keep-root", "CASCADE_RUN_STATUS_IDLE", 0, 0, now.isoformat()),
        ],
    )

    svc = AntiSessions(db=db_path, runtime=rt)
    svc.delete("sid-del")

    # Deleted session's entire subtree removed
    for cid in ("conv-del-root", "conv-del-child", "conv-del-grandchild"):
        assert not (cli_dir / "conversations" / f"{cid}.db").exists()
        assert not (cli_dir / "brain" / cid).exists()

    # Kept session's subtree untouched
    for cid in ("conv-keep-root", "conv-keep-child"):
        assert (cli_dir / "conversations" / f"{cid}.db").exists()
        assert (cli_dir / "brain" / cid).exists()

    # Summaries DB pruned for deleted subtree only
    conn = sqlite3.connect(cli_dir / "conversation_summaries.db")
    remaining = {r[0] for r in conn.execute("SELECT conversation_id FROM conversation_summaries")}
    conn.close()
    assert remaining == {"conv-keep-root", "conv-keep-child"}
