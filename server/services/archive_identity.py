"""Hub-owned identity metadata; native GA transcripts remain untouched.

A record is valid only while its recorded archive prefix remains unchanged.
Appending output does not change identity; truncation/rewrite invalidates it.
No prompt, response or tool content is persisted here.
"""
from __future__ import annotations

import hashlib
import json
import logging
import threading
import uuid
from pathlib import Path

log = logging.getLogger(__name__)
_lock = threading.RLock()


def _sidecar(path: Path) -> Path:
    return path.with_name(path.name + ".hub-identity.json")


def _digest(path: Path, size: int) -> str | None:
    digest = hashlib.sha256()
    remaining = size
    with path.open("rb") as stream:
        while remaining:
            chunk = stream.read(min(remaining, 1024 * 1024))
            if not chunk:
                return None
            digest.update(chunk)
            remaining -= len(chunk)
    return digest.hexdigest()


def _load(path: Path) -> dict:
    try:
        state = json.loads(_sidecar(path).read_text(encoding="utf-8"))
        if state.get("version") == 1 and isinstance(state.get("runs"), list):
            return state
    except (OSError, ValueError, TypeError):
        pass
    return {"version": 1, "generation": uuid.uuid4().hex, "runs": []}


def _valid(path: Path, record: dict) -> bool:
    try:
        size = record["prefix_size"]
        return isinstance(size, int) and size >= 0 and _digest(path, size) == record["prefix_hash"]
    except (OSError, KeyError, TypeError, ValueError):
        return False


def _save(path: Path, state: dict) -> None:
    target = _sidecar(path)
    temporary = target.with_name(target.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        temporary.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)


def begin_run(archive_path: str | Path, *, session_id: str, run_id: str,
              logical_id: str, stream_id: str, ordinal: int) -> None:
    path = Path(archive_path).resolve()
    with _lock:
        state = _load(path)
        valid = [record for record in state["runs"] if _valid(path, record)]
        if len(valid) != len(state["runs"]):
            state["generation"] = uuid.uuid4().hex
        state["runs"] = valid
        if any(record.get("run_id") == run_id for record in valid):
            return  # Automatic continuation belongs to the original logical run.
        size = path.stat().st_size
        for record in valid:
            if record.get("end") is None:
                record["end"] = ordinal
        state["runs"].append({
            "session_id": session_id, "run_id": run_id,
            "logical_id": logical_id, "stream_id": stream_id,
            "start": ordinal, "end": None, "outcome": None,
            "prefix_size": size, "prefix_hash": _digest(path, size),
        })
        _save(path, state)


def finish_run(archive_path: str | Path, run_id: str, *, ordinal: int,
               outcome: str | None) -> None:
    path = Path(archive_path).resolve()
    with _lock:
        state = _load(path)
        for record in state["runs"]:
            if record.get("run_id") == run_id and _valid(path, record):
                size = path.stat().st_size
                record.update(end=ordinal, outcome=outcome,
                              prefix_size=size, prefix_hash=_digest(path, size))
                _save(path, state)
                return


def project_identity(archive_path: str | Path | None, result: dict) -> dict:
    if not archive_path:
        return result
    path = Path(archive_path).resolve()
    with _lock:
        state = _load(path)
        valid = [record for record in state["runs"] if _valid(path, record)]
    if not valid:
        return result  # Legacy history: no inferred identity or terminal result.
    items = []
    for original in result["items"]:
        item = dict(original)
        for record in reversed(valid):
            end = record.get("end")
            if record["start"] <= item["ordinal"] and (end is None or item["ordinal"] < end):
                item.update(session_id=record["session_id"], run_id=record["run_id"],
                            logical_id=record["logical_id"], stream_id=record["stream_id"],
                            archive_generation=state["generation"], outcome=record.get("outcome"))
                break
        items.append(item)
    return {**result, "items": items}
