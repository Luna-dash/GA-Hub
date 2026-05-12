"""Upload & file-serving routes — used by the React paste/drag-drop input.

Uploads go to admin's own data dir (``~/.genericagent-admin/uploads/``)
so we never write into the GenericAgent repo. ``files-by-path`` allows
previewing files inside GA's ``temp/`` (e.g. wechat-received media).
"""
from __future__ import annotations

import logging
import mimetypes
import os
import uuid
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

from .. import _paths

log = logging.getLogger(__name__)
router = APIRouter()


def _upload_dir() -> str:
    return str(_paths.admin_uploads_dir())


_SAFE_EXT = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp",
    ".pdf", ".txt", ".md", ".csv", ".json", ".log",
    ".zip", ".tar", ".gz",
    ".mp4", ".mov", ".m4v", ".webm", ".mp3", ".wav", ".silk",
}


@router.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    """Accept image / file uploads (paste, drag-drop, or button picker).

    Returns ``{file_id, name, path, url, mime, size}``. ``path`` is the
    absolute disk path to be passed to the agent / wechat send. ``url``
    is a relative URL the frontend can use directly in <img src=...>.
    """
    name = file.filename or "untitled"
    ext = (Path(name).suffix or "").lower()
    if ext and ext not in _SAFE_EXT:
        log.info("upload with non-allowlisted ext: %s", ext)
    file_id = uuid.uuid4().hex
    safe_name = f"{file_id}{ext}"
    path = os.path.join(_upload_dir(), safe_name)
    data = await file.read()
    with open(path, "wb") as f:
        f.write(data)
    mime = file.content_type or mimetypes.guess_type(name)[0] or "application/octet-stream"
    return {
        "file_id": file_id,
        "name": name,
        "path": path,
        "url": f"/api/files/{safe_name}",
        "mime": mime,
        "size": len(data),
    }


@router.get("/api/files/{fname}")
async def get_file(fname: str):
    if "/" in fname or ".." in fname:
        raise HTTPException(400, "bad name")
    p = os.path.join(_upload_dir(), fname)
    if not os.path.isfile(p):
        raise HTTPException(404, "not found")
    return FileResponse(p)


@router.get("/api/files-by-path")
async def get_file_by_path(path: str):
    """Serve any file under GA's temp/ or admin's uploads/ for previewing."""
    abspath = os.path.abspath(path)
    allowed_roots = [
        os.path.abspath(str(_paths.temp_dir())),
        os.path.abspath(_upload_dir()),
    ]
    if not any(abspath.startswith(r + os.sep) for r in allowed_roots):
        raise HTTPException(403, "outside allowed roots")
    if not os.path.isfile(abspath):
        raise HTTPException(404, "not found")
    return FileResponse(abspath)
