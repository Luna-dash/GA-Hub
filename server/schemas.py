"""Pydantic request/response schemas for the web admin API."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


# ── chat ─────────────────────────────────────────────────────────
class ChatSubmit(BaseModel):
    text: str = ""
    images: list[str] = Field(default_factory=list)        # absolute paths returned by /api/upload
    source: str = "user"
    # Page-scoped override. None means fallback to persisted/global preference.
    llm_index: int | None = None


class BtwReq(BaseModel):
    text: str = ""


class BtwResp(BaseModel):
    ok: bool
    content: str = ""
    error: str = ""


class AgentTitleReq(BaseModel):
    title: str = ""


class ChatStreamMsg(BaseModel):
    type: Literal["heartbeat", "next", "done", "error"]
    stream_id: str | None = None
    content: str | None = None
    source: str | None = None
    error: str | None = None


# ── application status ─────────────────────────────────────────────────────
class GlobalAgentStatus(BaseModel):
    is_running: bool
    llm_no: int
    llm_name: str
    llm_model: str
    last_reply_time: int
    queued_tasks: int
    history_lines: int
    current_title: str


class SchedulerRuntimeStatus(BaseModel):
    running: bool


class SchedulerDomainStatus(BaseModel):
    state: Literal["running", "stopped", "error"]
    schedule_count: int | None
    error: str | None


class FeishuProcessStatus(BaseModel):
    """Feishu gateway status, or an initialization diagnostic.

    The OpenAPI schema intentionally describes the complete healthy response;
    initialization failures are represented by ``error`` in ``/api/status``.
    """

    model_config = {"extra": "allow"}

    running: bool
    pid: int | None
    returncode: int | None
    external: bool
    fsapp_path: str
    fsapp_exists: bool
    python: str
    log_file: str
    log_exists: bool
    last_check: Any | None
    last_check_ts: float


class SchedulerDomainCount(BaseModel):
    schedule_count: int


class AppStatusResp(BaseModel):
    """Always-available application status contract.

    Optional fields are deliberately omitted rather than null in setup mode;
    use ``response_model_exclude_unset=True`` to preserve that compatibility.
    """

    model_config = {"extra": "forbid"}

    configured: bool
    ga_root: str | None
    python_path: str | None
    resolved_python: str | None
    resolved_python_source: str | None
    mode: Literal["setup"] | None = None
    agent: GlobalAgentStatus | None = None
    feishu: FeishuProcessStatus | None = None
    autonomous: SchedulerDomainCount | None = None
    tasks: SchedulerDomainCount | None = None
    schedulers: dict[str, SchedulerRuntimeStatus | SchedulerDomainStatus] | None = None


# ── llm ──────────────────────────────────────────────────────────
class LLMSwitch(BaseModel):
    index: int


class ChatRetryConfigReq(BaseModel):
    enabled: bool = True
    max_attempts: int = Field(default=2, ge=0, le=5)


# ── rewind ───────────────────────────────────────────────────────
class RewindReq(BaseModel):
    """Rewind chat turns.

    Provide one of:
      - sid: stream_id of the turn to rewind back to (that turn + all later ones removed)
      - n:   number of most-recent turns to remove (1 = undo last turn)
    sid takes precedence if both provided.
    """
    sid: str | None = None
    n: int | None = Field(default=None, ge=1)


class RewindResp(BaseModel):
    removed_sids: list[str]
    kept: int
    history_lines: int


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


class MemoryTextResp(BaseModel):
    content: str


class MemoryWriteResp(BaseModel):
    ok: bool
    size: int


class SOPItem(BaseModel):
    name: str
    size: int
    mtime: int


class SOPListResp(BaseModel):
    sops: list[SOPItem]


class SOPDetailResp(BaseModel):
    name: str
    content: str


class SkillItem(BaseModel):
    path: str
    name: str
    size: int
    mtime: int


class SkillListResp(BaseModel):
    skills: list[SkillItem]
    count: int


class SkillDetailResp(BaseModel):
    path: str
    content: str


class SkillSearchMatch(BaseModel):
    line: int
    text: str


class SkillSearchHit(BaseModel):
    path: str
    matches: list[SkillSearchMatch]


class SkillSearchResp(BaseModel):
    hits: list[SkillSearchHit]
    scanned: int
    truncated: bool
    query: str


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


# ── scheduled tasks ──────────────────────────────────────────────
class TaskScheduleUpsert(BaseModel):
    id: str | None = None
    type: Literal["cron", "interval"] = "cron"
    name: str = ""
    enabled: bool = True
    prompt: str = ""
    cron: str | None = None
    interval_minutes: int | None = None
    notify_email: bool = False
    email_to: str = ""
    email_subject: str = ""


class EmailConfigReq(BaseModel):
    host: str = ""
    port: int = 587
    username: str = ""
    password: str = ""
    from_addr: str = ""
    default_to: str = ""
    use_tls: bool = True
    use_ssl: bool = False


class EmailTestReq(BaseModel):
    to: str = ""
    subject: str = "GenericAgent 邮件测试"
    body: str = "这是一封来自 GA-Hub 的测试邮件。"


# ── conductor ──────────────────────────────────────────────────────────────────
class ConductorChatIn(BaseModel):
    msg: str
    role: Literal["conductor", "system", "user"] = "conductor"
    # Page-scoped override. None means fallback to persisted/global preference.
    llm_index: int | None = None


class ConductorStartSubagent(BaseModel):
    prompt: str
    # Page-scoped override. None means fallback to persisted/global preference.
    llm_index: int | None = None


class ConductorStartReq(BaseModel):
    # Page-scoped override. None means fallback to persisted/global preference.
    llm_index: int | None = None


class ConductorSubagentAction(BaseModel):
    action: Literal["keyinfo", "input", "reply", "append", "message", "msg", "abort", "stop"]
    msg: str = ""


class ConductorApproval(BaseModel):
    prompt: str
    source: str = ""
