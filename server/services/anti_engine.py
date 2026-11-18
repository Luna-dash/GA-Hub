"""Project-scoped AntiCLI integration; model discovery is read-only."""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import subprocess
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import requests

from .. import _paths
from ..process_utils import hidden_process_kwargs
from . import anti_component

ACTIVE = frozenset({"submitting", "queued", "running", "unknown"})
TERMINAL = frozenset({"success", "rejected", "timeout", "rate_limited", "cli_error", "cancelled"})
DEFAULT_MODEL = "gemini-4-hydrogen-high"
DEFAULT_EFFORT = "high"


class AntiError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status


def daemon_port() -> int:
    try:
        port = int(os.environ.get("GA_HUB_ANTICLI_PORT", "8787"))
        if not 1 <= port <= 65535:
            raise ValueError("port outside TCP range")
        return port
    except ValueError as exc:
        raise AntiError(503, "GA_HUB_ANTICLI_PORT must be between 1 and 65535") from exc


class AntiAdapter:
    def request(self, method: str, path: str, *, read_timeout: float = 8, **kwargs):
        port = daemon_port()
        try:
            with requests.Session() as client:
                client.trust_env = False  # only the official agy child uses the system proxy
                res = client.request(method, f"http://127.0.0.1:{port}{path}",
                                     timeout=(2, read_timeout), allow_redirects=False, **kwargs)
            if res.status_code != 200:
                raise AntiError(res.status_code, "AntiCLI did not accept the request")
            return res.json()
        except (requests.RequestException, ValueError) as exc:
            raise AntiError(503, "AntiCLI is unavailable or returned an invalid response") from exc

    def submit(self, run: dict, workspace: Path, conversation: str | None) -> None:
        self.request("POST", "/v1/runs?async_mode=true",
                     headers={"X-Anticli-Run-Id": run["id"]}, json={
                         "workspace": str(workspace), "caller_id": "ga-hub",
                         "prompt": run["prompt"], "mode": "plan",
                         "model": run["model"], "effort": run["effort"],
                         "disable_slash_commands": True, "conversation_id": conversation,
                     })


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


class AntiSessions:
    def __init__(self, db: Path | None = None, adapter: AntiAdapter | None = None):
        self.db = db or _paths.ADMIN_DATA / "anti_sessions.sqlite3"
        self.adapter = adapter or AntiAdapter()

    def connect(self):
        self.db.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self.db)
        conn.row_factory = sqlite3.Row
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY, project TEXT NOT NULL, workspace TEXT NOT NULL,
                title TEXT NOT NULL, conversation TEXT
            );
            CREATE TABLE IF NOT EXISTS runs (
                id TEXT PRIMARY KEY, session_id TEXT NOT NULL, operation TEXT NOT NULL,
                prompt TEXT NOT NULL, status TEXT NOT NULL, answer TEXT,
                artifact TEXT, sha256 TEXT, error TEXT, model TEXT, effort TEXT,
                UNIQUE(session_id, operation)
            );
        """)
        # Existing direct-chat databases predate per-run settings. Do not rewrite history.
        columns = {row[1] for row in conn.execute("PRAGMA table_info(runs)")}
        if not {"model", "effort"}.issubset(columns):
            with conn:
                conn.execute("BEGIN IMMEDIATE")
                columns = {row[1] for row in conn.execute("PRAGMA table_info(runs)")}
                for column in ("model", "effort"):
                    if column not in columns:
                        conn.execute(f"ALTER TABLE runs ADD COLUMN {column} TEXT")
        return closing(conn)

    def models(self) -> dict:
        try:
            upstream = self.adapter.request("GET", "/v1/models", read_timeout=23)
        except AntiError:
            # Browsing the official catalog must not start the AntiCLI daemon.
            executable = anti_component.executable()
            if not executable:
                raise AntiError(503, "此版本未附带 AntiCLI，请安装 anticli 并加入 PATH") from None
            try:
                result = subprocess.run(
                    [executable, "models", "--json"], stdin=subprocess.DEVNULL,
                    capture_output=True, encoding="utf-8", errors="replace",
                    timeout=24, check=True, **hidden_process_kwargs(),
                )
                upstream = json.loads(result.stdout)
            except (OSError, subprocess.SubprocessError, ValueError) as exc:
                raise AntiError(503, "读取 AntiCLI 模型目录失败，请检查 agy 安装和登录状态") from exc
        if not isinstance(upstream, list):
            raise AntiError(502, "Invalid AntiCLI model catalog")
        items = {}
        for row in upstream:
            if not isinstance(row, dict):
                continue
            model, label = row.get("id"), row.get("display_name")
            if isinstance(model, str) and model and isinstance(label, str):
                items[model] = {"id": model, "display_name": label or model}
        if not items:
            raise AntiError(502, "AntiCLI returned an empty model catalog")
        return {"items": list(items.values())}

    def list(self) -> list[dict]:
        with self.connect() as db:
            return [self.public_session(dict(row)) for row in db.execute("SELECT * FROM sessions ORDER BY rowid DESC")]

    @staticmethod
    def public_session(row: dict) -> dict:
                    **anti_component.child_options(executable),
        return {key: row[key] for key in ("id", "project", "title", "workspace")} | {"engine": "anti"}

    def create(self, name: str, title: str) -> dict:
        root, _ = project(name)
        sid = uuid4().hex
        with self.connect() as db, db:
            db.execute("INSERT INTO sessions VALUES (?, ?, ?, ?, NULL)", (sid, name, str(root), title))
        return self.public_session(self.session(sid))

    def session(self, sid: str) -> dict:
        with self.connect() as db:
            row = db.execute("SELECT * FROM sessions WHERE id=?", (sid,)).fetchone()
        if not row:
            raise AntiError(404, "Anti session not found")
        return dict(row)

    def history(self, sid: str) -> list[dict]:
        self.session(sid)
        with self.connect() as db:
            return [dict(row) for row in db.execute("SELECT * FROM runs WHERE session_id=? ORDER BY rowid", (sid,))]

    def submit(self, sid: str, operation: str, prompt: str,
               model: str = DEFAULT_MODEL, effort: str = DEFAULT_EFFORT) -> dict:
        session = self.session(sid)
        workspace, _ = self.bound_project(session)
        with self.connect() as db, db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM runs WHERE session_id=? AND operation=?", (sid, operation)).fetchone()
            if row:
                if (row["prompt"], row["model"] or DEFAULT_MODEL, row["effort"] or DEFAULT_EFFORT) != (prompt, model, effort):
                    raise AntiError(409, "Operation already exists with different input or settings")
                return dict(row)
            if any(r[0] in ACTIVE for r in db.execute("SELECT status FROM runs WHERE session_id=?", (sid,))):
                raise AntiError(409, "This Anti session already has an unresolved run")
            conversation = db.execute("SELECT conversation FROM sessions WHERE id=?", (sid,)).fetchone()[0]
            stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
            rid = f"run_{stamp}_{uuid4().hex}"
            db.execute("INSERT INTO runs (id,session_id,operation,prompt,status,model,effort) VALUES (?,?,?,?,?,?,?)",
                       (rid, sid, operation, prompt, "submitting", model, effort))
        run = self.run(sid, rid)
        try:
            self.adapter.submit(run, workspace, conversation)
        except AntiError as exc:
            # Never re-POST a run after ambiguous admission. Reconcile by the recorded ID.
            status = "rejected" if exc.status in (400, 422) else "unknown"
            self.set_status(rid, status, str(exc), only="submitting")
            return self.run(sid, rid)
        self.set_status(rid, "queued", None, only="submitting")
        return self.run(sid, rid)

    def bound_project(self, session: dict) -> tuple[Path, Path]:
        root, dest = project(session["project"])
        if str(root) != session["workspace"]:
            raise AntiError(409, "Project path changed; start a new Anti session")
        return root, dest

    def set_status(self, rid: str, status: str, error: str | None, *, only: str):
        with self.connect() as db, db:
            db.execute("UPDATE runs SET status=?,error=? WHERE id=? AND status=?", (status, error, rid, only))

    def run(self, sid: str, rid: str) -> dict:
        with self.connect() as db:
            row = db.execute("SELECT * FROM runs WHERE id=? AND session_id=?", (rid, sid)).fetchone()
        if not row:
            raise AntiError(404, "Anti run not found")
        return dict(row)

    def refresh(self, sid: str, rid: str) -> dict:
        run = self.run(sid, rid)
        if run["status"] not in ACTIVE:
            return run
        try:
            remote = self.adapter.request("GET", f"/v1/runs/{rid}")
        except AntiError as exc:
            if exc.status in (404, 503):
                return run | {"error": "Cannot confirm run state; no automatic retry"}
            raise
        status = remote.get("status")
        if status not in ACTIVE | TERMINAL:
            raise AntiError(502, "Unrecognized AntiCLI status")
        answer = artifact = digest = error = None
        if status == "success":
            answer = self.adapter.request("GET", f"/v1/runs/{rid}/answer")["answer"]
            _, dest = self.bound_project(self.session(sid))
            dest.mkdir(parents=True, exist_ok=True)
            target = dest / f"{rid}.md"
            temp = dest / f".{uuid4().hex}.tmp"
            data = answer.encode("utf-8")
            try:
                with temp.open("xb") as f:
                    f.write(data)
                temp.replace(target)
            finally:
                temp.unlink(missing_ok=True)
            artifact, digest = str(target), hashlib.sha256(data).hexdigest()
        if status in TERMINAL - {"success"}:
            error = remote.get("error_code") or status
        with self.connect() as db, db:
            marks = ",".join("?" for _ in ACTIVE)
            updated = db.execute(
                f"UPDATE runs SET status=?,answer=?,artifact=?,sha256=?,error=? WHERE id=? AND status IN ({marks})",
                (status, answer, artifact, digest, error, rid, *ACTIVE),
            )
            if updated.rowcount and status == "success" and remote.get("conversation_id"):
                db.execute("UPDATE sessions SET conversation=? WHERE id=?", (remote["conversation_id"], sid))
        return self.run(sid, rid)

    def events(self, sid: str, rid: str, after: int) -> list[dict]:
        self.run(sid, rid)
        try:
            rows = self.adapter.request("GET", f"/v1/runs/{rid}/events?include_raw=true")
        except AntiError as exc:
            if exc.status == 404:
                return []
            raise
        events = []
        for row in rows:
            if row["seq"] <= after or row.get("event_type") != "step_update":
                continue
            # Never return raw CLI output, tool arguments, or auth/debug context.
            step = json.loads(row.get("raw_json") or "{}").get("step_update") or {}
            delta = step.get("text_delta")
            if isinstance(delta, str) and delta:
                events.append({"seq": row["seq"], "type": "message.delta", "text": delta})
        return events

    def cancel(self, sid: str, rid: str) -> dict:
        run = self.run(sid, rid)
        if run["status"] in TERMINAL:
            return run
        response = self.adapter.request("POST", f"/v1/runs/{rid}/cancel")
        updated = self.refresh(sid, rid)
        if response.get("status") == "cancel_requested" and updated["status"] in ACTIVE:
            return updated | {"cancel_pending": True}
        return updated
