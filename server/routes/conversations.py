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
import contextvars
import io
import json
import logging
import os
import threading
import zipfile
from pathlib import Path
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import PlainTextResponse, Response

from .. import _paths
from ..schemas import (
    ConversationUpdate,
    ConversationListResp,
    ConversationDetailResp,
    ConversationMutationResp,
    ConversationUpdateResp,
    ConversationRestoreReq,
    ConversationRestoreResp,
    ConversationImportResp,
    ArchiveZipListResp,
    ArchiveZipEntryListResp,
)
from ..services.archive_import import (
    ArchiveNotImportableError,
    copy_archive_for_import,
)
from ..services.archive_messages import (
    HistoryUnavailableError,
    archive_contains,
    archive_session_by_id,
    first_user_has_file_hint,
    first_user_preview,
    invalidate_archive_catalogue,
    list_archive_sessions,
    read_ui_messages,
    read_archive_counts,
    refresh_archive_catalogue,
)
from ..services.conversation_titles import migrate_legacy_titles
from ..services.session_coordinator import (
    AgentBusyError,
    SessionControlBusyError,
    SessionCoordinatorStoppedError,
)
from ..services.session_lifecycle import SessionLifecycle, session_lifecycle_of
from ..services.session_metadata import SessionMetadataStore, is_archive_metadata_id

log = logging.getLogger(__name__)
router = APIRouter()


class _LazyMetadataProxy:
    """Lazy fallback store for standalone unit callers; routes prefer app.state."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._store: SessionMetadataStore | None = None

    def _target(self) -> SessionMetadataStore:
        store = self._store
        if store is None:
            with self._lock:
                store = self._store
                if store is None:
                    store = self._store = SessionMetadataStore()
        return store

    def _has_overrides(self) -> bool:
        for key, value in self.__dict__.items():
            if key in {"_lock", "_store"}:
                continue
            if self._store is None or value != getattr(self._store, key, object()):
                return True
        return False

    def __getattr__(self, name: str) -> Any:
        return getattr(self._target(), name)


_DEFAULT_METADATA = _LazyMetadataProxy()
_metadata: Any = _DEFAULT_METADATA
_scoped_metadata: contextvars.ContextVar[Any] = contextvars.ContextVar(
    "_scoped_metadata", default=None
)
_legacy_titles_migrated = False
_legacy_titles_lock = threading.Lock()
_ZIP_ENTRY_MAX_SIZE = 10 * 1024 * 1024


def _metadata_for(target: Request | SessionLifecycle | Any | None = None) -> Any:
    """Resolve the app-owned metadata store unless a test explicitly patched ``_metadata``."""
    if _metadata is not _DEFAULT_METADATA or _DEFAULT_METADATA._has_overrides():
        return _metadata
    if isinstance(target, SessionLifecycle):
        return target.store
    if isinstance(target, Request):
        lifecycle = getattr(target.app.state, "session_lifecycle", None)
        if lifecycle is not None:
            return lifecycle.store
    if target is not None and hasattr(target, "find_by_archive"):
        return target
    scoped = _scoped_metadata.get()
    if scoped is not None:
        return scoped
    return _DEFAULT_METADATA


def _request_lifecycle(request: Request) -> SessionLifecycle:
    return session_lifecycle_of(request.app)


# The run coordinator belongs to the app-owned session domain; this route no
# longer reaches into a sibling route for it.
SessionDomain = Annotated[SessionLifecycle, Depends(_request_lifecycle)]
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
def run_legacy_title_migration_once(metadata: Any = None) -> None:
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
                _metadata_for(metadata),
                lambda sid: (index.get(sid) or (None,))[0],
            )
            _legacy_titles_migrated = True
        except Exception:
            log.exception("legacy conversation title migration failed")


def _ga_extract(path: str):
    """Extract UI messages through the shared GA archive adapter."""
    return read_ui_messages(path)


# ── conversation list / detail / export / restore ─────────────────
def _bound_session_id(archive_path, metadata: Any = None) -> str | None:
    """Hub session owning this archive, or None when it is free to import.

    Surfaced on every listing row so the UI can tell "open that session" from
    "import as a new session" without a second lookup per row.

    Title-only ``archive-<sha>`` rows are not bindings: they are what
    ``set_title_for_archive`` mints when a user renames an *unbound* archive,
    and they own no runtime. Counting one would strand the archive — renaming
    it would flip the row to "open that session" forever (and 409 the import).
    """
    store = metadata if metadata is not None else _metadata_for()
    row = store.find_by_archive(archive_path)
    if not row:
        return None
    session_id = str(row["id"])
    return None if is_archive_metadata_id(session_id) else session_id


def _conversation_source(archive_path, metadata: Any = None) -> str:
    """Where one archive came from: ``"session"``, ``"im"`` or ``"local"``.

    Deliberately no finer grain: archives do not record which frontend wrote
    them (the IM ``[FILE:...]`` header is identical for every chat frontend), so
    naming one would be a guess.  What the files do tell:

    * ``"session"`` — a real hub session owns this archive.  Goes through
      ``_bound_session_id`` so title-only ``archive-<sha>`` rows stay
      unclassified as bindings here too.
    * ``"im"``      — unbound, but GA's IM frontends injected their FILE_HINT
      header into the first user question.
    * ``"local"``   — the rest: command-line / local runs.
    """
    if _bound_session_id(archive_path, metadata=metadata) is not None:
        return "session"
    return "im" if first_user_has_file_hint(archive_path) else "local"


ConversationSourceFilter = Literal["all", "session", "im", "local"]


def _list_conversations_sync(
    q: str | None,
    offset: int,
    limit: int,
    source: ConversationSourceFilter | None = None,
    metadata: Any = None,
):
    store = metadata if metadata is not None else _metadata_for()
    token = _scoped_metadata.set(store)
    try:
        sessions = list_archive_sessions()
        items = []
        for path, mtime, preview, rounds in sessions:
            cid = os.path.basename(path)
            bound_id = _bound_session_id(path)
            row_source = _conversation_source(path)
            if source and source != "all" and row_source != source:
                continue
            items.append({
                "id": cid,
                "title": store.title_for_archive(path),
                "message_count": rounds,
                "mtime": int(mtime),
                "last_user_preview": preview,
                "bound_session_id": bound_id,
                "source": row_source,
                "_archive_path": path,
            })
        if q:
            ql = q.lower()
            # Search id + last-user preview first (cheap). For sessions that miss on
            # those, fall back to scanning the raw archive text so the "search title
            # or content" promise in the UI actually holds (GA archives carry no
            # title and the preview is only the last user message).
            keep = []
            for it in items:
                path = it["_archive_path"]
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
            try:
                item["dialogue_count"], item["turn_count"] = read_archive_counts(path)
            except HistoryUnavailableError:
                # Concurrent deletion/locking: unknown counts must not appear as zero.
                item["dialogue_count"] = item["turn_count"] = None
            item["original_user_preview"] = (
                "" if item["title"] else first_user_preview(path)
            )
        return {
            "total": total,
            "offset": offset,
            "limit": limit,
            "items": page,
        }
    finally:
        _scoped_metadata.reset(token)


@router.get("/api/conversations", response_model=ConversationListResp)
async def list_conversations(
    q: str | None = None,
    offset: int = 0,
    limit: int = 50,
    source: ConversationSourceFilter | None = None,
    request: Request = None,  # type: ignore[assignment]
):
    store = _metadata_for(request)
    return await asyncio.to_thread(_list_conversations_sync, q, offset, limit, source, store)


@router.get("/api/conversations/{cid}", response_model=ConversationDetailResp)
async def get_conversation(cid: str, request: Request = None):  # type: ignore[assignment]
    store = _metadata_for(request)
    # Catalogue refresh stats/scans the archive dir — keep it off the loop.
    s = await asyncio.to_thread(archive_session_by_id, cid)
    if s is None:
        raise HTTPException(404, "conversation not found")
    path = s[0]
    messages = await asyncio.to_thread(_ga_extract, path)
    title = await asyncio.to_thread(store.title_for_archive, path)
    token = _scoped_metadata.set(store)
    try:
        bound_id = await asyncio.to_thread(_bound_session_id, path)
        source = await asyncio.to_thread(_conversation_source, path)
    finally:
        _scoped_metadata.reset(token)
    return {
        "id": cid,
        "title": title,
        "messages": messages,
        "bound_session_id": bound_id,
        "source": source,
    }


@router.patch(
    "/api/conversations/{cid}",
    response_model=ConversationUpdateResp,
)
async def update_conversation(cid: str, req: ConversationUpdate, request: Request = None):  # type: ignore[assignment]
    store = _metadata_for(request)
    # Catalogue refresh stats/scans the archive dir — keep it off the loop.
    s = await asyncio.to_thread(archive_session_by_id, cid)
    if s is None:
        raise HTTPException(404, "conversation not found")
    title = req.title.strip()
    await asyncio.to_thread(store.set_title_for_archive, s[0], title)
    return {"ok": True, "id": cid, "title": title}


@router.delete(
    "/api/conversations/{cid}",
    response_model=ConversationMutationResp,
)
async def delete_conversation(lifecycle: SessionDomain, cid: str):
    store = _metadata_for(lifecycle)
    # Catalogue refresh stats/scans the archive dir — keep it off the loop.
    s = await asyncio.to_thread(archive_session_by_id, cid)
    if s is None:
        raise HTTPException(404, "conversation not found")
    path = Path(s[0]).resolve()
    bound_session = await asyncio.to_thread(store.find_by_archive, path)
    if bound_session is not None:
        # Peek (never construct) and keep the shutdown admission gate — same
        # refusal semantics as every other runtime-touching endpoint.
        coordinator = lifecycle.peek_coordinator()
        if coordinator is not None:
            def _delete_archive() -> None:
                # The binding was resolved before this session reservation was
                # acquired. Refuse rather than unlink through a reservation that
                # may now belong to a different archive identity.
                current_binding = store.find_by_archive(path)
                if current_binding and current_binding["id"] != bound_session["id"]:
                    raise HTTPException(409, {
                        "code": "archive_binding_changed",
                        "detail": "该归档的绑定会话已变化，请刷新后重试。",
                        "session_id": current_binding["id"],
                    })
                _unlink_archive(cid, path, metadata=store)

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

    await asyncio.to_thread(_unlink_archive, cid, path, store)
    invalidate_archive_catalogue()
    return {"ok": True, "id": cid}


def _unlink_archive(cid: str, path: Path, metadata: Any = None) -> None:
    """Delete an archive whose identity was resolved from GA enumeration."""
    store = metadata if metadata is not None else _metadata_for()
    try:
        path.unlink()
    except FileNotFoundError:
        raise HTTPException(404, "conversation not found")
    except OSError as exc:
        log.exception("failed to delete conversation %s", cid)
        raise HTTPException(500, f"failed to delete conversation: {exc}")
    bound_session = store.find_by_archive(path)
    store.delete_by_archive(path)
    if bound_session is not None:
        from ..services import theme_task_runs
        theme_task_runs.discard(bound_session["id"])


def _session_coordinator(lifecycle: SessionLifecycle):
    """Resolve the shared coordinator from the app-owned session domain."""
    return lifecycle.coordinator()


@router.post(
    "/api/conversations/{cid}/restore",
    response_model=ConversationRestoreResp,
)
async def restore_conversation(
    lifecycle: SessionDomain, cid: str, request: ConversationRestoreReq
):
    """Restore a GA archive as one chat session's working history.

    The archive is loaded into a *fresh* runtime built by the session-scoped
    factory (``archive_override``) and then atomically swapped into the shared
    coordinator via ``replace_runtime`` — restore never touches the global
    AgentService, so the history continues on whatever session the caller is
    attached to.
    """
    store = _metadata_for(lifecycle)
    # The target session must exist before any archive I/O: restoring into a
    # session that cannot receive the history is a client error, not a
    # half-loaded archive.
    try:
        store.get(request.session_id)
    except KeyError:
        # SessionNotFoundError subclasses KeyError; catching the base keeps
        # the mapping correct for any store implementation raising the
        # standard "missing record" signal.
        raise HTTPException(404, f"session not found: {request.session_id}")

    # Catalogue refresh stats/scans the archive dir — keep it off the loop.
    s = await asyncio.to_thread(archive_session_by_id, cid)
    if s is None:
        raise HTTPException(404, "conversation not found")
    path = s[0]

    # Build the replacement runtime outside the coordinator so a failure here
    # (RuntimeRestoreError — factory releases its own half-built agent) leaves
    # the currently installed runtime untouched.
    factory = lifecycle.runtime_factory()
    new_runtime = await asyncio.to_thread(
        factory, request.session_id, archive_override=str(path)
    )
    try:
        await asyncio.to_thread(
            _session_coordinator(lifecycle).replace_runtime,
            request.session_id,
            new_runtime,
            shutdown=lambda runtime: runtime.shutdown(),
            operation="restore",
        )
    except (SessionControlBusyError, SessionCoordinatorStoppedError) as exc:
        # Refused before the swap: the fresh runtime was never installed, so
        # dispose of it; the previously installed runtime keeps running.
        await asyncio.to_thread(new_runtime.shutdown)
        if isinstance(exc, SessionControlBusyError):
            raise HTTPException(409, {
                "code": "session_control_active",
                "detail": "当前会话正在执行互斥控制操作，恢复已取消，请稍后重试。",
                "operation": exc.operation,
            }) from exc
        raise

    # Display-only count for the response body (the runtime itself was already
    # hydrated from the archive above).
    restored = await asyncio.to_thread(read_ui_messages, str(path))
    return {
        "ok": True,
        "id": cid,
        "title": await asyncio.to_thread(store.title_for_archive, path),
        "restored_lines": len(restored),
    }


async def _rollback_import(session_id: str, new_path: Path | None, metadata: Any = None) -> None:
    """Undo a half-finished import: the new session row and its copy both go.

    The source archive is never part of this — import only reads it — so a
    rolled-back import leaves it byte-identical.
    """
    store = metadata if metadata is not None else _metadata_for()
    if new_path is not None:
        try:
            await asyncio.to_thread(Path(new_path).unlink, missing_ok=True)
        except OSError:
            log.warning("failed to remove imported copy %s", new_path, exc_info=True)
    try:
        await asyncio.to_thread(store.delete, session_id)
    except KeyError:
        pass
    except Exception:
        log.exception("failed to roll back imported session %s", session_id)


@router.post(
    "/api/conversations/{cid}/import",
    response_model=ConversationImportResp,
)
async def import_conversation(lifecycle: SessionDomain, cid: str):
    """Import one GA archive as a brand-new session (copy + bind).

    Import is the persistent counterpart of restore: instead of loading the
    archive into an existing session for this run only, it mints a new session
    whose *own* archive is a copy of the source. The source is never written,
    which is what makes importing an IM archive (still being appended to by its
    bot) safe, and the binding makes the new session survive a restart.

    The session row is created before the copy so every failure has something
    to roll back: by the end of this handler a session either owns a complete
    copy, or nothing happened and the source is untouched.
    """
    store = _metadata_for(lifecycle)
    # Catalogue refresh stats/scans the archive dir — keep it off the loop.
    s = await asyncio.to_thread(archive_session_by_id, cid)
    if s is None:
        raise HTTPException(404, "conversation not found")
    source = Path(s[0]).resolve()

    # One archive belongs to at most one session; a second binding would give
    # two runtimes the same file. The UI keys its action on the same lookup
    # (and the same "title-only rows do not count" narrowing).
    token = _scoped_metadata.set(store)
    try:
        bound_session_id = await asyncio.to_thread(_bound_session_id, source)
    finally:
        _scoped_metadata.reset(token)
    if bound_session_id is not None:
        raise HTTPException(409, {
            "code": "archive_already_bound",
            "detail": "该归档已属于一条会话，请直接打开该会话。",
            "session_id": bound_session_id,
        })

    title = await asyncio.to_thread(store.title_for_archive, source)
    if not title:
        # Untitled archive: the first real user question titles the session,
        # exactly like the archive listing's own fallback.
        title = await asyncio.to_thread(first_user_preview, source)

    row = await asyncio.to_thread(store.create, title=title)
    session_id = row["id"]
    new_path: Path | None = None
    try:
        # Copy + sanitise + trim in one worker call: the archive can be many
        # MB and nothing here may touch the event loop.
        new_path, imported_lines = await asyncio.to_thread(
            copy_archive_for_import, source
        )
        await asyncio.to_thread(store.bind_archive, session_id, new_path)
        # Cold start on the normal factory path: the bound copy is now the
        # session's archive, so this loads it exactly like any other session
        # (no override, no rebinding).
        await asyncio.to_thread(_session_coordinator(lifecycle).ensure_runtime, session_id)
    except BaseException as exc:
        await _rollback_import(session_id, new_path, metadata=store)
        if isinstance(exc, ArchiveNotImportableError):
            raise HTTPException(409, {
                "code": "archive_not_importable",
                "detail": "该归档没有完整的对话轮次，无法导入。",
            }) from exc
        raise

    return {
        "ok": True,
        "session_id": session_id,
        "title": row["title"],
        "imported_lines": imported_lines,
    }


@router.get("/api/conversations/{cid}/export")
async def export_conversation(
    cid: str,
    format: str = Query("md", pattern="^(md|json)$"),
    request: Request = None,  # type: ignore[assignment]
):
    store = _metadata_for(request)
    # Catalogue refresh stats/scans the archive dir — keep it off the loop.
    s = await asyncio.to_thread(archive_session_by_id, cid)
    if s is None:
        raise HTTPException(404, "conversation not found")
    path = s[0]
    messages = await asyncio.to_thread(_ga_extract, path)
    title = await asyncio.to_thread(store.title_for_archive, path)

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


def _list_archive_zips_sync() -> dict:
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


@router.get("/api/archive/zips", response_model=ArchiveZipListResp)
async def list_archive_zips():
    return await asyncio.to_thread(_list_archive_zips_sync)


def _list_zip_entries_sync(path: str) -> dict:
    with zipfile.ZipFile(path) as z:
        return {"entries": [
            {"name": i.filename, "size": i.file_size, "date": list(i.date_time)}
            for i in z.infolist()
            if not i.is_dir()
        ]}


def _archive_zip_path(name: str) -> str:
    if any(ch in name for ch in ("/", "\\", ":", "\x00")) or ".." in name or not name.endswith(".zip"):
        raise HTTPException(400, "bad name")
    return os.path.join(_archive_dir(), name)


@router.get(
    "/api/archive/zips/{name}/entries",
    response_model=ArchiveZipEntryListResp,
)
async def list_zip_entries(name: str):
    p = _archive_zip_path(name)
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
    p = _archive_zip_path(name)
    if ".." in entry or any(ch in entry for ch in ("\\", ":", "\x00")) or entry.startswith("/"):
        raise HTTPException(400, "bad entry")
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
