"""Versioned conversation repository — the single source of truth for sessions.

This module replaces the legacy pattern where several routes each read/wrote one
giant ``chat_history.json`` living inside the GA repo's ``memory/`` directory.
Conversations now live in GA-Hub's *own* admin data store
(``ADMIN_DATA/conversations_v2/``) so we never write into the GA repository at
all.

Layout::

    ADMIN_DATA/conversations_v2/
        index.json          → [{id, title, status, updated_at, ...}] summaries
        {session_id}.json   → full Conversation document
        .migrated_v1         → marker that the v1→v2 migration already ran

Writes are atomic (temp file + ``os.replace``) and guarded by an in-process
RLock. A ``revision`` counter (per-conversation, monotonic) drives optimistic
locking: callers that pass a stale ``expected_revision`` get ``RevisionConflict``
instead of clobbering newer data.

The repository is intentionally storage-only. Runtime / execution state lives in
the SessionCoordinator; this class only persists what must survive a restart.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

from server import _paths

log = logging.getLogger(__name__)

SCHEMA_VERSION = 2

# Conversation.status
STATUS_IDLE = "idle"
STATUS_QUEUED = "queued"
STATUS_RUNNING = "running"
STATUS_ABORTING = "aborting"
STATUS_ERROR = "error"
RUNNING_STATUSES = {STATUS_QUEUED, STATUS_RUNNING, STATUS_ABORTING}

# Message.status
MSG_STREAMING = "streaming"
MSG_COMPLETE = "complete"
MSG_ABORTED = "aborted"
MSG_ERROR = "error"


class RevisionConflict(Exception):
    """Caller's expected_revision is older than the persisted revision."""


class ConversationNotFound(KeyError):
    """No conversation with the given id."""


@dataclass
class Message:
    id: str
    role: str  # user | assistant | system
    content: str
    created_at: int
    stream_id: str | None = None
    source: str = "webui"
    status: str = MSG_COMPLETE
    attachments: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "role": self.role,
            "content": self.content,
            "created_at": self.created_at,
            "stream_id": self.stream_id,
            "source": self.source,
            "status": self.status,
            "attachments": self.attachments,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Message":
        return cls(
            id=d.get("id") or str(uuid.uuid4()),
            role=d.get("role", "user"),
            content=d.get("content", ""),
            created_at=int(d.get("created_at") or 0),
            stream_id=d.get("stream_id"),
            source=d.get("source", "webui"),
            status=d.get("status", MSG_COMPLETE),
            attachments=list(d.get("attachments") or []),
        )


@dataclass
class Conversation:
    id: str
    title: str = "新会话"
    created_at: int = 0
    updated_at: int = 0
    model_index: int = 0
    model_key: str | None = None
    status: str = STATUS_IDLE
    last_stream_id: str | None = None
    messages: list[Message] = field(default_factory=list)
    runtime: dict[str, Any] = field(default_factory=lambda: {"last_error": None, "revision": 0})
    schema_version: int = SCHEMA_VERSION

    # internal: not serialized into the document, used by repository for locking
    _revision: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "id": self.id,
            "title": self.title,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "model_index": self.model_index,
            "model_key": self.model_key,
            "status": self.status,
            "last_stream_id": self.last_stream_id,
            "messages": [m.to_dict() for m in self.messages],
            "runtime": {
                "last_error": self.runtime.get("last_error"),
                "revision": self._revision,
            },
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Conversation":
        rt = d.get("runtime") or {}
        c = cls(
            id=d["id"],
            title=d.get("title", "新会话"),
            created_at=int(d.get("created_at") or 0),
            updated_at=int(d.get("updated_at") or 0),
            model_index=int(d.get("model_index") or 0),
            model_key=d.get("model_key"),
            status=d.get("status", STATUS_IDLE),
            last_stream_id=d.get("last_stream_id"),
            messages=[Message.from_dict(m) for m in (d.get("messages") or [])],
            runtime={"last_error": rt.get("last_error"), "revision": 0},
            schema_version=int(d.get("schema_version") or SCHEMA_VERSION),
        )
        c._revision = int(rt.get("revision") or 0)
        return c

    def summary(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "model_index": self.model_index,
            "model_key": self.model_key,
            "status": self.status,
            "last_stream_id": self.last_stream_id,
            "message_count": len(self.messages),
            "revision": self._revision,
        }


class ConversationRepository:
    """Thread-safe, atomically-written JSON store for v2 conversations."""

    def __init__(self, base_dir: Path | None = None) -> None:
        self.base_dir = base_dir or _paths.conversations_v2_dir()
        self.base_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._index_path = self.base_dir / "index.json"

    # ── low-level io ──────────────────────────────────────────────
    def _session_path(self, sid: str) -> Path:
        # guard against path traversal — ids are uuids but be defensive
        if not sid or "/" in sid or "\\" in sid or sid in (".", ".."):
            raise ValueError(f"invalid session id: {sid!r}")
        return self.base_dir / f"{sid}.json"

    def _atomic_write_json(self, path: Path, payload: Any) -> None:
        tmp = path.with_suffix(path.suffix + f".tmp-{os.getpid()}-{threading.get_ident()}")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)

    def _read_json(self, path: Path) -> Any:
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except FileNotFoundError:
            return None

    # ── index ─────────────────────────────────────────────────────
    def _load_index(self) -> list[dict[str, Any]]:
        data = self._read_json(self._index_path)
        if data is None:
            return []
        if not isinstance(data, list):
            log.warning("index.json malformed (not a list); rebuilding from files")
            return self._rebuild_index()
        return data

    def _rebuild_index(self) -> list[dict[str, Any]]:
        summaries: list[dict[str, Any]] = []
        for p in self.base_dir.glob("*.json"):
            if p.name == "index.json":
                continue
            d = self._read_json(p)
            if isinstance(d, dict) and "id" in d:
                summaries.append(Conversation.from_dict(d).summary())
        summaries.sort(key=lambda s: s.get("updated_at") or 0, reverse=True)
        self._atomic_write_json(self._index_path, summaries)
        return summaries

    def _save_index(self, summaries: list[dict[str, Any]]) -> None:
        summaries.sort(key=lambda s: s.get("updated_at") or 0, reverse=True)
        self._atomic_write_json(self._index_path, summaries)

    def _upsert_index(self, conv: Conversation) -> None:
        idx = self._load_index()
        s = conv.summary()
        for i, e in enumerate(idx):
            if e.get("id") == conv.id:
                idx[i] = s
                self._save_index(idx)
                return
        idx.append(s)
        self._save_index(idx)

    def _drop_index(self, sid: str) -> None:
        idx = self._load_index()
        new = [e for e in idx if e.get("id") != sid]
        if len(new) != len(idx):
            self._save_index(new)

    # ── public API ───────────────────────────────────────────────
    def all_ids(self) -> list[str]:
        with self._lock:
            return [e["id"] for e in self._load_index() if "id" in e]

    def list_summaries(
        self,
        *,
        offset: int = 0,
        limit: int = 50,
        q: str = "",
    ) -> dict[str, Any]:
        with self._lock:
            idx = self._load_index()
        if q:
            ql = q.lower()
            idx = [e for e in idx if ql in (e.get("title") or "").lower()]
        total = len(idx)
        page = idx[offset : offset + limit] if limit > 0 else idx[offset:]
        return {"items": page, "total": total, "offset": offset, "limit": limit}

    def get(self, sid: str) -> Conversation:
        with self._lock:
            d = self._read_json(self._session_path(sid))
            if d is None:
                raise ConversationNotFound(sid)
            return Conversation.from_dict(d)

    def get_summary(self, sid: str) -> dict[str, Any]:
        with self._lock:
            for e in self._load_index():
                if e.get("id") == sid:
                    return e
        raise ConversationNotFound(sid)

    def create(
        self,
        *,
        title: str | None = None,
        model_index: int = 0,
        model_key: str | None = None,
    ) -> Conversation:
        now = int(time.time())
        conv = Conversation(
            id=str(uuid.uuid4()),
            title=title or "新会话",
            created_at=now,
            updated_at=now,
            model_index=model_index,
            model_key=model_key,
            status=STATUS_IDLE,
            _revision=0,
        )
        with self._lock:
            self._atomic_write_json(self._session_path(conv.id), conv.to_dict())
            self._upsert_index(conv)
        return conv

    def update_meta(
        self,
        sid: str,
        *,
        title: str | None = None,
        model_index: int | None = None,
        model_key: str | None = None,
        expected_revision: int | None = None,
    ) -> Conversation:
        with self._lock:
            conv = self.get(sid)
            if expected_revision is not None and expected_revision != conv._revision:
                raise RevisionConflict(
                    f"expected rev {expected_revision}, got {conv._revision}"
                )
            if title is not None:
                conv.title = title
            if model_index is not None:
                conv.model_index = model_index
            if model_key is not None:
                conv.model_key = model_key
            conv.updated_at = int(time.time())
            conv._revision += 1
            self._atomic_write_json(self._session_path(sid), conv.to_dict())
            self._upsert_index(conv)
            return conv

    def append_message(
        self,
        sid: str,
        message: Message,
        *,
        expected_revision: int | None = None,
        bump_revision: bool = True,
    ) -> Conversation:
        with self._lock:
            conv = self.get(sid)
            if expected_revision is not None and expected_revision != conv._revision:
                raise RevisionConflict(
                    f"expected rev {expected_revision}, got {conv._revision}"
                )
            if not message.created_at:
                message.created_at = int(time.time())
            conv.messages.append(message)
            conv.updated_at = int(time.time())
            if bump_revision:
                conv._revision += 1
            self._atomic_write_json(self._session_path(sid), conv.to_dict())
            self._upsert_index(conv)
            return conv

    def update_message(
        self,
        sid: str,
        message_id: str,
        *,
        content: str | None = None,
        status: str | None = None,
        expected_revision: int | None = None,
    ) -> Conversation:
        with self._lock:
            conv = self.get(sid)
            if expected_revision is not None and expected_revision != conv._revision:
                raise RevisionConflict(
                    f"expected rev {expected_revision}, got {conv._revision}"
                )
            for m in conv.messages:
                if m.id == message_id:
                    if content is not None:
                        m.content = content
                    if status is not None:
                        m.status = status
                    break
            else:
                raise KeyError(f"message {message_id} not in {sid}")
            conv.updated_at = int(time.time())
            conv._revision += 1
            self._atomic_write_json(self._session_path(sid), conv.to_dict())
            self._upsert_index(conv)
            return conv

    def set_status(
        self,
        sid: str,
        status: str,
        *,
        last_stream_id: str | None = None,
        last_error: str | None = None,
        expected_revision: int | None = None,
    ) -> Conversation:
        with self._lock:
            conv = self.get(sid)
            if expected_revision is not None and expected_revision != conv._revision:
                raise RevisionConflict(
                    f"expected rev {expected_revision}, got {conv._revision}"
                )
            conv.status = status
            if last_stream_id is not None:
                conv.last_stream_id = last_stream_id
            if last_error is not None:
                conv.runtime["last_error"] = last_error
            conv.updated_at = int(time.time())
            conv._revision += 1
            self._atomic_write_json(self._session_path(sid), conv.to_dict())
            self._upsert_index(conv)
            return conv

    def delete(self, sid: str, *, force: bool = False) -> None:
        with self._lock:
            conv = self.get(sid)
            if not force and conv.status in RUNNING_STATUSES:
                raise RevisionConflict(f"cannot delete running session {sid}")
            p = self._session_path(sid)
            try:
                p.unlink()
            except FileNotFoundError:
                pass
            self._drop_index(sid)

    def messages_after(
        self,
        sid: str,
        *,
        after_message_id: str | None = None,
        limit: int | None = None,
    ) -> list[Message]:
        """Return messages strictly after the given message id (or all)."""
        conv = self.get(sid)
        out: list[Message] = []
        started = after_message_id is None
        for m in conv.messages:
            if not started:
                if m.id == after_message_id:
                    started = True
                continue
            out.append(m)
            if limit is not None and len(out) >= limit:
                break
        return out

    def replace_messages(
        self,
        sid: str,
        messages: list[Message],
        *,
        expected_revision: int | None = None,
    ) -> Conversation:
        with self._lock:
            conv = self.get(sid)
            if expected_revision is not None and expected_revision != conv._revision:
                raise RevisionConflict(
                    f"expected rev {expected_revision}, got {conv._revision}"
                )
            conv.messages = list(messages)
            conv.updated_at = int(time.time())
            conv._revision += 1
            self._atomic_write_json(self._session_path(sid), conv.to_dict())
            self._upsert_index(conv)
            return conv

    def iter_all(self) -> Iterator[Conversation]:
        for sid in self.all_ids():
            try:
                yield self.get(sid)
            except ConversationNotFound:
                continue


# ── singleton accessor ───────────────────────────────────────────
_repo: ConversationRepository | None = None
_repo_lock = threading.Lock()


def get_repository() -> ConversationRepository:
    global _repo
    with _repo_lock:
        if _repo is None:
            _repo = ConversationRepository()
        return _repo


def reset_repository() -> None:
    """Test helper: drop the cached singleton."""
    global _repo
    with _repo_lock:
        _repo = None
