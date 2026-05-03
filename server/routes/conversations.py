"""Conversation history routes — read/edit/export memory/chat_history.json
plus browse memory/L4_raw_sessions/ archives."""
from __future__ import annotations

import io
import json
import logging
import os
import zipfile
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import PlainTextResponse, Response

from ..schemas import ConvRename
from .. import _paths

log = logging.getLogger(__name__)
router = APIRouter()


def _history_file() -> str:
    return str(_paths.memory_dir() / "chat_history.json")


def _archive_dir() -> str:
    return str(_paths.memory_dir() / "L4_raw_sessions")


def _load_all() -> list[dict]:
    hf = _history_file()
    if not os.path.isfile(hf):
        return []
    try:
        with open(hf, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            return data
        return []
    except Exception as e:
        log.warning("failed to load chat_history.json: %s", e)
        return []


def _save_all(data: list[dict]) -> None:
    hf = _history_file()
    tmp = hf + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, hf)


def _summary(c: dict) -> dict:
    msgs = c.get("messages") or []
    last_user = ""
    for m in reversed(msgs):
        if m.get("role") == "user":
            last_user = (m.get("content") or "")[:120]
            break
    return {
        "id": c.get("id"),
        "title": c.get("title"),
        "message_count": len(msgs),
        "last_user_preview": last_user,
    }


@router.get("/api/conversations")
async def list_conversations(
    q: str | None = None,
    offset: int = 0,
    limit: int = 50,
):
    all_ = _load_all()
    if q:
        ql = q.lower()
        filtered = []
        for c in all_:
            t = (c.get("title") or "").lower()
            if ql in t:
                filtered.append(c); continue
            for m in c.get("messages") or []:
                if ql in (m.get("content") or "").lower():
                    filtered.append(c); break
        all_ = filtered
    total = len(all_)
    page = list(reversed(all_))[offset: offset + limit]   # newest first
    return {
        "total": total,
        "offset": offset,
        "limit": limit,
        "items": [_summary(c) for c in page],
    }


@router.get("/api/conversations/{cid}")
async def get_conversation(cid: str):
    for c in _load_all():
        if c.get("id") == cid:
            return c
    raise HTTPException(404, "conversation not found")


@router.post("/api/conversations/{cid}/restore")
async def restore_conversation(cid: str):
    """Restore a chat_history.json conversation as the agent's working history.

    chat_history.json messages only carry plain ``{role, content}`` text — we
    can't reconstruct native API blocks. So we do **summary-level** restore:
    each message becomes a ``[USER]: ...`` or ``[Agent] ...`` line in
    ``agent.history`` (which gets injected into the next system prompt as
    ``<history>...</history>``). The agent reads this and continues with full
    awareness of what was discussed before.

    For native, full-context restore use ``POST /api/agent/sessions/{idx}/restore``
    (which reads ``temp/model_responses/`` snapshots).
    """
    target = None
    for c in _load_all():
        if c.get("id") == cid:
            target = c
            break
    if target is None:
        raise HTTPException(404, "conversation not found")

    # Build summary lines (cap each message to 500 chars to keep context lean)
    history_lines: list[str] = []
    for m in target.get("messages") or []:
        role = m.get("role", "")
        content = (m.get("content") or "").strip()
        if not content:
            continue
        # Strip the noisy "LLM Running (Turn N) ..." markers and tool tags
        # so the summary stays readable in the system prompt.
        content = _summarize(content)
        if not content:
            continue
        if role == "user":
            history_lines.append(f"[USER]: {content[:500]}")
        elif role == "assistant":
            history_lines.append(f"[Agent] {content[:500]}")

    # Apply via the running agent service (lazy import — only available in normal mode)
    from ..services.agent_service import AgentService
    svc = AgentService.instance()
    svc.agent.abort()
    svc.agent.history = history_lines
    # Clear the LLM backend history so we don't mix stale native blocks with
    # the new summary; the agent will rebuild context from agent.history next turn.
    for client in getattr(svc.agent, "llmclients", []) or []:
        backend = getattr(client, "backend", None)
        if backend is not None and hasattr(backend, "history"):
            backend.history = []
        if hasattr(client, "last_tools"):
            client.last_tools = ""

    return {
        "ok": True,
        "restored_lines": len(history_lines),
        "title": target.get("title") or cid,
        "id": cid,
    }


# ── helpers ─────────────────────────────────────────────────────
import re as _re

_NOISE_PATTERNS = [
    _re.compile(r"\*{0,2}LLM Running \(Turn \d+\) \.{3}\*{0,2}\n*", _re.M),
    _re.compile(r"<thinking>[\s\S]*?</thinking>", _re.M),
    _re.compile(r"<tool_use>[\s\S]*?</tool_use>", _re.M),
    _re.compile(r"<file_content>[\s\S]*?</file_content>", _re.M),
    _re.compile(r"<summary>([\s\S]*?)</summary>", _re.M),       # keep summary text
    _re.compile(r"^🛠️\s*[A-Za-z_][A-Za-z0-9_]*\(.*$", _re.M),
    _re.compile(r"`{3,}[\s\S]*?`{3,}", _re.M),
]


def _summarize(text: str) -> str:
    """Squeeze a verbose agent message down to its <summary> + visible prose."""
    # Pull out <summary> blocks first (these are the agent's own short version)
    summaries = _NOISE_PATTERNS[4].findall(text)
    if summaries:
        return " · ".join(s.strip() for s in summaries if s.strip())[:500]
    out = text
    for p in _NOISE_PATTERNS[:4] + _NOISE_PATTERNS[5:]:
        out = p.sub("", out)
    out = _re.sub(r"\n{3,}", "\n\n", out).strip()
    return out


@router.patch("/api/conversations/{cid}")
async def rename_conversation(cid: str, req: ConvRename):
    all_ = _load_all()
    for c in all_:
        if c.get("id") == cid:
            c["title"] = req.title
            _save_all(all_)
            return {"ok": True}
    raise HTTPException(404, "conversation not found")


@router.delete("/api/conversations/{cid}")
async def delete_conversation(cid: str):
    all_ = _load_all()
    new = [c for c in all_ if c.get("id") != cid]
    if len(new) == len(all_):
        raise HTTPException(404, "conversation not found")
    _save_all(new)
    return {"ok": True}


@router.get("/api/conversations/{cid}/export")
async def export_conversation(cid: str, format: str = Query("md", pattern="^(md|json)$")):
    for c in _load_all():
        if c.get("id") == cid:
            if format == "json":
                return Response(
                    content=json.dumps(c, ensure_ascii=False, indent=2),
                    media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="{cid}.json"'},
                )
            buf = io.StringIO()
            buf.write(f"# {c.get('title') or cid}\n\n")
            buf.write(f"_id: {cid}_\n\n---\n\n")
            for m in c.get("messages") or []:
                role = m.get("role", "")
                buf.write(f"## {role}\n\n{m.get('content', '')}\n\n")
            return PlainTextResponse(
                content=buf.getvalue(),
                media_type="text/markdown",
                headers={"Content-Disposition": f'attachment; filename="{cid}.md"'},
            )
    raise HTTPException(404, "conversation not found")


# ── L4 archive browsing ──────────────────────────────────────────
@router.get("/api/archive/zips")
async def list_archive_zips():
    adir = _archive_dir()
    if not os.path.isdir(adir):
        return {"zips": []}
    zips = []
    for n in sorted(os.listdir(adir), reverse=True):
        if n.endswith(".zip"):
            p = os.path.join(adir, n)
            try:
                st = os.stat(p)
                zips.append({"name": n, "size": st.st_size, "mtime": int(st.st_mtime)})
            except OSError:
                pass
    return {"zips": zips}


@router.get("/api/archive/zips/{name}/entries")
async def list_zip_entries(name: str):
    if "/" in name or ".." in name or not name.endswith(".zip"):
        raise HTTPException(400, "bad name")
    p = os.path.join(_archive_dir(), name)
    if not os.path.isfile(p):
        raise HTTPException(404, "zip not found")
    try:
        with zipfile.ZipFile(p) as z:
            return {"entries": [
                {"name": i.filename, "size": i.file_size, "date": list(i.date_time)}
                for i in z.infolist()
                if not i.is_dir()
            ]}
    except Exception as e:
        raise HTTPException(500, str(e))


@router.get("/api/archive/zips/{name}/read")
async def read_zip_entry(name: str, entry: str):
    if "/" in name or ".." in name or not name.endswith(".zip"):
        raise HTTPException(400, "bad name")
    if ".." in entry:
        raise HTTPException(400, "bad entry")
    p = os.path.join(_archive_dir(), name)
    if not os.path.isfile(p):
        raise HTTPException(404, "zip not found")
    try:
        with zipfile.ZipFile(p) as z:
            with z.open(entry) as f:
                data = f.read()
        try:
            text = data.decode("utf-8")
            return PlainTextResponse(content=text, media_type="text/plain; charset=utf-8")
        except UnicodeDecodeError:
            return Response(content=data, media_type="application/octet-stream")
    except KeyError:
        raise HTTPException(404, "entry not found")
    except Exception as e:
        raise HTTPException(500, str(e))
