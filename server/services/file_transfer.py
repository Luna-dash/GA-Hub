"""Hub-wide index of files explicitly delivered by finished conversations."""
from __future__ import annotations

import logging
import os
import re
import sqlite3
from contextlib import closing
from pathlib import Path
from urllib.parse import unquote, urlsplit

from .. import _paths

log = logging.getLogger(__name__)

# Only explicit file citations, never tool output, fenced examples, prompt
# attachments, or a scan of files written during the run.
_FENCE = re.compile(r"^[ \t]*(`{3,}|~{3,}).*$")
_CITATION = re.compile(r"!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+(?:\([^()\n]*\)[^\s)]*)?))(?:\s+\"[^\"\n]*\")?\s*\)|`([^`\n]+)`|(?<![\w/])((?:[A-Za-z]:[\\/]|(?<![:/])/(?!/))[^\s<>\]\[\"`]+)")
_FILE_MARKER = re.compile(r"\[FILE:([^\]\r\n]+)\]", re.I)
_CHAT_ATTACHMENT = re.compile(r"(?m)^\[用户发送文件: (.+)\]$")
_ANTI_REFERENCES = "\n\n引用文件（绝对路径）：\n"
_SUMMARY = re.compile(r"<(summary|thinking|think)\b[^>]*>.*?(?:</\1\s*>|\Z)", re.I | re.S)


def _citations(answer: str):
    fence = ""
    for line in _SUMMARY.sub("", answer).splitlines():
        if match := _FENCE.match(line):
            marker = match[1]
            if not fence:
                fence = marker
            elif marker[0] == fence[0] and len(marker) >= len(fence) and not line.lstrip()[len(marker):].strip():
                fence = ""
            continue
        if fence:
            continue
        for match in _FILE_MARKER.finditer(line):
            yield match[1].strip()
        for match in _CITATION.finditer(_FILE_MARKER.sub("", line)):
            raw = next(value for value in match.groups() if value is not None).strip()
            yield raw.rstrip(".,;。，；。)") if match[4] else raw


def anti_input_paths(prompt: str) -> tuple[str, ...]:
    _, sep, block = prompt.rpartition(_ANTI_REFERENCES)
    lines = block.splitlines()
    return tuple(line[2:] for line in lines) if sep and lines and all(line.startswith("- ") for line in lines) else ()


def _file(raw: str, project_path: str | None, project_name: str | None) -> Path | None:
    if raw.lower().startswith("file:"):
        url = urlsplit(raw)
        if url.netloc.lower() not in {"", "localhost"}:
            return None
        raw = url.path
        if os.name == "nt" and re.match(r"^/[a-zA-Z]:/", raw):
            raw = raw[1:]
    elif re.match(r"^[a-zA-Z][\w+.-]*:", raw) and not re.match(r"^[a-zA-Z]:[\\/]", raw):
        return None  # Not a local URI.
    raw = unquote(raw)
    if not raw or raw.startswith(("//", "\\\\", "#")) or any(c in raw for c in "\r\n\x00"):
        return None
    path = Path(raw)
    if not path.is_absolute() and (path.anchor or ".." in path.parts):
        return None
    candidates = [path] if path.is_absolute() else []
    if not path.is_absolute():
        if project_path:
            candidates.append(Path(project_path) / path)
        if _paths.GA_ROOT:
            temp = _paths.ga_layout_path("temp")
            if project_name:
                candidates.append(temp / "project_artifacts" / project_name / path)
            candidates.extend((temp / path, _paths.GA_ROOT / path))
    hits = {}
    for candidate in candidates:
        if candidate.is_file():
            resolved = candidate.resolve(strict=True)
            if not str(resolved).startswith(("//", "\\\\")):
                hits[os.path.normcase(str(resolved))] = resolved
    return next(iter(hits.values())) if len(hits) == 1 else None


class FileTransfer:
    def __init__(self, db: Path | None = None):
        self.db = db or _paths.ADMIN_DATA / "file_transfer.sqlite3"

    def connect(self):
        self.db.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.db)
        db.row_factory = sqlite3.Row
        db.execute("""CREATE TABLE IF NOT EXISTS files (
            id INTEGER PRIMARY KEY, path_key TEXT NOT NULL UNIQUE,
            path TEXT NOT NULL, name TEXT NOT NULL, engine TEXT NOT NULL,
            session_id TEXT NOT NULL, project TEXT
        )""")
        return db

    def record(self, engine: str, sid: str, *, artifact: str | None = None,
               answer: str = "", project_path: str | None = None,
               project_name: str | None = None, exclude: tuple[str, ...] = ()) -> None:
        rows = {}
        excluded = {os.path.normcase(str(path)) for value in exclude
                    if (path := _file(value, project_path, project_name)) is not None}
        raw_paths = dict.fromkeys([*([artifact] if artifact else []), *_citations(answer)])
        for raw in list(raw_paths)[:128]:
            try:
                path = _file(raw, project_path, project_name)
            except (OSError, ValueError, RuntimeError):
                continue
            if path is not None and (key := os.path.normcase(str(path))) not in excluded:
                rows[key] = (key, str(path), path.name, engine, sid, project_name)
        if rows:
            with closing(self.connect()) as db, db:
                db.executemany("INSERT OR REPLACE INTO files(path_key,path,name,engine,session_id,project) VALUES (?,?,?,?,?,?)", rows.values())

    def list(self) -> list[dict]:
        with closing(self.connect()) as db:
            rows = [dict(row) for row in db.execute("SELECT id,path,name,engine,session_id,project FROM files ORDER BY id DESC")]
        for row in rows:
            try:
                stat = Path(row["path"]).stat()
                from stat import S_ISREG
                row["available"] = S_ISREG(stat.st_mode)
                row["size"] = stat.st_size if row["available"] else 0
            except OSError:
                row.update(available=False, size=0)
            # JavaScript can represent integer ids and typical file sizes exactly.
        return rows

    def clear(self) -> None:
        with closing(self.connect()) as db, db:
            db.execute("DELETE FROM files")


def record_chat(sid: str, final_output: str, prompt: str = "") -> None:
    from .session_metadata import SessionMetadataStore
    try:
        meta = SessionMetadataStore().get(sid)
    except KeyError:
        meta = {}
    FileTransfer().record("chat", sid, answer=final_output, project_path=meta.get("project_path"),
                          project_name=meta.get("project_name"), exclude=tuple(_CHAT_ATTACHMENT.findall(prompt)))
