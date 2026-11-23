"""Project-scoped Antigravity (agy) session & run engine over unified ACP."""
from __future__ import annotations

import json
import logging
import re
import shutil
import sqlite3
import threading
import time
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from .. import _paths
from . import agy_profile
from .agy_profile import AgyProfileError as AntiError
from .agy_protocol import PERMISSION_MODES, default_permission_mode
from .agy_runtime import AgyRuntimeManager, runtime as default_runtime
from .agy_usage import AgyLedger
from .anti_references import ReferenceError, prepare_inputs

log = logging.getLogger(__name__)

ACTIVE = frozenset({"submitting", "queued", "running", "unknown"})
TERMINAL = frozenset({"success", "rejected", "timeout", "rate_limited", "cli_error", "cancelled"})
DEFAULT_MODEL = "gemini-4-hydrogen-high"
DEFAULT_EFFORT = "high"
EFFORT_VARIANTS = frozenset({"low", "medium", "high", "xhigh", "max"})


def project(name: str) -> tuple[Path, Path]:
    from frontends.gahub.bridge import workspace

    if not name or Path(name).name != name or name in {".", ".."} or not _paths.GA_ROOT:
        raise AntiError(404, "Registered project not found")
    item = workspace.get_workspace(name)
    if not item or not item.get("path"):
        raise AntiError(404, "Registered project not found")
    root = Path(item["path"]).resolve()
    if not root.is_dir():
        raise AntiError(409, "Project directory is unavailable")
    base = _paths.ga_layout_path("temp") / "project_artifacts"
    dest = base / name / "anti"
    if base.resolve() != base or dest.resolve() != dest:
        raise AntiError(409, "Project artifact directory must not redirect")
    return root, dest


def _prompt_title(prompt: str) -> str:
    text = " ".join(prompt.split())
    return text if len(text) <= 40 else text[:39].rstrip() + "…"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class _RunEventBus:
    """In-memory condition bus for low-latency SSE streaming of active runs."""

    def __init__(self) -> None:
        self._cond = threading.Condition()
        self._ephemeral: dict[tuple[Path, str], list[dict[str, Any]]] = {}

    def notify(self, key: tuple[Path, str], *, finished: bool = False, ephemeral: dict[str, Any] | None = None) -> None:
        with self._cond:
            if ephemeral is not None:
                self._ephemeral.setdefault(key, []).append(ephemeral)
            if finished:
                self._ephemeral.pop(key, None)
            self._cond.notify_all()

    def pop_ephemeral(self, key: tuple[Path, str]) -> list[dict[str, Any]]:
        with self._cond:
            return self._ephemeral.pop(key, [])

    def wait(self, key: tuple[Path, str], timeout: float = 0.8) -> None:
        with self._cond:
            if not self._ephemeral.get(key):
                # SQLite holds the terminal state. The timeout covers missed notifications.
                self._cond.wait(timeout)


_EVENT_BUS = _RunEventBus()


class AntiSessions:
    _local_runs: set[tuple[Path, str]] = set()
    _local_lock = threading.RLock()

    def __init__(self, db: Path | None = None, runtime: AgyRuntimeManager | None = None):
        self.db = db or (_paths.ADMIN_DATA / "anti_sessions.sqlite3")
        self.runtime = runtime or default_runtime
        self._db_key = self.db.resolve()
        self.ledger = AgyLedger(self.db)

    def connect(self):
        self.db.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self.db, timeout=15.0)
        conn.row_factory = sqlite3.Row
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY, project TEXT NOT NULL, workspace TEXT NOT NULL,
                title TEXT NOT NULL, conversation TEXT, updated_at TEXT
            );
            CREATE TABLE IF NOT EXISTS profile_conversations (
                session_id TEXT NOT NULL, profile_id TEXT NOT NULL, conversation TEXT NOT NULL,
                PRIMARY KEY(session_id, profile_id)
            );
            CREATE TABLE IF NOT EXISTS runs (
                id TEXT PRIMARY KEY, session_id TEXT NOT NULL, operation TEXT NOT NULL,
                prompt TEXT NOT NULL, status TEXT NOT NULL, answer TEXT,
                artifact TEXT, sha256 TEXT, error TEXT, model TEXT, effort TEXT,
                references_json TEXT, error_detail TEXT, profile_id TEXT,
                attachments_json TEXT, mode TEXT, permission_mode TEXT, usage_json TEXT,
                UNIQUE(session_id, operation)
            );
            CREATE TABLE IF NOT EXISTS run_events (
                run_id TEXT NOT NULL,
                seq INTEGER NOT NULL,
                payload_json TEXT NOT NULL,
                PRIMARY KEY(run_id, seq)
            );
        """)
        columns = {row[1] for row in conn.execute("PRAGMA table_info(runs)")}
        run_columns = (
            "model", "effort", "references_json", "error_detail",
            "profile_id", "attachments_json", "mode", "permission_mode", "usage_json",
        )
        if not set(run_columns).issubset(columns):
            with conn:
                conn.execute("BEGIN IMMEDIATE")
                columns = {row[1] for row in conn.execute("PRAGMA table_info(runs)")}
                for column in run_columns:
                    if column not in columns:
                        conn.execute(f"ALTER TABLE runs ADD COLUMN {column} TEXT")
        session_columns = {row[1] for row in conn.execute("PRAGMA table_info(sessions)")}
        if "conversation" not in session_columns or "updated_at" not in session_columns:
            with conn:
                conn.execute("BEGIN IMMEDIATE")
                session_columns = {row[1] for row in conn.execute("PRAGMA table_info(sessions)")}
                if "conversation" not in session_columns:
                    conn.execute("ALTER TABLE sessions ADD COLUMN conversation TEXT")
                if "updated_at" not in session_columns:
                    conn.execute("ALTER TABLE sessions ADD COLUMN updated_at TEXT")
                    for sid, first_prompt in conn.execute("""
                        SELECT s.id, (SELECT r.prompt FROM runs r WHERE r.session_id=s.id ORDER BY r.rowid LIMIT 1)
                        FROM sessions s WHERE s.title='Anti'
                    """).fetchall():
                        conn.execute("UPDATE sessions SET title=? WHERE id=?", (_prompt_title(first_prompt or ""), sid))
        self.ledger.ensure_schema(conn)
        return closing(conn)

    def models(self, allow_fallback: bool = True) -> dict:  # noqa: ARG002
        return {"items": self.runtime.models()}

    def commands(self) -> dict:
        fn = getattr(self.runtime, "commands", None)
        return {"items": fn() if callable(fn) else []}

    def _enrich_session(self, item: dict) -> dict:
        fn = getattr(self.runtime, "session_connected", None)
        item["acp_connected"] = bool(fn(str(self._db_key), item["id"])) if callable(fn) else False
        return item

    def list(self) -> list[dict]:
        with self.connect() as db:
            return [self._enrich_session(item) for item in self._public_sessions(db)]

    @staticmethod
    def _public_sessions(db: sqlite3.Connection, sid: str | None = None) -> list[dict]:
        statuses = tuple(sorted(ACTIVE))
        placeholders = ",".join("?" for _ in statuses)
        where = "WHERE s.id=?" if sid is not None else ""
        params = (*statuses, sid) if sid is not None else statuses
        rows = db.execute(f"""
            SELECT s.id, s.project, s.title, s.workspace, s.updated_at,
                (s.conversation IS NOT NULL OR EXISTS(
                    SELECT 1 FROM profile_conversations pc WHERE pc.session_id=s.id
                )) AS has_conversation,
                (SELECT r.id FROM runs r WHERE r.session_id=s.id
                 AND r.status IN ({placeholders}) ORDER BY r.rowid DESC LIMIT 1) AS active_run_id
            FROM sessions s {where} ORDER BY s.rowid DESC
        """, params)
        out = []
        for row in rows:
            item = dict(row) | {"engine": "anti"}
            item["has_conversation"] = bool(item.get("has_conversation"))
            out.append(item)
        return out

    def create(self, name: str, title: str | None = None) -> dict:
        root, _ = project(name)
        sid = uuid4().hex
        with self._local_lock:
            with self.connect() as db, db:
                db.execute(
                    "INSERT INTO sessions (id,project,workspace,title,updated_at) VALUES (?,?,?,?,?)",
                    (sid, name, str(root), title or "", _now()),
                )
                return self._public_sessions(db, sid)[0]

    def rename(self, sid: str, title: str) -> dict:
        with self.connect() as db, db:
            if not db.execute("UPDATE sessions SET title=? WHERE id=?", (title, sid)).rowcount:
                raise AntiError(404, "Anti session not found")
            return self._public_sessions(db, sid)[0]

    def delete(self, sid: str) -> None:
        with self.connect() as db, db:
            db.execute("BEGIN IMMEDIATE")
            if any(row[0] in ACTIVE for row in db.execute("SELECT status FROM runs WHERE session_id=?", (sid,))):
                raise AntiError(409, "请先结束这条 Anti 会话中尚未完成的运行，再删除会话。")
            if not db.execute("DELETE FROM sessions WHERE id=?", (sid,)).rowcount:
                raise AntiError(404, "Anti session not found")
            db.execute("DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE session_id=?)", (sid,))
            db.execute("DELETE FROM profile_conversations WHERE session_id=?", (sid,))
            db.execute("DELETE FROM runs WHERE session_id=?", (sid,))
        self.runtime.close_session(str(self._db_key), sid)

    def reset_runtime(self, sid: str) -> dict:
        """Close the live ACP child process for this session while keeping conversation resume ID."""
        self.session(sid)
        with self.connect() as db:
            if any(row[0] in ACTIVE for row in db.execute("SELECT status FROM runs WHERE session_id=?", (sid,))):
                raise AntiError(409, "当前有正在运行的任务，请先停止后再重连会话。")
        self.runtime.close_session(str(self._db_key), sid)
        with self.connect() as db:
            return self._enrich_session(self._public_sessions(db, sid)[0])

    def delete_profile_conversations(self, profile_id: str) -> None:
        with self.connect() as db, db:
            db.execute("DELETE FROM profile_conversations WHERE profile_id=?", (profile_id,))

    def session(self, sid: str) -> dict:
        with self.connect() as db:
            row = db.execute("SELECT * FROM sessions WHERE id=?", (sid,)).fetchone()
        if not row:
            raise AntiError(404, "Anti session not found")
        return dict(row)

    @staticmethod
    def _decode_run(row: sqlite3.Row) -> dict:
        item = dict(row)
        raw_attachments = item.get("attachments_json")
        if raw_attachments:
            try:
                parsed = json.loads(raw_attachments)
                item["attachments"] = parsed if isinstance(parsed, list) else []
            except ValueError:
                item["attachments"] = []
        else:
            item["attachments"] = []
        raw_usage = item.get("usage_json")
        if raw_usage:
            try:
                item["usage"] = json.loads(raw_usage)
            except ValueError:
                item["usage"] = None
        if not item.get("mode"):
            item["mode"] = "plan"
        if not item.get("permission_mode"):
            item["permission_mode"] = default_permission_mode(item["mode"], None)
        return item

    def history(self, sid: str) -> list[dict]:
        self.session(sid)
        with self.connect() as db:
            runs = [self._decode_run(row) for row in db.execute("SELECT * FROM runs WHERE session_id=? ORDER BY rowid", (sid,))]
        for run in runs:
            if run["status"] in ACTIVE:
                approval = self.runtime.active_turn_approval(self._db_key, run["id"])
                if approval:
                    run["approval"] = approval
        return runs

    @staticmethod
    def _build_cli_prompt(prompt: str, attachments: list[dict], staged: list[Path], workspace: Path) -> str:
        sections: list[str] = []
        if attachments:
            att_lines: list[str] = []
            for item in attachments:
                path = item.get("path", "")
                name = item.get("name") or Path(path).name
                if path:
                    att_lines.append(f"- {name}: `{Path(path).as_posix()}`")
            if att_lines:
                sections.append("用户附加了以下文件，请先查看：\n" + "\n".join(att_lines))
        if staged:
            ref_lines = [f"- `{p.as_posix()}`" for p in staged]
            sections.append("用户引用了以下文件：\n" + "\n".join(ref_lines))
        if prompt:
            sections.append(prompt)
        return "\n\n".join(sections)

    def _run_background(
        self,
        *,
        sid: str,
        rid: str,
        workspace: Path,
        profile_id: str,
        conversation: str | None,
        prompt_text: str,
        model: str,
        effort: str,
        mode: str,
        permission_mode: str,
        staged: list[Path],
        staging_dirs: list[Path],
        attachments: list[dict],
    ) -> None:
        key = (self._db_key, rid)
        add_dirs = tuple(str(d) for d in staging_dirs)
        allowed_roots = [workspace, *staging_dirs, _paths.admin_uploads_dir()]

        # submit() has initialized the schema; reuse one connection for the turn.
        # ACP callbacks can arrive on either the reader or the turn thread.
        event_lock = threading.Lock()
        events_db: sqlite3.Connection | None = None
        events_closed = False
        write_failure_logged = False

        def on_event(evt: dict[str, Any]) -> None:
            nonlocal events_db, write_failure_logged
            with event_lock:
                if events_closed:
                    return
                etype = evt.get("type")
                if etype in ("message.delta", "step.update") and isinstance(evt.get("seq"), int) and evt["seq"] > 0:
                    try:
                        if events_db is None:
                            events_db = sqlite3.connect(self.db, timeout=15.0, check_same_thread=False)
                        with events_db:
                            events_db.execute(
                                "INSERT OR REPLACE INTO run_events (run_id, seq, payload_json) VALUES (?,?,?)",
                                (rid, evt["seq"], json.dumps(evt, ensure_ascii=False)),
                            )
                    except (OSError, sqlite3.Error):
                        if not write_failure_logged:
                            log.warning("Could not persist an Agy stream event for run %s", rid, exc_info=True)
                            write_failure_logged = True
                _EVENT_BUS.notify(key, ephemeral=evt if etype == "approval.requested" else None)

        result: dict[str, Any] = {}
        registered = False
        try:
            worker = self.runtime.get_worker(str(self._db_key), profile_id, sid, workspace)
            self.runtime.register_turn(self._db_key, rid, worker)
            registered = True
            result = worker.run_turn(
                run_id=rid,
                prompt_text=prompt_text,
                model=model,
                effort=effort,
                mode=mode,
                permission_mode=permission_mode,
                resume_conversation=conversation,
                add_dirs=add_dirs,
                staged_paths=staged,
                attachments=attachments,
                allowed_roots=allowed_roots,
                on_event=on_event,
            )
        except AntiError as exc:
            result = {"status": "cli_error", "error": str(exc), "usage": {}}
        except Exception as exc:
            log.exception("Unexpected Agy ACP run failure")
            result = {"status": "cli_error", "error": f"Agy 运行异常: {exc}", "usage": {}}
        finally:
            with event_lock:
                events_closed = True
                if events_db is not None:
                    try:
                        events_db.close()
                    except sqlite3.Error:
                        log.warning("Could not close the Agy event writer for run %s", rid, exc_info=True)
            if registered:
                self.runtime.unregister_turn(self._db_key, rid)
            for directory in staging_dirs:
                shutil.rmtree(directory, ignore_errors=True)

        status = result.get("status", "cli_error")
        answer = result.get("answer")
        error = result.get("error")
        conv_id = result.get("conversation_id")
        usage = result.get("usage") or {}
        usage_json = json.dumps(usage, ensure_ascii=False) if usage else None
        error_detail = None
        if isinstance(error, str) and ("login" in error.lower() or "auth" in error.lower()):
            error_detail = "请先在顶部账号管理完成官方 Agy 登录后再试。"

        try:
            with self.connect() as db, db:
                if isinstance(conv_id, str) and conv_id:
                    db.execute(
                        "INSERT INTO profile_conversations (session_id,profile_id,conversation) VALUES (?,?,?) "
                        "ON CONFLICT(session_id,profile_id) DO UPDATE SET conversation=excluded.conversation",
                        (sid, profile_id, conv_id),
                    )
                    if profile_id == agy_profile.DEFAULT:
                        db.execute("UPDATE sessions SET conversation=? WHERE id=?", (conv_id, sid))
                db.execute(
                    "UPDATE runs SET status=?, answer=?, error=?, error_detail=?, usage_json=? WHERE id=? "
                    "AND status IN ('submitting','queued','running','unknown')",
                    (status, answer, error, error_detail, usage_json, rid),
                )
        finally:
            with self._local_lock:
                self._local_runs.discard(key)
            _EVENT_BUS.notify(key, finished=True)

        cooldown = 60 if status == "rate_limited" else 0
        self.ledger.record_run(
            rid,
            model,
            status,
            profile_id=profile_id,
            input_tokens=int(usage.get("input_tokens") or 0),
            output_tokens=int(usage.get("output_tokens") or 0),
            cache_read_tokens=int(usage.get("cache_read_tokens") or 0),
            thinking_tokens=int(usage.get("thinking_tokens") or 0),
            cooldown_seconds=cooldown,
        )

    def submit(
        self,
        sid: str,
        operation: str,
        prompt: str,
        model: str = DEFAULT_MODEL,
        effort: str = DEFAULT_EFFORT,
        references: list[tuple[int, str]] | None = None,
        profile_id: str = "default",
        attachments: list[dict] | None = None,
        mode: str = "plan",
        permission_mode: str | None = None,
    ) -> dict:
        if mode not in {"plan", "accept-edits"}:
            raise AntiError(422, "不支持的 Anti 运行模式")
        resolved_permission = default_permission_mode(mode, permission_mode)
        if resolved_permission not in PERMISSION_MODES:
            raise AntiError(422, "不支持的权限策略")
        references = references or []
        attachments = attachments or []
        normalized_refs = [[file_id, path] for file_id, path in references]
        refs_json = json.dumps(normalized_refs, ensure_ascii=False)
        attachments_json = json.dumps(attachments, ensure_ascii=False)
        session = self.session(sid)
        workspace_dir = Path(session["workspace"])
        if not workspace_dir.is_dir():
            raise AntiError(409, "Project directory is unavailable")
        _, artifacts = project(session["project"])
        staged: list[Path] = []
        staging_dirs: list[Path] = []

        with self._local_lock:
            with self.connect() as db, db:
                db.execute("BEGIN IMMEDIATE")
                existing = db.execute("SELECT * FROM runs WHERE session_id=? AND operation=?", (sid, operation)).fetchone()
                if existing is not None:
                    decoded = self._decode_run(existing)
                    if (
                        decoded["prompt"] != prompt
                        or (decoded["model"] or DEFAULT_MODEL) != model
                        or (decoded["effort"] or DEFAULT_EFFORT) != effort
                        or (decoded.get("references_json") or "[]") != refs_json
                        or (decoded.get("attachments_json") or "[]") != attachments_json
                        or (decoded.get("mode") or "plan") != mode
                        or (decoded.get("permission_mode") or default_permission_mode(mode, None)) != resolved_permission
                    ):
                        raise AntiError(409, "Operation already exists with different parameters")
                    return decoded
                if any(row[0] in ACTIVE for row in db.execute("SELECT status FROM runs WHERE session_id=?", (sid,))):
                    raise AntiError(409, "Another Anti run is already active for this session")
                allowed, blocked_reason = self.ledger.check_run_allowed(model, profile_id=profile_id, conn=db)
                if not allowed:
                    raise AntiError(429, blocked_reason or "当前账号处于风控冷却中，请稍后重试。")

                rid = f"run_{datetime.now(timezone.utc):%Y%m%d_%H%M%S}_{uuid4().hex}"
                staging = artifacts / "references" / rid
                try:
                    staged, staging_dirs = prepare_inputs(references, attachments, workspace_dir, staging)
                except ReferenceError as exc:
                    raise AntiError(422, str(exc)) from exc

                cli_prompt = self._build_cli_prompt(prompt, attachments, staged, workspace_dir)
                conv_row = db.execute(
                    "SELECT conversation FROM profile_conversations WHERE session_id=? AND profile_id=?",
                    (sid, profile_id),
                ).fetchone()
                conversation = conv_row[0] if conv_row else (session["conversation"] if profile_id == "default" else None)

                run = {
                    "id": rid,
                    "session_id": sid,
                    "operation": operation,
                    "prompt": prompt,
                    "status": "running",
                    "answer": None,
                    "artifact": None,
                    "sha256": None,
                    "error": None,
                    "model": model,
                    "effort": effort,
                    "references_json": refs_json,
                    "error_detail": None,
                    "profile_id": profile_id,
                    "attachments_json": attachments_json,
                    "mode": mode,
                    "permission_mode": resolved_permission,
                }
                db.execute(
                    """
                    INSERT INTO runs
                    (id,session_id,operation,prompt,status,model,effort,references_json,profile_id,attachments_json,mode,permission_mode)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                    """,
                    (rid, sid, operation, prompt, "running", model, effort, refs_json, profile_id, attachments_json, mode, resolved_permission),
                )
                now = _now()
                if not session["title"]:
                    title_source = prompt or (attachments[0].get("name") if attachments else "") or "附件消息"
                    db.execute("UPDATE sessions SET title=?, updated_at=? WHERE id=?", (_prompt_title(title_source), now, sid))
                else:
                    db.execute("UPDATE sessions SET updated_at=? WHERE id=?", (now, sid))

            self._local_runs.add((self._db_key, rid))
            threading.Thread(
                target=self._run_background,
                kwargs={
                    "sid": sid,
                    "rid": rid,
                    "workspace": workspace_dir,
                    "profile_id": profile_id,
                    "conversation": conversation,
                    "prompt_text": cli_prompt,
                    "model": model,
                    "effort": effort,
                    "mode": mode,
                    "permission_mode": resolved_permission,
                    "staged": staged,
                    "staging_dirs": staging_dirs,
                    "attachments": attachments,
                },
                daemon=True,
            ).start()
            return self._decode_run(self._raw_run(sid, rid))

    def _raw_run(self, sid: str, rid: str) -> sqlite3.Row:
        self.session(sid)
        with self.connect() as db:
            row = db.execute("SELECT * FROM runs WHERE session_id=? AND id=?", (sid, rid)).fetchone()
        if not row:
            raise AntiError(404, "Anti run not found")
        return row

    def run(self, sid: str, rid: str) -> dict:
        return self._decode_run(self._raw_run(sid, rid))

    def edit_count(self) -> int:
        with self._local_lock:
            return len(self._local_runs)

    def approve(self, sid: str, rid: str, approval_id: str, decision: str, option_id: str | None = None) -> dict:
        run = self.run(sid, rid)
        if run["status"] not in ACTIVE:
            raise AntiError(409, "当前运行已经结束，无法再提交审批")
        if not self.runtime.approve_turn(self._db_key, rid, approval_id, decision, option_id=option_id):
            raise AntiError(409, "该审批请求已过期或已完成")
        return self.refresh(sid, rid)

    def refresh(self, sid: str, rid: str) -> dict:
        run = self.run(sid, rid)
        if run["status"] not in ACTIVE:
            return run
        approval = self.runtime.active_turn_approval(self._db_key, rid)
        if approval is not None:
            run["approval"] = approval
            return run
        with self._local_lock:
            alive = (self._db_key, rid) in self._local_runs
        if alive:
            return run
        with self.connect() as db, db:
            db.execute(
                "UPDATE runs SET status=?, error=? WHERE id=? AND status IN ('submitting','queued','running','unknown')",
                ("cli_error", "原 Agy 会话已断开，可继续发送消息自动恢复上下文", rid),
            )
        return self.run(sid, rid)

    def events(self, sid: str, rid: str, after: int = 0) -> list[dict]:
        self.run(sid, rid)
        with self.connect() as db:
            rows = db.execute(
                "SELECT payload_json FROM run_events WHERE run_id=? AND seq>? ORDER BY seq",
                (rid, after),
            ).fetchall()
        out: list[dict] = []
        for row in rows:
            try:
                parsed = json.loads(row[0])
                if isinstance(parsed, dict):
                    out.append(parsed)
            except ValueError:
                continue
        return out

    @staticmethod
    def _sse(event: dict) -> str:
        return f"event: {event['type']}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"

    def stream_events(self, sid: str, rid: str):
        run = self.run(sid, rid)
        cursor = 0
        key = (self._db_key, rid)

        def _flush():
            nonlocal cursor
            batch = self.events(sid, rid, after=cursor)
            chunks = []
            for evt in batch:
                cursor = max(cursor, int(evt["seq"]))
                chunks.append(self._sse(evt))
            for eph in _EVENT_BUS.pop_ephemeral(key):
                chunks.append(self._sse(eph))
            return chunks

        for chunk in _flush():
            yield chunk

        if run["status"] in TERMINAL:
            return

        while True:
            _EVENT_BUS.wait(key, timeout=0.6)
            for chunk in _flush():
                yield chunk
            current = self.run(sid, rid)
            if current["status"] in TERMINAL:
                for chunk in _flush():
                    yield chunk
                return

    def cancel(self, sid: str, rid: str) -> dict:
        run = self.run(sid, rid)
        if run["status"] in TERMINAL:
            return run
        deadline = time.monotonic() + 3.0
        sent = False
        while True:
            current = self.run(sid, rid)
            if current["status"] in TERMINAL:
                return current
            if not sent:
                sent = self.runtime.cancel_turn(self._db_key, rid)
            if time.monotonic() >= deadline:
                # A live worker still owns the turn until it commits the result.
                return self.refresh(sid, rid)
            time.sleep(0.05)
