"""Memory & Skill routes — global_mem, insight, SOP markdown, skill catalog."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
import hashlib
import logging
import os
from pathlib import Path
import stat
import tempfile
import threading
import time

from fastapi import APIRouter, HTTPException, Query

from ..schemas import (
    MemoryTextResp,
    MemoryWriteReq,
    MemoryWriteResp,
    SOPDetailResp,
    SOPItem,
    SOPListResp,
    SkillDetailResp,
    SkillItem,
    SkillListResp,
    SkillSearchHit,
    SkillSearchMatch,
    SkillSearchResp,
)
from .. import _paths

log = logging.getLogger(__name__)
router = APIRouter()


def _mem_dir() -> str: return str(_paths.memory_dir())
def _global_mem() -> str: return str(_paths.memory_dir() / "global_mem.txt")
def _insight() -> str: return str(_paths.memory_dir() / "global_mem_insight.txt")
def _skill_dir() -> str: return str(_paths.memory_dir() / "skill_search")


_memory_write_lock = threading.RLock()
_UTF8_BOM = b"\xef\xbb\xbf"


@dataclass(frozen=True)
class _MemorySnapshot:
    exists: bool
    data: bytes
    content: str
    mtime_ns: str | None
    sha256: str | None
    mode: int | None

    def response(self) -> dict:
        return {
            "content": self.content,
            "mtime_ns": self.mtime_ns,
            "sha256": self.sha256,
        }


def _read(path: str) -> str:
    """Read one skill file as text, for the read-only skill endpoints.

    Decoding is deliberately lossy (errors="replace"), matching what search
    already did: a GBK-encoded note is still a searchable skill, and a strict
    decode only turned it into a 500 in the viewer.
    """
    if not os.path.isfile(path):
        return ""
    with open(path, encoding="utf-8-sig", errors="replace", newline="") as fh:
        return fh.read()


def _snapshot(path: str) -> _MemorySnapshot:
    """Read bytes and metadata from one stable path snapshot."""
    for _attempt in range(3):
        try:
            with open(path, "rb") as fh:
                data = fh.read()
                opened = os.fstat(fh.fileno())
            current = os.stat(path)
        except FileNotFoundError:
            return _MemorySnapshot(False, b"", "", None, None, None)

        opened_id = (opened.st_dev, opened.st_ino, opened.st_mtime_ns, opened.st_size)
        current_id = (current.st_dev, current.st_ino, current.st_mtime_ns, current.st_size)
        if opened_id == current_id:
            content = data.decode("utf-8-sig")
            return _MemorySnapshot(
                True,
                data,
                content,
                str(opened.st_mtime_ns),
                hashlib.sha256(data).hexdigest(),
                stat.S_IMODE(opened.st_mode),
            )
    raise HTTPException(409, detail={"error": "memory_busy", "message": "Memory file is changing; reload and retry."})


def _same_version(snapshot: _MemorySnapshot, expected_mtime_ns: str | None, expected_sha256: str | None) -> bool:
    return snapshot.mtime_ns == expected_mtime_ns and snapshot.sha256 == expected_sha256


def _raise_conflict(snapshot: _MemorySnapshot) -> None:
    raise HTTPException(
        409,
        detail={
            "error": "memory_conflict",
            "message": "Memory file changed since it was loaded. Reload before saving.",
            "current_mtime_ns": snapshot.mtime_ns,
            "current_sha256": snapshot.sha256,
        },
    )


def _encode_like(snapshot: _MemorySnapshot, content: str) -> bytes:
    normalized = content.replace("\r\n", "\n").replace("\r", "\n")
    if snapshot.exists:
        old = snapshot.content
        crlf = old.count("\r\n")
        lone_lf = old.count("\n") - crlf
        lone_cr = old.count("\r") - crlf
        if crlf > lone_lf and crlf >= lone_cr:
            normalized = normalized.replace("\n", "\r\n")
        elif lone_cr > lone_lf and lone_cr > crlf:
            normalized = normalized.replace("\n", "\r")
    encoded = normalized.encode("utf-8")
    if snapshot.data.startswith(_UTF8_BOM):
        encoded = _UTF8_BOM + encoded
    return encoded


def _fsync_directory(directory: Path) -> None:
    if os.name == "nt":
        return
    try:
        fd = os.open(directory, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _stage_bytes(destination: Path, data: bytes, mode: int | None = None) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, raw_temp = tempfile.mkstemp(prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent)
    temp_path = Path(raw_temp)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        if mode is not None:
            os.chmod(temp_path, mode)
        return temp_path
    except BaseException:
        temp_path.unlink(missing_ok=True)
        raise


def _backup_snapshot(path: str, snapshot: _MemorySnapshot) -> None:
    if not snapshot.exists or snapshot.sha256 is None:
        return
    backup_dir = _paths.ADMIN_DATA / "memory-backups"
    safe_name = Path(path).name.replace(os.sep, "_")
    destination = backup_dir / f"{safe_name}.{time.time_ns()}.{snapshot.sha256[:12]}.bak"
    staged = _stage_bytes(destination, snapshot.data, snapshot.mode)
    try:
        os.replace(staged, destination)
        _fsync_directory(backup_dir)
    finally:
        staged.unlink(missing_ok=True)


def _write_memory(path: str, req: MemoryWriteReq) -> dict:
    with _memory_write_lock:
        before = _snapshot(path)
        if not _same_version(before, req.expected_mtime_ns, req.expected_sha256):
            _raise_conflict(before)

        new_data = _encode_like(before, req.content)
        if before.exists and new_data == before.data:
            return {
                "ok": True,
                "size": len(before.data),
                "mtime_ns": before.mtime_ns,
                "sha256": before.sha256,
            }

        destination = Path(path)
        staged = _stage_bytes(destination, new_data, before.mode)
        try:
            # Re-check immediately before the side effects so an external edit
            # cannot be silently overwritten after our initial validation.
            current = _snapshot(path)
            if not _same_version(current, before.mtime_ns, before.sha256):
                _raise_conflict(current)
            _backup_snapshot(path, before)
            current = _snapshot(path)
            if not _same_version(current, before.mtime_ns, before.sha256):
                _raise_conflict(current)
            os.replace(staged, destination)
            _fsync_directory(destination.parent)
        finally:
            staged.unlink(missing_ok=True)

        written = _snapshot(path)
        return {
            "ok": True,
            "size": len(written.data),
            "mtime_ns": written.mtime_ns,
            "sha256": written.sha256,
        }


@router.get("/api/memory/global", response_model=MemoryTextResp)
async def get_global():
    # File IO stays off the event loop — same contract as every other route.
    snapshot = await asyncio.to_thread(_snapshot, _global_mem())
    return snapshot.response()


@router.put("/api/memory/global", response_model=MemoryWriteResp)
async def put_global(req: MemoryWriteReq):
    return await asyncio.to_thread(_write_memory, _global_mem(), req)


@router.get("/api/memory/insight", response_model=MemoryTextResp)
async def get_insight():
    snapshot = await asyncio.to_thread(_snapshot, _insight())
    return snapshot.response()


@router.put("/api/memory/insight", response_model=MemoryWriteResp)
async def put_insight(req: MemoryWriteReq):
    return await asyncio.to_thread(_write_memory, _insight(), req)


def _list_sops() -> list[dict]:
    out: list[dict] = []
    md = _mem_dir()
    if not os.path.isdir(md):
        return out
    for name in sorted(os.listdir(md)):
        if name.endswith("_sop.md") or name.endswith(".md"):
            p = os.path.join(md, name)
            if not os.path.isfile(p):
                continue
            try:
                st = os.stat(p)
                out.append(SOPItem(name=name, size=st.st_size, mtime=int(st.st_mtime)).model_dump())
            except OSError:
                pass
    return out


@router.get("/api/memory/sops", response_model=SOPListResp)
async def list_sops():
    return {"sops": await asyncio.to_thread(_list_sops)}


def _safe_sop_path(name: str) -> str:
    # This endpoint accepts one file name, never a path.  Check both separator
    # styles and Windows drive/ADS syntax even when tests run on another OS.
    if (
        not name
        or name in {".", ".."}
        or "/" in name
        or "\\" in name
        or ":" in name
        or "\x00" in name
        or not name.endswith(".md")
    ):
        raise HTTPException(400, "bad sop name")
    return os.path.join(_mem_dir(), name)


def _read_sop(name: str) -> dict:
    p = _safe_sop_path(name)
    if not os.path.isfile(p):
        raise HTTPException(404, "sop not found")
    snapshot = _snapshot(p)
    return {"name": name, **snapshot.response()}


@router.get("/api/memory/sops/{name}", response_model=SOPDetailResp)
async def read_sop(name: str):
    return await asyncio.to_thread(_read_sop, name)


@router.put("/api/memory/sops/{name}", response_model=MemoryWriteResp)
async def write_sop(name: str, req: MemoryWriteReq):
    p = _safe_sop_path(name)
    return await asyncio.to_thread(_write_memory, p, req)


# ── skills ──────────────────────────────────────────────────────
# One format contract for all three skill endpoints. They used to keep three
# private extension sets (list {.md,.json,.py}; read that plus {.txt,.yaml,.yml};
# search that plus {.sh,""}), so the UI was wrong in both directions: search
# reported hits read answered 400 to, and read opened files the list never
# mentioned. The two helpers below are now the single source of that decision.
SKILL_TEXT_EXT = {".md", ".json", ".py", ".txt", ".yaml", ".yml", ".sh", ""}
_SNIFF_BYTES = 8192


def _is_skill_text(name: str) -> bool:
    """Shared format gate for list / read / search."""
    return os.path.splitext(name)[1].lower() in SKILL_TEXT_EXT


def _is_binary_blob(path: str) -> bool:
    """True when the head of a file rules it out as text; fails closed.

    "" is in SKILL_TEXT_EXT so extensionless files such as README count as
    skills, which also lets extensionless binaries in. A NUL byte is the cheap tell.
    """
    try:
        with open(path, "rb") as fh:
            return b"\x00" in fh.read(_SNIFF_BYTES)
    except OSError:
        return True


def _advertised_path(path: str, root: str) -> str:
    """POSIX form of a skill path — the one shape all three endpoints speak.

    os.path.relpath() returns native separators, so on Windows list and search
    used to hand out 'family\\child\\deep.md' while read only ever accepted
    'family/child/deep.md': every nested skill was advertised but unopenable.
    The wire contract must not depend on the host OS, so both producers go
    through here.
    """
    return Path(os.path.relpath(path, root)).as_posix()


def _list_skills(limit: int) -> dict:
    sd = _skill_dir()
    if not os.path.isdir(sd):
        return {"skills": [], "count": 0}
    root = _skill_root()
    out = []
    for base, dirs, files in os.walk(sd):
        _prune_escaping_dirs(dirs, base, root)
        for name in files:
            if not _is_skill_text(name):
                continue
            p = os.path.join(base, name)
            # Links (incl. Windows junctions) into the machine are not skills —
            # skip them so the list never advertises a file read would refuse.
            if _escapes_skill_root(p, root):
                continue
            if _is_binary_blob(p):
                continue
            rel = _advertised_path(p, sd)
            try:
                st = os.stat(p)
                out.append(
                    SkillItem(
                        path=rel,
                        name=name,
                        size=st.st_size,
                        mtime=int(st.st_mtime),
                    ).model_dump()
                )
            except OSError:
                pass
            if len(out) >= limit:
                break
        if len(out) >= limit:
            break
    return {"skills": out, "count": len(out)}


@router.get("/api/memory/skills", response_model=SkillListResp)
async def list_skills(limit: int = Query(default=200, ge=1, le=1000)):
    """Lightweight skill listing. Walks memory/skill_search/ for the shared skill text formats."""
    return await asyncio.to_thread(_list_skills, limit)


def _skill_root() -> Path:
    """Real (link-resolved) skill root — the single boundary for skill endpoints."""
    return Path(_skill_dir()).resolve()


def _escapes_skill_root(path: str | os.PathLike[str], root: Path | None = None) -> bool:
    """True when the real path leaves the skill root.

    Fails closed for unresolvable paths (broken link, symlink loop, NUL byte) so
    callers skip the entry instead of touching the file. resolve() is what makes
    this cover junctions: on Windows os.path.islink() is False for a junction,
    so os.walk(followlinks=False) would still descend into one.
    """
    try:
        Path(path).resolve().relative_to(_skill_root() if root is None else root)
    except (ValueError, OSError, RuntimeError):
        return True
    return False


def _prune_escaping_dirs(dirs: list[str], base: str, root: Path) -> None:
    """Drop directory entries resolving outside the skill root (in-place)."""
    dirs[:] = [d for d in dirs if not _escapes_skill_root(os.path.join(base, d), root)]


def _client_path_form(raw_path: str) -> str:
    """POSIX form of a client-supplied path; a backslash counts as a separator.

    A client holding a path we advertised under the old native-separator
    contract, or one that rebuilt a path with os.path.join, must still be able
    to open it. Normalizing widens the accepted separator only: the traversal
    check in _safe_skill_path runs on the normalized form, so a backslash
    cannot smuggle a '..' segment past it.
    """
    return raw_path.replace("\\", "/")


def _safe_skill_path(raw_path: str) -> Path:
    """Resolve one client-supplied path and keep it inside the skill root."""
    if not raw_path or "\x00" in raw_path or ":" in raw_path:
        raise HTTPException(400, "bad path")

    root = _skill_root()
    candidate = root / _client_path_form(raw_path)
    if _escapes_skill_root(candidate, root):
        raise HTTPException(400, "bad path")
    return candidate.resolve()


def _read_skill(path: str) -> dict:
    p = _safe_skill_path(path)
    # Same format gate as list and search, so neither can advertise a file this
    # endpoint refuses. The caller can no longer traverse paths; what is left is
    # a format check, plus the NUL sniff that extensionless names now need.
    if not _is_skill_text(p.name):
        raise HTTPException(400, f"not a readable text file: {p.suffix.lower()}")
    if not p.is_file():
        raise HTTPException(404, "not found")
    if _is_binary_blob(str(p)):
        raise HTTPException(400, "not a readable text file: binary content")
    return {"path": _client_path_form(path), "content": _read(str(p))}


@router.get("/api/memory/skills/read", response_model=SkillDetailResp)
async def read_skill(path: str):
    return await asyncio.to_thread(_read_skill, path)


def _search_skills(q: str, limit: int) -> dict:
    needle = q.lower()
    sd = _skill_dir()
    if not os.path.isdir(sd):
        return {"hits": [], "scanned": 0, "truncated": False}

    root = _skill_root()
    MAX_FILE_BYTES = 512 * 1024     # skip pathological files (a scan cost, not a
                                    # format rule, so this one stays search-only)
    PER_FILE_HITS = 5               # cap matches per file in the preview
    hits: list[SkillSearchHit] = []
    scanned = 0
    truncated = False

    for base, dirs, files in os.walk(sd):
        _prune_escaping_dirs(dirs, base, root)
        for name in files:
            if not _is_skill_text(name):
                continue
            p = os.path.join(base, name)
            # A link into the rest of the machine is not a skill: never read it,
            # or the match preview would leak content from outside the root.
            if _escapes_skill_root(p, root):
                continue
            if _is_binary_blob(p):
                continue
            try:
                if os.path.getsize(p) > MAX_FILE_BYTES:
                    continue
                scanned += 1
                with open(p, encoding="utf-8-sig", errors="replace") as f:
                    matches: list[SkillSearchMatch] = []
                    for i, line in enumerate(f, start=1):
                        if needle in line.lower():
                            matches.append(
                                SkillSearchMatch(line=i, text=line.rstrip("\n")[:240])
                            )
                            if len(matches) >= PER_FILE_HITS:
                                break
                    if matches:
                        hits.append(
                            SkillSearchHit(
                                path=_advertised_path(p, sd),
                                matches=matches,
                            )
                        )
                        if len(hits) >= limit:
                            truncated = True
                            break
            except OSError:
                continue
        if len(hits) >= limit:
            truncated = True
            break

    return {"hits": hits, "scanned": scanned, "truncated": truncated, "query": q}


@router.get("/api/memory/skills/search", response_model=SkillSearchResp)
async def search_skills(q: str, limit: int = Query(default=60, ge=1, le=200)):
    """Full-text grep over memory/skill_search/*.

    Walks the skill tree, scans every text file (.md/.json/.py/.txt/no-ext)
    line by line, returns matches with surrounding line numbers. Case
    insensitive substring match — keeps the implementation portable across
    OSes (no system grep dependency) and predictable.

    Response shape::

        {"hits": [{"path": "...", "matches": [{"line": 42, "text": "..."}, ...]}, ...],
         "scanned": <int>, "truncated": <bool>}
    """
    q = (q or "").strip()
    if not q:
        return {"hits": [], "scanned": 0, "truncated": False}
    return await asyncio.to_thread(_search_skills, q, limit)
