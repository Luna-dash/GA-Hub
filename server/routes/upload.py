"""Upload & file-serving routes — used by the React paste/drag-drop input.

Uploads go to admin's own data dir (``~/.genericagent-admin/uploads/``)
so we never write into the GenericAgent repo. ``files-by-path`` allows
previewing files inside GA's ``temp/`` (e.g. wechat-received media).
"""
from __future__ import annotations

import logging
import mimetypes
import os
import platform
import subprocess
import uuid
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .. import _paths

log = logging.getLogger(__name__)
router = APIRouter()


class RevealRequest(BaseModel):
    path: str


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


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


def _resolve_reveal_path(raw_path: str) -> Path:
    value = raw_path.strip().strip('"')
    if not value:
        raise HTTPException(400, "path is required")

    path = Path(value).expanduser()
    if not path.is_absolute():
        if _paths.GA_ROOT is None:
            raise HTTPException(503, "GA root is not configured")
        path = Path(_paths.GA_ROOT) / path
    path = path.resolve()

    if not path.exists():
        raise HTTPException(404, "not found")
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
            args = ["explorer.exe", str(path)]
        elif system == "Darwin":
            args = ["open", str(path)]
        else:
            args = ["xdg-open", str(path)]
        try:
            subprocess.Popen(args)
        except OSError as exc:
            log.warning("Cannot open %s: %s", path, exc)
            raise HTTPException(500, "default application is unavailable") from exc
        return

    try:
        if system == "Windows":
            os.startfile(str(path))  # type: ignore[attr-defined]
        elif system == "Darwin":
            subprocess.Popen(["open", str(path)])
        else:
            subprocess.Popen(["xdg-open", str(path)])
    except OSError as exc:
        log.warning("Cannot open %s: %s", path, exc)
        raise HTTPException(500, "default application is unavailable") from exc


def _upload_dir() -> str:
    return str(_paths.admin_uploads_dir())


# Generous content allowlist: covers everything a user realistically pastes
# or drag-drops (images, docs, office, code, media, archives) while keeping
# out executables / scripts / active markup that could be abused if the file
# is later opened or served back. Kept broad on purpose so normal use never
# hits a wall — only genuinely dangerous extensions are rejected.
_SAFE_EXT = {
    # images
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".tiff", ".heic",
    # documents / text / data
    ".pdf", ".txt", ".md", ".rst", ".csv", ".tsv", ".json", ".jsonl",
    ".log", ".yaml", ".yml", ".toml", ".ini", ".xml",
    # office
    ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp",
    # ebooks
    ".epub", ".mobi",
    # code (served as text, never executed by the server)
    ".py", ".js", ".ts", ".tsx", ".jsx", ".java", ".c", ".cpp", ".h", ".hpp",
    ".go", ".rs", ".rb", ".php", ".sql", ".sh", ".css", ".vue",
    # archives
    ".zip", ".tar", ".gz", ".tgz", ".7z", ".rar",
    # media
    ".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi",
    ".mp3", ".wav", ".silk", ".m4a", ".flac", ".ogg", ".aac",
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
        log.warning("rejected upload with non-allowlisted ext: %s", ext)
        raise HTTPException(
            415,
            f"file type '{ext}' is not allowed",
        )
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
    # Reject any separator or traversal token. Backslash matters on Windows
    # where it is a valid path separator, so guard against both forms.
    if "/" in fname or "\\" in fname or ".." in fname or os.sep in fname:
        raise HTTPException(400, "bad name")
    p = os.path.join(_upload_dir(), fname)
    if not os.path.isfile(p):
        raise HTTPException(404, "not found")
    return FileResponse(p)


@router.post("/api/files/reveal")
def reveal_file(req: RevealRequest):
    """Open a local path with the host's default application.

    Any existing absolute path is allowed if its type is on the
    document/image/media/text allowlist (or is a directory). Relative
    paths still resolve under ``GA_ROOT``. Content download via
    ``files-by-path`` remains root-restricted separately.
    """
    path = _resolve_reveal_path(req.path)
    _open_in_default_app(path)
    return {"ok": True, "path": str(path)}


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
