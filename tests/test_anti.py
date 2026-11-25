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
        fallback_handoff_context=None,
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
            "allowed_roots": [Path(p).resolve() for p in allowed_roots],
            "attachments": list(attachments),
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
            **({"progress_messages": ["阶段一：检查文件", "阶段二：应用修改"]} if resume_conversation else {}),
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
        assert run["started_at"]
        if run["status"] in engine.ACTIVE:
            assert run["finished_at"] is None
        path = f"{runs}/{run['id']}"
        assert client.post(runs, json=body).json()["id"] == run["id"]
        assert client.post(runs, json=body | {"prompt": "changed"}).status_code == 409
        assert client.post(runs, json=body | {"effort": "invalid"}).status_code == 422

        completed = _wait_terminal(client, path)
        assert completed["status"] == "success"
        assert completed["started_at"] == run["started_at"]
        assert completed["finished_at"]
        assert completed["answer"] == "完整结果"
        assert completed["progress_messages"] == []
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
        assert done2["progress_messages"] == ["阶段一：检查文件", "阶段二：应用修改"]
        assert client.get(runs).json()[-1]["progress_messages"] == ["阶段一：检查文件", "阶段二：应用修改"]
        assert done2["usage"] == {
            "input_tokens": 120,
            "output_tokens": 30,
            "cache_read_tokens": 60,
            "cache_write_tokens": 0,
            "thinking_tokens": 0,
            "model_calls": None,
            "generation_ms": None,
        }
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
        assert uploads.resolve() not in runtime.calls[0]["allowed_roots"]
        assert Path(runtime.calls[0]["attachments"][0]["path"]).resolve().is_relative_to(artifacts.resolve())
        assert local.as_posix() in runtime.calls[0]["prompt"]


def test_conversation_resume_is_shared_across_agy_profiles(tmp_path, monkeypatch):
    monkeypatch.setattr(engine, "project", lambda name: (tmp_path, tmp_path / "artifacts"))
    runtime = FakeRuntime()
    sessions = engine.AntiSessions(tmp_path / "anti.sqlite", runtime)
    sid = sessions.create("project")["id"]
    shared_conv = None
    for index, profile in enumerate(("default", "alpha", "beta", "alpha", "default", "beta")):
        runtime.conv_map[profile] = shared_conv or f"conv-{profile}"
        run = sessions.submit(sid, f"op{index}", "hello", profile_id=profile, mode="accept-edits" if index % 2 else "plan")
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            if sessions.refresh(sid, run["id"])["status"] == "success":
                break
            time.sleep(0.02)
        assert runtime.calls[-1]["conversation"] == shared_conv
        shared_conv = shared_conv or f"conv-{profile}"
        assert sessions.session(sid)["conversation"] == shared_conv


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


def test_force_cancel_and_force_reset_converge_stuck_run_and_keep_conversation(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    monkeypatch.setattr(transfer._paths, "ADMIN_DATA", tmp_path / "data")
    monkeypatch.setattr(engine, "project", lambda name: (workspace, tmp_path / "artifacts"))
    db = tmp_path / "anti_force.sqlite"

    class ForceAwareRuntime(FakeRuntime):
        def __init__(self):
            super().__init__(hold_turn=False)
            self.force_calls: list[tuple[str, bool]] = []

        def cancel_turn(self, db_path, run_id, *, force=False):
            self.force_calls.append((run_id, force))
            if not force:
                # Simulate an unresponsive upstream ignoring soft cancel.
                return True
            return super().cancel_turn(db_path, run_id)

    runtime = ForceAwareRuntime()
    monkeypatch.setattr(anti, "AntiSessions", lambda: engine.AntiSessions(db, runtime))
    monkeypatch.setattr(anti.daemon, "submission", lambda: __import__("contextlib").nullcontext("default"))
    app = FastAPI()
    app.include_router(anti.router)
    with TestClient(app) as client:
        sid = client.post("/api/anti/sessions", json={"project": "project"}).json()["id"]
        runs = f"/api/anti/sessions/{sid}/runs"

        # 1. Establish a saved conversation id via a normal completed run.
        first = client.post(runs, json={"operation": "op0", "prompt": "init"}).json()
        assert _wait_terminal(client, f"{runs}/{first['id']}")["status"] == "success"

        # 2. Switch to wedged turns where soft cancel hangs and normal reset raises 409.
        entered = threading.Event()
        orig_run_turn = FakeWorker.run_turn

        def hooked_run_turn(self, **kwargs):
            if self.manager.hold_turn:
                self.perm_event.clear()
                entered.set()
            return orig_run_turn(self, **kwargs)

        monkeypatch.setattr(FakeWorker, "run_turn", hooked_run_turn)
        runtime.hold_turn = True
        wedged1 = client.post(runs, json={"operation": "op1", "prompt": "stuck 1"}).json()
        assert entered.wait(2.0)

        ticks = iter([0.0, 0.0, 3.5])

        class FastClock:
            @staticmethod
            def monotonic():
                return next(ticks)

            @staticmethod
            def sleep(_seconds):
                pass

        with monkeypatch.context() as clock:
            clock.setattr(engine, "time", FastClock)
            soft_resp = client.post(f"{runs}/{wedged1['id']}/cancel")
        assert soft_resp.status_code == 200
        assert soft_resp.json()["status"] in engine.ACTIVE
        assert client.post(f"/api/anti/sessions/{sid}/reset").status_code == 409

        force_resp = client.post(f"{runs}/{wedged1['id']}/cancel?force=true")
        assert force_resp.status_code == 200
        assert force_resp.json()["status"] == "cancelled"
        assert (wedged1["id"], True) in runtime.force_calls

        # 3. A second wedged run can be force-reset while preserving conversation resume capability.
        entered.clear()
        wedged2 = client.post(runs, json={"operation": "op2", "prompt": "stuck 2"}).json()
        assert entered.wait(2.0)
        reset_resp = client.post(f"/api/anti/sessions/{sid}/reset?force=true")
        assert reset_resp.status_code == 200
        assert reset_resp.json()["has_conversation"] is True
        assert reset_resp.json()["active_run_id"] is None
        assert client.get(f"{runs}/{wedged2['id']}").json()["status"] == "cancelled"


def test_workers_listing_and_mid_turn_steer_endpoint(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    monkeypatch.setattr(transfer._paths, "ADMIN_DATA", tmp_path / "data")
    monkeypatch.setattr(engine, "project", lambda name: (workspace, tmp_path / "artifacts"))
    db = tmp_path / "anti_steer.sqlite"

    class SteerRuntime(FakeRuntime):
        def __init__(self):
            super().__init__(hold_turn=True)
            self.steers: list[dict] = []

        def list_workers(self, db_key=None):
            return [
                {
                    "profile_id": "default",
                    "session_id": sid,
                    "workspace": str(workspace),
                    "pid": 9101,
                    "alive": True,
                    "busy": bool(self.workers.get(("turn", active_id))),
                    "state": "running",
                    "active_run_id": active_id,
                    "idle_seconds": 0,
                    "idle_ttl": 1800,
                    "dirty": False,
                    "retired": False,
                    "exit_pending": False,
                }
            ]

        def steer_turn(self, db_path, run_id, *, prompt_text, staged_paths, attachments, allowed_roots):
            self.steers.append({
                "run_id": run_id,
                "prompt_text": prompt_text,
                "allowed_roots": list(allowed_roots),
            })
            return {"steered": True, "prompt_seq": 2}

    runtime = SteerRuntime()
    monkeypatch.setattr(anti, "AntiSessions", lambda: engine.AntiSessions(db, runtime))
    monkeypatch.setattr(anti.daemon, "submission", lambda: __import__("contextlib").nullcontext("default"))
    app = FastAPI()
    app.include_router(anti.router)
    with TestClient(app) as client:
        sid = client.post("/api/anti/sessions", json={"project": "project", "title": "Steer 会话"}).json()["id"]
        runs = f"/api/anti/sessions/{sid}/runs"
        entered = threading.Event()
        orig_run_turn = FakeWorker.run_turn

        def hooked_run_turn(self, **kwargs):
            self.perm_event.clear()
            entered.set()
            return orig_run_turn(self, **kwargs)

        monkeypatch.setattr(FakeWorker, "run_turn", hooked_run_turn)
        run = client.post(runs, json={"operation": "op-steer", "prompt": "start task"}).json()
        active_id = run["id"]
        assert entered.wait(2.0)

        workers_resp = client.get("/api/anti/workers")
        assert workers_resp.status_code == 200
        items = workers_resp.json()["items"]
        assert len(items) == 1
        assert items[0]["project"] == "project"
        assert items[0]["session_title"] == "Steer 会话"
        assert items[0]["pid"] == 9101
        assert items[0]["active_run_id"] == active_id

        steer_resp = client.post(f"{runs}/{active_id}/steer", json={"prompt": "优先补单测"})
        assert steer_resp.status_code == 200
        assert runtime.steers[-1]["run_id"] == active_id
        assert "优先补单测" in runtime.steers[-1]["prompt_text"]

        runtime.workers[(str(db.resolve()), "default", sid)].perm_event.set()
        assert _wait_terminal(client, f"{runs}/{active_id}")["status"] == "success"

        done_steer = client.post(f"{runs}/{active_id}/steer", json={"prompt": "late"})
        assert done_steer.status_code == 409


def test_session_grants_compact_and_shared_context_across_account_switches(tmp_path, monkeypatch):
    from contextlib import nullcontext
    import sqlite3
    from server.services import agy_profile

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    data_dir = tmp_path / "data"
    monkeypatch.setattr(transfer._paths, "ADMIN_DATA", data_dir)
    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", data_dir)
    monkeypatch.setattr(engine, "project", lambda name: (workspace, tmp_path / "artifacts"))

    alt = agy_profile.add("备用账号")

    class Phase3Runtime(FakeRuntime):
        def __init__(self):
            super().__init__(require_approval=True)
            self._has_cached = True
            self._commands = [{"name": "plan", "description": "规划", "hint": None}]
            self._grants: dict[str, set[str]] = {}
            self.model_profile_queries: list[str | None] = []
            self.command_profile_queries: list[str | None] = []

        def models(self, profile_id=None):
            self.model_profile_queries.append(profile_id)
            return [{"id": f"model-{profile_id or 'default'}", "display_name": f"Model {profile_id or 'default'}"}]

        def commands(self, profile_id=None):
            self.command_profile_queries.append(profile_id)
            return list(self._commands)

        def has_cached_commands(self, profile_id=None):
            return self._has_cached

        def session_grants(self, db_path, session_id):
            return sorted(self._grants.get(session_id, set()))

        def clear_session_grants(self, db_path, session_id, kind=None):
            current = self._grants.setdefault(session_id, set())
            if kind:
                current.discard(kind)
            else:
                current.clear()
            return sorted(current)

    runtime = Phase3Runtime()
    db = tmp_path / "anti.sqlite"
    monkeypatch.setattr(anti, "AntiSessions", lambda: engine.AntiSessions(db, runtime))
    active_holder = {"pid": "default"}
    monkeypatch.setattr(anti.daemon, "submission", lambda: nullcontext(active_holder["pid"]))

    app = FastAPI()
    app.include_router(anti.router)
    with TestClient(app) as client:
        assert client.get(f"/api/anti/models?profile_id={alt.id}").json()["items"][0]["id"] == f"model-{alt.id}"
        assert client.get(f"/api/anti/commands?profile_id={alt.id}").json()["items"][0]["name"] == "plan"
        assert runtime.model_profile_queries[-1] == alt.id
        assert runtime.command_profile_queries[-1] == alt.id

        session = client.post("/api/anti/sessions", json={"project": "project"}).json()
        sid = session["id"]
        assert session["profile_id"] is None
        assert session["grants"] == []

        # Per-session account binding endpoint is removed; compact without conversation -> 409
        assert client.patch(f"/api/anti/sessions/{sid}/profile", json={"profile_id": alt.id}).status_code in {404, 405}
        assert client.post(f"/api/anti/sessions/{sid}/compact", json={}).status_code == 409

        # Turn 1 runs on active account 'default'
        run = client.post(
            f"/api/anti/sessions/{sid}/runs",
            json={"operation": "op-bind", "prompt": "check", "mode": "accept-edits", "permission_mode": "approval-required"},
        ).json()
        rid = run["id"]
        deadline = time.monotonic() + 2.0
        while (str(db.resolve()), "default", sid) not in runtime.workers and time.monotonic() < deadline:
            time.sleep(0.01)
        assert (str(db.resolve()), "default", sid) in runtime.workers

        runtime._grants[sid] = {"edit", "execute"}
        runtime.workers[(str(db.resolve()), "default", sid)].perm_event.set()
        assert _wait_terminal(client, f"/api/anti/sessions/{sid}/runs/{rid}")["status"] == "success"

        # Session lists accumulated grants and supports per-kind / full revoke
        listed = next(item for item in client.get("/api/anti/sessions").json() if item["id"] == sid)
        assert listed["profile_id"] is None
        assert listed["grants"] == ["edit", "execute"]
        assert listed["has_conversation"] is True

        revoked_one = client.delete(f"/api/anti/sessions/{sid}/grants?kind=edit")
        assert revoked_one.status_code == 200 and revoked_one.json()["grants"] == ["execute"]
        revoked_all = client.delete(f"/api/anti/sessions/{sid}/grants")
        assert revoked_all.status_code == 200 and revoked_all.json()["grants"] == []

        # Switch active account -> next run (/compact) resumes the exact same conversation ID!
        active_holder["pid"] = alt.id
        runtime.conv_map[alt.id] = "conv-default"
        assert client.post(f"/api/anti/sessions/{sid}/compact", json={}).status_code == 409
        runtime._commands.append({"name": "compact", "description": "压缩上下文", "hint": None})
        compact_resp = client.post(f"/api/anti/sessions/{sid}/compact", json={})
        assert compact_resp.status_code == 200
        compact_run = compact_resp.json()
        assert compact_run["prompt"] == "/compact"
        deadline = time.monotonic() + 2.0
        while (str(db.resolve()), alt.id, sid) not in runtime.workers and time.monotonic() < deadline:
            time.sleep(0.01)
        runtime.workers[(str(db.resolve()), alt.id, sid)].perm_event.set()
        assert _wait_terminal(client, f"/api/anti/sessions/{sid}/runs/{compact_run['id']}")["status"] == "success"
        assert runtime.calls[-1]["profile_id"] == alt.id
        assert runtime.calls[-1]["conversation"] == "conv-default"

        # Deleting legacy profile_conversations must NEVER delete sessions.conversation
        engine.AntiSessions(db, runtime).delete_profile_conversations(alt.id)
        assert engine.AntiSessions(db, runtime).session(sid)["conversation"] == "conv-default"

    # Legacy SQLite DB with NULL sessions.conversation + profile_conversations row backfills automatically
    leg_db = tmp_path / "legacy_backfill.sqlite"
    engine.AntiSessions(leg_db, runtime).list()
    with sqlite3.connect(leg_db) as conn, conn:
        conn.execute(
            "INSERT INTO sessions (id, project, workspace, title, conversation, updated_at, profile_id) VALUES (?,?,?,?,?,?,?)",
            ("s-backfill", "project", str(workspace), "Legacy", None, "2026-11-25T00:00:00Z", alt.id),
        )
        conn.execute(
            "INSERT INTO profile_conversations (session_id, profile_id, conversation) VALUES (?,?,?)",
            ("s-backfill", alt.id, "conv-from-alt"),
        )
    engine.AntiSessions._initialized_dbs.clear()
    backfilled = engine.AntiSessions(leg_db, runtime).session("s-backfill")
    assert backfilled["conversation"] == "conv-from-alt"


def test_models_config_sync_and_run_effective_model_persistence(tmp_path, monkeypatch):
    from contextlib import nullcontext
    from server.services import agy_models, agy_profile

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    data_dir = tmp_path / "data"
    monkeypatch.setattr(transfer._paths, "ADMIN_DATA", data_dir)
    monkeypatch.setattr(agy_profile._paths, "ADMIN_DATA", data_dir)
    agy_models.reset_cache()
    monkeypatch.setattr(engine, "project", lambda name: (workspace, tmp_path / "artifacts"))

    class ModelSyncRuntime(FakeRuntime):
        def models_catalog_info(self, profile_id=None, *, force_refresh=False, include_cloudcode=False):
            return {
                "items": [{"id": "gemini-4-hydrogen-high", "display_name": "Gemini 4 Hydrogen (High)"}],
                "synced_at": "2026-11-25T06:00:00+08:00",
                "next_sync_at": "2026-11-25T12:00:00+08:00",
                "stale": False,
                "default_model": "gemini-4-hydrogen-high",
                "default_effort": "high",
            }

        def sync_models(self, profile_id=None):
            return {
                "items": [
                    {"id": "gemini-4-hydrogen-high", "display_name": "Gemini 4 Hydrogen (High)"},
                    {"id": "gemini-pro-orchestrator-neon", "display_name": "Orchestrator (Neon)", "is_orchestrator": True},
                ],
                "synced_at": "2026-11-25T09:00:00+08:00",
                "next_sync_at": "2026-11-25T12:00:00+08:00",
                "stale": False,
                "default_model": "gemini-4-hydrogen-high",
                "default_effort": "high",
            }

    runtime = ModelSyncRuntime()

    def fallback_turn(**kwargs):
        return {
            "status": "success",
            "conversation_id": "conv-fb",
            "answer": "ok",
            "progress_messages": [],
            "effective_model": "gemini-4-hydrogen-high",
            "fallback_notice": "当前账号不支持模型「old-hybrid」，已自动回退至「gemini-4-hydrogen-high」执行",
            "usage": {"input_tokens": 10, "output_tokens": 5},
        }

    runtime.run_turn_hook = fallback_turn
    monkeypatch.setattr(FakeWorker, "run_turn", lambda self, **kw: runtime.run_turn_hook(**kw))

    db = tmp_path / "anti.sqlite"
    monkeypatch.setattr(anti, "AntiSessions", lambda: engine.AntiSessions(db, runtime))
    monkeypatch.setattr(anti.daemon, "submission", lambda profile_id=None: nullcontext(profile_id or "default"))

    app = FastAPI()
    app.include_router(anti.router)
    with TestClient(app) as client:
        assert client.post("/api/anti/models/sync").json()["items"][1]["is_orchestrator"] is True
        cfg = client.get("/api/anti/models/config").json()
        assert cfg["schedule_hours"] == [0, 6, 12, 18]
        assert cfg["allow_auto_fallback"] is True

        sid = client.post("/api/anti/sessions", json={"project": "project"}).json()["id"]
        run = client.post(
            f"/api/anti/sessions/{sid}/runs",
            json={"operation": "op-fb", "prompt": "hi", "model": "old-hybrid", "effort": "high"},
        ).json()
        done = _wait_terminal(client, f"/api/anti/sessions/{sid}/runs/{run['id']}")
        assert done["effective_model"] == "gemini-4-hydrogen-high"
        assert "old-hybrid" in (done.get("fallback_notice") or "")


def test_decode_run_repairs_legacy_exclusive_usage_json(tmp_path):
    import json
    import sqlite3

    db = tmp_path / "legacy_usage.sqlite"
    sessions = engine.AntiSessions(db)
    with sessions.connect() as db_conn, db_conn:
        db_conn.execute(
            "INSERT INTO sessions (id, project, workspace, title, updated_at) VALUES (?,?,?,?,?)",
            ("s-leg", "p", str(tmp_path), "Legacy", "2026-11-25T00:00:00Z"),
        )
        db_conn.execute(
            "INSERT INTO runs (id, session_id, operation, prompt, status, usage_json) VALUES (?,?,?,?,?,?)",
            (
                "r-leg",
                "s-leg",
                "op-leg",
                "hi",
                "success",
                json.dumps({
                    "input_tokens": 778_033,
                    "output_tokens": 90_537,
                    "cache_read_tokens": 4_683_759,
                    "thinking_tokens": 29_726,
                }),
            ),
        )
    row, = sessions.history("s-leg")
    assert row["usage"]["input_tokens"] == 5_461_792
    assert row["usage"]["cache_read_tokens"] == 4_683_759


def test_broken_thread_clears_conversation_and_injects_handoff(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    monkeypatch.setattr(transfer._paths, "ADMIN_DATA", tmp_path / "data")
    monkeypatch.setattr(engine, "project", lambda name: (workspace, tmp_path / "artifacts"))
    db = tmp_path / "anti_broken.sqlite"

    calls: list[dict] = []

    class BrokenThenFreshWorker:
        def __init__(self, runtime_ref):
            self.runtime_ref = runtime_ref

        def run_turn(self, **kwargs):
            calls.append(kwargs)
            idx = len(calls)
            if idx == 1:
                return {"status": "success", "conversation_id": "conv-old", "answer": "part 1", "usage": {}}
            if idx == 2:
                return {
                    "status": "cli_error",
                    "conversation_id": "conv-old",
                    "error": "signature broken",
                    "thread_broken": True,
                    "usage": {},
                }
            return {"status": "success", "conversation_id": "conv-new", "answer": "part 3", "usage": {}}

    class DummyRuntime(FakeRuntime):
        def get_worker(self, db_key, profile_id, session_id, workspace_path):
            return BrokenThenFreshWorker(self)

    runtime = DummyRuntime()
    monkeypatch.setattr(anti, "AntiSessions", lambda: engine.AntiSessions(db, runtime))
    monkeypatch.setattr(anti.daemon, "submission", lambda profile_id=None: __import__("contextlib").nullcontext(profile_id or "default"))

    app = FastAPI()
    app.include_router(anti.router)
    with TestClient(app) as client:
        sid = client.post("/api/anti/sessions", json={"project": "project"}).json()["id"]
        r1 = client.post(f"/api/anti/sessions/{sid}/runs", json={"operation": "op1", "prompt": "step 1"}).json()
        assert _wait_terminal(client, f"/api/anti/sessions/{sid}/runs/{r1['id']}")["status"] == "success"
        s_row1 = next(item for item in client.get("/api/anti/sessions").json() if item["id"] == sid)
        assert s_row1["has_conversation"] is True

        # Turn 2 fails with thread_broken=True -> conversation mapping is cleared automatically.
        r2 = client.post(f"/api/anti/sessions/{sid}/runs", json={"operation": "op2", "prompt": "step 2"}).json()
        done2 = _wait_terminal(client, f"/api/anti/sessions/{sid}/runs/{r2['id']}")
        assert done2["status"] == "cli_error"
        s_row2 = next(item for item in client.get("/api/anti/sessions").json() if item["id"] == sid)
        assert s_row2["has_conversation"] is False

        # Turn 3 starts fresh without broken conversation ID, carrying handoff summary from step 1.
        r3 = client.post(f"/api/anti/sessions/{sid}/runs", json={"operation": "op3", "prompt": "step 3"}).json()
        done3 = _wait_terminal(client, f"/api/anti/sessions/{sid}/runs/{r3['id']}")
        assert done3["status"] == "success"
        assert calls[2]["resume_conversation"] is None
        assert calls[2]["fallback_handoff_context"] and "step 1" in calls[2]["fallback_handoff_context"]



