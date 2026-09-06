"""Conversation history routes — read GA's raw session archives
(temp/model_responses/*.txt) and browse memory/L4_raw_sessions/ archives.

Mostly read-only with respect to GA: `restore` loads a chosen archive into
the agent's in-memory working history via GA's own `restore()` helper, and
`delete` unlinks the archive file itself (which lives under GA's temp/
through the sessions junction). Nothing else writes into GA's files.

GA enumeration/signature/lookup mechanics live in the archive service
(`services/archive_messages.py`); this route keeps HTTP shaping, title
metadata, delete orchestration, restore, export and ZIP browsing.
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

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import PlainTextResponse, Response

from .. import _paths
from ..schemas import (
    ConversationUpdate,
    ConversationListResp,
    ConversationDetailResp,
    ConversationMutationResp,
    ConversationUpdateResp,
    ConversationRestoreResp,
    ArchiveZipListResp,
    ArchiveZipEntryListResp,
)
from ..services.archive_messages import (
    archive_contains,
    archive_session_by_id,
    first_user_preview,
    invalidate_archive_catalogue,
    list_archive_sessions,
    read_ui_messages,
    restore_ga_archive,
    refresh_archive_catalogue,
)
from ..services.conversation_titles import migrate_legacy_titles
from ..services.session_coordinator import AgentBusyError, SessionControlBusyError
from ..services.session_metadata import SessionMetadataStore

log = logging.getLogger(__name__)
router = APIRouter()
_metadata = SessionMetadataStore()
_legacy_titles_migrated = False
_legacy_titles_lock = threading.Lock()
_ZIP_ENTRY_MAX_SIZE = 10 * 1024 * 1024
_ZIP_READ_CHUNK_SIZE = 64 * 1024


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


# ── GA archive helpers ────────────────────────────────────────────
def run_legacy_title_migration_once() -> None:
    """Sweep legacy titles once; run from lifespan startup, off the event loop.

    The sid→path map doubles as the resolver for the migration: sessions
    absent from the catalogue no longer exist, so their stale titles are
    dropped with the sidecar file. Never raises — a failed sweep stays
    unmarked so the next process retries it (the flag moves only on the
    success paths, never before the work).
    """
    global _legacy_titles_migrated
    if _legacy_titles_migrated:
        return
    with _legacy_titles_lock:
        if _legacy_titles_migrated:
            return
        try:
            index = refresh_archive_catalogue()
            if not index:
                # Nothing to resolve; count as done so boots stop rescanning.
                _legacy_titles_migrated = True
                return
            migrate_legacy_titles(
                _metadata,
                lambda sid: (index.get(sid) or (None,))[0],
            )
            _legacy_titles_migrated = True
        except Exception:
            log.exception("legacy conversation title migration failed")


def _ga_extract(path: str):
    """Extract UI messages through the shared GA archive adapter."""
    return read_ui_messages(path)


def _restore_archive(agent, path: str):
    """Run GA's blocking restore and archive projection off the event loop."""
    restore_ga_archive(agent, path)
    return _ga_extract(path)


# ── conversation list / detail / export / restore ─────────────────
def _list_conversations_sync(
    q: str | None,
    offset: int,
    limit: int,
):
    sessions = list_archive_sessions()
    items = []
    for path, mtime, preview, rounds in sessions:
        cid = os.path.basename(path)
        items.append({
            "id": cid,
            "title": _metadata.title_for_archive(path),
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
            if archive_contains(path, ql):
                keep.append(it)
        items = keep
    total = len(items)
    page = items[offset: offset + limit]
    for item in page:
        path = item.pop("_archive_path")
        item["original_user_preview"] = (
            "" if item["title"] else first_user_preview(path)
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
    # Catalogue refresh stats/scans the archive dir — keep it off the loop.
    s = await asyncio.to_thread(archive_session_by_id, cid)
    if s is None:
        raise HTTPException(404, "conversation not found")
    path = s[0]
    messages = await asyncio.to_thread(_ga_extract, path)
    title = await asyncio.to_thread(_metadata.title_for_archive, path)
    return {
        "id": cid,
        "title": title,
        "messages": messages,
    }


@router.patch(
    "/api/conversations/{cid}",
    response_model=ConversationUpdateResp,
)
async def update_conversation(cid: str, req: ConversationUpdate):
    # Catalogue refresh stats/scans the archive dir — keep it off the loop.
    s = await asyncio.to_thread(archive_session_by_id, cid)
    if s is None:
        raise HTTPException(404, "conversation not found")
    title = req.title.strip()
    await asyncio.to_thread(_metadata.set_title_for_archive, s[0], title)
    return {"ok": True, "id": cid, "title": title}


@router.delete(
    "/api/conversations/{cid}",
    response_model=ConversationMutationResp,
)
async def delete_conversation(cid: str):
    # Catalogue refresh stats/scans the archive dir — keep it off the loop.
    s = await asyncio.to_thread(archive_session_by_id, cid)
    if s is None:
        raise HTTPException(404, "conversation not found")
    path = Path(s[0]).resolve()
    bound_session = await asyncio.to_thread(_metadata.find_by_archive, path)
    if bound_session is not None:
        from ..routes import sessions as session_routes
        # Peek (never construct) and keep the shutdown admission gate — same
        # refusal semantics as every other runtime-touching endpoint.
        coordinator = session_routes.peek_coordinator()
        if coordinator is not None:
            def _delete_archive() -> None:
                # The binding was resolved before this session reservation was
                # acquired. Refuse rather than unlink through a reservation that
                # may now belong to a different archive identity.
                current_binding = _metadata.find_by_archive(path)
                if current_binding and current_binding["id"] != bound_session["id"]:
                    raise HTTPException(409, {
                        "code": "archive_binding_changed",
                        "detail": "该归档的绑定会话已变化，请刷新后重试。",
                        "session_id": current_binding["id"],
                    })
                _unlink_archive(cid, path)

            try:
                # runtime.shutdown() joins worker threads — keep it off the loop.
                await asyncio.to_thread(
                    coordinator.release_runtime,
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

            invalidate_archive_catalogue()
            return {"ok": True, "id": cid}

    await asyncio.to_thread(_unlink_archive, cid, path)
    invalidate_archive_catalogue()
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
    _metadata.delete_by_archive(path)


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

    # Catalogue refresh stats/scans the archive dir — keep it off the loop.
    s = await asyncio.to_thread(archive_session_by_id, cid)
    if s is None:
        raise HTTPException(404, "conversation not found")
    path = s[0]

    svc = AgentService.instance()
    messages = await asyncio.to_thread(_restore_archive, svc.agent, path)
    svc.reset_live_snapshots("restore_conversation")

    return {
        "ok": True,
        "id": cid,
        "title": await asyncio.to_thread(_metadata.title_for_archive, path),
        "restored_lines": len(messages),
    }


@router.get("/api/conversations/{cid}/export")
async def export_conversation(cid: str, format: str = Query("md", pattern="^(md|json)$")):
    # Catalogue refresh stats/scans the archive dir — keep it off the loop.
    s = await asyncio.to_thread(archive_session_by_id, cid)
    if s is None:
        raise HTTPException(404, "conversation not found")
    path = s[0]
    messages = await asyncio.to_thread(_ga_extract, path)
    title = await asyncio.to_thread(_metadata.title_for_archive, path)

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


def _list_zip_entries_sync(path: str) -> dict:
    with zipfile.ZipFile(path) as z:
        return {"entries": [
            {"name": i.filename, "size": i.file_size, "date": list(i.date_time)}
            for i in z.infolist()
            if not i.is_dir()
        ]}


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
        # Zip listing reads the central directory — keep it off the loop.
        return await asyncio.to_thread(_list_zip_entries_sync, p)
    except Exception as e:
        raise HTTPException(500, str(e))


def _read_zip_entry_sync(path: str, entry: str) -> bytes:
    with zipfile.ZipFile(path) as z:
        info = z.getinfo(entry)
        if info.file_size > _ZIP_ENTRY_MAX_SIZE:
            raise ZipEntryTooLarge
        with z.open(entry) as f:
            return _read_zip_entry_limited(f)


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
        # Decompression is bounded but still disk IO — keep it off the loop.
        data = await asyncio.to_thread(_read_zip_entry_sync, p, entry)
    except KeyError:
        raise HTTPException(404, "entry not found")
    except ZipEntryTooLarge:
        raise HTTPException(413, "zip entry too large")
    except Exception as e:
        raise HTTPException(500, str(e))
    try:
        text = data.decode("utf-8")
        return PlainTextResponse(content=text, media_type="text/plain; charset=utf-8")
    except UnicodeDecodeError:
        return Response(content=data, media_type="application/octet-stream")
