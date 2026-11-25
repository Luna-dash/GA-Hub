"""Project-scoped Antigravity (agy) session & run engine over unified ACP."""
from __future__ import annotations

import inspect
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
from . import agy_models, agy_profile
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
        self._ephemeral: dict[tuple[Path, str], list[tuple[int, dict[str, Any]]]] = {}
        self._next_seq: dict[tuple[Path, str], int] = {}

    def notify(self, key: tuple[Path, str], *, finished: bool = False, ephemeral: dict[str, Any] | None = None) -> None:
        with self._cond:
            if ephemeral is not None:
                seq = self._next_seq.get(key, 0) + 1
                self._next_seq[key] = seq
                self._ephemeral.setdefault(key, []).append((seq, ephemeral))
            if finished:
                self._ephemeral.pop(key, None)
                self._next_seq.pop(key, None)
            self._cond.notify_all()

    def ephemeral_after(self, key: tuple[Path, str], after_seq: int = 0) -> tuple[int, list[dict[str, Any]]]:
        with self._cond:
            entries = self._ephemeral.get(key, [])
            unseen = [payload for seq, payload in entries if seq > after_seq]
            latest = entries[-1][0] if entries else after_seq
            return max(after_seq, latest), unseen

    def has_ephemeral_after(self, key: tuple[Path, str], after_seq: int = 0) -> bool:
        with self._cond:
            entries = self._ephemeral.get(key, [])
            return bool(entries and entries[-1][0] > after_seq)

    def wait(self, key: tuple[Path, str], timeout: float = 0.8, *, after_eph_seq: int | None = None) -> None:
        with self._cond:
            has_unseen = (
                bool(self._ephemeral.get(key))
                if after_eph_seq is None
                else bool(self._ephemeral.get(key) and self._ephemeral[key][-1][0] > after_eph_seq)
            )
            if not has_unseen:
                # SQLite holds the terminal state. The timeout covers missed notifications.
                self._cond.wait(timeout)


_EVENT_BUS = _RunEventBus()


class AntiSessions:
    _local_runs: set[tuple[Path, str]] = set()
    _extra_staging_dirs: dict[tuple[Path, str], list[Path]] = {}
    _local_lock = threading.RLock()
    _schema_lock = threading.Lock()
    _initialized_dbs: dict[Path, int] = {}

    def __init__(self, db: Path | None = None, runtime: AgyRuntimeManager | None = None):
        self.db = db or (_paths.ADMIN_DATA / "anti_sessions.sqlite3")
        self.runtime = runtime or default_runtime
        self._db_key = self.db.resolve()
        self.ledger = AgyLedger(self.db)

    def _initialize_schema(self, conn: sqlite3.Connection) -> None:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY, project TEXT NOT NULL, workspace TEXT NOT NULL,
                title TEXT NOT NULL, conversation TEXT, updated_at TEXT, profile_id TEXT
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
                started_at TEXT, finished_at TEXT, progress_messages_json TEXT,
                effective_model TEXT, fallback_notice TEXT,
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
            "started_at", "finished_at", "progress_messages_json",
            "effective_model", "fallback_notice",
        )
        if not set(run_columns).issubset(columns):
            with conn:
                conn.execute("BEGIN IMMEDIATE")
                columns = {row[1] for row in conn.execute("PRAGMA table_info(runs)")}
                for column in run_columns:
                    if column not in columns:
                        conn.execute(f"ALTER TABLE runs ADD COLUMN {column} TEXT")
        session_columns = {row[1] for row in conn.execute("PRAGMA table_info(sessions)")}
        if "conversation" not in session_columns or "updated_at" not in session_columns or "profile_id" not in session_columns:
            with conn:
                conn.execute("BEGIN IMMEDIATE")
                session_columns = {row[1] for row in conn.execute("PRAGMA table_info(sessions)")}
                if "conversation" not in session_columns:
                    conn.execute("ALTER TABLE sessions ADD COLUMN conversation TEXT")
                if "profile_id" not in session_columns:
                    conn.execute("ALTER TABLE sessions ADD COLUMN profile_id TEXT")
                if "updated_at" not in session_columns:
                    conn.execute("ALTER TABLE sessions ADD COLUMN updated_at TEXT")
                    for sid, first_prompt in conn.execute("""
                        SELECT s.id, (SELECT r.prompt FROM runs r WHERE r.session_id=s.id ORDER BY r.rowid LIMIT 1)
                        FROM sessions s WHERE s.title='Anti'
                    """).fetchall():
                        conn.execute("UPDATE sessions SET title=? WHERE id=?", (_prompt_title(first_prompt or ""), sid))
        self.ledger.ensure_schema(conn)
        missing_convs = conn.execute(
            "SELECT id, profile_id FROM sessions "
            "WHERE (conversation IS NULL OR conversation='') "
            "AND EXISTS(SELECT 1 FROM profile_conversations pc WHERE pc.session_id=sessions.id)"
        ).fetchall()
        if missing_convs:
            with conn:
                for row in missing_convs:
                    s_id, s_pid = row[0], row[1]
                    conv_val = None
                    if isinstance(s_pid, str) and s_pid.strip():
                        found = conn.execute(
                            "SELECT conversation FROM profile_conversations WHERE session_id=? AND profile_id=?",
                            (s_id, s_pid.strip()),
                        ).fetchone()
                        if found and found[0]:
                            conv_val = found[0]
                    if not conv_val:
                        found = conn.execute(
                            "SELECT pc.conversation FROM runs ru "
                            "JOIN profile_conversations pc ON pc.session_id=ru.session_id AND pc.profile_id=ru.profile_id "
                            "WHERE ru.session_id=? ORDER BY ru.rowid DESC LIMIT 1",
                            (s_id,),
                        ).fetchone()
                        if found and found[0]:
                            conv_val = found[0]
                    if not conv_val:
                        found = conn.execute(
                            "SELECT conversation FROM profile_conversations WHERE session_id=? ORDER BY rowid DESC LIMIT 1",
                            (s_id,),
                        ).fetchone()
                        if found and found[0]:
                            conv_val = found[0]
                    if conv_val:
                        conn.execute("UPDATE sessions SET conversation=? WHERE id=?", (conv_val, s_id))

    def connect(self):
        self.db.parent.mkdir(parents=True, exist_ok=True)
        existed = self.db.exists()
        ctime = self.db.stat().st_ctime_ns if existed else None
        conn = sqlite3.connect(self.db, timeout=15.0)
        conn.row_factory = sqlite3.Row
        if not existed or self._initialized_dbs.get(self._db_key) != ctime:
            with self._schema_lock:
                self._initialize_schema(conn)
                try:
                    new_ctime = self.db.stat().st_ctime_ns
                    self._initialized_dbs[self._db_key] = new_ctime
                    AgyLedger._initialized_dbs[self._db_key] = new_ctime
                except OSError:
                    pass
        else:
            conn.execute("PRAGMA synchronous=NORMAL")
        return closing(conn)

    @staticmethod
    def _validate_optional_profile(profile_id: str | None) -> str | None:
        if profile_id is None:
            return None
        cleaned = profile_id.strip()
        if not cleaned:
            return None
        _, profiles = agy_profile.snapshot()
        if not any(p.id == cleaned for p in profiles):
            raise AntiError(404, "找不到指定的 Agy 账号")
        return cleaned

    def models(self, allow_fallback: bool = True, profile_id: str | None = None, *, force_refresh: bool = False) -> dict:  # noqa: ARG002
        pid = self._validate_optional_profile(profile_id)
        info_fn = getattr(self.runtime, "models_catalog_info", None)
        if callable(info_fn):
            return info_fn(profile_id=pid, force_refresh=force_refresh)
        if pid is not None:
            try:
                return {"items": self.runtime.models(profile_id=pid)}
            except TypeError:
                pass
        return {"items": self.runtime.models()}

    def sync_models(self, profile_id: str | None = None) -> dict:
        pid = self._validate_optional_profile(profile_id)
        sync_fn = getattr(self.runtime, "sync_models", None)
        if callable(sync_fn):
            return sync_fn(profile_id=pid)
        return self.models(profile_id=pid, force_refresh=True)

    def commands(self, profile_id: str | None = None) -> dict:
        pid = self._validate_optional_profile(profile_id)
        fn = getattr(self.runtime, "commands", None)
        if not callable(fn):
            return {"items": []}
        if pid is not None:
            try:
                return {"items": fn(profile_id=pid)}
            except TypeError:
                pass
        return {"items": fn()}

    def _enrich_session(self, item: dict) -> dict:
        fn = getattr(self.runtime, "session_connected", None)
        item["acp_connected"] = bool(fn(str(self._db_key), item["id"])) if callable(fn) else False
        item["profile_id"] = None
        grants_fn = getattr(self.runtime, "session_grants", None)
        item["grants"] = list(grants_fn(str(self._db_key), item["id"])) if callable(grants_fn) else []
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
            SELECT s.id, s.project, s.title, s.workspace, s.updated_at, NULL AS profile_id,
                (s.conversation IS NOT NULL AND s.conversation != '') AS has_conversation,
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
                return self._enrich_session(self._public_sessions(db, sid)[0])

    def rename(self, sid: str, title: str) -> dict:
        with self.connect() as db, db:
            if not db.execute("UPDATE sessions SET title=? WHERE id=?", (title, sid)).rowcount:
                raise AntiError(404, "Anti session not found")
            return self._enrich_session(self._public_sessions(db, sid)[0])

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
        forget_fn = getattr(self.runtime, "forget_session_grants", None)
        if callable(forget_fn):
            forget_fn(str(self._db_key), sid)
        self.runtime.close_session(str(self._db_key), sid)

    def _close_session_runtime(self, sid: str, *, force: bool = False) -> None:
        if force:
            try:
                self.runtime.close_session(str(self._db_key), sid, force=True)
            except TypeError:
                self.runtime.close_session(str(self._db_key), sid)
        else:
            self.runtime.close_session(str(self._db_key), sid)

    def reset_runtime(self, sid: str, *, force: bool = False) -> dict:
        """Close the live ACP child process for this session while keeping conversation resume ID."""
        self.session(sid)
        placeholders = ",".join("?" * len(ACTIVE))
        with self.connect() as db:
            active_ids = [
                row[0]
                for row in db.execute(
                    f"SELECT id FROM runs WHERE session_id=? AND status IN ({placeholders})",
                    (sid, *ACTIVE),
                )
            ]
        if active_ids:
            if not force:
                raise AntiError(409, "当前有正在运行的任务，请先停止后再重连会话。")
            for rid in active_ids:
                self.cancel(sid, rid, force=True)
        self._close_session_runtime(sid, force=force)
        with self.connect() as db:
            return self._enrich_session(self._public_sessions(db, sid)[0])

    def delete_profile_conversations(self, profile_id: str) -> None:
        with self.connect() as db, db:
            db.execute("DELETE FROM profile_conversations WHERE profile_id=?", (profile_id,))
            db.execute("UPDATE sessions SET profile_id=NULL WHERE profile_id=?", (profile_id,))

    def resolve_session_profile(self, sid: str, explicit_profile_id: str | None = None) -> str:  # noqa: ARG002
        self.session(sid)
        return agy_profile.snapshot()[0]

    def clear_session_grants(self, sid: str, kind: str | None = None) -> dict:
        self.session(sid)
        clear_fn = getattr(self.runtime, "clear_session_grants", None)
        if callable(clear_fn):
            clear_fn(str(self._db_key), sid, kind)
        with self.connect() as db:
            return self._enrich_session(self._public_sessions(db, sid)[0])

    def compact(
        self,
        sid: str,
        *,
        profile_id: str = "default",
        model: str | None = None,
        effort: str | None = None,
        mode: str = "plan",
        permission_mode: str | None = None,
    ) -> dict:
        def_model, def_effort = agy_models.default_model_and_effort()
        resolved_model = model or def_model
        resolved_effort = effort or def_effort
        self.session(sid)
        with self.connect() as db:
            row = self._public_sessions(db, sid)[0]
        if not row.get("has_conversation"):
            raise AntiError(409, "当前会话尚无多轮上下文，无需压缩。")
        has_cached_fn = getattr(self.runtime, "has_cached_commands", None)
        if callable(has_cached_fn) and has_cached_fn(profile_id):
            cmds = {str(c.get("name") or "") for c in self.commands(profile_id=profile_id).get("items", [])}
            if "compact" not in cmds:
                raise AntiError(409, "当前 Agy 会话未宣告支持 /compact 上下文压缩命令。")
        return self.submit(
            sid,
            f"compact_{uuid4().hex[:12]}",
            "/compact",
            resolved_model,
            resolved_effort,
            [],
            profile_id,
            [],
            mode,
            permission_mode,
        )

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
                parsed_usage = json.loads(raw_usage)
                if isinstance(parsed_usage, dict):
                    raw_in = max(0, int(parsed_usage.get("input_tokens") or 0))
                    cr = max(0, int(parsed_usage.get("cache_read_tokens") or 0))
                    cw = max(0, int(parsed_usage.get("cache_write_tokens") or 0))
                    if (cr + cw) > raw_in:
                        parsed_usage["input_tokens"] = raw_in + cr + cw
                    item["usage"] = parsed_usage
                else:
                    item["usage"] = None
            except ValueError:
                item["usage"] = None
        raw_progress = item.get("progress_messages_json")
        if raw_progress:
            try:
                parsed_progress = json.loads(raw_progress)
                item["progress_messages"] = (
                    [str(entry) for entry in parsed_progress if isinstance(entry, str) and entry.strip()]
                    if isinstance(parsed_progress, list)
                    else []
                )
            except ValueError:
                item["progress_messages"] = []
        else:
            item["progress_messages"] = []
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

    @staticmethod
    def _build_handoff_summary(
        db: sqlite3.Connection,
        sid: str,
        *,
        max_turns: int = 6,
        max_chars: int = 4000,
    ) -> str | None:
        rows = db.execute(
            "SELECT prompt, answer FROM runs WHERE session_id=? AND status='success' ORDER BY rowid DESC LIMIT ?",
            (sid, max_turns),
        ).fetchall()
        if not rows:
            return None
        ordered = list(reversed(rows))
        lines = [
            "[前文对话交接摘要]",
            "（以下为本会话先前已完成轮次的摘要，供你无缝续接上下文）",
        ]
        used = sum(len(x) + 1 for x in lines)
        for idx, row in enumerate(ordered, 1):
            p_raw = " ".join(str(row[0] or "").split())
            a_raw = " ".join(str(row[1] or "").split())
            if len(p_raw) > 240:
                p_raw = p_raw[:237] + "..."
            if len(a_raw) > 420:
                a_raw = a_raw[:417] + "..."
            block = f"{idx}. 用户: {p_raw or '（附件/指令）'}\n   助手: {a_raw or '（无文本回复）'}"
            if used + len(block) + 1 > max_chars and idx > 1:
                break
            lines.append(block)
            used += len(block) + 1
        return "\n".join(lines) if len(lines) > 2 else None

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
        fallback_handoff_context: str | None = None,
    ) -> None:
        key = (self._db_key, rid)
        add_dirs = tuple(str(d) for d in staging_dirs)
        # Never expose the shared admin_uploads_dir() across sessions: all external
        # and managed_upload inputs are already copied into per-run staging_dirs.
        allowed_roots = [workspace, *staging_dirs]

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
            turn_kwargs: dict[str, Any] = {
                "run_id": rid,
                "prompt_text": prompt_text,
                "model": model,
                "effort": effort,
                "mode": mode,
                "permission_mode": permission_mode,
                "resume_conversation": conversation,
                "add_dirs": add_dirs,
                "staged_paths": staged,
                "attachments": attachments,
                "allowed_roots": allowed_roots,
                "on_event": on_event,
            }
            if fallback_handoff_context is not None:
                try:
                    params = inspect.signature(worker.run_turn).parameters
                    if "fallback_handoff_context" in params or any(
                        p.kind == inspect.Parameter.VAR_KEYWORD for p in params.values()
                    ):
                        turn_kwargs["fallback_handoff_context"] = fallback_handoff_context
                except (ValueError, TypeError):
                    pass
            result = worker.run_turn(**turn_kwargs)
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
            with self._local_lock:
                extra_dirs = self._extra_staging_dirs.pop(key, [])
            for directory in [*staging_dirs, *extra_dirs]:
                shutil.rmtree(directory, ignore_errors=True)

        status = result.get("status", "cli_error")
        answer = result.get("answer")
        error = result.get("error")
        conv_id = result.get("conversation_id")
        thread_broken = bool(result.get("thread_broken"))
        reset_seconds = result.get("reset_seconds")
        usage = result.get("usage") or {}
        usage_json = json.dumps(usage, ensure_ascii=False) if usage else None
        progress_messages = [
            str(m).strip()
            for m in (result.get("progress_messages") or [])
            if isinstance(m, str) and m.strip()
        ]
        progress_messages_json = json.dumps(progress_messages, ensure_ascii=False) if progress_messages else None
        effective_model = result.get("effective_model") or model
        fallback_notice = result.get("fallback_notice")
        error_detail = None
        if not result.get("auth_transient") and isinstance(error, str) and ("login" in error.lower() or "auth" in error.lower()):
            error_detail = "请先在顶部账号管理完成官方 Agy 登录后再试。"

        try:
            with self.connect() as db, db:
                if thread_broken:
                    db.execute("UPDATE sessions SET conversation=NULL WHERE id=?", (sid,))
                    db.execute(
                        "DELETE FROM profile_conversations WHERE session_id=? AND profile_id=?",
                        (sid, profile_id),
                    )
                elif isinstance(conv_id, str) and conv_id:
                    db.execute("UPDATE sessions SET conversation=? WHERE id=?", (conv_id, sid))
                    db.execute(
                        "INSERT INTO profile_conversations (session_id,profile_id,conversation) VALUES (?,?,?) "
                        "ON CONFLICT(session_id,profile_id) DO UPDATE SET conversation=excluded.conversation",
                        (sid, profile_id, conv_id),
                    )
                db.execute(
                    "UPDATE runs SET status=?, answer=?, error=?, error_detail=?, usage_json=?, finished_at=?, progress_messages_json=?, effective_model=?, fallback_notice=? WHERE id=? "
                    "AND status IN ('submitting','queued','running','unknown')",
                    (
                        status, answer, error, error_detail, usage_json, _now(),
                        progress_messages_json, effective_model, fallback_notice, rid,
                    ),
                )
        finally:
            with self._local_lock:
                self._local_runs.discard(key)
            _EVENT_BUS.notify(key, finished=True)

        if status == "rate_limited" and isinstance(reset_seconds, (int, float)) and reset_seconds > 0:
            cooldown = max(60, min(int(reset_seconds), 3600))
        else:
            cooldown = 60 if status == "rate_limited" else 0
        self.ledger.record_run(
            rid,
            effective_model,
            status,
            profile_id=profile_id,
            input_tokens=int(usage.get("input_tokens") or 0),
            output_tokens=int(usage.get("output_tokens") or 0),
            cache_read_tokens=int(usage.get("cache_read_tokens") or 0),
            cache_write_tokens=int(usage.get("cache_write_tokens") or 0),
            thinking_tokens=int(usage.get("thinking_tokens") or 0),
            model_calls=int(usage.get("model_calls") or 0),
            generation_ms=int(usage.get("generation_ms") or 0),
            cooldown_seconds=cooldown,
        )

    def submit(
        self,
        sid: str,
        operation: str,
        prompt: str,
        model: str | None = None,
        effort: str | None = None,
        references: list[tuple[int, str]] | None = None,
        profile_id: str = "default",
        attachments: list[dict] | None = None,
        mode: str = "plan",
        permission_mode: str | None = None,
    ) -> dict:
        if mode not in {"plan", "accept-edits"}:
            raise AntiError(422, "不支持的 Anti 运行模式")
        def_model, def_effort = agy_models.default_model_and_effort()
        model = model or def_model
        effort = effort or def_effort
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
        staged_attachments: list[dict] = []

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
                    staged, staging_dirs, staged_attachments = prepare_inputs(references, attachments, workspace_dir, staging)
                except ReferenceError as exc:
                    raise AntiError(422, str(exc)) from exc

                cli_prompt = self._build_cli_prompt(prompt, staged_attachments, staged, workspace_dir)
                conversation = session.get("conversation")
                if not conversation:
                    conv_row = db.execute(
                        "SELECT conversation FROM profile_conversations WHERE session_id=? ORDER BY rowid DESC LIMIT 1",
                        (sid,),
                    ).fetchone()
                    conversation = conv_row[0] if conv_row else None
                handoff_summary = self._build_handoff_summary(db, sid)
                if isinstance(conversation, str) and conversation:
                    try:
                        agy_profile.rescue_conversation_files(conversation)
                    except Exception:
                        log.debug("Could not rescue conversation files for %s", conversation, exc_info=True)

                now = _now()
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
                    "started_at": now,
                    "finished_at": None,
                }
                db.execute(
                    """
                    INSERT INTO runs
                    (id,session_id,operation,prompt,status,model,effort,references_json,profile_id,attachments_json,mode,permission_mode,started_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                    """,
                    (rid, sid, operation, prompt, "running", model, effort, refs_json, profile_id, attachments_json, mode, resolved_permission, now),
                )
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
                    "attachments": staged_attachments,
                    "fallback_handoff_context": handoff_summary,
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
                "UPDATE runs SET status=?, error=?, finished_at=? WHERE id=? AND status IN ('submitting','queued','running','unknown')",
                ("cli_error", "原 Agy 会话已断开，可继续发送消息自动恢复上下文", _now(), rid),
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

    def poll_stream_step(
        self, sid: str, rid: str, cursor: int = 0, eph_cursor: int = 0,
    ) -> tuple[int, int, list[str], bool]:
        key = (self._db_key, rid)
        batch = self.events(sid, rid, after=cursor)
        chunks: list[str] = []
        for evt in batch:
            cursor = max(cursor, int(evt["seq"]))
            chunks.append(self._sse(evt))
        eph_cursor, ephemerals = _EVENT_BUS.ephemeral_after(key, eph_cursor)
        for eph in ephemerals:
            chunks.append(self._sse(eph))
        current = self.run(sid, rid)
        done = current["status"] in TERMINAL
        if done:
            tail = self.events(sid, rid, after=cursor)
            for evt in tail:
                cursor = max(cursor, int(evt["seq"]))
                chunks.append(self._sse(evt))
        return cursor, eph_cursor, chunks, done

    def stream_events(self, sid: str, rid: str):
        key = (self._db_key, rid)
        cursor, eph_cursor, chunks, done = self.poll_stream_step(sid, rid, 0, 0)
        for chunk in chunks:
            yield chunk
        if done:
            return
        while True:
            _EVENT_BUS.wait(key, timeout=0.6, after_eph_seq=eph_cursor)
            cursor, eph_cursor, chunks, done = self.poll_stream_step(sid, rid, cursor, eph_cursor)
            for chunk in chunks:
                yield chunk
            if done:
                return

    def workers(self) -> list[dict[str, Any]]:
        list_fn = getattr(self.runtime, "list_workers", None)
        raw = list_fn(str(self._db_key)) if callable(list_fn) else []
        if not raw:
            return []
        _, profiles = agy_profile.snapshot()
        profile_names = {p.id: p.name for p in profiles}
        sids = {str(item["session_id"]) for item in raw if item.get("session_id")}
        sessions_meta: dict[str, tuple[str, str]] = {}
        if sids:
            placeholders = ",".join("?" * len(sids))
            with self.connect() as db:
                for row in db.execute(
                    f"SELECT id, project, title FROM sessions WHERE id IN ({placeholders})",
                    tuple(sids),
                ):
                    sessions_meta[row["id"]] = (row["project"], row["title"])
        enriched: list[dict[str, Any]] = []
        for item in raw:
            sid = str(item.get("session_id") or "")
            pid = str(item.get("profile_id") or "default")
            proj, title = sessions_meta.get(sid, ("", ""))
            enriched.append({
                **item,
                "project": proj,
                "session_title": title,
                "profile_name": profile_names.get(pid, pid),
            })
        return enriched

    def steer(
        self,
        sid: str,
        rid: str,
        prompt: str,
        references: list[tuple[int, str]] | None = None,
        attachments: list[dict] | None = None,
    ) -> dict:
        session = self.session(sid)
        run = self.run(sid, rid)
        if run["status"] not in ACTIVE:
            raise AntiError(409, "当前任务已结束，请直接发送新消息。")
        workspace_dir = Path(session["workspace"])
        if not workspace_dir.is_dir():
            raise AntiError(409, "Project directory is unavailable")
        _, artifacts = project(session["project"])
        references = references or []
        attachments = attachments or []
        staging = artifacts / "references" / f"{rid}_steer_{uuid4().hex[:8]}"
        try:
            staged, staging_dirs, staged_attachments = prepare_inputs(references, attachments, workspace_dir, staging)
        except ReferenceError as exc:
            raise AntiError(422, str(exc)) from exc
        cli_prompt = self._build_cli_prompt(prompt, staged_attachments, staged, workspace_dir)
        steer_fn = getattr(self.runtime, "steer_turn", None)
        if not callable(steer_fn):
            for directory in staging_dirs:
                shutil.rmtree(directory, ignore_errors=True)
            raise AntiError(409, "当前运行时不支持运行中插话纠偏。")
        try:
            steer_fn(
                self._db_key,
                rid,
                prompt_text=cli_prompt,
                staged_paths=staged,
                attachments=staged_attachments,
                allowed_roots=[workspace_dir, *staging_dirs],
            )
        except Exception:
            for directory in staging_dirs:
                shutil.rmtree(directory, ignore_errors=True)
            raise
        if staging_dirs:
            key = (self._db_key, rid)
            with self._local_lock:
                if key in self._local_runs:
                    self._extra_staging_dirs.setdefault(key, []).extend(staging_dirs)
        return self.refresh(sid, rid)

    def _force_finalize_cancelled(self, rid: str, reason: str = "已强制终止任务") -> None:
        key = (self._db_key, rid)
        with self._local_lock:
            self._local_runs.discard(key)
        with self.connect() as db, db:
            db.execute(
                "UPDATE runs SET status=?, error=?, finished_at=? WHERE id=? "
                "AND status IN ('submitting','queued','running','unknown')",
                ("cancelled", reason, _now(), rid),
            )
        _EVENT_BUS.notify(key, finished=True)

    def force_cancel_all_active(self) -> int:
        placeholders = ",".join("?" * len(ACTIVE))
        with self.connect() as db:
            rows = db.execute(
                f"SELECT session_id, id FROM runs WHERE status IN ({placeholders})",
                tuple(ACTIVE),
            ).fetchall()
        count = 0
        for sid, rid in rows:
            self.cancel(sid, rid, force=True)
            count += 1
        return count

    def cancel(self, sid: str, rid: str, *, force: bool = False) -> dict:
        run = self.run(sid, rid)
        if run["status"] in TERMINAL:
            return run
        deadline = time.monotonic() + (5.0 if force else 3.0)
        sent = False
        while True:
            current = self.run(sid, rid)
            if current["status"] in TERMINAL:
                return current
            if not sent:
                if force:
                    try:
                        sent = self.runtime.cancel_turn(self._db_key, rid, force=True)
                    except TypeError:
                        sent = self.runtime.cancel_turn(self._db_key, rid)
                        self._close_session_runtime(sid, force=True)
                    if not sent:
                        with self._local_lock:
                            alive = (self._db_key, rid) in self._local_runs
                        if not alive:
                            self._close_session_runtime(sid, force=True)
                            self._force_finalize_cancelled(rid)
                            return self.run(sid, rid)
                else:
                    sent = self.runtime.cancel_turn(self._db_key, rid)
            if time.monotonic() >= deadline:
                if force:
                    self._close_session_runtime(sid, force=True)
                    self._force_finalize_cancelled(rid)
                    return self.run(sid, rid)
                # A live worker still owns the turn until it commits the result.
                return self.refresh(sid, rid)
            time.sleep(0.05)
