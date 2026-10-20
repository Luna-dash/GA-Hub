"""Upload & file-serving routes — used by the React paste/drag-drop input.

Uploads go to admin's own data dir (``~/.genericagent-admin/uploads/``)
so we never write into the GenericAgent repo. ``files-by-path`` allows
previewing files inside GA's ``temp/`` (e.g. wechat-received media).
"""
from __future__ import annotations

import asyncio
import logging
import mimetypes
import os
import platform
import subprocess
import uuid
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from threading import BoundedSemaphore
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile, Request
from fastapi.responses import FileResponse

from .. import _paths
from ..process_utils import hidden_process_kwargs
from ..schemas import RevealFileReq, RevealFileResp, ResolveFileReq, ResolveFileResp, UploadResp

log = logging.getLogger(__name__)
router = APIRouter()

# Admission is bounded independently of the shared FastAPI worker pool.
# Release only when the real job finishes, including after client cancellation.
_FILE_POOLS = {kind: (ThreadPoolExecutor(max_workers=2, thread_name_prefix=f"files-{kind}"),
                      BoundedSemaphore(4)) for kind in ("resolve", "reveal")}


async def _file_job(kind, fn, *args):
    pool, slots = _FILE_POOLS[kind]
    if not slots.acquire(blocking=False):
        raise HTTPException(429, "file service busy; please retry later")
    try:
        future = pool.submit(partial(fn, *args))
    except BaseException:
        slots.release()
        raise
    future.add_done_callback(lambda _: slots.release())
    return await asyncio.wrap_future(future)



# Open-with-default-app allowlist: documents / images / media / common text
# & source (viewed, not executed by the server). Rejects installers/scripts
# that would be dangerous if a random page could POST /api/files/reveal.
# Path roots are intentionally NOT restricted — agent transcripts often
# cite GA-Hub, sibling repos, or absolute cwd paths outside GA_ROOT.
_REVEAL_SAFE_EXT = {
    # images
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".tiff", ".heic", ".svg",
    # documents / text / data
    ".pdf", ".txt", ".md", ".rst", ".csv", ".tsv", ".json", ".jsonl",
    ".log", ".yaml", ".yml", ".toml", ".ini", ".xml", ".html", ".htm",
    # office
    ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp",
    # ebooks
    ".epub", ".mobi",
    # code (opened by editor/notepad; server never executes them)
    ".py", ".js", ".ts", ".tsx", ".jsx", ".java", ".c", ".cpp", ".h", ".hpp",
    ".go", ".rs", ".rb", ".php", ".sql", ".css", ".vue",
    # archives (open in explorer/archive tool)
    ".zip", ".tar", ".gz", ".tgz", ".7z", ".rar",
    # media
    ".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi",
    ".mp3", ".wav", ".silk", ".m4a", ".flac", ".ogg", ".aac",
}

# Never launch these even if the OS would "open" them.
_REVEAL_BLOCKED_EXT = {
    ".exe", ".msi", ".msp", ".com", ".scr", ".pif",
    ".dll", ".sys", ".drv",
    ".vbs", ".vbe", ".jse", ".wsf", ".wsh", ".msc",
    ".reg", ".inf", ".lnk", ".url", ".scf",
    ".app", ".dmg", ".pkg", ".deb", ".rpm",
}


def _reveal_ext_allowed(path: Path) -> bool:
    """True if *path* may be handed to the OS default application."""
    if path.is_dir():
        # Folders → Explorer/Finder only (no code execution).
        return True
    ext = path.suffix.lower()
    if not ext:
        # Extensionless: allow only if it looks like plain text (small heuristic).
        # Reject by default — safer than launching unknown binaries.
        return False
    if ext in _REVEAL_BLOCKED_EXT:
        return False
    # Shell scripts often execute on "open" under Windows associations.
    if ext in {".bat", ".cmd", ".ps1", ".psm1", ".sh"}:
        return False
    return ext in _REVEAL_SAFE_EXT


def _normalize_rel(raw: str) -> str:
    from ..services.file_resolution import normalize
    return normalize(raw)


def _resolve_path_info(raw: str, project_path: str | None = None,
                       project_name: str | None = None) -> dict:
    from ..services.file_resolution import resolve
    return resolve(raw, project_path, project_name)


def _fuzzy_find(raw: str, **_ignored) -> tuple[Path | None, bool]:
    """Compatibility helper; unbound calls no longer scan all GA projects."""
    info = _resolve_path_info(raw)
    return (Path(info['resolved']) if info['resolved'] else None, info['ambiguous'])


def _project_context(request: Request, session_id: str | None) -> tuple:
    if not session_id:
        return None, None
    from ..services.session_lifecycle import session_lifecycle_of
    try:
        session = session_lifecycle_of(request.app).store.get(session_id)
    except KeyError:
        raise HTTPException(404, "session not found")
    return session.get('project_path'), session.get('project_name')


def _resolve_reveal_path(raw_path: str, project_path: str | None = None,
                         project_name: str | None = None) -> Path:
    info = _resolve_path_info(raw_path, project_path, project_name)
    if not info["resolved"]:
        if info["ambiguous"]:
            raise HTTPException(404, "ambiguous path matches multiple files")
        raise HTTPException(404, "not found")
    path = Path(info["resolved"])
    if not _reveal_ext_allowed(path):
        raise HTTPException(
            403,
            "file type not allowed for open (documents/images/media/text only)",
        )
    return path


def _open_in_default_app(path: Path) -> None:
    system = platform.system()
    if path.is_dir():
        if system == "Windows":
            _show_in_file_manager(path)
            return
        elif system == "Darwin":
            args = ["open", str(path)]
        else:
            args = ["xdg-open", str(path)]
        try:
            subprocess.Popen(args, **hidden_process_kwargs())
        except OSError as exc:
            log.warning("file_open_failed path=%s error=%s", path, exc)
            raise HTTPException(500, "default application is unavailable") from exc
        return

    # Never hand files to OS associations: .py/.js can be configured to execute
    # on Windows. Reveal files in their folder instead; Explorer selects them.
    _show_in_file_manager(path)


def _upload_dir() -> str:
    return str(_paths.admin_uploads_dir())


# Only these passive raster formats are served inline for thumbnails. Every
# other upload is accepted, but served as an attachment so active content
# cannot execute in the GA-Hub origin.
_INLINE_IMAGE_EXT = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".tiff",
}


def _file_response_headers(path: str | Path) -> dict[str, str]:
    """Return safe headers for a path-based file response."""
    return {"X-Content-Type-Options": "nosniff"}


def _file_response(path: str | Path) -> FileResponse:
    """Serve only passive raster images inline; download everything else."""
    response_path = path
    path_obj = Path(path)
    headers = _file_response_headers(path_obj)
    if path_obj.suffix.lower() in _INLINE_IMAGE_EXT:
        return FileResponse(
            response_path,
            media_type=mimetypes.guess_type(path_obj.name)[0] or "application/octet-stream",
            headers=headers,
        )
    return FileResponse(
        response_path,
        media_type="application/octet-stream",
        filename=path_obj.name,
        content_disposition_type="attachment",
        headers=headers,
    )


class UploadTooLarge(ValueError):
    """Raised when an upload exceeds the server-side size limit."""


_UPLOAD_MAX_SIZE = 50 * 1024 * 1024
_UPLOAD_CHUNK_SIZE = 1024 * 1024
_UPLOAD_SLOTS = BoundedSemaphore(2)


def _write_chunk(output, chunk: bytes) -> None:
    # Module-level so the blocking-contract probe can patch the disk write.
    output.write(chunk)


async def _save_upload_stream(file: UploadFile, path: Path, *, max_size: int) -> int:
    """Save an upload without materialising its whole body in memory."""
    size = 0
    try:
        with path.open("wb") as output:
            while True:
                chunk = await file.read(_UPLOAD_CHUNK_SIZE)
                if not chunk:
                    break
                size += len(chunk)
                if size > max_size:
                    raise UploadTooLarge
                # Disk writes must not run on the event loop; reads stay async
                # so backpressure and cancellation keep their existing shape.
                job = asyncio.create_task(asyncio.to_thread(_write_chunk, output, chunk))
                try:
                    await asyncio.shield(job)
                except asyncio.CancelledError:
                    # Finish the real write before the context closes the handle.
                    await job
                    raise
    except BaseException:
        # Cancellation is a BaseException on supported Python versions; never
        # leave a partial file behind when the request task is cancelled.
        path.unlink(missing_ok=True)
        raise
    return size


@router.post("/api/upload")
async def upload(file: UploadFile = File(...)) -> UploadResp:
    """Accept image / file uploads (paste, drag-drop, or button picker).

    Returns ``{file_id, name, path, url, mime, size}``. ``path`` is the
    absolute disk path to be passed to the agent / wechat send. ``url``
    is a relative URL the frontend can use directly in <img src=...>.
    """
    name = file.filename or "untitled"
    ext = (Path(name).suffix or "").lower()
    file_id = uuid.uuid4().hex
    safe_name = f"{file_id}{ext}"
    path = os.path.join(_upload_dir(), safe_name)
    if not _UPLOAD_SLOTS.acquire(blocking=False):
        raise HTTPException(429, "upload service busy; please retry later")
    temporary = Path(path).with_suffix(".part")
    try:
        size = await _save_upload_stream(file, temporary, max_size=_UPLOAD_MAX_SIZE)
        os.replace(temporary, path)
    except UploadTooLarge as exc:
        raise HTTPException(413, "file is larger than 50 MB") from exc
    finally:
        try:
            temporary.unlink(missing_ok=True)
        finally:
            _UPLOAD_SLOTS.release()
    mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
    return {
        "file_id": file_id,
        "name": name,
        "path": path,
        "url": f"/api/files/{safe_name}",
        "mime": mime,
        "size": size,
    }


@router.get("/api/files/{fname}")
async def get_file(fname: str):
    # Reject any separator or traversal token. Backslash matters on Windows
    # where it is a valid path separator, so guard against both forms.
    if "/" in fname or "\\" in fname or ".." in fname or os.sep in fname:
        raise HTTPException(400, "bad name")
    p = os.path.join(_upload_dir(), fname)
    if not await asyncio.to_thread(os.path.isfile, p):
        raise HTTPException(404, "not found")
    return _file_response(p)


def _show_in_file_manager(path: Path) -> None:
    """Reveal files or folders, reusing the Hub-owned Explorer on Windows."""
    system = platform.system()
    try:
        if system == "Windows":
            from ..services.file_manager import explorer_window
            explorer_window.reveal(path)
            return
        parent = path if path.is_dir() else path.parent
        args = ["open", str(parent)] if system == "Darwin" else ["xdg-open", str(parent)]
        subprocess.Popen(args, **hidden_process_kwargs())
    except OSError as exc:
        log.warning("file_reveal_failed path=%s error=%s", path, exc)
        raise HTTPException(500, "file manager is unavailable") from exc


@router.post("/api/files/resolve")
async def resolve_file_path(req: ResolveFileReq, request: Request) -> ResolveFileResp:
    """Resolve an agent-cited path (absolute / GA-root relative / bare temp
    name / fuzzy tail) without opening anything."""
    return await _file_job("resolve", _resolve_path_info, req.path, *_project_context(request, req.session_id))


@router.post("/api/files/reveal")
async def reveal_file(req: RevealFileReq, request: Request) -> RevealFileResp:
    context = _project_context(request, req.session_id)
    return await _file_job("reveal", _reveal_file_sync, req, context)


def _reveal_file_sync(req: RevealFileReq, context: tuple) -> RevealFileResp:
    """Open a local path with the host's default application.

    Safe files are located in the file manager; directories are opened.
    Relative paths use project-scoped, budgeted citation resolution.
    Content download via files-by-path remains separately root-restricted.
    """
    path = _resolve_reveal_path(req.path, *context)
    if req.mode == "folder":
        _show_in_file_manager(path)
    elif req.mode == "parent":
        _open_in_default_app(path.parent if path.is_file() else path)
    else:
        _open_in_default_app(path)
    return {"ok": True, "path": str(path)}


def _resolve_file_by_path(raw_path: str) -> str:
    """Resolve a downloadable file and keep symlinks inside allowed roots."""
    resolved = os.path.realpath(os.path.abspath(raw_path))
    allowed_roots = [
        os.path.realpath(os.path.abspath(str(_paths.temp_dir()))),
        os.path.realpath(os.path.abspath(_upload_dir())),
    ]
    try:
        inside_root = any(
            os.path.commonpath([resolved, root]) == root
            for root in allowed_roots
        )
    except ValueError:
        inside_root = False
    if not inside_root:
        raise HTTPException(403, "outside allowed roots")
    if not os.path.isfile(resolved):
        raise HTTPException(404, "not found")
    return resolved


@router.get("/api/files-by-path")
async def get_file_by_path(path: str):
    """Serve any file under GA's temp/ or admin's uploads/ for previewing."""
    # realpath() on a user-supplied path can touch dead UNC/drive targets and
    # block for seconds on Windows — resolve in a worker thread.
    resolved = await asyncio.to_thread(_resolve_file_by_path, path)
    return _file_response(resolved)
