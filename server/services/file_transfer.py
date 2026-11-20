"""Hub-wide index of files explicitly added by the user."""
from __future__ import annotations

from contextlib import closing, suppress
from datetime import datetime
import os
from pathlib import Path
import re
import sqlite3
from stat import S_ISREG

from .. import _paths

_UNSAFE_NAME_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]+')
_LEADING_MD_DECOR = re.compile(r'^[#>*`\-+.\d\s]+')


def _safe_segment(raw: str | None, *, fallback: str, max_len: int) -> str:
    text = (raw or "").strip()
    if any(sep in text for sep in ("/", "\\")):
        leaf = Path(text.rstrip("/\\")).name
        if leaf and leaf not in {".", ".."}:
            text = leaf
    cleaned = _UNSAFE_NAME_CHARS.sub("-", text)
    cleaned = re.sub(r"\s+", "-", cleaned)
    cleaned = re.sub(r"-{2,}", "-", cleaned).strip(".- ")
    if not cleaned or cleaned in {".", ".."}:
        return fallback
    return cleaned[:max_len].rstrip(".- ") or fallback


def _reply_title_segment(text: str) -> str:
    for line in text.splitlines():
        stripped = _LEADING_MD_DECOR.sub("", line).strip()
        if stripped:
            return _safe_segment(stripped, fallback="回复", max_len=24)
    return "回复"


class FileTransfer:
    def __init__(self, db: Path | None = None):
        self.db = db or _paths.ADMIN_DATA / "file_transfer.sqlite3"

    def connect(self):
        self.db.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.db)
        db.row_factory = sqlite3.Row
        # Do not migrate the old automatic entries into the curated list.
        db.execute("""CREATE TABLE IF NOT EXISTS manual_files (
            id INTEGER PRIMARY KEY AUTOINCREMENT, path_key TEXT NOT NULL UNIQUE,
            path TEXT NOT NULL, name TEXT NOT NULL, engine TEXT NOT NULL,
            session_id TEXT NOT NULL, project TEXT
        )""")
        return db

    def add(self, path: str, engine: str, sid: str, project: str | None) -> None:
        candidate = Path(path)
        if (not candidate.is_absolute() or path.startswith(("//", "\\\\"))
                or any(c in path for c in "\r\n\x00")):
            raise ValueError("Only absolute local file paths can be added")
        candidate = candidate.resolve(strict=True)
        if str(candidate).startswith(("//", "\\\\")) or not candidate.is_file():
            raise ValueError("Only local regular files can be added")
        with closing(self.connect()) as db, db:
            db.execute("INSERT OR IGNORE INTO manual_files(path_key,path,name,engine,session_id,project) VALUES (?,?,?,?,?,?)",
                       (os.path.normcase(str(candidate)), str(candidate), candidate.name, engine, sid, project))

    def save_reply(self, text: str, engine: str, sid: str, project: str | None) -> None:
        if not text.strip():
            raise ValueError("An empty reply cannot be saved")
        data = text.encode("utf-8")
        directory = self.db.parent / "transfer_documents"
        directory.mkdir(parents=True, exist_ok=True)
        if directory.resolve().parent != self.db.parent.resolve():
            raise OSError("Reply document directory must not redirect")
        project_part = _safe_segment(project, fallback="未绑定项目", max_len=32)
        title_part = _reply_title_segment(text)
        stamp = datetime.now().strftime("%m%d-%H%M%S")
        base_stem = f"{project_part}-{title_part}-{stamp}"
        resolved_dir = directory.resolve()
        for seq in range(1, 100):
            suffix = "" if seq == 1 else f"-{seq}"
            candidate = directory / f"{base_stem}{suffix}.md"
            if candidate.resolve().parent != resolved_dir:
                raise OSError("Reply document target must stay inside transfer_documents")
            try:
                out = candidate.open("xb")
                target = candidate
                break
            except FileExistsError:
                continue
        else:
            raise FileExistsError(f"Could not allocate unique reply file under {directory}")
        try:
            with out:
                out.write(data)
            self.add(str(target.absolute()), engine, sid, project)
        except Exception:
            with suppress(OSError):
                target.unlink()
            raise

    def list(self) -> list[dict]:
        with closing(self.connect()) as db:
            rows = [dict(row) for row in db.execute("SELECT id,path,name,engine,session_id,project FROM manual_files ORDER BY id DESC")]
        for row in rows:
            try:
                stat = Path(row["path"]).stat()
                row["available"] = S_ISREG(stat.st_mode)
                row["size"] = stat.st_size if row["available"] else 0
            except OSError:
                row.update(available=False, size=0)
            # JavaScript can represent integer ids and typical file sizes exactly.
        return rows

    def clear(self) -> None:
        with closing(self.connect()) as db, db:
            db.execute("DELETE FROM manual_files")
