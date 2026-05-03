"""Memory & Skill routes — global_mem, insight, SOP markdown, skill catalog."""
from __future__ import annotations

import json
import logging
import os
from typing import Any

from fastapi import APIRouter, HTTPException

from ..schemas import TextWrite
from .. import _paths

log = logging.getLogger(__name__)
router = APIRouter()


def _mem_dir() -> str: return str(_paths.memory_dir())
def _global_mem() -> str: return str(_paths.memory_dir() / "global_mem.txt")
def _insight() -> str: return str(_paths.memory_dir() / "global_mem_insight.txt")
def _skill_dir() -> str: return str(_paths.memory_dir() / "skill_search")


def _read(path: str) -> str:
    if not os.path.isfile(path):
        return ""
    return open(path, encoding="utf-8").read()


def _write(path: str, content: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(content)
    os.replace(tmp, path)


@router.get("/api/memory/global")
async def get_global():
    return {"content": _read(_global_mem())}


@router.put("/api/memory/global")
async def put_global(req: TextWrite):
    _write(_global_mem(), req.content)
    return {"ok": True, "size": len(req.content)}


@router.get("/api/memory/insight")
async def get_insight():
    return {"content": _read(_insight())}


@router.put("/api/memory/insight")
async def put_insight(req: TextWrite):
    _write(_insight(), req.content)
    return {"ok": True, "size": len(req.content)}


@router.get("/api/memory/sops")
async def list_sops():
    out = []
    md = _mem_dir()
    if not os.path.isdir(md):
        return {"sops": []}
    for name in sorted(os.listdir(md)):
        if name.endswith("_sop.md") or name.endswith(".md"):
            p = os.path.join(md, name)
            if not os.path.isfile(p):
                continue
            try:
                st = os.stat(p)
                out.append({"name": name, "size": st.st_size, "mtime": int(st.st_mtime)})
            except OSError:
                pass
    return {"sops": out}


def _safe_sop_path(name: str) -> str:
    if "/" in name or ".." in name or not name.endswith(".md"):
        raise HTTPException(400, "bad sop name")
    return os.path.join(_mem_dir(), name)


@router.get("/api/memory/sops/{name}")
async def read_sop(name: str):
    p = _safe_sop_path(name)
    if not os.path.isfile(p):
        raise HTTPException(404, "sop not found")
    return {"name": name, "content": _read(p)}


@router.put("/api/memory/sops/{name}")
async def write_sop(name: str, req: TextWrite):
    p = _safe_sop_path(name)
    _write(p, req.content)
    return {"ok": True, "size": len(req.content)}


# ── skills ──────────────────────────────────────────────────────
@router.get("/api/memory/skills")
async def list_skills(limit: int = 200):
    """Lightweight skill listing. Walks memory/skill_search/ for *.md / *.json / *.py."""
    sd = _skill_dir()
    if not os.path.isdir(sd):
        return {"skills": [], "count": 0}
    out = []
    LISTED_EXT = {".md", ".json", ".py"}
    for root, _dirs, files in os.walk(sd):
        for name in files:
            if os.path.splitext(name)[1].lower() not in LISTED_EXT:
                continue
            p = os.path.join(root, name)
            rel = os.path.relpath(p, sd)
            try:
                st = os.stat(p)
                out.append({
                    "path": rel,
                    "name": name,
                    "size": st.st_size,
                    "mtime": int(st.st_mtime),
                })
            except OSError:
                pass
            if len(out) >= limit:
                break
        if len(out) >= limit:
            break
    return {"skills": out, "count": len(out)}


@router.get("/api/memory/skills/read")
async def read_skill(path: str):
    if ".." in path or path.startswith("/"):
        raise HTTPException(400, "bad path")
    # Restrict to extensions we list (defensive — caller can't path-traverse,
    # but we still don't want to serve arbitrary binaries).
    ext = os.path.splitext(path)[1].lower()
    if ext not in {".md", ".json", ".py", ".txt", ".yaml", ".yml"}:
        raise HTTPException(400, f"not a readable text file: {ext}")
    p = os.path.join(_skill_dir(), path)
    if not os.path.isfile(p):
        raise HTTPException(404, "not found")
    return {"path": path, "content": _read(p)}


@router.get("/api/memory/skills/search")
async def search_skills(q: str, limit: int = 60):
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
    needle = q.lower()
    sd = _skill_dir()
    if not os.path.isdir(sd):
        return {"hits": [], "scanned": 0, "truncated": False}

    READABLE_EXT = {".md", ".json", ".py", ".txt", ".yaml", ".yml", ".sh", ""}
    MAX_FILE_BYTES = 512 * 1024     # skip pathological files
    PER_FILE_HITS = 5               # cap matches per file in the preview
    hits: list[dict[str, Any]] = []
    scanned = 0
    truncated = False

    for root, _dirs, files in os.walk(sd):
        for name in files:
            ext = os.path.splitext(name)[1].lower()
            if ext not in READABLE_EXT:
                continue
            p = os.path.join(root, name)
            try:
                if os.path.getsize(p) > MAX_FILE_BYTES:
                    continue
                scanned += 1
                with open(p, encoding="utf-8", errors="replace") as f:
                    matches: list[dict[str, Any]] = []
                    for i, line in enumerate(f, start=1):
                        if needle in line.lower():
                            matches.append({
                                "line": i,
                                "text": line.rstrip("\n")[:240],
                            })
                            if len(matches) >= PER_FILE_HITS:
                                break
                    if matches:
                        hits.append({
                            "path": os.path.relpath(p, sd),
                            "matches": matches,
                        })
                        if len(hits) >= limit:
                            truncated = True
                            break
            except OSError:
                continue
        if len(hits) >= limit:
            truncated = True
            break

    return {"hits": hits, "scanned": scanned, "truncated": truncated, "query": q}
