"""Pydantic request/response schemas for the web admin API."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


# ── chat ─────────────────────────────────────────────────────────
class ChatSubmit(BaseModel):
    text: str = ""
    images: list[str] = Field(default_factory=list)        # absolute paths returned by /api/upload
    source: str = "user"


class ChatStreamMsg(BaseModel):
    type: Literal["heartbeat", "next", "done", "error"]
    stream_id: str | None = None
    content: str | None = None
    source: str | None = None
    error: str | None = None


# ── llm ──────────────────────────────────────────────────────────
class LLMSwitch(BaseModel):
    index: int


# ── wechat ───────────────────────────────────────────────────────
class WxSendReq(BaseModel):
    uid: str
    text: str | None = None
    file_path: str | None = None              # path returned by /api/upload
    context_token: str = ""


class WxAllowlistReq(BaseModel):
    allowlist: list[str]


# ── conversations ────────────────────────────────────────────────
class ConvRename(BaseModel):
    title: str


# ── memory ───────────────────────────────────────────────────────
class TextWrite(BaseModel):
    content: str


# ── autonomous ───────────────────────────────────────────────────
class ScheduleUpsert(BaseModel):
    id: str | None = None
    type: Literal["idle", "cron", "interval"]
    name: str = ""
    enabled: bool = True
    prompt: str | None = None
    idle_minutes: int | None = None
    cron: str | None = None
    interval_minutes: int | None = None
