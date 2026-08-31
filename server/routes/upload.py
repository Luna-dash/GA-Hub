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

from .. import _paths
from ..process_utils import hidden_process_kwargs
from ..schemas import RevealFileReq, RevealFileResp, ResolveFileReq, ResolveFileResp, UploadResp

log = logging.getLogger(__name__)
router = APIRouter()


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


def _normalize_rel(raw: str) -> str:
    """Normalize an agent-cited path for probing (separators, ./ noise)."""
    value = (raw or "").strip().strip('"').replace("\\", "/")
    while value.startswith("./"):
        value = value[2:]
    return value.strip()


def _path_candidates(raw: str) -> list[Path]:
    """Probe order for agent-cited paths (first existing wins):

    1. absolute paths as-is
    2. relative to GA root (`temp/x.md`, `memory/…`)
    3. bare names inside GA's temp dir (`model_responses_x.txt`)
    4. bare names inside the L4 session-archive dir
    5. relative to the GA-Hub checkout (`scripts/build_all.py` citations)
    """
    value = _normalize_rel(raw)
    if not value:
        return []
    path = Path(value).expanduser()
    bases: list[Path] = []
    if path.is_absolute():
        bases.append(path)
    else:
        if _paths.GA_ROOT:
            root = Path(_paths.GA_ROOT)
            bases.append(root / path)
            bases.append(root / "temp" / path)
            bases.append(root / "memory" / "L4_raw_sessions" / path)
        bases.append(_paths.ADMIN_ROOT / path)
    seen: set[str] = set()
    unique: list[Path] = []
    for base in bases:
        key = str(base).lower()
        if key not in seen:
            seen.add(key)
            unique.append(base)
    return unique


_FUZZY_PRUNE_DIRS = {
    ".git", "node_modules", "__pycache__", ".venv", "venv",
    ".idea", ".vscode", "binaries", "target",
}
_FUZZY_MAX_DEPTH = 3


def _fuzzy_find(raw: str) -> tuple[Path | None, bool]:
    """Depth-bounded unique-tail search under GA root for unresolved paths.

    Returns ``(path, ambiguous)``. Ambiguous (≥2 hits) resolves to nothing —
    guessing would open the wrong file. Bounded depth + pruned junk dirs keep
    this in the tens-of-milliseconds range; it only runs on demand.
    """
    rel = _normalize_rel(raw).lstrip("/")
    if not rel or _paths.GA_ROOT is None:
        return None, False
    parts = [p for p in rel.split("/") if p and p != "."]
    if not parts:
        return None, False
    tail = "/".join(parts)
    last = parts[-1]
    hits: list[Path] = []
    ga_root = Path(_paths.GA_ROOT)
    base_depth = len(ga_root.parts)
    for dirpath, dirnames, filenames in os.walk(ga_root):
        depth = len(Path(dirpath).parts) - base_depth
        if depth >= _FUZZY_MAX_DEPTH:
            dirnames[:] = []
        dirnames[:] = [d for d in dirnames if d not in _FUZZY_PRUNE_DIRS]
        rel_dir = "/".join(Path(dirpath).parts[base_depth:])
        for name in list(filenames) + list(dirnames):
            rel_path = f"{rel_dir}/{name}" if rel_dir else name
            if rel_path == tail or name == last:
                hits.append(Path(dirpath) / name)
                if len(hits) >= 2:
                    return None, True
    if hits:
        return hits[0], False
    return None, False


def _resolve_path_info(raw_path: str) -> dict:
    raw = raw_path or ""
    for candidate in _path_candidates(raw):
        try:
            if candidate.exists():
                resolved = candidate.resolve()
                return {
                    "raw": raw,
                    "resolved": str(resolved),
                    "exists": True,
                    "is_dir": resolved.is_dir(),
                    "ambiguous": False,
                }
        except OSError:
            continue
    hit, ambiguous = _fuzzy_find(raw)
    if hit is not None:
        return {
            "raw": raw,
            "resolved": str(hit.resolve()),
            "exists": True,
            "is_dir": hit.is_dir(),
            "ambiguous": False,
        }
    return {
        "raw": raw,
        "resolved": None,
        "exists": False,
        "is_dir": False,
        "ambiguous": ambiguous,
    }


def _resolve_reveal_path(raw_path: str) -> Path:
    info = _resolve_path_info(raw_path)
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
            try:
                os.startfile(str(path))  # type: ignore[attr-defined]
            except OSError as exc:
                log.warning("Cannot open %s: %s", path, exc)
                raise HTTPException(500, "default application is unavailable") from exc
            return
        elif system == "Darwin":
            args = ["open", str(path)]
        else:
            args = ["xdg-open", str(path)]
        try:
            subprocess.Popen(args, **hidden_process_kwargs())
        except OSError as exc:
            log.warning("Cannot open %s: %s", path, exc)
            raise HTTPException(500, "default application is unavailable") from exc
        return

    try:
        if system == "Windows":
            os.startfile(str(path))  # type: ignore[attr-defined]
        elif system == "Darwin":
            subprocess.Popen(["open", str(path)], **hidden_process_kwargs())
        else:
            subprocess.Popen(["xdg-open", str(path)], **hidden_process_kwargs())
    except OSError as exc:
        log.warning("Cannot open %s: %s", path, exc)
        raise HTTPException(500, "default application is unavailable") from exc


def _upload_dir() -> str:
    return str(_paths.admin_uploads_dir())


# Only these passive raster formats are served inline for thumbnails. Every
# other upload is accepted, but served as an attachment so active content
# cannot execute in the GA-Hub origin.
_INLINE_IMAGE_EXT = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".tiff",
}


class UploadTooLarge(ValueError):
    """Raised when an upload exceeds the server-side size limit."""


_UPLOAD_MAX_SIZE = 50 * 1024 * 1024
_UPLOAD_CHUNK_SIZE = 1024 * 1024


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
                output.write(chunk)
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
    try:
        size = await _save_upload_stream(file, Path(path), max_size=_UPLOAD_MAX_SIZE)
    except UploadTooLarge as exc:
        raise HTTPException(413, "file is larger than 50 MB") from exc
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
    if not os.path.isfile(p):
        raise HTTPException(404, "not found")
    ext = Path(fname).suffix.lower()
    if ext in _INLINE_IMAGE_EXT:
        return FileResponse(
            p,
            media_type=mimetypes.guess_type(fname)[0] or "application/octet-stream",
            headers={"X-Content-Type-Options": "nosniff"},
        )
    return FileResponse(
        p,
        media_type="application/octet-stream",
        filename=fname,
        content_disposition_type="attachment",
        headers={"X-Content-Type-Options": "nosniff"},
    )


def _show_in_file_manager(path: Path) -> None:
    """Reveal a file in its parent folder (Windows selects it), or open a dir.

    Explorer is a GUI process: it must NOT be started with the house
    CREATE_NO_WINDOW/SW_HIDE policy — the hidden show-state makes the window
    never appear (the "click does nothing" bug). The select path is quoted
    *inside* the argument, because Explorer mis-parses a whole-argument
    re-quoting of ``/select,<path with spaces>``.
    """
    system = platform.system()
    try:
        if system == "Windows":
            if path.is_file():
                subprocess.Popen(f'explorer /select,"{path}"')
            else:
                subprocess.Popen(f'explorer "{path}"')
            return
        parent = path if path.is_dir() else path.parent
        args = ["open", str(parent)] if system == "Darwin" else ["xdg-open", str(parent)]
        subprocess.Popen(args, **hidden_process_kwargs())
    except OSError as exc:
        log.warning("Cannot reveal %s: %s", path, exc)
        raise HTTPException(500, "file manager is unavailable") from exc


@router.post("/api/files/resolve")
def resolve_file_path(req: ResolveFileReq) -> ResolveFileResp:
    """Resolve an agent-cited path (absolute / GA-root relative / bare temp
    name / fuzzy tail) without opening anything."""
    return _resolve_path_info(req.path)


@router.post("/api/files/reveal")
def reveal_file(req: RevealFileReq) -> RevealFileResp:
    """Open a local path with the host's default application.

    Any existing absolute path is allowed if its type is on the
    document/image/media/text allowlist (or is a directory). Relative paths
    resolve through the citation cascade (GA root, temp, L4 archives, the
    GA-Hub checkout, then a bounded fuzzy search). ``mode`` selects the
    action: open the file, reveal it in the file manager, or open its parent
    folder. Content download via ``files-by-path`` remains root-restricted
    separately.
    """
    path = _resolve_reveal_path(req.path)
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
    resolved = _resolve_file_by_path(path)
    return FileResponse(resolved)
