"""Hub-owned identity metadata; native GA transcripts remain untouched.

A record is valid only while its recorded archive prefix remains unchanged.
Appending output does not change identity; truncation/rewrite invalidates it.
No prompt, response or tool content is persisted here.
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
import uuid
from functools import lru_cache
from pathlib import Path

_lock = threading.RLock()


def _sidecar(path: Path) -> Path:
    return path.with_name(path.name + ".hub-identity.json")


def _signature(stat: os.stat_result) -> tuple[int, ...]:
    return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns


@lru_cache(maxsize=32)
def _prefix_hashes(path: Path, signature: tuple[int, ...],
                   sizes: tuple[int, ...]) -> dict[int, str]:
    """Validate all recorded prefixes in a single pass over this file version."""
    digest = hashlib.sha256()
    hashes = {}
    offset = 0
    with path.open("rb") as stream:
        before = _signature(os.fstat(stream.fileno()))
        # Windows path.stat() and fstat() can report different timestamps.
        if before[2] != signature[2] or _signature(path.stat()) != signature:
            raise OSError("archive changed before identity validation")
        for size in sizes:
            while offset < size:
                chunk = stream.read(min(size - offset, 1024 * 1024))
                if not chunk:
                    raise OSError("archive truncated during identity validation")
                digest.update(chunk)
                offset += len(chunk)
            hashes[size] = digest.hexdigest()
        if _signature(os.fstat(stream.fileno())) != before or _signature(path.stat()) != signature:
            raise OSError("archive changed during identity validation")
    return hashes


def _validate(path: Path, records: list[dict], *, include_current: bool = False
              ) -> tuple[list[dict], int, str | None]:
    # Sidecar metadata is re-read on every call; cache only archive byte hashes.
    signature = _signature(path.stat())
    size = signature[2]
    prefixes = {record.get("prefix_size") for record in records
                if type(record.get("prefix_size")) is int and 0 <= record["prefix_size"] <= size}
    if include_current:
        prefixes.add(size)
    hashes = _prefix_hashes(path, signature, tuple(sorted(prefixes))) if prefixes else {}
    valid = [record for record in records
             if type(record.get("prefix_size")) is int and record["prefix_size"] in hashes
             and hashes[record["prefix_size"]] == record.get("prefix_hash")]
    return valid, size, hashes.get(size)


def _load(path: Path) -> dict:
    try:
        state = json.loads(_sidecar(path).read_text(encoding="utf-8"))
        if state.get("version") == 1 and isinstance(state.get("runs"), list):
            return state
    except (OSError, ValueError, TypeError):
        pass
    return {"version": 1, "generation": uuid.uuid4().hex, "runs": []}


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
        valid, size, digest = _validate(path, state["runs"], include_current=True)
        if len(valid) != len(state["runs"]):
            state["generation"] = uuid.uuid4().hex
        state["runs"] = valid
        if any(record.get("run_id") == run_id for record in valid):
            return  # Automatic continuation belongs to the original logical run.
        for record in valid:
            if record.get("end") is None:
                record["end"] = ordinal
        state["runs"].append({
            "session_id": session_id, "run_id": run_id,
            "logical_id": logical_id, "stream_id": stream_id,
            "start": ordinal, "end": None, "outcome": None,
            "prefix_size": size, "prefix_hash": digest,
        })
        _save(path, state)


def finish_run(archive_path: str | Path, run_id: str, *, ordinal: int,
               outcome: str | None) -> None:
    path = Path(archive_path).resolve()
    with _lock:
        state = _load(path)
        matching = [record for record in state["runs"] if record.get("run_id") == run_id]
        if not matching:
            return
        valid, size, digest = _validate(path, matching, include_current=True)
        if valid:
            valid[0].update(end=ordinal, outcome=outcome, prefix_size=size, prefix_hash=digest)
            _save(path, state)


def project_identity(archive_path: str | Path | None, result: dict) -> dict:
    if not archive_path or not result["items"]:
        return result
    path = Path(archive_path).resolve()
    with _lock:
        state = _load(path)
        if not state["runs"]:
            return result
        try:
            valid, _, _ = _validate(path, state["runs"])
        except OSError:
            return result  # A changing or inaccessible archive has no trusted identity.
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
