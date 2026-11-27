"""Tiered storage scanner, garbage collector, and retention policy for Agy archives.

Protects essential live session state (active root conversation DBs, user-facing
brain artifacts, compact transcript.jsonl, inbox messages, subagent manifests,
and GA-Hub SQLite chat history/ledger) while automatically or manually reclaiming
secondary, duplicate, and orphaned data across four tiers:

- L0 (orphan & expired logs): conversation trees already deleted from GA-Hub
  (plus immediate delete hook & deferred retry queue), expired CLI logs, crashes.
- L1 (redundant copies in idle live roots): duplicate ``tasks/`` logs, streaming
  ``logs/chunks/``, ``logs/transcript_full.jsonl``, aged/oversized ``steps/``,
  and aged ``scratch/`` directories.
- L2 (finished subagent children): ``killed`` or idle/reported child conversations
  past their grace period.
- L3 (cold root demotion & DB compaction, opt-in/caution): demotes very old idle
  root sessions by removing native Agy DBs while keeping GA-Hub chat history and
  top-level artifacts (next turn resumes via GA-Hub handoff summary), prunes old
  terminal ``run_events``, and checkpoints/vacuums ``anti_sessions.sqlite3``.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
import json
import logging
import os
from pathlib import Path
import re
import shutil
import sqlite3
from tempfile import NamedTemporaryFile
import threading
import time
from typing import Any, Iterable

from .. import _paths
from . import agy_profile

log = logging.getLogger(__name__)

_NATIVE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_ACTIVE_RUN_STATUSES = frozenset({"submitting", "queued", "running", "unknown"})
_ORPHAN_MTIME_SAFETY_SECONDS = 600.0  # 10 min race guard for brand-new first-turn DBs

DEFAULT_POLICY: dict[str, Any] = {
    "auto_enabled": True,
    "interval_hours": 24,
    "l0_orphans_enabled": True,
    "l0_log_retention_days": 7,
    "l1_redundant_enabled": True,
    "l1_grace_hours": 6,
    "l1_steps_retention_days": 3,
    "l1_steps_max_file_mb": 5,
    "l1_scratch_retention_days": 7,
    "l2_subagents_enabled": True,
    "l2_killed_grace_hours": 24,
    "l2_idle_retention_days": 7,
    "l2_keep_artifacts": True,
    "l3_cold_roots_enabled": False,
    "l3_cold_root_days": 30,
    "l3_run_events_retention_days": 30,
}

_INT_BOUNDS: dict[str, tuple[int, int]] = {
    "interval_hours": (1, 168),
    "l0_log_retention_days": (1, 365),
    "l1_grace_hours": (0, 720),
    "l1_steps_retention_days": (0, 365),
    "l1_steps_max_file_mb": (1, 1024),
    "l1_scratch_retention_days": (0, 365),
    "l2_killed_grace_hours": (0, 720),
    "l2_idle_retention_days": (1, 365),
    "l3_cold_root_days": (7, 3650),
    "l3_run_events_retention_days": (7, 3650),
}

_BOOL_KEYS = frozenset({
    "auto_enabled",
    "l0_orphans_enabled",
    "l1_redundant_enabled",
    "l2_subagents_enabled",
    "l2_keep_artifacts",
    "l3_cold_roots_enabled",
})

_policy_lock = threading.RLock()
_gc_exec_lock = threading.Lock()


def _policy_path() -> Path:
    return _paths.ADMIN_DATA / "agy_gc_policy.json"


def _state_path() -> Path:
    return _paths.ADMIN_DATA / "agy_gc_state.json"


def _hub_db_path(db_path: Path | None = None) -> Path:
    return db_path if db_path is not None else (_paths.ADMIN_DATA / "anti_sessions.sqlite3")


def _workspace_cli_dir(cli_dir: Path | None = None) -> Path:
    if cli_dir is not None:
        return cli_dir
    return agy_profile.workspace_app_data_dir()


def _now_utc(now: datetime | None = None) -> datetime:
    if now is None:
        return datetime.now(timezone.utc)
    return now.astimezone(timezone.utc) if now.tzinfo else now.replace(tzinfo=timezone.utc)


def _parse_iso(raw: str | None) -> datetime | None:
    if not raw or not isinstance(raw, str):
        return None
    text = raw.strip()
    if not text:
        return None
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
        return dt.astimezone(timezone.utc) if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    stage: Path | None = None
    try:
        with NamedTemporaryFile(mode="wb", dir=path.parent, delete=False) as fp:
            stage = Path(fp.name)
            fp.write(data)
        stage.replace(path)
        stage = None
    finally:
        if stage is not None:
            stage.unlink(missing_ok=True)


def normalize_policy(raw: dict[str, Any] | None) -> dict[str, Any]:
    out = dict(DEFAULT_POLICY)
    if not isinstance(raw, dict):
        return out
    for key in _BOOL_KEYS:
        if key in raw and isinstance(raw[key], bool):
            out[key] = raw[key]
    for key, (lo, hi) in _INT_BOUNDS.items():
        val = raw.get(key)
        if isinstance(val, int) and not isinstance(val, bool):
            out[key] = max(lo, min(hi, val))
    return out


def load_policy() -> dict[str, Any]:
    with _policy_lock:
        path = _policy_path()
        try:
            if path.is_file() and not path.is_symlink():
                return normalize_policy(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            log.debug("Failed reading agy GC policy; using defaults", exc_info=True)
        return dict(DEFAULT_POLICY)


def save_policy(patch: dict[str, Any]) -> dict[str, Any]:
    with _policy_lock:
        current = load_policy()
        merged = dict(current)
        for key, val in (patch or {}).items():
            if val is None:
                continue
            if key in _BOOL_KEYS and isinstance(val, bool):
                merged[key] = val
            elif key in _INT_BOUNDS and isinstance(val, int) and not isinstance(val, bool):
                lo, hi = _INT_BOUNDS[key]
                merged[key] = max(lo, min(hi, val))
        normalized = normalize_policy(merged)
        _atomic_write_json(_policy_path(), normalized)
        return normalized


def _load_state() -> dict[str, Any]:
    with _policy_lock:
        path = _state_path()
        try:
            if path.is_file() and not path.is_symlink():
                raw = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    return raw
        except (OSError, ValueError):
            pass
        return {}


def _save_state(updater: dict[str, Any]) -> dict[str, Any]:
    with _policy_lock:
        state = _load_state()
        state.update(updater)
        try:
            _atomic_write_json(_state_path(), state)
        except OSError:
            log.debug("Could not persist agy GC state", exc_info=True)
        return state


def get_policy_status() -> dict[str, Any]:
    policy = load_policy()
    state = _load_state()
    pending = state.get("pending_delete_cids")
    pending_count = len(pending) if isinstance(pending, list) else 0
    return {
        "policy": policy,
        "last_run_at": state.get("last_run_at"),
        "last_reclaimed_bytes": int(state.get("last_reclaimed_bytes") or 0),
        "last_removed_entries": int(state.get("last_removed_entries") or 0),
        "last_error": state.get("last_error"),
        "pending_delete_count": pending_count,
    }


def _record_pending_deletes(cids: Iterable[str]) -> None:
    clean = [c for c in cids if isinstance(c, str) and _NATIVE_ID_RE.fullmatch(c)]
    if not clean:
        return
    with _policy_lock:
        state = _load_state()
        existing = [c for c in (state.get("pending_delete_cids") or []) if isinstance(c, str)]
        merged = list(dict.fromkeys([*existing, *clean]))
        state["pending_delete_cids"] = merged
        try:
            _atomic_write_json(_state_path(), state)
        except OSError:
            pass


def _clear_pending_deletes(cleared: set[str]) -> None:
    if not cleared:
        return
    with _policy_lock:
        state = _load_state()
        existing = [c for c in (state.get("pending_delete_cids") or []) if isinstance(c, str)]
        remaining = [c for c in existing if c not in cleared]
        if len(remaining) != len(existing):
            state["pending_delete_cids"] = remaining
            try:
                _atomic_write_json(_state_path(), state)
            except OSError:
                pass


def _is_within(root: Path, candidate: Path) -> bool:
    try:
        if candidate.is_symlink():
            return False
        resolved_root = root.resolve()
        resolved_cand = candidate.resolve()
        return resolved_cand == resolved_root or resolved_root in resolved_cand.parents
    except OSError:
        return False


def _path_stats(path: Path) -> tuple[int, int]:
    if not path.exists() or path.is_symlink():
        return 0, 0
    if path.is_file():
        try:
            return path.stat().st_size, 1
        except OSError:
            return 0, 0
    total_bytes = 0
    total_files = 0
    for dirpath, dirnames, filenames in os.walk(path, followlinks=False):
        dirnames[:] = [d for d in dirnames if not (Path(dirpath) / d).is_symlink()]
        for fname in filenames:
            fp = Path(dirpath) / fname
            if fp.is_symlink():
                continue
            try:
                total_bytes += fp.stat().st_size
                total_files += 1
            except OSError:
                pass
    return total_bytes, total_files


def _latest_mtime(path: Path) -> float:
    try:
        latest = path.stat().st_mtime
    except OSError:
        return 0.0
    if path.is_dir() and not path.is_symlink():
        for dirpath, dirnames, filenames in os.walk(path, followlinks=False):
            dirnames[:] = [d for d in dirnames if not (Path(dirpath) / d).is_symlink()]
            for fname in filenames:
                fp = Path(dirpath) / fname
                try:
                    st = fp.stat()
                    if st.st_mtime > latest:
                        latest = st.st_mtime
                except OSError:
                    pass
    return latest


def _safe_remove(root: Path, target: Path) -> tuple[int, int, int]:
    """Safely remove a file or directory within ``root``. Returns (bytes, removed, failed)."""
    if not target.exists():
        return 0, 0, 0
    if not _is_within(root, target):
        return 0, 0, 1
    size_before, file_count = _path_stats(target)
    try:
        if target.is_dir():
            shutil.rmtree(target)
        else:
            target.unlink()
        return size_before, max(1, file_count), 0
    except OSError:
        return 0, 0, 1


def _runtime_active_info(runtime: Any | None) -> tuple[set[str], set[str], int]:
    """Return ``(active_hub_session_ids, active_acp_session_ids, active_turn_count)``."""
    if runtime is None:
        try:
            from . import agy_runtime as _rt_mod
            runtime = _rt_mod.runtime
        except Exception:
            return set(), set(), 0
    active_hub_sids: set[str] = set()
    active_acp_sids: set[str] = set()
    active_turns = 0
    try:
        lock = getattr(runtime, "_lock", None)
        ctx = lock if lock is not None else threading.Lock()
        with ctx:
            workers_map = getattr(runtime, "_workers", {}) or {}
            retiring_map = getattr(runtime, "_retiring", {}) or {}
            turns_map = getattr(runtime, "_active_turns", {}) or {}
            active_turns = sum(1 for w in turns_map.values() if getattr(w, "active_turn", None) is not None)
            all_workers = list(workers_map.values()) + [
                entry[0] for entry in retiring_map.values() if isinstance(entry, tuple) and entry
            ]
            for worker in all_workers:
                sid = getattr(worker, "session_id", None)
                acp_sid = getattr(worker, "acp_session_id", None)
                if isinstance(sid, str) and sid:
                    active_hub_sids.add(sid)
                if isinstance(acp_sid, str) and acp_sid:
                    active_acp_sids.add(acp_sid)
    except Exception:
        log.debug("Could not inspect AgyRuntimeManager active workers", exc_info=True)
    return active_hub_sids, active_acp_sids, active_turns


@dataclass
class _HubSnapshot:
    db_exists: bool = False
    live_root_convs: set[str] = field(default_factory=set)
    conv_to_session: dict[str, dict[str, Any]] = field(default_factory=dict)
    busy_root_convs: set[str] = field(default_factory=set)
    old_run_events_bytes: int = 0
    old_run_events_rows: int = 0
    freelist_bytes: int = 0
    wal_bytes: int = 0


def _read_hub_snapshot(
    db_path: Path,
    *,
    active_hub_sids: set[str],
    l3_run_events_cutoff_iso: str,
) -> _HubSnapshot:
    snap = _HubSnapshot()
    if not db_path.is_file() or db_path.is_symlink():
        return snap
    snap.db_exists = True
    wal_path = db_path.with_name(db_path.name + "-wal")
    try:
        if wal_path.is_file():
            snap.wal_bytes = wal_path.stat().st_size
    except OSError:
        pass
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=3.0)
        conn.row_factory = sqlite3.Row
    except sqlite3.Error:
        return snap
    try:
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "sessions" not in tables:
            return snap
        busy_sids = set(active_hub_sids)
        if "runs" in tables:
            placeholders = ",".join("?" for _ in _ACTIVE_RUN_STATUSES)
            for row in conn.execute(
                f"SELECT DISTINCT session_id FROM runs WHERE status IN ({placeholders})",
                tuple(_ACTIVE_RUN_STATUSES),
            ):
                if row[0]:
                    busy_sids.add(str(row[0]))

        sessions_by_id: dict[str, dict[str, Any]] = {}
        for row in conn.execute("SELECT id, conversation, updated_at FROM sessions"):
            sid = str(row["id"])
            conv = str(row["conversation"] or "").strip()
            info = {"id": sid, "conversation": conv, "updated_at": row["updated_at"]}
            sessions_by_id[sid] = info
            if conv:
                snap.live_root_convs.add(conv)
                snap.conv_to_session[conv] = info
                if sid in busy_sids:
                    snap.busy_root_convs.add(conv)

        if "profile_conversations" in tables:
            for row in conn.execute("SELECT session_id, conversation FROM profile_conversations"):
                sid = str(row["session_id"])
                conv = str(row["conversation"] or "").strip()
                if conv and sid in sessions_by_id:
                    snap.live_root_convs.add(conv)
                    snap.conv_to_session.setdefault(conv, sessions_by_id[sid])
                    if sid in busy_sids:
                        snap.busy_root_convs.add(conv)

        if "run_events" in tables and "runs" in tables:
            placeholders = ",".join("?" for _ in _ACTIVE_RUN_STATUSES)
            row = conn.execute(
                f"""
                SELECT COUNT(*), COALESCE(SUM(length(re.payload_json)), 0)
                FROM run_events re
                JOIN runs r ON r.id = re.run_id
                WHERE r.status NOT IN ({placeholders})
                  AND r.finished_at IS NOT NULL
                  AND r.finished_at != ''
                  AND r.finished_at < ?
                """,
                (*_ACTIVE_RUN_STATUSES, l3_run_events_cutoff_iso),
            ).fetchone()
            if row:
                snap.old_run_events_rows = int(row[0] or 0)
                snap.old_run_events_bytes = int(row[1] or 0)

        try:
            ps = int(conn.execute("PRAGMA page_size").fetchone()[0] or 0)
            fc = int(conn.execute("PRAGMA freelist_count").fetchone()[0] or 0)
            snap.freelist_bytes = ps * fc
        except sqlite3.Error:
            pass
    except sqlite3.Error:
        log.debug("Failed reading hub sqlite snapshot", exc_info=True)
    finally:
        conn.close()
    return snap


def _read_summaries(cli_dir: Path) -> tuple[dict[str, str], dict[str, dict[str, Any]]]:
    """Read ``conversation_summaries.db`` safely (read-only).

    Returns ``(parent_of, info_by_cid)``.
    """
    sdb = cli_dir / "conversation_summaries.db"
    if not sdb.is_file() or sdb.is_symlink():
        return {}, {}
    parent_of: dict[str, str] = {}
    info_by_cid: dict[str, dict[str, Any]] = {}
    try:
        conn = sqlite3.connect(f"file:{sdb}?mode=ro", uri=True, timeout=2.0)
        conn.row_factory = sqlite3.Row
    except sqlite3.Error:
        return {}, {}
    try:
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "conversation_summaries" not in tables:
            return {}, {}
        cols = {r[1] for r in conn.execute("PRAGMA table_info(conversation_summaries)")}
        sel_parent = "parent_conversation_id" if "parent_conversation_id" in cols else "'' AS parent_conversation_id"
        sel_status = "status" if "status" in cols else "'' AS status"
        sel_not_idle = "not_fully_idle" if "not_fully_idle" in cols else "0 AS not_fully_idle"
        sel_killed = "killed" if "killed" in cols else "0 AS killed"
        sel_mtime = "last_modified_time" if "last_modified_time" in cols else "'' AS last_modified_time"
        for row in conn.execute(
            f"SELECT conversation_id, {sel_parent}, {sel_status}, {sel_not_idle}, {sel_killed}, {sel_mtime} "
            "FROM conversation_summaries"
        ):
            cid = str(row["conversation_id"] or "").strip()
            if not cid:
                continue
            pid = str(row["parent_conversation_id"] or "").strip()
            parent_of[cid] = pid
            info_by_cid[cid] = {
                "parent_id": pid,
                "status": str(row["status"] or ""),
                "not_fully_idle": bool(row["not_fully_idle"]),
                "killed": bool(row["killed"]),
                "last_modified_time": str(row["last_modified_time"] or ""),
            }
    except sqlite3.Error:
        log.debug("Failed reading conversation_summaries.db", exc_info=True)
    finally:
        conn.close()
    return parent_of, info_by_cid


def _unreported_live_children(cli_dir: Path, parent_cid: str) -> set[str]:
    """Return child IDs registered under ``parent_cid`` that are not killed and haven't reported back."""
    sub_dir = cli_dir / "brain" / parent_cid / ".system_generated" / "subagents"
    if not sub_dir.is_dir() or sub_dir.is_symlink():
        return set()
    reported: set[str] = set()
    msg_dir = cli_dir / "brain" / parent_cid / ".system_generated" / "messages"
    if msg_dir.is_dir() and not msg_dir.is_symlink():
        try:
            for entry in msg_dir.iterdir():
                if not entry.is_file() or entry.suffix != ".json" or entry.name == "read.json":
                    continue
                try:
                    data = json.loads(entry.read_text(encoding="utf-8"))
                    sender = data.get("sender") if isinstance(data, dict) else None
                    if isinstance(sender, str) and sender:
                        reported.add(sender)
                except (OSError, ValueError):
                    continue
        except OSError:
            pass
    unreported: set[str] = set()
    try:
        for entry in sub_dir.iterdir():
            if not entry.is_file() or entry.suffix != ".json":
                continue
            child_id = entry.stem
            if not _NATIVE_ID_RE.fullmatch(child_id) or child_id in reported:
                continue
            try:
                rec = json.loads(entry.read_text(encoding="utf-8"))
                if isinstance(rec, dict) and rec.get("state") == "SUBAGENT_STATE_KILLED":
                    continue
            except (OSError, ValueError):
                pass
            unreported.add(child_id)
    except OSError:
        pass
    return unreported


def _conv_db_files(cli_dir: Path, cid: str) -> list[Path]:
    conv_dir = cli_dir / "conversations"
    if not conv_dir.is_dir():
        return []
    out: list[Path] = []
    for suffix in (".db", ".db-wal", ".db-shm", ".pb"):
        cand = conv_dir / f"{cid}{suffix}"
        if cand.exists() and not cand.is_symlink():
            out.append(cand)
    return out


def _annotation_files(cli_dir: Path, cid: str) -> list[Path]:
    ann_dir = cli_dir / "annotations"
    if not ann_dir.is_dir():
        return []
    out: list[Path] = []
    for suffix in (".pbtxt", ".json"):
        cand = ann_dir / f"{cid}{suffix}"
        if cand.exists() and not cand.is_symlink():
            out.append(cand)
    return out


def _discover_disk_cids(cli_dir: Path) -> set[str]:
    cids: set[str] = set()
    conv_dir = cli_dir / "conversations"
    if conv_dir.is_dir() and not conv_dir.is_symlink():
        try:
            for entry in conv_dir.iterdir():
                if entry.is_file() and not entry.is_symlink():
                    name = entry.name
                    for ext in (".db-wal", ".db-shm", ".db", ".pb"):
                        if name.endswith(ext):
                            stem = name[: -len(ext)]
                            if _NATIVE_ID_RE.fullmatch(stem):
                                cids.add(stem)
                            break
        except OSError:
            pass
    brain_dir = cli_dir / "brain"
    if brain_dir.is_dir() and not brain_dir.is_symlink():
        try:
            for entry in brain_dir.iterdir():
                if entry.is_dir() and not entry.is_symlink() and _NATIVE_ID_RE.fullmatch(entry.name):
                    cids.add(entry.name)
        except OSError:
            pass
    return cids


def _root_of(cid: str, parent_of: dict[str, str]) -> str:
    seen: set[str] = set()
    cur = cid
    while cur and cur not in seen:
        seen.add(cur)
        parent = parent_of.get(cur, "")
        if not parent:
            return cur
        cur = parent
    return cur


def _descendants_of(roots: Iterable[str], parent_of: dict[str, str]) -> set[str]:
    children_map: dict[str, list[str]] = {}
    for cid, pid in parent_of.items():
        if pid:
            children_map.setdefault(pid, []).append(cid)
    result: set[str] = set()
    stack = [r for r in roots if isinstance(r, str) and r]
    while stack:
        cur = stack.pop()
        if cur in result:
            continue
        result.add(cur)
        for child in children_map.get(cur, ()):
            if child not in result:
                stack.append(child)
    return result


def _conversation_activity_ts(cli_dir: Path, cid: str, summary_info: dict[str, Any] | None) -> float:
    ts = 0.0
    if summary_info:
        parsed = _parse_iso(summary_info.get("last_modified_time"))
        if parsed is not None:
            ts = max(ts, parsed.timestamp())
    for fp in _conv_db_files(cli_dir, cid):
        try:
            ts = max(ts, fp.stat().st_mtime)
        except OSError:
            pass
    brain_cid = cli_dir / "brain" / cid
    if brain_cid.is_dir() and not brain_cid.is_symlink():
        try:
            ts = max(ts, brain_cid.stat().st_mtime)
        except OSError:
            pass
        tr = brain_cid / ".system_generated" / "logs" / "transcript.jsonl"
        if tr.is_file():
            try:
                ts = max(ts, tr.stat().st_mtime)
            except OSError:
                pass
    return ts


def _has_top_level_artifacts(brain_cid: Path) -> bool:
    if not brain_cid.is_dir() or brain_cid.is_symlink():
        return False
    try:
        for entry in brain_cid.iterdir():
            if entry.name not in {".system_generated", "scratch"}:
                return True
    except OSError:
        pass
    return False


@dataclass
class TierPlan:
    paths: list[Path] = field(default_factory=list)
    summary_cids: set[str] = field(default_factory=set)
    cold_root_sids: set[str] = field(default_factory=set)
    cold_root_cids: set[str] = field(default_factory=set)
    bytes: int = 0
    file_count: int = 0
    item_count: int = 0  # conversations or logical groups affected

    def add_path(self, path: Path) -> None:
        sz, cnt = _path_stats(path)
        if cnt <= 0 and not path.exists():
            return
        self.paths.append(path)
        self.bytes += sz
        self.file_count += cnt


@dataclass
class ScanReport:
    cli_dir: Path
    hub_db: Path
    policy: dict[str, Any]
    active_turns: int
    l0: TierPlan
    l1: TierPlan
    l2: TierPlan
    l3: TierPlan
    active_core_bytes: int
    active_core_files: int
    active_root_count: int
    protected_child_count: int


def scan_storage(
    *,
    cli_dir: Path | None = None,
    db_path: Path | None = None,
    policy: dict[str, Any] | None = None,
    runtime: Any | None = None,
    now: datetime | None = None,
) -> ScanReport:
    """Compute exact per-tier reclaimable targets and protected core totals without mutating disk."""
    eff_cli = _workspace_cli_dir(cli_dir)
    eff_db = _hub_db_path(db_path)
    eff_policy = normalize_policy(policy) if policy is not None else load_policy()
    now_dt = _now_utc(now)
    now_ts = now_dt.timestamp()

    active_hub_sids, active_acp_sids, active_turns = _runtime_active_info(runtime)
    l3_events_cutoff = (now_dt - timedelta(days=eff_policy["l3_run_events_retention_days"])).isoformat()
    hub = _read_hub_snapshot(
        eff_db,
        active_hub_sids=active_hub_sids,
        l3_run_events_cutoff_iso=l3_events_cutoff,
    )
    parent_of, summaries = _read_summaries(eff_cli)
    pending_deletes = {
        c for c in (_load_state().get("pending_delete_cids") or [])
        if isinstance(c, str) and _NATIVE_ID_RE.fullmatch(c)
    }

    disk_cids = _discover_disk_cids(eff_cli)
    all_cids = disk_cids | set(summaries.keys())

    # Active/busy roots and unreported children must never be modified.
    busy_cids: set[str] = set(active_acp_sids) | set(hub.busy_root_convs)
    unreported_children: set[str] = set()
    for root_cid in hub.live_root_convs:
        unreported_children.update(_unreported_live_children(eff_cli, root_cid))

    l0 = TierPlan()
    l1 = TierPlan()
    l2 = TierPlan()
    l3 = TierPlan()

    l0_log_cutoff = now_ts - eff_policy["l0_log_retention_days"] * 86400
    l1_grace_cutoff = now_ts - eff_policy["l1_grace_hours"] * 3600
    l1_steps_cutoff = now_ts - eff_policy["l1_steps_retention_days"] * 86400
    l1_steps_max_bytes = eff_policy["l1_steps_max_file_mb"] * 1024 * 1024
    l1_scratch_cutoff = now_ts - eff_policy["l1_scratch_retention_days"] * 86400
    l2_killed_cutoff = now_ts - eff_policy["l2_killed_grace_hours"] * 3600
    l2_idle_cutoff = now_ts - eff_policy["l2_idle_retention_days"] * 86400
    l3_cold_cutoff = now_ts - eff_policy["l3_cold_root_days"] * 86400

    # Track paths claimed by L0/L1/L2/L3 so we can compute exact active_core residual.
    claimed_paths: set[Path] = set()
    protected_children = 0

    def _claim(plan: TierPlan, path: Path) -> None:
        if path in claimed_paths or not path.exists() or path.is_symlink():
            return
        claimed_paths.add(path)
        plan.add_path(path)

    for cid in sorted(all_cids):
        root = _root_of(cid, parent_of)
        sinfo = summaries.get(cid)
        is_live_root = cid in hub.live_root_convs
        is_live_tree = is_live_root or (root in hub.live_root_convs)
        is_busy = (
            cid in busy_cids
            or root in busy_cids
            or bool(sinfo and (sinfo.get("status") == "CASCADE_RUN_STATUS_RUNNING" or sinfo.get("not_fully_idle")))
        )

        # ── L0: Orphans (deleted Hub sessions & their subtrees) ──
        if not is_live_tree:
            if is_busy:
                continue
            explicit_pending = cid in pending_deletes or root in pending_deletes
            if not explicit_pending:
                if not hub.db_exists:
                    continue
                act_ts = _conversation_activity_ts(eff_cli, cid, sinfo)
                if act_ts > (now_ts - _ORPHAN_MTIME_SAFETY_SECONDS):
                    continue
            has_any = False
            for fp in _conv_db_files(eff_cli, cid):
                _claim(l0, fp)
                has_any = True
            brain_cid = eff_cli / "brain" / cid
            if brain_cid.is_dir() and not brain_cid.is_symlink():
                _claim(l0, brain_cid)
                has_any = True
            for fp in _annotation_files(eff_cli, cid):
                _claim(l0, fp)
                has_any = True
            if cid in summaries:
                l0.summary_cids.add(cid)
                has_any = True
            if has_any:
                l0.item_count += 1
            continue

        # ── L2: Finished / killed subagent children under live roots ──
        if not is_live_root:
            if is_busy or cid in unreported_children:
                protected_children += 1
                continue
            killed = bool(sinfo and sinfo.get("killed"))
            is_idle = bool(sinfo and sinfo.get("status") == "CASCADE_RUN_STATUS_IDLE" and not sinfo.get("not_fully_idle"))
            act_ts = _conversation_activity_ts(eff_cli, cid, sinfo)
            eligible = (killed and act_ts <= l2_killed_cutoff) or (
                not killed and is_idle and act_ts <= l2_idle_cutoff
            )
            if not eligible:
                protected_children += 1
                continue

            has_any = False
            for fp in _conv_db_files(eff_cli, cid):
                _claim(l2, fp)
                has_any = True
            brain_cid = eff_cli / "brain" / cid
            keep_art = bool(eff_policy.get("l2_keep_artifacts", True)) and _has_top_level_artifacts(brain_cid)
            if brain_cid.is_dir() and not brain_cid.is_symlink():
                if keep_art:
                    for sub_name in (".system_generated", "scratch"):
                        sub = brain_cid / sub_name
                        if sub.exists() and not sub.is_symlink():
                            _claim(l2, sub)
                            has_any = True
                else:
                    _claim(l2, brain_cid)
                    has_any = True
            for fp in _annotation_files(eff_cli, cid):
                _claim(l2, fp)
                has_any = True
            if cid in summaries and not keep_art:
                l2.summary_cids.add(cid)
            if has_any:
                l2.item_count += 1
            continue

        # ── Live Root Sessions: check L3 (cold demotion) vs L1 (redundant copies) ──
        if is_busy:
            continue

        sess_info = hub.conv_to_session.get(cid) or {}
        sess_updated = _parse_iso(sess_info.get("updated_at"))
        act_ts = _conversation_activity_ts(eff_cli, cid, sinfo)
        effective_root_ts = max(act_ts, sess_updated.timestamp() if sess_updated else 0.0)

        # Check L3 cold root eligibility first (native DB + entire .system_generated + scratch)
        is_cold_root = effective_root_ts > 0 and effective_root_ts <= l3_cold_cutoff
        brain_cid = eff_cli / "brain" / cid
        sysgen = brain_cid / ".system_generated"

        if is_cold_root:
            has_cold = False
            for fp in _conv_db_files(eff_cli, cid):
                _claim(l3, fp)
                has_cold = True
            if sysgen.is_dir() and not sysgen.is_symlink():
                _claim(l3, sysgen)
                has_cold = True
            scratch = brain_cid / "scratch"
            if scratch.is_dir() and not scratch.is_symlink():
                _claim(l3, scratch)
                has_cold = True
            for fp in _annotation_files(eff_cli, cid):
                _claim(l3, fp)
                has_cold = True
            if has_cold:
                l3.item_count += 1
                l3.cold_root_cids.add(cid)
                if sess_info.get("id"):
                    l3.cold_root_sids.add(str(sess_info["id"]))
                if cid in summaries:
                    l3.summary_cids.add(cid)
            continue

        # ── L1: Redundant copies inside idle live root's brain/<cid>/ ──
        l1_hit = False
        if sysgen.is_dir() and not sysgen.is_symlink():
            # 1) tasks/ (duplicate of steps/ stdout)
            tasks_dir = sysgen / "tasks"
            if tasks_dir.is_dir() and not tasks_dir.is_symlink():
                try:
                    for entry in tasks_dir.iterdir():
                        if not entry.is_symlink() and _latest_mtime(entry) <= l1_grace_cutoff:
                            _claim(l1, entry)
                            l1_hit = True
                except OSError:
                    pass
            # 2) logs/chunks/ and logs/transcript_full.jsonl
            logs_dir = sysgen / "logs"
            if logs_dir.is_dir() and not logs_dir.is_symlink():
                chunks_dir = logs_dir / "chunks"
                if chunks_dir.is_dir() and not chunks_dir.is_symlink():
                    if _latest_mtime(chunks_dir) <= l1_grace_cutoff:
                        _claim(l1, chunks_dir)
                        l1_hit = True
                full_tr = logs_dir / "transcript_full.jsonl"
                if full_tr.is_file() and not full_tr.is_symlink():
                    try:
                        if full_tr.stat().st_mtime <= l1_grace_cutoff:
                            _claim(l1, full_tr)
                            l1_hit = True
                    except OSError:
                        pass
            # 3) steps/* (aged or oversized output files)
            steps_dir = sysgen / "steps"
            if steps_dir.is_dir() and not steps_dir.is_symlink():
                try:
                    for step_entry in steps_dir.iterdir():
                        if step_entry.is_symlink():
                            continue
                        st_mtime = _latest_mtime(step_entry)
                        st_bytes, _ = _path_stats(step_entry)
                        if st_mtime <= l1_steps_cutoff or (
                            st_bytes >= l1_steps_max_bytes and st_mtime <= l1_grace_cutoff
                        ):
                            _claim(l1, step_entry)
                            l1_hit = True
                except OSError:
                    pass
        # 4) scratch/ older than l1_scratch_retention_days
        scratch_dir = brain_cid / "scratch"
        if scratch_dir.is_dir() and not scratch_dir.is_symlink():
            try:
                for entry in scratch_dir.iterdir():
                    if not entry.is_symlink() and _latest_mtime(entry) <= l1_scratch_cutoff:
                        _claim(l1, entry)
                        l1_hit = True
            except OSError:
                pass
        if l1_hit:
            l1.item_count += 1

    # ── L0: Expired CLI logs & crashes ──
    cli_log_dir = eff_cli / "log"
    if cli_log_dir.is_dir() and not cli_log_dir.is_symlink():
        try:
            for entry in cli_log_dir.iterdir():
                if not entry.is_symlink() and _latest_mtime(entry) <= l0_log_cutoff:
                    _claim(l0, entry)
        except OSError:
            pass
    crashes_dir = eff_cli / "crashes"
    if crashes_dir.is_dir() and not crashes_dir.is_symlink():
        try:
            for entry in crashes_dir.iterdir():
                if not entry.is_symlink():
                    _claim(l0, entry)
        except OSError:
            pass

    # ── L3: Add reclaimable Hub SQLite run_events + freelist/WAL estimate ──
    db_reclaim_est = hub.old_run_events_bytes + hub.freelist_bytes
    if db_reclaim_est > 0:
        l3.bytes += db_reclaim_est
        if hub.old_run_events_rows > 0:
            l3.file_count += 1

    # ── Compute protected active_core residual across conversations/brain/log/crashes ──
    total_native_bytes = 0
    total_native_files = 0
    for sub in ("conversations", "brain", "log", "crashes"):
        b, c = _path_stats(eff_cli / sub)
        total_native_bytes += b
        total_native_files += c

    reclaimable_native_bytes = l0.bytes + l1.bytes + l2.bytes + max(0, l3.bytes - db_reclaim_est)
    reclaimable_native_files = l0.file_count + l1.file_count + l2.file_count + max(
        0, l3.file_count - (1 if hub.old_run_events_rows > 0 else 0)
    )
    active_core_bytes = max(0, total_native_bytes - reclaimable_native_bytes)
    active_core_files = max(0, total_native_files - reclaimable_native_files)

    return ScanReport(
        cli_dir=eff_cli,
        hub_db=eff_db,
        policy=eff_policy,
        active_turns=active_turns,
        l0=l0,
        l1=l1,
        l2=l2,
        l3=l3,
        active_core_bytes=active_core_bytes,
        active_core_files=active_core_files,
        active_root_count=len(hub.live_root_convs),
        protected_child_count=protected_children,
    )


def _prune_summaries_db(cli_dir: Path, cids: set[str]) -> int:
    """Remove deleted conversation IDs from ``conversation_summaries.db`` (best-effort)."""
    if not cids:
        return 0
    sdb = cli_dir / "conversation_summaries.db"
    if not sdb.is_file() or sdb.is_symlink():
        return 0
    removed = 0
    try:
        conn = sqlite3.connect(sdb, timeout=2.0)
    except sqlite3.Error:
        return 0
    try:
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        cid_list = sorted(cids)
        with conn:
            for chunk_start in range(0, len(cid_list), 200):
                batch = cid_list[chunk_start : chunk_start + 200]
                placeholders = ",".join("?" for _ in batch)
                if "conversation_summaries" in tables:
                    cur = conn.execute(
                        f"DELETE FROM conversation_summaries WHERE conversation_id IN ({placeholders})",
                        batch,
                    )
                    removed += max(0, cur.rowcount)
                if "conversations_fts" in tables:
                    try:
                        conn.execute(
                            f"DELETE FROM conversations_fts WHERE conversation_id IN ({placeholders})",
                            batch,
                        )
                    except sqlite3.Error:
                        pass
                if "conversation_parents" in tables:
                    try:
                        conn.execute(
                            f"DELETE FROM conversation_parents WHERE conversation_id IN ({placeholders}) "
                            f"OR parent_id IN ({placeholders})",
                            [*batch, *batch],
                        )
                    except sqlite3.Error:
                        pass
    except sqlite3.Error:
        log.debug("Deferred pruning conversation_summaries.db (likely busy)", exc_info=True)
    finally:
        conn.close()
    return removed


def _compact_hub_db(
    db_path: Path,
    *,
    cold_root_sids: set[str],
    run_events_cutoff_iso: str,
    allow_vacuum: bool,
) -> tuple[int, int]:
    """Apply L3 mutations to ``anti_sessions.sqlite3`` and reclaim space.

    Returns ``(reclaimed_bytes, removed_entries)``.
    """
    if not db_path.is_file() or db_path.is_symlink():
        return 0, 0
    wal_path = db_path.with_name(db_path.name + "-wal")
    size_before = db_path.stat().st_size + (wal_path.stat().st_size if wal_path.is_file() else 0)
    removed = 0
    try:
        conn = sqlite3.connect(db_path, timeout=5.0)
    except sqlite3.Error:
        return 0, 0
    try:
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        with conn:
            if cold_root_sids and "sessions" in tables:
                sid_list = sorted(cold_root_sids)
                placeholders = ",".join("?" for _ in sid_list)
                conn.execute(
                    f"UPDATE sessions SET conversation=NULL WHERE id IN ({placeholders})",
                    sid_list,
                )
                if "profile_conversations" in tables:
                    conn.execute(
                        f"DELETE FROM profile_conversations WHERE session_id IN ({placeholders})",
                        sid_list,
                    )
            if "run_events" in tables and "runs" in tables:
                placeholders = ",".join("?" for _ in _ACTIVE_RUN_STATUSES)
                cur = conn.execute(
                    f"""
                    DELETE FROM run_events
                    WHERE run_id IN (
                        SELECT id FROM runs
                        WHERE status NOT IN ({placeholders})
                          AND finished_at IS NOT NULL
                          AND finished_at != ''
                          AND finished_at < ?
                    )
                    """,
                    (*_ACTIVE_RUN_STATUSES, run_events_cutoff_iso),
                )
                if cur.rowcount and cur.rowcount > 0:
                    removed += 1
        if allow_vacuum:
            try:
                conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                conn.execute("VACUUM")
            except sqlite3.Error:
                log.debug("Deferred VACUUM on anti_sessions.sqlite3", exc_info=True)
    except sqlite3.Error:
        log.debug("Failed compacting anti_sessions.sqlite3", exc_info=True)
        return 0, 0
    finally:
        conn.close()
    try:
        size_after = db_path.stat().st_size + (wal_path.stat().st_size if wal_path.is_file() else 0)
    except OSError:
        size_after = size_before
    return max(0, size_before - size_after), removed


def _prune_empty_dirs(root: Path, paths: Iterable[Path]) -> None:
    parents: set[Path] = set()
    for p in paths:
        if p.parent != root:
            parents.add(p.parent)
    for parent in sorted(parents, key=lambda x: len(x.parts), reverse=True):
        try:
            if parent.is_dir() and not parent.is_symlink() and _is_within(root, parent):
                if not any(parent.iterdir()):
                    parent.rmdir()
        except OSError:
            pass


def run_cleanup(
    tiers: Iterable[str],
    *,
    cli_dir: Path | None = None,
    db_path: Path | None = None,
    policy: dict[str, Any] | None = None,
    runtime: Any | None = None,
    now: datetime | None = None,
    record_state: bool = False,
) -> dict[str, Any]:
    """Execute cleanup for the requested tiers (subset of ``{'l0', 'l1', 'l2', 'l3'}``)."""
    wanted = {str(t).strip().lower() for t in tiers} & {"l0", "l1", "l2", "l3"}
    if not wanted:
        return {"reclaimed_bytes": 0, "removed_entries": 0, "failed_entries": 0}

    with _gc_exec_lock:
        now_dt = _now_utc(now)
        report = scan_storage(
            cli_dir=cli_dir,
            db_path=db_path,
            policy=policy,
            runtime=runtime,
            now=now_dt,
        )
        reclaimed = 0
        removed = 0
        failed = 0
        summary_cids_to_prune: set[str] = set()
        cleared_pending: set[str] = set()
        still_pending: set[str] = set()
        touched_paths: list[Path] = []

        tier_plans = {
            "l0": report.l0,
            "l1": report.l1,
            "l2": report.l2,
            "l3": report.l3,
        }

        for tier_name in ("l0", "l1", "l2", "l3"):
            if tier_name not in wanted:
                continue
            plan = tier_plans[tier_name]
            for path in plan.paths:
                r_b, r_ok, r_err = _safe_remove(report.cli_dir, path)
                reclaimed += r_b
                removed += r_ok
                failed += r_err
                touched_paths.append(path)
                if r_err > 0 and tier_name == "l0":
                    # Track failed orphan CIDs for deferred retry.
                    stem = path.name.split(".db")[0]
                    if _NATIVE_ID_RE.fullmatch(stem):
                        still_pending.add(stem)
                elif r_err == 0 and tier_name == "l0":
                    stem = path.name.split(".db")[0]
                    if _NATIVE_ID_RE.fullmatch(stem):
                        cleared_pending.add(stem)
            summary_cids_to_prune.update(plan.summary_cids)

        _prune_empty_dirs(report.cli_dir, touched_paths)

        # Prune conversation_summaries.db only when no active Agy turns are writing.
        if summary_cids_to_prune and report.active_turns == 0:
            _prune_summaries_db(report.cli_dir, summary_cids_to_prune)

        if "l3" in wanted:
            l3_cutoff = (now_dt - timedelta(days=report.policy["l3_run_events_retention_days"])).isoformat()
            db_reclaimed, db_removed = _compact_hub_db(
                report.hub_db,
                cold_root_sids=report.l3.cold_root_sids,
                run_events_cutoff_iso=l3_cutoff,
                allow_vacuum=(report.active_turns == 0),
            )
            reclaimed += db_reclaimed
            removed += db_removed

        cleared_pending -= still_pending
        if cleared_pending:
            _clear_pending_deletes(cleared_pending)
        if still_pending:
            _record_pending_deletes(still_pending)

        if record_state:
            _save_state({
                "last_run_at": now_dt.isoformat(),
                "last_reclaimed_bytes": reclaimed,
                "last_removed_entries": removed,
                "last_error": None,
            })

        return {
            "reclaimed_bytes": reclaimed,
            "removed_entries": removed,
            "failed_entries": failed,
        }


def cleanup_deleted_conversations(
    conv_ids: Iterable[str],
    *,
    cli_dir: Path | None = None,
    db_path: Path | None = None,
    runtime: Any | None = None,
) -> dict[str, int]:
    """L0 immediate hook: remove the full conversation subtree(s) after a Hub session is deleted.

    Never deletes any conversation ID still referenced by another remaining Hub session or
    active worker. Any locked files are queued into ``pending_delete_cids`` for later retry.
    """
    roots = {c.strip() for c in conv_ids if isinstance(c, str) and _NATIVE_ID_RE.fullmatch(c.strip())}
    if not roots:
        return {"reclaimed_bytes": 0, "removed_entries": 0, "failed_entries": 0}

    eff_cli = _workspace_cli_dir(cli_dir)
    eff_db = _hub_db_path(db_path)

    with _gc_exec_lock:
        active_hub_sids, active_acp_sids, active_turns = _runtime_active_info(runtime)
        hub = _read_hub_snapshot(
            eff_db,
            active_hub_sids=active_hub_sids,
            l3_run_events_cutoff_iso="1970-01-01T00:00:00+00:00",
        )
        parent_of, _ = _read_summaries(eff_cli)
        # Never touch anything still referenced by remaining Hub sessions or live workers.
        protected_roots = hub.live_root_convs | active_acp_sids
        candidate_roots = roots - protected_roots
        if not candidate_roots:
            return {"reclaimed_bytes": 0, "removed_entries": 0, "failed_entries": 0}

        tree = _descendants_of(candidate_roots, parent_of) - protected_roots
        # Also protect descendants of any remaining live root just in case.
        if hub.live_root_convs:
            tree -= _descendants_of(hub.live_root_convs, parent_of)

        reclaimed = 0
        removed = 0
        failed = 0
        retry_cids: set[str] = set()
        succeeded_cids: set[str] = set()

        for cid in sorted(tree):
            cid_failed = False
            for fp in _conv_db_files(eff_cli, cid):
                r_b, r_ok, r_err = _safe_remove(eff_cli, fp)
                reclaimed += r_b
                removed += r_ok
                failed += r_err
                if r_err:
                    cid_failed = True
            brain_cid = eff_cli / "brain" / cid
            if brain_cid.is_dir() and not brain_cid.is_symlink():
                r_b, r_ok, r_err = _safe_remove(eff_cli, brain_cid)
                reclaimed += r_b
                removed += r_ok
                failed += r_err
                if r_err:
                    cid_failed = True
            for fp in _annotation_files(eff_cli, cid):
                r_b, r_ok, r_err = _safe_remove(eff_cli, fp)
                reclaimed += r_b
                removed += r_ok
                failed += r_err
                if r_err:
                    cid_failed = True
            if cid_failed:
                retry_cids.add(cid)
            else:
                succeeded_cids.add(cid)

        if succeeded_cids and active_turns == 0:
            _prune_summaries_db(eff_cli, succeeded_cids)
        if retry_cids:
            _record_pending_deletes(retry_cids)

        return {
            "reclaimed_bytes": reclaimed,
            "removed_entries": removed,
            "failed_entries": failed,
        }


def is_scheduled_gc_due(*, policy: dict[str, Any] | None = None, now: datetime | None = None) -> bool:
    eff_policy = normalize_policy(policy) if policy is not None else load_policy()
    if not eff_policy.get("auto_enabled", True):
        return False
    state = _load_state()
    last_run = _parse_iso(state.get("last_run_at"))
    if last_run is None:
        return True
    interval = timedelta(hours=int(eff_policy.get("interval_hours", 24)))
    return _now_utc(now) >= (last_run + interval)


def run_scheduled_gc(
    *,
    cli_dir: Path | None = None,
    db_path: Path | None = None,
    runtime: Any | None = None,
    now: datetime | None = None,
) -> dict[str, Any] | None:
    """Run due automatic GC tiers based on saved policy when idle."""
    policy = load_policy()
    if not policy.get("auto_enabled", True):
        return None
    if not is_scheduled_gc_due(policy=policy, now=now):
        return None
    tiers: list[str] = []
    if policy.get("l0_orphans_enabled", True):
        tiers.append("l0")
    if policy.get("l1_redundant_enabled", True):
        tiers.append("l1")
    if policy.get("l2_subagents_enabled", True):
        tiers.append("l2")
    if policy.get("l3_cold_roots_enabled", False):
        tiers.append("l3")
    if not tiers:
        _save_state({"last_run_at": _now_utc(now).isoformat(), "last_error": None})
        return {"reclaimed_bytes": 0, "removed_entries": 0, "failed_entries": 0}
    try:
        return run_cleanup(
            tiers,
            cli_dir=cli_dir,
            db_path=db_path,
            policy=policy,
            runtime=runtime,
            now=now,
            record_state=True,
        )
    except Exception as exc:
        log.warning("Scheduled Agy storage GC failed", exc_info=True)
        _save_state({"last_error": str(exc)})
        return None
