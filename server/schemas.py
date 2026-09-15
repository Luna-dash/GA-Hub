"""Pydantic request/response schemas for the web admin API."""
from __future__ import annotations

from typing import TYPE_CHECKING, Any, Literal

from pydantic import BaseModel, Field

from .services.session_runtime_status import STATUS_IDLE

if TYPE_CHECKING:  # SessionRuntimePayload.from_state annotation only
    from .services.session_coordinator import RuntimeState


class BtwReq(BaseModel):
    text: str = ""


class BtwResp(BaseModel):
    ok: bool
    content: str = ""
    error: str = ""


class AgentTitleReq(BaseModel):
    title: str = ""


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
    removed_history_entries: int


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
class ConversationUpdate(BaseModel):
    title: str = Field(default="", max_length=200)

class ConversationSummaryResp(BaseModel):
    id: str
    title: str
    message_count: int
    last_user_preview: str
    original_user_preview: str

class ConversationListResp(BaseModel):
    total: int
    offset: int
    limit: int
    items: list[ConversationSummaryResp]

class ConversationMessageResp(BaseModel):
    role: Literal["user", "assistant"]
    content: str

class ConversationDetailResp(BaseModel):
    id: str
    title: str
    messages: list[ConversationMessageResp]

class ConversationMutationResp(BaseModel):
    ok: bool
    id: str

class ConversationUpdateResp(ConversationMutationResp):
    title: str

class ConversationRestoreReq(BaseModel):
    session_id: str = Field(min_length=1)

class ConversationRestoreResp(ConversationMutationResp):
    title: str
    restored_lines: int
    full: bool = True

class ArchiveZipResp(BaseModel):
    name: str
    size: int
    mtime: int

class ArchiveZipListResp(BaseModel):
    zips: list[ArchiveZipResp]

class ArchiveZipEntryResp(BaseModel):
    name: str
    size: int
    date: tuple[int, int, int, int, int, int]

class ArchiveZipEntryListResp(BaseModel):
    entries: list[ArchiveZipEntryResp]


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


# ── sessions / projects / scheduled chats / runtimes ────────────

class SessionCreate(BaseModel):
    title: str = Field(default="", max_length=200)
    llm_key: str | None = Field(default=None, min_length=1, max_length=200)
    llm_index: int | None = Field(default=None, ge=0)

class SessionUpdate(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    llm_key: str | None = Field(default=None, min_length=1, max_length=200)
    llm_index: int | None = Field(default=None, ge=0)

class SessionModelUpdate(BaseModel):
    llm_key: str | None = Field(default=None, min_length=1, max_length=200)
    llm_index: int | None = Field(default=None, ge=0)

class HubSession(BaseModel):
    id: str
    title: str
    kind: str = "user"
    llm_key: str | None = None
    llm_index: int | None
    archive_path: str | None
    status: str = STATUS_IDLE
    project_name: str | None = None
    project_path: str | None = None
    created_at: str
    updated_at: str

class SessionListResp(BaseModel):
    total: int
    items: list[HubSession]

class ProjectItem(BaseModel):
    name: str
    path: str
    last_used: int = 0
    mem_lines: int = 0
    memory_path: str | None = None
    source: str | None = None
    dangling: bool = False

class ProjectListResp(BaseModel):
    total: int
    items: list[ProjectItem]

class ProjectCreate(BaseModel):
    path: str = Field(min_length=1, max_length=1000)

class SessionProjectUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    path: str = Field(min_length=1, max_length=1000)

class RunSubmit(BaseModel):
    text: str = Field(min_length=1)
    images: list[str] = Field(default_factory=list)
    source: str = Field(default="webui", min_length=1, max_length=50)

class ScheduledChatCreate(BaseModel):
    text: str = Field(min_length=1)
    images: list[str] = Field(default_factory=list)
    scheduled_for: float

class ScheduledChatResp(BaseModel):
    id: str
    session_id: str
    text: str
    images: list[str]
    scheduled_for: float
    created_at: float
    status: Literal["pending", "dispatching", "sent", "cancelled"]
    sent_at: float | None
    cancelled_at: float | None
    last_error: str | None
    retry_at: float | None

class ScheduledChatListResp(BaseModel):
    total: int
    items: list[ScheduledChatResp]

class SessionRuntimeResp(BaseModel):
    session_id: str
    status: str
    run_id: str | None
    stream_id: str | None
    completed_run_id: str | None = None
    error: str | None = None
    ok: bool | None = None

class SessionRuntimePayload(SessionRuntimeResp):
    @classmethod
    def from_state(
        cls, state: RuntimeState, *, ok: bool | None = None
    ) -> "SessionRuntimePayload":
        fields = {
            "session_id": state.session_id,
            "status": state.status,
            "run_id": state.run_id,
            "stream_id": state.stream_id,
            "completed_run_id": state.completed_run_id,
        }
        if state.error is not None:
            fields["error"] = state.error
        if ok is not None:
            fields["ok"] = ok
        return cls(**fields)

class SessionMessageProjection(BaseModel):
    id: str
    role: Literal["user", "assistant"]
    content: str
    ordinal: int
    timestamp: str | None = None

class SessionMessagesResp(BaseModel):
    session_id: str
    archive_bound: bool
    revision: str | None
    items: list[SessionMessageProjection]
    total: int = 0
    has_more: bool = False
    next_before: int | None = None

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
    # P0 idempotency: one id per logical admission; the engine replays the
    # first terminal response for a retried id. The hub mints one when absent.
    operation_id: str | None = Field(default=None, max_length=128)
    # Page-scoped override. None means fallback to persisted/global preference.
    llm_index: int | None = Field(default=None, ge=0)
    subagent_llm_index: int | None = Field(default=None, ge=0)
    subagent_model_policy: Literal["follow_main", "default", "locked"] | None = None


class ConductorDeliverable(BaseModel):
    """One declared output artifact (mirrors the engine's Contract B shape)."""

    path: str
    desc: str = ""


class ConductorManifestCheck(BaseModel):
    """One deterministic acceptance probe evaluated by the engine itself.

    Read-only probes plus fixed-template run checks (no arbitrary commands,
    no shell — mirrors the engine's ManifestCheck contract).
    """

    kind: Literal["path_exists", "file_contains", "python_compile",
                  "json_parse", "file_line_count", "file_hash"]
    path: str = ""
    contains: str = ""
    paths: list[str] = Field(default_factory=list, max_length=10)
    min_lines: int | None = Field(default=None, ge=0)
    max_lines: int | None = Field(default=None, ge=0)
    algorithm: Literal["sha256", "sha1"] | None = None
    expected: str = Field(default="", max_length=128)
    severity: Literal["blocking", "advisory"] = "blocking"
    timeout_seconds: int = Field(default=30, ge=1, le=120)


class ConductorStartSubagent(BaseModel):
    prompt: str
    request_id: str | None = None
    # P0 idempotency: a retried dispatch with the same id replays the first
    # answer instead of spawning a second worker. Hub mints one when absent.
    operation_id: str | None = Field(default=None, max_length=128)
    # Explicit per-dispatch request from the Conductor supervisor.
    llm_index: int | None = Field(default=None, ge=0)
    # Optional page configuration; omitted fields preserve service state.
    conductor_llm_index: int | None = Field(default=None, ge=0)
    subagent_llm_index: int | None = Field(default=None, ge=0)
    subagent_model_policy: Literal["follow_main", "default", "locked"] | None = None
    # Dispatch manifest (Contract B). The engine rejects dispatches without
    # goal/deliverables with 422; carrying the fields here lets the public
    # hub endpoint satisfy the real engine contract instead of failing it.
    goal: str | None = Field(default=None, max_length=5000)
    boundaries: list[str] = Field(default_factory=list, max_length=50)
    deliverables: list[ConductorDeliverable] = Field(default_factory=list, max_length=50)
    done_when: str | None = Field(default=None, max_length=5000)
    checks: list[ConductorManifestCheck] = Field(default_factory=list, max_length=50)


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
    # Accept escape hatch: the engine refuses plain accept while its
    # deterministic verification verdict is not clean; force is audited.
    force: bool = False
    expected_boot_id: str | None = Field(default=None, max_length=128)
    expected_generation: int | None = Field(default=None, ge=0)
    expected_command_revision: int | None = Field(default=None, ge=0)
    # P0 idempotency for actions that re-open or advance a worker (the
    # engine's own operation cache only covers chat/dispatch): the hub
    # replays the recorded response for a retried id instead of waking the
    # worker twice.
    operation_id: str | None = Field(default=None, max_length=128)
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


class ConductorActivityEvent(BaseModel):
    """One durable row of the Conductor 动态 timeline.

    ``id`` is derived from the engine journal (epoch + seq), so a replay of the
    same event upserts rather than duplicating. The page keys live SSE rows and
    hydrated rows off this same value.
    """

    id: str
    request_id: str
    kind: str
    at: float
    atMs: int
    text: str
    worker_id: str | None = None


class ConductorActivityListResp(BaseModel):
    items: list[ConductorActivityEvent]
    # True when an older window exists before items[0].atMs.
    has_more: bool = False
    # False in legacy no-store mode, where the page must rely on live SSE.
    durable: bool = True


class ConductorSubagent(BaseModel):
    model_config = {"extra": "allow"}
    # extra=allow is deliberate: the hub list snapshot mirrors engine-only
    # fields (manifest, quality_checks, done_marker, ...) that the worker
    # dossier renders. Declared fields below are the required core.

    id: str
    prompt: str = ""
    reply: str
    status: str
    created_at: int = 0
    updated_at: int = 0
    review_status: str = "none"
    review_note: str = ""
    attempt: int = 1
    completed_at: int | None = None
    accepted_at: int | None = None
    generation: int = 0
    active_generation: int = 0
    command_revision: int = 0
    boot_id: str | None = None
    # Requested worker model index (engine-resolved; llm_fallback on the
    # dispatch response covers the degraded case). None for legacy snapshots.
    llm_index: int | None = None
    request_id: str | None = None
    # Hub-decided UI stage (conductor_vocabulary.subagent_stage); the page
    # maps it to label/tone instead of re-deriving tracker semantics.
    stage: str | None = None
    # Hub archive marker: the worker is no longer in the engine pool and its
    # detail comes from the persisted snapshot (read-only for the page).
    archived: bool = False
    # Mid-run progress anchors (2026-09-05): engine-evaluated checkpoints
    # {id, desc, check, status, reached_at, missed_at}. None = pre-milestone
    # engine snapshot.
    plan_milestones: list[dict] | None = None


class ConductorSubagentListResp(BaseModel):
    items: list[ConductorSubagent]
    boot_id: str | None = None
    snapshot_revision: int = -1


class ConductorWorkflowWorker(BaseModel):
    generation: int = 0
    state: Literal[
        "running", "pending", "accepted", "rejected", "timeout",
        "failed", "cancelled", "killed",
    ]


class ConductorWorkflow(BaseModel):
    request_id: str
    title: str | None = None
    admission_state: str = "admitted"
    boot_id: str | None = None
    status: Literal[
        "admitted", "supervising", "reworking", "awaiting_review",
        "completed", "failed", "cancelled", "killed",
    ]
    # None while the workflow can still recover; names the terminal
    # transition ("workflow_completed" / "workflow_failed") once closed.
    terminal_event: str | None = None
    # Hub-decided UI stage (conductor_workflow.workflow_stage): renders the
    # tracker's own judgement (aggregating / recoverable_failure / ...) so
    # the page never re-derives state-machine rules.
    stage: str | None = None
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
    # Automation-first review policy: clean deliveries skip human review.
    auto_accept: bool = True
    boot_id: str | None = None
    protocol_version: int | None = None
    capabilities: list[str] = Field(default_factory=list)
    path_policy: dict | None = None
    recovery: dict | None = None


class ConductorOperationResp(BaseModel):
    operation_id: str
    known: bool
    state: str | None = None
    result: dict | None = None
    request_id: str | None = None
    updated_at: float | None = None


class ConductorSettingsReq(BaseModel):
    auto_accept: bool


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
    ok: bool
    backup: str | None = None
    removed_mixin_references: int = 0
    llms: list[dict[str, Any]] = []
    warnings: list[str] = []
    structured: MyKeyStructured | None = None


class MyKeySessionTestResp(BaseModel):
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


# ── events / service panel / file reveal & upload ────────────────
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
    mode: Literal["open", "folder", "parent"] = "open"


class ResolveFileReq(BaseModel):
    path: str


class ResolveFileResp(BaseModel):
    raw: str
    resolved: str | None
    exists: bool
    is_dir: bool
    ambiguous: bool


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


# ── feishu bot ───────────────────────────────────────────────────
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


# ── mykey raw editor ─────────────────────────────────────────────
class RawWriteReq(BaseModel):
    raw: str

class SessionUpsertReq(BaseModel):
    var: str
    type: str  # native_claude | native_oai | claude | oai | mixin
    fields: dict[str, Any]

# ── preferences / notify / setup ─────────────────────────────────

class NavPreference(BaseModel):
    id: str
    visible: bool

class NavPreferencesReq(BaseModel):
    preferences: list[NavPreference]

class NavPreferencesResp(BaseModel):
    configured: bool
    preferences: list[NavPreference]

class NotifyReq(BaseModel):
    title: str = Field("", max_length=120)
    body: str = Field("", max_length=400)

class SetupReq(BaseModel):
    ga_root: str
    python_path: str | None = None
