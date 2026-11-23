"""Behavioral tests for unified Agy ACP sessions, approvals, resume, and attachments."""
import threading
import time
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.routes import anti, upload
from server.services import anti_engine as engine
from server.services import file_transfer as transfer


class FakeWorker:
    def __init__(self, manager, profile_id, sid, workspace):
        self.manager = manager
        self.profile_id = profile_id
        self.session_id = sid
        self.workspace = workspace
        self.active_turn = None
        self._closed = False
        self.perm_event = threading.Event()
        self.perm_choice = None

    def run_turn(
        self,
        *,
        run_id,
        prompt_text,
        model,
        effort,
        mode,
        permission_mode,
        resume_conversation,
        add_dirs,
        staged_paths,
        attachments,
        allowed_roots,
        on_event,
    ):
        self.manager.calls.append({
            "profile_id": self.profile_id,
            "workspace": self.workspace,
            "conversation": resume_conversation,
            "prompt": prompt_text,
            "model": model,
            "effort": effort,
            "mode": mode,
            "permission_mode": permission_mode,
            "add_dirs": list(add_dirs),
        })
        on_event({"seq": 1, "type": "step.update", "step": {"index": 0, "kind": "thought", "state": "ACTIVE", "text_delta": "分析中"}})
        on_event({"seq": 2, "type": "step.update", "step": {"index": 1, "kind": "tool_call", "state": "ACTIVE", "tool": "view_file"}})
        on_event({"seq": 3, "type": "message.delta", "text": "好"})

        if self.manager.require_approval:
            approval_id = "a" * 32
            self.manager.pending[run_id] = {
                "id": approval_id,
                "title": "Edit note",
                "details": "note.txt",
                "prompt_type": "approval",
                "tool_kind": "edit",
                "allow_always": True,
            }
            on_event({"seq": 0, "type": "approval.requested", "approval": self.manager.pending[run_id]})
            self.perm_event.wait(3.0)
            self.manager.pending.pop(run_id, None)
            if self.perm_choice == "reject":
                return {"status": "success", "conversation_id": self.manager.next_conv(self.profile_id, run_id), "answer": "已拒绝修改", "usage": {}}

        if self.manager.hold_turn:
            self.perm_event.wait(3.0)
            if self.manager.cancelled_ids.get(run_id):
                return {"status": "cancelled", "conversation_id": resume_conversation, "answer": None, "usage": {}}

        return {
            "status": "success",
            "conversation_id": self.manager.next_conv(self.profile_id, run_id),
            "answer": "完整结果",
            "usage": {"input_tokens": 120, "output_tokens": 30, "cache_read_tokens": 60},
        }

    def close(self):
        self._closed = True


class FakeRuntime:
    def __init__(self, *, require_approval=False, hold_turn=False):
        self.calls = []
        self.pending = {}
        self.workers = {}
        self.cancelled_ids = {}
        self.require_approval = require_approval
        self.hold_turn = hold_turn
        self.conv_map = {}

    def next_conv(self, profile_id, run_id):
        return self.conv_map.get(profile_id, f"conv-{profile_id}")

    def models(self):
        return [{"id": "alternate", "display_name": "Alternative"}]

    def commands(self):
        return [{"name": "plan", "description": "生成方案"}]

    def session_connected(self, db_key, sid):
        return any(k for k in self.workers if isinstance(k, tuple) and len(k) == 3 and k[0] == db_key and k[2] == sid)

    def get_worker(self, db_key, profile_id, sid, workspace):
        key = (db_key, profile_id, sid)
        if key not in self.workers:
            self.workers[key] = FakeWorker(self, profile_id, sid, workspace)
        return self.workers[key]

    def register_turn(self, db_path, run_id, worker):
        self.workers[("turn", run_id)] = worker

    def unregister_turn(self, db_path, run_id):
        self.workers.pop(("turn", run_id), None)

    def active_turn_approval(self, db_path, run_id):
        return self.pending.get(run_id)

    def approve_turn(self, db_path, run_id, approval_id, decision, option_id=None):
        p = self.pending.get(run_id)
        w = self.workers.get(("turn", run_id))
        if not p or p["id"] != approval_id or w is None:
            return False
        w.perm_choice = decision
        w.perm_event.set()
        return True

    def cancel_turn(self, db_path, run_id):
        self.cancelled_ids[run_id] = True
        w = self.workers.get(("turn", run_id))
        if w:
            w.perm_event.set()
        return True

    def close_session(self, db_key, sid):
        pass


def _wait_terminal(client, path, timeout=3.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        data = client.get(path).json()
        if data["status"] in engine.TERMINAL:
            return data
        time.sleep(0.02)
    raise AssertionError(f"run did not finish: {path}")


def test_unified_acp_round_trip_mode_switch_and_resume(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    artifacts = tmp_path / "project_artifacts" / "project" / "anti"
    runtime = FakeRuntime()
    db = tmp_path / "anti.sqlite"
    monkeypatch.setattr(transfer._paths, "ADMIN_DATA", tmp_path / "data")
    monkeypatch.setattr(engine, "project", lambda name: (workspace, artifacts))
    monkeypatch.setattr(anti, "AntiSessions", lambda: engine.AntiSessions(db, runtime))
    monkeypatch.setattr(anti.daemon, "submission", lambda: __import__("contextlib").nullcontext("default"))
    app = FastAPI()
    app.include_router(anti.router)
    with TestClient(app) as client:
        assert client.get("/api/anti/models").json() == {"items": [{"id": "alternate", "display_name": "Alternative"}]}
        assert client.get("/api/anti/commands").json() == {"items": [{"name": "plan", "description": "生成方案", "hint": None}]}
        sessions = "/api/anti/sessions"
        session = client.post(sessions, json={"project": "project"}).json()
        assert session["engine"] == "anti"
        assert session["workspace"] == str(workspace)

        runs = f"{sessions}/{session['id']}/runs"
        body = {"operation": "message1", "prompt": "check structure"}
        run = client.post(runs, json=body).json()
        path = f"{runs}/{run['id']}"
        assert client.post(runs, json=body).json()["id"] == run["id"]
        assert client.post(runs, json=body | {"prompt": "changed"}).status_code == 409
        assert client.post(runs, json=body | {"effort": "invalid"}).status_code == 422

        completed = _wait_terminal(client, path)
        assert completed["status"] == "success"
        assert completed["answer"] == "完整结果"
        assert runtime.calls[0]["mode"] == "plan"
        assert runtime.calls[0]["conversation"] is None

        ev = client.get(path + "/events").json()
        assert [e["seq"] for e in ev] == [1, 2, 3]
        assert ev[0]["step"]["kind"] == "thought"
        assert ev[1]["step"]["tool"] == "view_file"
        assert ev[2]["type"] == "message.delta" and ev[2]["text"] == "好"
        assert client.get(path + "/events?after=2").json() == [ev[2]]

        # Switching to accept-edits in the SAME session resumes the exact same conversation_id!
        second = client.post(runs, json={
            "operation": "message2",
            "prompt": "apply patch",
            "mode": "accept-edits",
            "permission_mode": "auto-accept-edits",
            "model": "alternate",
            "effort": "low",
        }).json()
        done2 = _wait_terminal(client, f"{runs}/{second['id']}")
        assert done2["status"] == "success"
        assert done2["usage"] == {"input_tokens": 120, "output_tokens": 30, "cache_read_tokens": 60, "thinking_tokens": 0}
        assert runtime.calls[-1]["mode"] == "accept-edits"
        assert runtime.calls[-1]["permission_mode"] == "auto-accept-edits"
        assert runtime.calls[-1]["conversation"] == "conv-default"

        reset_resp = client.post(f"{sessions}/{session['id']}/reset")
        assert reset_resp.status_code == 200
        assert reset_resp.json()["has_conversation"] is True


def test_interactive_approval_over_unified_acp(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    runtime = FakeRuntime(require_approval=True)
    db = tmp_path / "anti.sqlite"
    monkeypatch.setattr(transfer._paths, "ADMIN_DATA", tmp_path / "data")
    monkeypatch.setattr(engine, "project", lambda name: (workspace, tmp_path / "artifacts"))
    monkeypatch.setattr(anti, "AntiSessions", lambda: engine.AntiSessions(db, runtime))
    monkeypatch.setattr(anti.daemon, "submission", lambda: __import__("contextlib").nullcontext("default"))
    app = FastAPI()
    app.include_router(anti.router)
    with TestClient(app) as client:
        sid = client.post("/api/anti/sessions", json={"project": "project"}).json()["id"]
        run = client.post(f"/api/anti/sessions/{sid}/runs", json={
            "operation": "edit1",
            "prompt": "edit note",
            "mode": "accept-edits",
            "permission_mode": "approval-required",
        }).json()
        rid = run["id"]
        deadline = time.monotonic() + 2.0
        pending = None
        while time.monotonic() < deadline:
            cur = client.get(f"/api/anti/sessions/{sid}/runs/{rid}").json()
            if cur.get("approval"):
                pending = cur["approval"]
                break
            time.sleep(0.02)
        assert pending is not None and pending["allow_always"] is True

        resp = client.post(
            f"/api/anti/sessions/{sid}/runs/{rid}/approval",
            json={"approval_id": pending["id"], "decision": "reject"},
            headers={"X-GA-Hub-Action": "approve-agy"},
        )
        assert resp.status_code == 200
        done = _wait_terminal(client, f"/api/anti/sessions/{sid}/runs/{rid}")
        assert done["answer"] == "已拒绝修改"


def test_anti_file_resolution_uses_session_workspace(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    citation = workspace / "anti-citation.md"
    citation.touch()
    monkeypatch.setattr(engine._paths, "ADMIN_DATA", tmp_path / "data")
    monkeypatch.setattr(engine, "project", lambda name: (workspace, tmp_path / "artifacts"))
    session = engine.AntiSessions().create("project")
    app = FastAPI()
    app.include_router(upload.router)
    with TestClient(app) as client:
        body = {"engine": "anti", "session_id": session["id"], "path": citation.name}
        resolved = client.post("/api/files/resolve", json=body)
        assert resolved.status_code == 200
        assert resolved.json()["resolved"] == str(citation.resolve())
        missing = client.post("/api/files/resolve", json=body | {"session_id": "missing"})
        assert missing.status_code == 404


def test_legacy_anti_sessions_get_first_prompt_title(tmp_path):
    import sqlite3

    db = tmp_path / "legacy.sqlite"
    with sqlite3.connect(db) as conn:
        conn.executescript("""
            CREATE TABLE sessions (id TEXT PRIMARY KEY, project TEXT, workspace TEXT, title TEXT, conversation_id TEXT);
            CREATE TABLE runs (id TEXT PRIMARY KEY, session_id TEXT, prompt TEXT, model TEXT, effort TEXT, status TEXT);
            INSERT INTO sessions VALUES ('one', 'p', '/p', 'Anti', NULL),
                                        ('two', 'p', '/p', 'Anti', NULL),
                                        ('three', 'p', '/p', 'Custom', NULL);
            INSERT INTO runs VALUES ('r', 'one', 'Read the   workspace', 'm', 'high', 'completed');
        """)
    sessions = engine.AntiSessions(db)
    assert {row["id"]: row["title"] for row in sessions.list()} == {
        "one": "Read the workspace", "two": "", "three": "Custom",
    }
    historical, = sessions.history("one")
    assert (historical["status"], historical["model"], historical["effort"]) == ("completed", "m", "high")


def test_selected_references_and_attachments_stage_properly(tmp_path, monkeypatch):
    workspace = tmp_path / "project"
    workspace.mkdir()
    artifacts = tmp_path / "artifacts"
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    local = workspace / "inside.txt"
    local.write_text("inside", encoding="utf-8")
    external = tmp_path / "external.txt"
    external.write_text("outside", encoding="utf-8")
    uploaded = uploads / "shot.png"
    uploaded.write_bytes(b"\x89PNG\r\n\x1a\n")

    monkeypatch.setattr(transfer._paths, "ADMIN_DATA", tmp_path / "data")
    monkeypatch.setattr(transfer._paths, "admin_uploads_dir", lambda: uploads)
    monkeypatch.setattr(engine, "project", lambda name: (workspace.resolve(), artifacts.resolve()))
    indexed = transfer.FileTransfer()
    for file in (local, external):
        indexed.add(str(file), "chat", "s", None)

    runtime = FakeRuntime()
    monkeypatch.setattr(anti, "AntiSessions", lambda: engine.AntiSessions(tmp_path / "anti.sqlite", runtime))
    monkeypatch.setattr(anti.daemon, "submission", lambda: __import__("contextlib").nullcontext("default"))
    app = FastAPI()
    app.include_router(anti.router)
    with TestClient(app) as client:
        sid = client.post("/api/anti/sessions", json={"project": "project"}).json()["id"]
        url = f"/api/anti/sessions/{sid}/runs"
        assert client.post(url, json={"operation": "empty", "prompt": "   "}).status_code == 422
        body = {
            "operation": "att-ref",
            "prompt": "inspect",
            "references": [{"id": 1, "path": str(local)}, {"id": 2, "path": str(external)}],
            "attachments": [{"path": str(uploaded), "name": "shot.png", "source": "managed_upload", "size": 8}],
        }
        run = client.post(url, json=body).json()
        done = _wait_terminal(client, f"{url}/{run['id']}")
        assert done["status"] == "success"
        assert len(runtime.calls[0]["add_dirs"]) == 1
        assert local.as_posix() in runtime.calls[0]["prompt"]


def test_conversation_resume_is_per_agy_profile(tmp_path, monkeypatch):
    monkeypatch.setattr(engine, "project", lambda name: (tmp_path, tmp_path / "artifacts"))
    runtime = FakeRuntime()
    sessions = engine.AntiSessions(tmp_path / "anti.sqlite", runtime)
    sid = sessions.create("project")["id"]
    seen = {}
    for index, profile in enumerate(("default", "alpha", "beta", "alpha", "default", "beta")):
        runtime.conv_map[profile] = f"conv-{profile}"
        run = sessions.submit(sid, f"op{index}", "hello", profile_id=profile, mode="accept-edits" if index % 2 else "plan")
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            if sessions.refresh(sid, run["id"])["status"] == "success":
                break
            time.sleep(0.02)
        assert runtime.calls[-1]["conversation"] == seen.get(profile)
        seen[profile] = f"conv-{profile}"


def test_events_stream_sse_emits_live_events(tmp_path, monkeypatch):
    monkeypatch.setattr(engine, "project", lambda name: (tmp_path, tmp_path / "artifacts"))
    runtime = FakeRuntime()
    sessions = engine.AntiSessions(tmp_path / "anti.sqlite", runtime)
    sid = sessions.create("project")["id"]
    run = sessions.submit(sid, "sse-op", "stream me")
    monkeypatch.setattr(anti, "AntiSessions", lambda: sessions)
    app = FastAPI()
    app.include_router(anti.router)
    client = TestClient(app)

    resp = client.get(f"/api/anti/sessions/{sid}/runs/{run['id']}/events/stream")
    assert resp.status_code == 200
    assert "text/event-stream" in resp.headers["content-type"]
    assert "step.update" in resp.text and "好" in resp.text


def test_cancel_timeout_does_not_release_a_live_turn(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    monkeypatch.setattr(engine, "project", lambda name: (workspace, tmp_path / "artifacts"))
    entered = threading.Event()
    release = threading.Event()
    runtime = FakeRuntime()

    def slow_turn(self, **kwargs):
        entered.set()
        release.wait(5)
        return {"status": "cancelled", "usage": {}}

    def request_cancel(db_path, run_id):
        return True

    class Clock:
        @staticmethod
        def monotonic():
            return next(ticks)

    monkeypatch.setattr(FakeWorker, "run_turn", slow_turn)
    monkeypatch.setattr(runtime, "cancel_turn", request_cancel)
    sessions = engine.AntiSessions(tmp_path / "anti.sqlite", runtime)
    sid = sessions.create("project")["id"]
    run = sessions.submit(sid, "slow-cancel", "wait")
    rid = run["id"]
    try:
        assert entered.wait(2)
        ticks = iter([0.0, 3.1])
        with monkeypatch.context() as clock:
            clock.setattr(engine, "time", Clock)
            assert sessions.cancel(sid, rid)["status"] in engine.ACTIVE
        assert sessions.run(sid, rid)["status"] in engine.ACTIVE
    finally:
        release.set()
    deadline = time.monotonic() + 2
    while sessions.run(sid, rid)["status"] not in engine.TERMINAL and time.monotonic() < deadline:
        time.sleep(0.01)
    assert sessions.run(sid, rid)["status"] == "cancelled"


def test_account_cooldown_blocks_submit_until_reset_or_switch(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    monkeypatch.setattr(transfer._paths, "ADMIN_DATA", tmp_path / "data")
    monkeypatch.setattr(engine, "project", lambda name: (workspace, tmp_path / "artifacts"))
    runtime = FakeRuntime()
    db = tmp_path / "anti.sqlite"
    sessions = engine.AntiSessions(db, runtime)
    sessions.ledger.record_run("r_limit", engine.DEFAULT_MODEL, "rate_limited", profile_id="default", cooldown_seconds=120)

    monkeypatch.setattr(anti, "AntiSessions", lambda: engine.AntiSessions(db, runtime))
    monkeypatch.setattr(anti.daemon, "submission", lambda: __import__("contextlib").nullcontext("default"))
    app = FastAPI()
    app.include_router(anti.router)
    with TestClient(app) as client:
        sid = client.post("/api/anti/sessions", json={"project": "project"}).json()["id"]
        blocked = client.post(
            f"/api/anti/sessions/{sid}/runs",
            json={"operation": "op_blocked", "prompt": "try run"},
        )
        assert blocked.status_code == 429
        assert "风控冷却" in blocked.json()["detail"]

        # Switching to another profile does not inherit default's cooldown.
        sid_other = client.post("/api/anti/sessions", json={"project": "project"}).json()["id"]
        other_run = sessions.submit(sid_other, "op_other", "try other", profile_id="a" * 32)
        assert other_run["status"] in {"running", "success"}  # the fake worker can finish before submit returns

        # Resetting breaker unblocks default profile too.
        assert client.post(
            "/api/anti/breaker/reset",
            json={"model_group": "gemini-4"},
            headers={"X-GA-Hub-Action": "manage-anti-gateway"},
        ).status_code == 204
        unblocked = client.post(
            f"/api/anti/sessions/{sid}/runs",
            json={"operation": "op_ok", "prompt": "retry after reset"},
        )
        assert unblocked.status_code == 200


def test_connect_initializes_schema_once_with_wal_and_ephemeral_is_non_destructive(tmp_path, monkeypatch):
    monkeypatch.setattr(engine, "project", lambda name: (tmp_path, tmp_path / "artifacts"))
    db = tmp_path / "wal_once.sqlite"
    sessions = engine.AntiSessions(db, FakeRuntime())
    init_calls = 0
    real_init = engine.AntiSessions._initialize_schema

    def counted_init(self, conn):
        nonlocal init_calls
        init_calls += 1
        return real_init(self, conn)

    monkeypatch.setattr(engine.AntiSessions, "_initialize_schema", counted_init)
    with sessions.connect() as conn:
        mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
    with sessions.connect() as _conn2:
        pass
    with engine.AntiSessions(db, FakeRuntime()).connect() as _conn3:
        pass
    assert init_calls == 1
    assert mode.lower() == "wal"

    # Ephemeral approval events must remain observable to multiple SSE consumers until finished.
    key = (db.resolve(), "run-eph")
    engine._EVENT_BUS.notify(key, ephemeral={"seq": 0, "type": "approval.requested"})
    cur_a, seen_a = engine._EVENT_BUS.ephemeral_after(key, 0)
    cur_b, seen_b = engine._EVENT_BUS.ephemeral_after(key, 0)
    assert cur_a == 1 and len(seen_a) == 1
    assert cur_b == 1 and len(seen_b) == 1
    assert engine._EVENT_BUS.ephemeral_after(key, cur_a) == (1, [])
    engine._EVENT_BUS.notify(key, finished=True)
    assert engine._EVENT_BUS.ephemeral_after(key, 0) == (0, [])
