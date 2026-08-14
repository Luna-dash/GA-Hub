"""Conversation history routes — read GA's raw session archives
(temp/model_responses/*.txt) and browse memory/L4_raw_sessions/ archives.

Read-only with respect to GA: we never write back to GA's files. The only
mutating action is `restore`, which loads a chosen archive into the agent's
in-memory working history via GA's own `restore()` helper.
"""
from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import threading
import zipfile
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import PlainTextResponse, Response
from pydantic import BaseModel, Field

from .. import _paths
from ..services.archive_messages import read_ui_messages
from ..services.conversation_metadata import ConversationMetadataAdapter
from ..services.conversation_titles import ConversationTitleStore
from ..services.session_coordinator import AgentBusyError, SessionControlBusyError
from ..services.session_metadata import SessionMetadataStore

log = logging.getLogger(__name__)
router = APIRouter()
_metadata = ConversationMetadataAdapter(
    SessionMetadataStore(), ConversationTitleStore()
)
_ZIP_ENTRY_MAX_SIZE = 10 * 1024 * 1024
_ZIP_READ_CHUNK_SIZE = 64 * 1024
_session_index_lock = threading.Lock()
_session_index_state = None
_session_index: dict[str, tuple] = {}


class ZipEntryTooLarge(Exception):
    pass


def _read_zip_entry_limited(entry) -> bytes:
    data = bytearray()
    while True:
        chunk = entry.read(_ZIP_READ_CHUNK_SIZE)
        if not chunk:
            return bytes(data)
        if len(data) + len(chunk) > _ZIP_ENTRY_MAX_SIZE:
            raise ZipEntryTooLarge
        data.extend(chunk)


class ConversationUpdate(BaseModel):
    title: str = Field(default="", max_length=200)


class ConversationSummaryResp(BaseModel):
    id: str
    title: str
    message_count: int
    last_user_preview: str
    original_user_preview: str


class ConversationListResp(BaseModel):
    total: int
    offset: int
    limit: int
    items: list[ConversationSummaryResp]


class ConversationMessageResp(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ConversationDetailResp(BaseModel):
    id: str
    title: str
    messages: list[ConversationMessageResp]


class ConversationMutationResp(BaseModel):
    ok: bool
    id: str


class ConversationUpdateResp(ConversationMutationResp):
    title: str


class ConversationRestoreResp(ConversationMutationResp):
    title: str
    restored_lines: int
    full: bool = True


class ArchiveZipResp(BaseModel):
    name: str
    size: int
    mtime: int


class ArchiveZipListResp(BaseModel):
    zips: list[ArchiveZipResp]


class ArchiveZipEntryResp(BaseModel):
    name: str
    size: int
    date: tuple[int, int, int, int, int, int]


class ArchiveZipEntryListResp(BaseModel):
    entries: list[ArchiveZipEntryResp]


# ── GA archive helpers ────────────────────────────────────────────
def _ga_sessions():
    """Return GA's session list, mirroring server/routes/agent.py.

    list_sessions() -> [(path, mtime, preview, n_rounds)] sorted by mtime desc.
    Importing inside the function keeps the (optional) GA path injection local
    and matches the established pattern in agent.py.
    """
    from frontends.continue_cmd import list_sessions

    return list_sessions()


def _session_index_signature():
    root = _paths.GA_ROOT
    if root is None:
        return ()
    archive_dir = Path(root) / "temp" / "model_responses"
    entries = []
    try:
        paths = archive_dir.glob("model_responses_*.txt")
        for path in paths:
            try:
                stat = path.stat()
                entries.append((path.name, stat.st_mtime_ns, stat.st_size))
            except OSError:
                continue
    except OSError:
        return ()
    return tuple(sorted(entries))


def _invalidate_session_index() -> None:
    global _session_index_state, _session_index
    with _session_index_lock:
        _session_index_state = None
        _session_index = {}


def _refresh_session_index() -> dict[str, tuple]:
    global _session_index_state, _session_index
    signature = _session_index_signature()
    with _session_index_lock:
        if signature != _session_index_state:
            rows = _ga_sessions()
            index = {}
            for row in rows:
                index.setdefault(os.path.basename(row[0]), row)
            _session_index = index
            _session_index_state = signature
        return _session_index


def _ga_extract(path: str):
    """Extract UI messages through the shared GA archive adapter."""
    return read_ui_messages(path)


def _restore_archive(agent, path: str):
    """Run GA's blocking restore and archive projection off the event loop."""
    from frontends.continue_cmd import restore

    restore(agent, path)
    return _ga_extract(path)


def _session_by_id(cid: str):
    """Find a GA session tuple by its basename id."""
    return _refresh_session_index().get(cid)


def _conversation_title(cid: str, path: str) -> str:
    return _metadata.get_title(cid, path)


def _first_user_preview(path: str) -> str:
    """Return the original user question used as the default display title."""
    try:
        messages = _ga_extract(path)
    except (OSError, ValueError, TypeError, UnicodeError):
        return ""
    for message in messages:
        if message.get("role") != "user":
            continue
        content = str(message.get("content") or "")
        return " ".join(content.split())[:200]
    return ""


# ── conversation list / detail / export / restore ─────────────────
def _list_conversations_sync(
    q: str | None,
    offset: int,
    limit: int,
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
            "_archive_path": path,
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
    for item in page:
        path = item.pop("_archive_path")
        item["original_user_preview"] = (
            "" if item["title"] else _first_user_preview(path)
        )
    return {
        "total": total,
        "offset": offset,
        "limit": limit,
        "items": page,
    }


@router.get("/api/conversations", response_model=ConversationListResp)
async def list_conversations(
    q: str | None = None,
    offset: int = 0,
    limit: int = 50,
):
    return await asyncio.to_thread(_list_conversations_sync, q, offset, limit)


@router.get("/api/conversations/{cid}", response_model=ConversationDetailResp)
async def get_conversation(cid: str):
    s = _session_by_id(cid)
    if s is None:
        raise HTTPException(404, "conversation not found")
    path = s[0]
    messages = await asyncio.to_thread(_ga_extract, path)
    return {
        "id": cid,
        "title": _conversation_title(cid, path),
        "messages": messages,
    }


@router.patch(
    "/api/conversations/{cid}",
    response_model=ConversationUpdateResp,
)
async def update_conversation(cid: str, req: ConversationUpdate):
    s = _session_by_id(cid)
    if s is None:
        raise HTTPException(404, "conversation not found")
    title = req.title.strip()
    _metadata.set_title(cid, s[0], title)
    return {"ok": True, "id": cid, "title": title}


@router.delete(
    "/api/conversations/{cid}",
    response_model=ConversationMutationResp,
)
async def delete_conversation(cid: str):
    s = _session_by_id(cid)
    if s is None:
        raise HTTPException(404, "conversation not found")
    path = Path(s[0]).resolve()
    bound_session = _metadata._sessions.find_by_archive(path)
    if bound_session is not None:
        from ..routes import sessions as session_routes
        coordinator = session_routes._coordinator
        if coordinator is not None:
            def _delete_archive() -> None:
                # The binding was resolved before this session reservation was
                # acquired. Refuse rather than unlink through a reservation that
                # may now belong to a different archive identity.
                current_binding = _metadata._sessions.find_by_archive(path)
                if current_binding and current_binding["id"] != bound_session["id"]:
                    raise HTTPException(409, {
                        "code": "archive_binding_changed",
                        "session_id": current_binding["id"],
                    })
                _unlink_archive(cid, path)

            try:
                coordinator.release_runtime(
                    bound_session["id"],
                    shutdown=lambda runtime: runtime.shutdown(),
                    operation="archive_delete",
                    after_release=_delete_archive,
                )
            except AgentBusyError as exc:
                raise HTTPException(409, {
                    "code": "session_active",
                    "run_id": exc.active_run_id,
                    "session_id": bound_session["id"],
                })
            except SessionControlBusyError as exc:
                raise HTTPException(409, {
                    "code": "session_control_active",
                    "operation": exc.operation,
                    "session_id": bound_session["id"],
                })

            _invalidate_session_index()
            return {"ok": True, "id": cid}

    _unlink_archive(cid, path)
    _invalidate_session_index()
    return {"ok": True, "id": cid}


def _unlink_archive(cid: str, path: Path) -> None:
    """Delete an archive whose identity was resolved from GA enumeration."""
    try:
        path.unlink()
    except FileNotFoundError:
        raise HTTPException(404, "conversation not found")
    except OSError as exc:
        log.exception("failed to delete conversation %s", cid)
        raise HTTPException(500, f"failed to delete conversation: {exc}")
    _metadata.delete(cid, path)


@router.post(
    "/api/conversations/{cid}/restore",
    response_model=ConversationRestoreResp,
)
async def restore_conversation(cid: str):
    """Restore a GA archive as the agent's working history.

    Delegates to GA's native ``restore(agent, path)`` which rebuilds the
    backend's history from the raw log, then resets the WebUI live snapshots
    (mirrors server/routes/agent.py restore-session behaviour) so reconnecting
    clients don't replay stale bubbles.
    """
    from ..services.agent_service import AgentService
    from ..services.event_bus import bus

    s = _session_by_id(cid)
    if s is None:
        raise HTTPException(404, "conversation not found")
    path = s[0]

    svc = AgentService.instance()
    messages = await asyncio.to_thread(_restore_archive, svc.agent, path)
    with svc._lock:
        svc._snapshots.clear()
    bus.publish("chat:reset", {"reason": "restore_conversation"})

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
    messages = await asyncio.to_thread(_ga_extract, path)
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


@router.get("/api/archive/zips", response_model=ArchiveZipListResp)
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


@router.get(
    "/api/archive/zips/{name}/entries",
    response_model=ArchiveZipEntryListResp,
)
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
            info = z.getinfo(entry)
            if info.file_size > _ZIP_ENTRY_MAX_SIZE:
                raise ZipEntryTooLarge
            with z.open(entry) as f:
                data = _read_zip_entry_limited(f)
        try:
            text = data.decode("utf-8")
            return PlainTextResponse(content=text, media_type="text/plain; charset=utf-8")
        except UnicodeDecodeError:
            return Response(content=data, media_type="application/octet-stream")
    except KeyError:
        raise HTTPException(404, "entry not found")
    except ZipEntryTooLarge:
        raise HTTPException(413, "zip entry too large")
    except Exception as e:
        raise HTTPException(500, str(e))
