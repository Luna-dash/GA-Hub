"""Run-level theme task metrics; conversation archives remain the source of history."""
from __future__ import annotations

import json
import logging
from functools import wraps
import os
import threading
import time
from pathlib import Path
from uuid import uuid4
from .. import _paths

_lock = threading.RLock()


def _path() -> Path:
    return _paths.ADMIN_DATA / "session_metadata" / "theme_runs.json"


def _read() -> dict:
    p = _path()
    return json.loads(p.read_text("utf-8")) if p.exists() else {}


def _write(rows: dict) -> None:
    p = _path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(f".{uuid4().hex}.tmp")
    try:
        tmp.write_text(json.dumps(rows, ensure_ascii=False), "utf-8")
        os.replace(tmp, p)
    finally:
        tmp.unlink(missing_ok=True)


def _best_effort(fn):
    @wraps(fn)
    def call(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except Exception:
            logging.getLogger(__name__).exception("Theme statistics failed: %s", fn.__name__)
            return None
    return call


@_best_effort
def begin(session_id: str, run_id: str, model_key: str | None) -> None:
    with _lock:
        rows = _read()
        rows[session_id] = {"session_id": session_id, "run_id": run_id,
                            "started_at": time.time(), "finished_at": None,
                            "turns": 0, "turn_ids": [], "model_key": model_key,
                            "model_name": model_key, "outcome": None, "report": ""}
        _write(rows)


@_best_effort
def model_snapshot(session_id: str, run_id: str, name: str) -> None:
    with _lock:
        rows = _read()
        row = rows.get(session_id)
        if row and row["run_id"] == run_id:
            row["model_name"] = name
            _write(rows)


@_best_effort
def turn(session_id: str, run_id: str, stream_id: str, number: object) -> None:
    with _lock:
        rows = _read()
        row = rows.get(session_id)
        if not row or row["run_id"] != run_id or row["finished_at"]:
            return
        identity = f"{stream_id}:{number}"
        if identity not in row["turn_ids"]:
            row["turn_ids"].append(identity)
            row["turns"] = len(row["turn_ids"])
            _write(rows)


@_best_effort
def finish(session_id: str, run_id: str, outcome: str, report: str = "") -> None:
    with _lock:
        rows = _read()
        row = rows.get(session_id)
        if row and row["run_id"] == run_id:
            row.update(finished_at=time.time(), outcome=outcome, report=report)
            _write(rows)


def get(session_id: str, active_run_id: str | None = None) -> dict | None:
    with _lock:
        row = _read().get(session_id)
        if row and not row["finished_at"] and active_run_id != row["run_id"]:
            # A restart cannot prove a pending run succeeded.
            row = {**row, "outcome": "interrupted", "interrupted": True}
        if row:
            row.pop("turn_ids", None)
        return row
