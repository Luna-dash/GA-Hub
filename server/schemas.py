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
    max_attempts: int = Field(default=3, ge=0, le=5)
    scheduled_max_attempts: int = Field(default=6, ge=0, le=10)
    backoff_base_seconds: float = Field(default=2.0, ge=0.0, le=600.0)
    backoff_factor: float = Field(default=2.0, ge=1.0, le=10.0)
    backoff_max_seconds: float = Field(default=60.0, ge=0.0, le=600.0)
    scheduled_backoff_base_seconds: float = Field(default=5.0, ge=0.0, le=600.0)
    scheduled_backoff_max_seconds: float = Field(default=600.0, ge=0.0, le=600.0)


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


class WxQRState(BaseModel):
    model_config = {"extra": "allow"}

    status: str
    qrcode_id: str | None = None
    url: str | None = None
    bot_id: str | None = None
    error: str | None = None


class WxStatusResp(BaseModel):
    logged_in: bool
    bot_id: str
    polling: bool
    qr: WxQRState
    contacts: int
    allowlist: list[str]
    log_count: int


class WxContact(BaseModel):
    uid: str
    last_text: str
    last_ts: int
    msg_count: int
    nickname: str


class WxContactListResp(BaseModel):
    contacts: list[WxContact]


class WxLogEntry(BaseModel):
    ts: int
    direction: str
    uid: str
    text: str
    media: list[str]
    context_token: str
    nickname: str = ""


class WxLogListResp(BaseModel):
    messages: list[WxLogEntry]


class WxLogoutResp(BaseModel):
    ok: bool


class WxPollStartResp(BaseModel):
    started: bool


class WxPollStopResp(BaseModel):
    ok: bool


class WxSendResp(BaseModel):
    ok: bool


class WxAllowlistResp(BaseModel):
    allowlist: list[str]


class WxAllowlistWriteResp(BaseModel):
    ok: bool
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


class AutonomousScheduleResp(BaseModel):
    id: str
    type: str
    enabled: bool
    prompt: str
    idle_minutes: int
    cron: str
    interval_minutes: int
    last_fired_at: int
    fire_count: int
    name: str


class AutonomousScheduleListResp(BaseModel):
    schedules: list[AutonomousScheduleResp]


class AutonomousMutationResp(BaseModel):
    ok: bool


class AutonomousTriggerResp(BaseModel):
    run_id: str
    stream_id: str


class AutonomousRunResp(BaseModel):
    id: str
    schedule_id: str
    fired_at: int
    prompt_preview: str
    report_paths: list[str] = Field(default_factory=list)
    note: str = ""


class AutonomousRunListResp(BaseModel):
    runs: list[AutonomousRunResp]


class AutonomousReportItem(BaseModel):
    name: str
    size: int
    mtime: int


class AutonomousReportListResp(BaseModel):
    reports: list[AutonomousReportItem]


class AutonomousReportDetailResp(BaseModel):
    name: str
    content: str


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


class TaskScheduleResp(BaseModel):
    id: str
    type: str
    enabled: bool
    prompt: str
    cron: str
    interval_minutes: int
    notify_email: bool
    email_to: str
    email_subject: str
    last_fired_at: int
    fire_count: int
    name: str


class TaskScheduleListResp(BaseModel):
    schedules: list[TaskScheduleResp]


class TaskMutationResp(BaseModel):
    ok: bool


class TaskTriggerResp(BaseModel):
    run_id: str
    stream_id: str


class TaskRunResp(BaseModel):
    id: str
    task_id: str
    task_name: str
    fired_at: int
    stream_id: str
    finished_at: int
    status: str
    prompt_preview: str
    result_preview: str
    email_sent: bool
    email_error: str
    note: str


class TaskRunListResp(BaseModel):
    runs: list[TaskRunResp]


class EmailConfigReq(BaseModel):
    host: str = ""
    port: int = 587
    username: str = ""
    password: str = ""
    from_addr: str = ""
    default_to: str = ""
    use_tls: bool = True
    use_ssl: bool = False


class EmailConfigResp(BaseModel):
    host: str
    port: int
    username: str
    from_addr: str
    default_to: str
    use_tls: bool
    use_ssl: bool
    password_set: bool


class EmailTestReq(BaseModel):
    to: str = ""
    subject: str = "GenericAgent 邮件测试"
    body: str = "这是一封来自 GA-Hub 的测试邮件。"


class EmailTestResp(BaseModel):
    ok: bool
    to: str
    error: str | None = None


# ── conductor ──────────────────────────────────────────────────────────────────
class ConductorChatIn(BaseModel):
    msg: str
    role: Literal["conductor", "system", "user"] = "conductor"
    # Supervisor messages keep the originating workflow explicit across HTTP
    # calls. ``final`` is only valid for the accepted delivery report.
    request_id: str | None = None
    final: bool = False
    # Page-scoped override. None means fallback to persisted/global preference.
    llm_index: int | None = Field(default=None, ge=0)
    subagent_llm_index: int | None = Field(default=None, ge=0)
    subagent_model_policy: Literal["follow_main", "default", "locked"] | None = None


class ConductorStartSubagent(BaseModel):
    prompt: str
    request_id: str | None = None
    # Explicit per-dispatch request from the Conductor supervisor.
    llm_index: int | None = Field(default=None, ge=0)
    # Optional page configuration; omitted fields preserve service state.
    conductor_llm_index: int | None = Field(default=None, ge=0)
    subagent_llm_index: int | None = Field(default=None, ge=0)
    subagent_model_policy: Literal["follow_main", "default", "locked"] | None = None


class ConductorStartReq(BaseModel):
    # Page-scoped selections. Omitted policy preserves the current service state.
    llm_index: int | None = Field(default=None, ge=0)
    subagent_llm_index: int | None = Field(default=None, ge=0)
    subagent_model_policy: Literal["follow_main", "default", "locked"] | None = None


class ConductorSubagentAction(BaseModel):
    action: Literal[
        "keyinfo", "input", "reply", "append", "message", "msg",
        "accept", "rework", "abort", "stop",
    ]
    msg: str = ""
    request_id: str | None = None
    # Used when input/reply resumes a stopped subagent.
    llm_index: int | None = Field(default=None, ge=0)
    conductor_llm_index: int | None = Field(default=None, ge=0)
    subagent_llm_index: int | None = Field(default=None, ge=0)
    subagent_model_policy: Literal["follow_main", "default", "locked"] | None = None


class ConductorTextResp(BaseModel):
    content: str


class ConductorChatMessage(BaseModel):
    model_config = {"extra": "allow"}

    id: str
    role: str
    msg: str
    ts: int
    request_id: str | None = None
    kind: Literal["final", "error"] | None = None
    # Engine-authoritative final marker (D4); mirrors the gahub_app chat
    # item so hydrated history and live events share one shape.
    final: bool | None = None


class ConductorChatListResp(BaseModel):
    items: list[ConductorChatMessage]


class ConductorSubagent(BaseModel):
    model_config = {"extra": "allow"}

    id: str
    prompt: str
    reply: str
    status: str
    created_at: int
    updated_at: int
    review_status: str = "none"
    review_note: str = ""
    attempt: int = 1
    completed_at: int | None = None
    accepted_at: int | None = None
    generation: int = 0
    request_id: str | None = None


class ConductorSubagentListResp(BaseModel):
    items: list[ConductorSubagent]


class ConductorWorkflowWorker(BaseModel):
    generation: int = 0
    state: Literal[
        "running", "pending", "accepted", "failed", "cancelled", "killed"
    ]


class ConductorWorkflow(BaseModel):
    request_id: str
    status: Literal[
        "admitted", "supervising", "reworking", "awaiting_review",
        "completed", "failed", "cancelled", "killed",
    ]
    subagents: dict[str, ConductorWorkflowWorker]
    created_at: float
    completed_at: float | None = None
    item: ConductorChatMessage | None = None
    phase: str | None = None
    error: str | None = None
    failed_agent_id: str | None = None


class ConductorWorkflowListResp(BaseModel):
    items: list[ConductorWorkflow]


class ConductorSubagentInstructionResp(BaseModel):
    model_config = {"extra": "allow"}

    id: str | None = None
    instruction: str | None = None


class ConductorSubagentActionResp(BaseModel):
    model_config = {"extra": "allow"}

    id: str | None = None
    status: str | None = None
    error: str | None = None


class ConductorLogItem(BaseModel):
    id: str
    ts: int
    event: str
    turn: int | None
    text: str


class ConductorLogResp(BaseModel):
    log: list[ConductorLogItem]


class ConductorSubagentCounts(BaseModel):
    running: int
    stopped: int


class ConductorStatusResp(BaseModel):
    started: bool
    stopping: bool
    admission_open: bool
    loop_alive: bool
    agent_alive: bool
    subagents: ConductorSubagentCounts
    chat_count: int


class ConductorLifecycleResp(ConductorStatusResp):
    ok: bool


# ── mykey ───────────────────────────────────────────────────────
class MyKeySession(BaseModel):
    model_config = {"extra": "allow"}

    var: str
    type: Literal["native_claude", "native_oai", "claude", "oai", "mixin"]
    fields: dict[str, Any]
    lineno: int | None = None
    end_lineno: int | None = None


class MyKeyStructured(BaseModel):
    model_config = {"extra": "allow"}

    sessions: list[MyKeySession]
    mixins: list[MyKeySession]
    mixin: MyKeySession | None = None
    globals: dict[str, Any]


class MyKeyDataResp(BaseModel):
    path: str
    exists: bool
    raw: str
    structured: MyKeyStructured
    mtime: int


class MyKeyWriteResp(BaseModel):
    model_config = {"extra": "allow"}

    ok: bool
    backup: str | None = None
    removed_mixin_references: int = 0
    llms: list[dict[str, Any]] = []
    warnings: list[str] = []
    structured: MyKeyStructured | None = None


class MyKeySessionTestResp(BaseModel):
    model_config = {"extra": "allow"}

    ok: bool
    error: str | None = None
    latency_ms: int | None = None
    preview: str | None = None
    model: str | None = None
    name: str | None = None


class MyKeyBackup(BaseModel):
    name: str
    mtime: int
    size: int


class MyKeyBackupListResp(BaseModel):
    backups: list[MyKeyBackup]


class MyKeySyncResultResp(BaseModel):
    model_config = {"extra": "allow"}

    ok: bool
    action: str
    path: str
    returncode: int
    stdout: str
    stderr: str
    llms: list[dict[str, Any]] = []
    warnings: list[str] = []
    structured: MyKeyStructured | None = None


class MyKeyOpenResp(BaseModel):
    ok: bool
    path: str


# Observability / services
class LogLinesResp(BaseModel):
    lines: list[str]
    file: str | None = None


class EventBusEnvelope(BaseModel):
    topic: str
    payload: dict[str, Any]
    ts: float


class EventRecentResp(BaseModel):
    events: list[EventBusEnvelope]


class ServicePanelItem(BaseModel):
    id: str
    name: str
    state: Literal["running", "ready", "stopped", "error"]
    summary: str
    href: str
    metrics: dict[str, Any]
    error: str | None
    activity: Literal["active", "standby", "inactive"]
    health: Literal["healthy", "attention", "unknown"]
    expected_running: bool


class ServicePanelResp(BaseModel):
    services: list[ServicePanelItem]
    timestamp: int


# Upload / local files
class RevealFileReq(BaseModel):
    path: str


class UploadResp(BaseModel):
    file_id: str
    name: str
    path: str
    url: str
    mime: str
    size: int


class RevealFileResp(BaseModel):
    ok: bool
    path: str


# Feishu bot
class FsSendReq(BaseModel):
    receive_id: str
    text: str
    receive_id_type: Literal["open_id", "chat_id", "user_id", "union_id", "email"] = "open_id"
    use_card: bool = False


class FsKeysReq(BaseModel):
    app_id: str = Field(min_length=1)
    app_secret: str = Field(min_length=1)
    allowed_users: str = ""


class FsCheckResp(BaseModel):
    model_config = {"extra": "allow"}

    ready: bool | None = None
    ok: bool | None = None
    returncode: int | None = None
    error: str | None = None
    raw: str | None = None
    fsapp_path: str | None = None
    app_id_masked: str | None = None
    app_secret_masked: str | None = None
    allowed_users: list[str] | None = None
    public_access: bool | None = None
    pattern_count: int | None = None
    agent_ok: bool | None = None
    agent_error: str | None = None


class FsStatusResp(BaseModel):
    running: bool
    pid: int | None
    returncode: int | None
    external: bool
    fsapp_path: str
    fsapp_exists: bool
    python: str
    log_file: str
    log_exists: bool
    last_check: FsCheckResp | None = None
    last_check_ts: float = 0


class FsKeysResp(BaseModel):
    ok: bool
    app_id_masked: str | None = None
    allowed_users_saved: bool | None = None


class FsStartResp(BaseModel):
    model_config = {"extra": "allow"}

    started: bool
    running: bool
    pid: int | None = None
    log_file: str | None = None


class FsStopResp(BaseModel):
    stopped: bool
    running: bool
    pid: int | None = None


class FsSendResp(BaseModel):
    model_config = {"extra": "allow"}

    ok: bool
    returncode: int | None = None
    raw: str | None = None
    message_id: str | None = None
