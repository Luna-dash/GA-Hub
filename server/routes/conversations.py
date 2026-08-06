"""Conversation history routes — read GA's raw session archives
(temp/model_responses/*.txt) and browse memory/L4_raw_sessions/ archives.

Read-only with respect to GA: we never write back to GA's files. The only
mutating action is `restore`, which loads a chosen archive into the agent's
in-memory working history via GA's own `restore()` helper.
"""
from __future__ import annotations

import io
import json
import logging
import os
import zipfile
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import PlainTextResponse, Response
from pydantic import BaseModel, Field

from .. import _paths
from ..services.archive_messages import read_ui_messages
from ..services.conversation_titles import ConversationTitleStore
from ..services.session_metadata import SessionMetadataStore

log = logging.getLogger(__name__)
router = APIRouter()
_title_store = ConversationTitleStore()
_session_store = SessionMetadataStore()


class ConversationUpdate(BaseModel):
    title: str = Field(default="", max_length=200)


# ── GA archive helpers ────────────────────────────────────────────
def _ga_sessions():
    """Return GA's session list, mirroring server/routes/agent.py.

    list_sessions() -> [(path, mtime, preview, n_rounds)] sorted by mtime desc.
    Importing inside the function keeps the (optional) GA path injection local
    and matches the established pattern in agent.py.
    """
    from frontends.continue_cmd import list_sessions

    return list_sessions()


def _ga_extract(path: str):
    """Extract UI messages through the shared GA archive adapter."""
    return read_ui_messages(path)


def _session_by_id(cid: str):
    """Find a GA session tuple by its basename id. Returns (path, mtime, preview, n_rounds) or None."""
    for path, mtime, preview, rounds in _ga_sessions():
        if os.path.basename(path) == cid:
            return (path, mtime, preview, rounds)
    return None


def _conversation_title(cid: str, path: str) -> str:
    resolved = str(Path(path).resolve())
    for row in _session_store.list():
        if row.get("archive_path") and str(Path(row["archive_path"]).resolve()) == resolved:
            title = str(row.get("title") or "").strip()
            if title:
                return title
    return _title_store.get(cid)


def _update_bound_titles(path: str, title: str) -> None:
    resolved = str(Path(path).resolve())
    for row in _session_store.list():
        if row.get("archive_path") and str(Path(row["archive_path"]).resolve()) == resolved:
            _session_store.update(row["id"], {"title": title})


# ── conversation list / detail / export / restore ─────────────────
@router.get("/api/conversations")
async def list_conversations(
    q: str | None = None,
    offset: int = 0,
    limit: int = 50,
):
    sessions = _ga_sessions()
    items = []
    for path, mtime, preview, rounds in sessions:
        cid = os.path.basename(path)
        items.append({
            "id": cid,
            "title": _conversation_title(cid, path),
            "message_count": rounds,
            "last_user_preview": preview,
        })
    if q:
        ql = q.lower()
        # Search id + last-user preview first (cheap). For sessions that miss on
        # those, fall back to scanning the raw archive text so the "search title
        # or content" promise in the UI actually holds (GA archives carry no
        # title and the preview is only the last user message).
        keep = []
        for it, (path, _mt, _pv, _rd) in zip(items, sessions):
            if (ql in it["id"].lower()
                    or ql in (it["title"] or "").lower()
                    or ql in (it["last_user_preview"] or "").lower()):
                keep.append(it)
                continue
            try:
                with open(path, encoding="utf-8", errors="replace") as fh:
                    if ql in fh.read().lower():
                        keep.append(it)
            except OSError:
                continue
        items = keep
    total = len(items)
    page = items[offset: offset + limit]
    return {
        "total": total,
        "offset": offset,
        "limit": limit,
        "items": page,
    }


@router.get("/api/conversations/{cid}")
async def get_conversation(cid: str):
    s = _session_by_id(cid)
    if s is None:
        raise HTTPException(404, "conversation not found")
    path = s[0]
    messages = _ga_extract(path)
    return {
        "id": cid,
        "title": _conversation_title(cid, path),
        "messages": messages,
    }


@router.patch("/api/conversations/{cid}")
async def update_conversation(cid: str, req: ConversationUpdate):
    s = _session_by_id(cid)
    if s is None:
        raise HTTPException(404, "conversation not found")
    title = req.title.strip()
    _title_store.set(cid, title)
    _update_bound_titles(s[0], title)
    return {"ok": True, "id": cid, "title": title}


@router.delete("/api/conversations/{cid}")
async def delete_conversation(cid: str):
    s = _session_by_id(cid)
    if s is None:
        raise HTTPException(404, "conversation not found")
    path = Path(s[0]).resolve()
    # The path is obtained from the current GA archive enumeration; never trust cid as a path.
    try:
        path.unlink()
    except FileNotFoundError:
        raise HTTPException(404, "conversation not found")
    except OSError as exc:
        log.exception("failed to delete conversation %s", cid)
        raise HTTPException(500, f"failed to delete conversation: {exc}")
    _title_store.delete(cid)
    return {"ok": True, "id": cid}


@router.post("/api/conversations/{cid}/restore")
async def restore_conversation(cid: str):
    """Restore a GA archive as the agent's working history.

    Delegates to GA's native ``restore(agent, path)`` which rebuilds the
    backend's history from the raw log, then resets the WebUI live snapshots
    (mirrors server/routes/agent.py restore-session behaviour) so reconnecting
    clients don't replay stale bubbles.
    """
    from frontends.continue_cmd import restore
    from ..services.agent_service import AgentService
    from ..services.event_bus import bus

    s = _session_by_id(cid)
    if s is None:
        raise HTTPException(404, "conversation not found")
    path = s[0]

    svc = AgentService.instance()
    msg, full = restore(svc.agent, path)
    with svc._lock:
        svc._snapshots.clear()
    bus.publish("chat:reset", {"reason": "restore_conversation"})

    messages = _ga_extract(path)
    return {
        "ok": True,
        "id": cid,
        "title": _conversation_title(cid, path),
        "restored_lines": len(messages),
    }


@router.get("/api/conversations/{cid}/export")
async def export_conversation(cid: str, format: str = Query("md", pattern="^(md|json)$")):
    s = _session_by_id(cid)
    if s is None:
        raise HTTPException(404, "conversation not found")
    path = s[0]
    messages = _ga_extract(path)
    title = _conversation_title(cid, path)

    if format == "json":
        payload = {"id": cid, "title": title, "messages": messages}
        return Response(
            content=json.dumps(payload, ensure_ascii=False, indent=2),
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="{cid}.json"'},
        )
    buf = io.StringIO()
    buf.write(f"# {title}\n\n")
    buf.write(f"_id: {cid}_\n\n---\n\n")
    for m in messages:
        role = m.get("role", "")
        buf.write(f"## {role}\n\n{m.get('content', '')}\n\n")
    return PlainTextResponse(
        content=buf.getvalue(),
        media_type="text/markdown",
        headers={"Content-Disposition": f'attachment; filename="{cid}.md"'},
    )


# ── L4 archive browsing (read-only) ───────────────────────────────
def _archive_dir() -> str:
    return str(_paths.memory_dir() / "L4_raw_sessions")


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
