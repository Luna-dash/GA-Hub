"""Direct Antigravity (agy) ACP conversations, independent of the GA session engine.

Project workspaces and artifact directories reuse GA's registered workspace
table, while all Agy ACP sessions, approvals, profiles, and quota tracking run
directly inside GA-Hub without an external AntiCLI daemon.
"""
import asyncio
from dataclasses import asdict
import json
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import AwareDatetime, BaseModel, Field, StringConstraints, ValidationError, model_validator

from ..origin_policy import is_allowed_ui_origin
from ..schemas import AttachmentRef
from ..services import agy_models, agy_profile, agy_usage, anti_engine, anti_profiles
from ..services.anti_daemon import AntiAuthState, AntiDaemonState, daemon
from ..services.anti_engine import DEFAULT_EFFORT, DEFAULT_MODEL, AntiError, AntiSessions
from ..services.agy_usage import AgyLedger

router = APIRouter(prefix="/api/anti", tags=["anti"])


AntiSessionTitle = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=160)]


class AntiDaemonStatus(BaseModel):
    state: AntiDaemonState
    detail: str | None = None
    agy_available: bool | None = None
    active_count: int | None = None
    auth_state: AntiAuthState | None = None
    managed: bool | None = None
    port: int | None = None
    version: str | None = None
    max_concurrency: int | None = None
    supports_steering: bool | None = None


class AntiWorkerItem(BaseModel):
    profile_id: str
    profile_name: str = ""
    session_id: str
    session_title: str = ""
    project: str = ""
    workspace: str
    pid: int | None = None
    alive: bool = False
    busy: bool = False
    state: Literal["running", "retiring", "idle", "stopped"] = "idle"
    active_run_id: str | None = None
    idle_seconds: int = 0
    idle_ttl: int = 0
    dirty: bool = False
    retired: bool = False
    exit_pending: bool = False


class AntiWorkerList(BaseModel):
    items: list[AntiWorkerItem]


class AntiDaemonLogsResp(BaseModel):
    lines: list[str]
    log_path: str


class AntiAccountQuotaRow(BaseModel):
    model: str = Field(min_length=1, max_length=128)
    limit: str = Field(min_length=1, max_length=128)
    remaining_pct: float = Field(ge=0, le=100)
    resets_at: AwareDatetime | None = None


AgyAccountTier = Literal["ultra", "pro", "plus", "enterprise", "free"]


class AntiAccountUsage(BaseModel):
    state: Literal["authenticated", "login_required", "unverified"]
    rows: list[AntiAccountQuotaRow]
    detail: str | None = None
    account_tier: AgyAccountTier | None = None
    account_tier_name: str | None = None


class AntiModelItem(BaseModel):
    id: str
    display_name: str
    efforts: list[str] | None = None
    default_effort: str | None = None
    is_default: bool | None = None
    is_orchestrator: bool | None = None


class AntiModelList(BaseModel):
    items: list[AntiModelItem]
    synced_at: str | None = None
    next_sync_at: str | None = None
    stale: bool | None = None
    default_model: str | None = None
    default_effort: str | None = None


class AntiQuotaRule(BaseModel):
    pattern: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=160)]
    group: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=64)]


class AntiOrchestratorPreset(BaseModel):
    id: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=32)]
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=32)]
    planner: Annotated[str, StringConstraints(strip_whitespace=True, max_length=128)] | None = None
    executor: Annotated[str, StringConstraints(strip_whitespace=True, max_length=128)] | None = None


class AntiModelsConfigResp(BaseModel):
    config_path: str
    auto_sync: bool = True
    schedule_hours: list[int] = Field(default_factory=lambda: [0, 6, 12, 18])
    last_synced_at: str | None = None
    next_sync_at: str | None = None
    last_error: str | None = None
    default_model: str = DEFAULT_MODEL
    default_effort: str = DEFAULT_EFFORT
    allow_auto_fallback: bool = True
    aliases: dict[str, str] = Field(default_factory=dict)
    quota_rules: list[AntiQuotaRule] = Field(default_factory=list)
    orchestrator_presets: list[AntiOrchestratorPreset] = Field(
        default_factory=lambda: [AntiOrchestratorPreset(**p) for p in agy_models.DEFAULT_ORCHESTRATOR_PRESETS]
    )
    hidden_models: list[str] = Field(default_factory=list)


class AntiModelsConfigPatch(BaseModel):
    auto_sync: bool | None = None
    schedule_hours: list[int] | None = None
    default_model: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=128)] | None = None
    default_effort: Literal["low", "medium", "high", "xhigh", "max"] | None = None
    allow_auto_fallback: bool | None = None
    aliases: dict[str, str] | None = None
    quota_rules: list[AntiQuotaRule] | None = None
    orchestrator_presets: list[AntiOrchestratorPreset] | None = None
    hidden_models: list[Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=128)]] | None = None


class AgyOrchestratorSettings(BaseModel):
    profile_id: str
    planner: str | None = None
    executor: str | None = None


class AgyOrchestratorUpdate(BaseModel):
    planner: Annotated[str, StringConstraints(strip_whitespace=True, max_length=128)] | None = None
    executor: Annotated[str, StringConstraints(strip_whitespace=True, max_length=128)] | None = None


class AntiCommandItem(BaseModel):
    name: str
    description: str | None = None
    hint: str | None = None


class AntiCommandList(BaseModel):
    items: list[AntiCommandItem]


class AntiSessionResp(BaseModel):
    model_config = {"extra": "allow"}

    id: str
    project: str
    title: str
    workspace: str
    updated_at: str | None = None
    active_run_id: str | None = None
    completed_run_id: str | None = None
    last_outcome: Literal["completed", "cancelled", "failed"] | None = None
    last_error: str | None = None
    has_conversation: bool | None = None
    acp_connected: bool | None = None
    profile_id: str | None = None
    grants: list[str] = Field(default_factory=list)
    queued_count: int | None = None
    engine: Literal["anti"] = "anti"


class AntiQuestionOption(BaseModel):
    id: str
    label: str


class AntiApprovalQuestion(BaseModel):
    question: str
    options: list[AntiQuestionOption] = Field(default_factory=list)


class AntiApprovalPrompt(BaseModel):
    model_config = {"extra": "allow"}

    id: str
    title: str
    details: str
    prompt_type: Literal["approval", "question"] = "approval"
    tool_kind: str = "other"
    allow_always: bool = False
    security_warning: str | None = None
    command: str | None = None
    diff: str | None = None
    question: AntiApprovalQuestion | None = None


class AntiRunUsage(BaseModel):
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    thinking_tokens: int = 0
    model_calls: int | None = None
    generation_ms: int | None = None


class AntiRunResp(BaseModel):
    model_config = {"extra": "allow"}

    id: str
    status: str
    operation: str
    prompt: str
    answer: str | None = None
    error: str | None = None
    error_detail: str | None = None
    model: str | None = None
    effort: str | None = None
    effective_model: str | None = None
    fallback_notice: str | None = None
    mode: Literal["plan", "accept-edits"] = "plan"
    permission_mode: Literal["approval-required", "auto-accept-edits", "auto", "full-access"] = "approval-required"
    approval: AntiApprovalPrompt | None = None
    usage: AntiRunUsage | None = None
    attachments: list[AttachmentRef] = Field(default_factory=list)
    started_at: str | None = None
    finished_at: str | None = None
    progress_messages: list[str] = Field(default_factory=list)


class AntiSessionCreate(BaseModel):
    project: Annotated[str, StringConstraints(min_length=1, max_length=160)]
    title: AntiSessionTitle | None = None


class AntiSessionRename(BaseModel):
    title: AntiSessionTitle


class AntiFileReference(BaseModel):
    id: Annotated[int, Field(gt=0, le=9007199254740991)]
    path: Annotated[str, StringConstraints(min_length=1, max_length=4096)]


class AntiRunCreate(BaseModel):
    operation: Annotated[str, StringConstraints(pattern=r"^[a-zA-Z0-9_-]{1,80}$")]
    prompt: Annotated[str, StringConstraints(max_length=24000)] = ""
    model: Annotated[str, StringConstraints(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/+@-]*$")] | None = None
    effort: Literal["low", "medium", "high", "xhigh", "max"] | None = None
    references: list[AntiFileReference] = Field(default_factory=list, max_length=8)
    attachments: list[AttachmentRef] = Field(default_factory=list, max_length=256)
    mode: Literal["plan", "accept-edits"] = "plan"
    permission_mode: Literal["approval-required", "auto-accept-edits", "auto", "full-access"] | None = None
    orchestrator_planner: Annotated[str, StringConstraints(strip_whitespace=True, max_length=128)] | None = None
    orchestrator_executor: Annotated[str, StringConstraints(strip_whitespace=True, max_length=128)] | None = None

    @model_validator(mode="after")
    def _require_input(self) -> "AntiRunCreate":
        if not (self.prompt.strip() or self.references or self.attachments):
            raise ValueError("请输入内容或添加附件")
        return self


class AntiSessionCompactReq(BaseModel):
    model: Annotated[str, StringConstraints(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/+@-]*$")] | None = None
    effort: Literal["low", "medium", "high", "xhigh", "max"] | None = None
    mode: Literal["plan", "accept-edits"] = "plan"
    permission_mode: Literal["approval-required", "auto-accept-edits", "auto", "full-access"] | None = None


class AntiRunSteer(BaseModel):
    prompt: Annotated[str, StringConstraints(max_length=24000)] = ""
    references: list[AntiFileReference] = Field(default_factory=list, max_length=8)
    attachments: list[AttachmentRef] = Field(default_factory=list, max_length=256)

    @model_validator(mode="after")
    def _require_input(self) -> "AntiRunSteer":
        if not (self.prompt.strip() or self.references or self.attachments):
            raise ValueError("请输入内容或添加附件")
        return self


class AntiQueuedPromptItem(BaseModel):
    id: str
    session_id: str
    position: int
    prompt: str
    model: str | None = None
    effort: str | None = None
    references: list[AntiFileReference] = Field(default_factory=list)
    attachments: list[AttachmentRef] = Field(default_factory=list)
    mode: Literal["plan", "accept-edits"] = "plan"
    permission_mode: Literal["approval-required", "auto-accept-edits", "auto", "full-access"] = "approval-required"
    orchestrator_planner: str | None = None
    orchestrator_executor: str | None = None
    created_at: str


class AntiQueueStateResp(BaseModel):
    items: list[AntiQueuedPromptItem] = Field(default_factory=list)
    paused: bool = False
    pause_reason: str | None = None


class AntiQueueEnqueueReq(BaseModel):
    prompt: Annotated[str, StringConstraints(max_length=24000)] = ""
    model: Annotated[str, StringConstraints(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/+@-]*$")] | None = None
    effort: Literal["low", "medium", "high", "xhigh", "max"] | None = None
    references: list[AntiFileReference] = Field(default_factory=list, max_length=8)
    attachments: list[AttachmentRef] = Field(default_factory=list, max_length=256)
    mode: Literal["plan", "accept-edits"] = "plan"
    permission_mode: Literal["approval-required", "auto-accept-edits", "auto", "full-access"] | None = None
    orchestrator_planner: Annotated[str, StringConstraints(strip_whitespace=True, max_length=128)] | None = None
    orchestrator_executor: Annotated[str, StringConstraints(strip_whitespace=True, max_length=128)] | None = None

    @model_validator(mode="after")
    def _require_input(self) -> "AntiQueueEnqueueReq":
        if not (self.prompt.strip() or self.references or self.attachments):
            raise ValueError("请输入内容或添加附件")
        return self


class AntiQueueMoveReq(BaseModel):
    direction: Literal["up", "down", "top"]


class AntiQueueDispatchReq(BaseModel):
    item_id: str | None = None


class AntiQueuePromoteResp(BaseModel):
    run: AntiRunResp
    queue: AntiQueueStateResp


class AntiStep(BaseModel):
    index: int
    kind: str
    state: str | None = None
    tool: str | None = None
    duration_seconds: float | None = None
    text_delta: str | None = None
    detail: str | None = None
    command: str | None = None
    cwd: str | None = None
    output: str | None = None
    exit_code: int | None = None
    diff: str | None = None


class AntiMessageDelta(BaseModel):
    seq: int
    type: Literal["message.delta"]
    text: str
    step: AntiStep | None = None


class AntiStepUpdate(BaseModel):
    seq: int
    type: Literal["step.update"]
    step: AntiStep


AntiEvent = Annotated[AntiMessageDelta | AntiStepUpdate, Field(discriminator="type")]


def _call(method, *args, **kwargs):
    try:
        return getattr(AntiSessions(), method)(*args, **kwargs)
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


def _require_action(request: Request, action: str, missing_detail: str) -> None:
    if not is_allowed_ui_origin(request.headers.get("origin"), request.headers.get("host")):
        raise HTTPException(403, "Untrusted UI origin")
    if request.headers.get("x-ga-hub-action") != action:
        raise HTTPException(403, missing_detail)


@router.get("/status", response_model=AntiDaemonStatus)
def daemon_status(request: Request):
    verify = (
        request.headers.get("x-ga-hub-action") == "verify-anti-auth"
        and is_allowed_ui_origin(request.headers.get("origin"), request.headers.get("host"))
    )
    try:
        return asdict(daemon.status(verify_auth=verify))
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.post("/start", response_model=AntiDaemonStatus)
def start_daemon(request: Request):
    _require_action(request, "start-anti", "Missing Anti start action")
    try:
        return asdict(daemon.start())
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.post("/stop", response_model=AntiDaemonStatus)
def stop_daemon(request: Request, force: bool = Query(default=False)):
    _require_action(request, "stop-anti", "Missing Anti stop action")
    try:
        if force:
            AntiSessions().force_cancel_all_active()
            return asdict(daemon.stop(force=True))
        return asdict(daemon.stop())
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.post("/restart", response_model=AntiDaemonStatus)
def restart_daemon(request: Request, force: bool = Query(default=False)):
    _require_action(request, "restart-anti", "Missing Anti restart action")
    try:
        if force:
            AntiSessions().force_cancel_all_active()
            return asdict(daemon.restart(force=True))
        return asdict(daemon.restart())
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.get("/logs", response_model=AntiDaemonLogsResp)
def daemon_logs(lines: int = Query(default=80, ge=1, le=500)):
    tail, log_path = daemon.tail_logs(lines)
    return {"lines": tail, "log_path": log_path}


@router.get("/workers", response_model=AntiWorkerList)
def daemon_workers():
    return {"items": _call("workers")}


class AgyProfileUsageSnapshot(BaseModel):
    checked_at: str
    min_remaining_pct: float | None = None
    rows: list[AntiAccountQuotaRow] = Field(default_factory=list)


class AgyProfile(BaseModel):
    id: str
    name: str
    has_credentials: bool | None = None
    auth_state: str | None = None
    account_tier: AgyAccountTier | None = None
    account_tier_name: str | None = None
    usage: AgyProfileUsageSnapshot | None = None
    cooldown_seconds: int | None = None


class AgyProfiles(BaseModel):
    active: str
    profiles: list[AgyProfile]
    login_profile: str | None = None


class AgyUsageRefreshAllResult(BaseModel):
    refreshed: int = 0
    skipped: int = 0
    failed: int = 0
    active: str
    profiles: list[AgyProfile]
    login_profile: str | None = None


class AgyProfileCreate(BaseModel):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=64)]


class AgyCodeLoginState(BaseModel):
    flow_id: str
    profile_id: str
    phase: str
    authorization_url: str | None = None
    error: str | None = None


class AgyCodeLoginSubmit(BaseModel):
    code: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=16384)]


class AntiUsageStats(BaseModel):
    window_hours: int
    total_runs: int = 0
    success_runs: int = 0
    failed_runs: int = 0
    rate_limited_runs: int = 0
    total_tokens: int = 0
    model_calls: int = 0
    tokens_per_sec: float = 0.0
    cache_hit_ratio: float = 0.0
    estimated_cost_usd: float = 0.0


class AntiQuotaPool(BaseModel):
    model_config = {"extra": "allow"}

    model_group: str
    display_name: str
    status: str
    cooldown_remaining_seconds: int = 0
    window_5h_pct: float | None = None
    window_7d_pct: float | None = None
    calibrated_remaining_pct: float | None = None
    estimated_cost_7d_usd: float | None = None

    @model_validator(mode="before")
    @classmethod
    def _normalize_pool(cls, data: object) -> object:
        if not isinstance(data, dict):
            return data
        normalized = dict(data)
        if "model_group" not in normalized and "group" in normalized:
            normalized["model_group"] = normalized["group"]
        if "cooldown_remaining_seconds" not in normalized and "cooldown_remaining_sec" in normalized:
            normalized["cooldown_remaining_seconds"] = normalized["cooldown_remaining_sec"]
        raw_status = normalized.get("status")
        if raw_status == "COOLDOWN":
            normalized["status"] = "cooling_down"
        elif raw_status == "OK":
            normalized["status"] = "normal"
        return normalized


class AntiBreakerResetReq(BaseModel):
    model_group: str | None = Field(default=None, max_length=64)
    profile_id: str | None = Field(default=None, max_length=64)


class AntiQuotaCalibrateReq(BaseModel):
    model_group: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=64)]
    remaining_pct: float = Field(ge=0, le=100)
    note: str | None = Field(default=None, max_length=200)
    profile_id: str | None = Field(default=None, max_length=64)


def _resolve_target_profile(profile_id: str | None) -> str:
    active_id, profiles = anti_profiles.snapshot()
    if isinstance(profile_id, str) and profile_id.strip():
        target = profile_id.strip()
        if not any(p.id == target for p in profiles):
            raise HTTPException(404, "找不到指定的 Agy 账号")
        return target
    return active_id


def _profile_action(request: Request) -> None:
    _require_action(request, "manage-agy-profiles", "Missing Agy profile action")


@router.get("/profiles", response_model=AgyProfiles, response_model_exclude_none=True)
def agy_profiles():
    try:
        active, profiles = anti_profiles.snapshot_details()
        cooldowns = AntiSessions().ledger.active_cooldown_by_profile()
        for item in profiles:
            rem = cooldowns.get(item["id"])
            if rem:
                item["cooldown_seconds"] = rem
        return {
            "active": active,
            "profiles": profiles,
            "login_profile": daemon.active_login_profile(),
        }
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.post("/profiles", response_model=AgyProfile, response_model_exclude_none=True)
def create_agy_profile(body: AgyProfileCreate, request: Request):
    _profile_action(request)
    try:
        return asdict(daemon.add_profile(body.name))
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.post("/profiles/capture", response_model=AgyProfile, response_model_exclude_none=True)
def capture_agy_profile(body: AgyProfileCreate, request: Request):
    _profile_action(request)
    try:
        return asdict(daemon.capture_profile(body.name))
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.post("/profiles/{profile_id}/switch", response_model=AgyProfiles, response_model_exclude_none=True)
def switch_agy_profile(profile_id: str, request: Request):
    _profile_action(request)
    try:
        daemon.switch_profile(profile_id)
        return agy_profiles()
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.patch("/profiles/{profile_id}", response_model=AgyProfile, response_model_exclude_none=True)
def rename_agy_profile(profile_id: str, body: AgyProfileCreate, request: Request):
    _profile_action(request)
    try:
        return asdict(daemon.rename_profile(profile_id, body.name))
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.delete("/profiles/{profile_id}", status_code=204)
def delete_agy_profile(profile_id: str, request: Request):
    _profile_action(request)
    try:
        daemon.delete_profile(profile_id)
        agy_usage.clear_token_cache(profile_id)
        sessions_svc = AntiSessions()
        sessions_svc.delete_profile_conversations(profile_id)
        sessions_svc.ledger.delete_profile(profile_id)
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.get("/profiles/{profile_id}/orchestrator", response_model=AgyOrchestratorSettings)
def get_profile_orchestrator(profile_id: str):
    try:
        return agy_profile.get_orchestrator_settings(profile_id)
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.patch("/profiles/{profile_id}/orchestrator", response_model=AgyOrchestratorSettings)
def update_profile_orchestrator(profile_id: str, body: AgyOrchestratorUpdate, request: Request):
    _profile_action(request)
    try:
        return daemon.set_profile_orchestrator(profile_id, planner=body.planner, executor=body.executor)
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.post("/profiles/{profile_id}/login", status_code=204)
def login_agy_profile(profile_id: str, request: Request):
    _profile_action(request)
    try:
        daemon.login_profile(profile_id)
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.post("/profiles/{profile_id}/login/start", response_model=AgyCodeLoginState)
def start_code_login(profile_id: str, request: Request):
    _profile_action(request)
    try:
        return daemon.start_code_login(profile_id)
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.get("/profiles/login/status/{flow_id}", response_model=AgyCodeLoginState)
def code_login_status(flow_id: str):
    try:
        return daemon.code_login_status(flow_id)
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.post("/profiles/login/submit/{flow_id}", response_model=AgyCodeLoginState)
def submit_code_login(flow_id: str, body: AgyCodeLoginSubmit, request: Request):
    _profile_action(request)
    try:
        return daemon.submit_code_login(flow_id, body.code)
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.post("/profiles/login/cancel/{flow_id}", response_model=AgyCodeLoginState)
def cancel_code_login(flow_id: str, request: Request):
    _profile_action(request)
    try:
        return daemon.cancel_code_login(flow_id)
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.post("/profiles/{profile_id}/logout", response_model=AgyProfile, response_model_exclude_none=True)
def logout_agy_profile(profile_id: str, request: Request):
    _profile_action(request)
    try:
        res = daemon.clear_profile_credentials(profile_id)
        agy_usage.clear_token_cache(profile_id)
        AntiSessions().ledger.clear_quota_state(profile_id)
        return res
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.post("/account-usage", response_model=AntiAccountUsage, response_model_exclude_none=True)
def check_account_usage(request: Request, profile_id: str | None = Query(default=None)):
    _require_action(request, "check-anti-usage", "Missing Anti usage action")
    try:
        target_id = _resolve_target_profile(profile_id)
        report = agy_usage.probe_account_usage(target_id)
        parsed = AntiAccountUsage.model_validate(report)
        if parsed.rows:
            anti_profiles.record_usage(
                target_id,
                parsed.state,
                [json.loads(row.model_dump_json()) for row in parsed.rows],
                account_tier=parsed.account_tier,
                account_tier_name=parsed.account_tier_name,
            )
        else:
            anti_profiles.record_auth_state(target_id, parsed.state)
        return parsed
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc
    except ValidationError as exc:
        raise HTTPException(502, "返回了无法识别的额度报告。") from exc


@router.post(
    "/account-usage/refresh-all",
    response_model=AgyUsageRefreshAllResult,
    response_model_exclude_none=True,
)
def refresh_all_account_usage(
    request: Request,
    only_stale: bool = Query(default=False),
):
    _require_action(request, "check-anti-usage", "Missing Anti usage action")
    try:
        summary = daemon.refresh_all_profiles_usage(only_stale=only_stale)
        snapshot = agy_profiles()
        return {
            "refreshed": int(summary.get("refreshed", 0)),
            "skipped": int(summary.get("skipped", 0)),
            "failed": int(summary.get("failed", 0)),
            **snapshot,
        }
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.get("/quota", response_model=list[AntiQuotaPool])
def gateway_quota(profile_id: str | None = Query(default=None)):
    try:
        target_id = _resolve_target_profile(profile_id)
        data = AntiSessions().ledger.quota_pools(profile_id=target_id)
        return [AntiQuotaPool.model_validate(item) for item in data]
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc
    except ValidationError as exc:
        raise HTTPException(502, "返回了无法识别的配额状态。") from exc


@router.post("/breaker/reset", status_code=204)
def reset_gateway_breaker(
    body: AntiBreakerResetReq,
    request: Request,
    profile_id: str | None = Query(default=None),
):
    _require_action(request, "manage-anti-gateway", "Missing Anti gateway action")
    try:
        target_id = _resolve_target_profile(profile_id or body.profile_id)
        AntiSessions().ledger.reset_breaker(body.model_group, profile_id=target_id)
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.post("/quota/calibrate", response_model=AntiQuotaPool)
def calibrate_gateway_quota(
    body: AntiQuotaCalibrateReq,
    request: Request,
    profile_id: str | None = Query(default=None),
):
    _require_action(request, "manage-anti-gateway", "Missing Anti gateway action")
    try:
        target_id = _resolve_target_profile(profile_id or body.profile_id)
        data = AntiSessions().ledger.calibrate_quota(body.model_group, body.remaining_pct, body.note, profile_id=target_id)
        return AntiQuotaPool.model_validate(data)
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc
    except ValidationError as exc:
        raise HTTPException(502, "返回了无法识别的校准结果。") from exc


@router.get("/stats", response_model=AntiUsageStats)
def gateway_stats(
    window_hours: int = Query(default=24, ge=0, le=8760),
    profile_id: str | None = Query(default=None),
    today: bool = Query(default=False),
):
    try:
        target_id = _resolve_target_profile(profile_id)
        data = AntiSessions().ledger.stats(window_hours, profile_id=target_id, today=today)
        return AntiUsageStats.model_validate(data)
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc
    except ValidationError as exc:
        raise HTTPException(502, "返回了无法识别的统计信息。") from exc


@router.get("/models", response_model=AntiModelList, response_model_exclude_none=True)
def models(profile_id: str | None = Query(default=None)):
    return _call("models", profile_id=profile_id) if profile_id else _call("models")


@router.post("/models/sync", response_model=AntiModelList, response_model_exclude_none=True)
def sync_models(profile_id: str | None = Query(default=None)):
    return _call("sync_models", profile_id=profile_id) if profile_id else _call("sync_models")


@router.get("/models/config", response_model=AntiModelsConfigResp)
def models_config():
    return agy_models.public_config_view()


@router.patch("/models/config", response_model=AntiModelsConfigResp)
def update_models_config(body: AntiModelsConfigPatch, request: Request):
    _require_action(request, "manage-anti-gateway", "Missing Anti gateway action")
    agy_models.patch_user_config(
        auto_sync=body.auto_sync,
        schedule_hours=body.schedule_hours,
        default_model=body.default_model,
        default_effort=body.default_effort,
        allow_auto_fallback=body.allow_auto_fallback,
        aliases=body.aliases,
        quota_rules=[r.model_dump() for r in body.quota_rules] if body.quota_rules is not None else None,
        orchestrator_presets=[p.model_dump() for p in body.orchestrator_presets] if body.orchestrator_presets is not None else None,
        hidden_models=body.hidden_models,
    )
    return agy_models.public_config_view()


@router.get("/commands", response_model=AntiCommandList)
def commands(profile_id: str | None = Query(default=None)):
    return _call("commands", profile_id=profile_id) if profile_id else _call("commands")


@router.get("/sessions", response_model=list[AntiSessionResp])
def sessions():
    return _call("list")


@router.post("/sessions", response_model=AntiSessionResp)
def create_session(body: AntiSessionCreate):
    return _call("create", body.project, body.title)


@router.patch("/sessions/{sid}", response_model=AntiSessionResp)
def rename_session(sid: str, body: AntiSessionRename):
    return _call("rename", sid, body.title)


@router.post("/sessions/{sid}/reset", response_model=AntiSessionResp)
def reset_session(sid: str, force: bool = Query(default=False)):
    return _call("reset_runtime", sid, force=True) if force else _call("reset_runtime", sid)


@router.delete("/sessions/{sid}", status_code=204)
def delete_session(sid: str):
    _call("delete", sid)


@router.get("/sessions/{sid}/runs", response_model=list[AntiRunResp])
def runs(sid: str):
    return _call("history", sid)


@router.delete("/sessions/{sid}/grants", response_model=AntiSessionResp)
def clear_session_grants(sid: str, kind: str | None = Query(default=None)):
    return _call("clear_session_grants", sid, kind)


@router.post("/sessions/{sid}/compact", response_model=AntiRunResp)
def compact_session(sid: str, body: AntiSessionCompactReq | None = None):
    req = body or AntiSessionCompactReq()
    try:
        with daemon.submission() as profile_id:
            return _call(
                "compact",
                sid,
                profile_id=profile_id,
                model=req.model,
                effort=req.effort,
                mode=req.mode,
                permission_mode=req.permission_mode,
            )
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.post("/sessions/{sid}/runs", response_model=AntiRunResp)
def submit_run(sid: str, body: AntiRunCreate):
    extra_orch = {
        k: v
        for k, v in (
            ("orchestrator_planner", body.orchestrator_planner),
            ("orchestrator_executor", body.orchestrator_executor),
        )
        if v is not None
    }
    try:
        with daemon.submission() as profile_id:
            return _call(
                "submit",
                sid,
                body.operation,
                body.prompt,
                body.model,
                body.effort,
                [(ref.id, ref.path) for ref in body.references],
                profile_id,
                [att.model_dump() for att in body.attachments],
                body.mode,
                body.permission_mode,
                **extra_orch,
            )
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.get("/sessions/{sid}/runs/{rid}", response_model=AntiRunResp)
def run(sid: str, rid: str):
    return _call("refresh", sid, rid)


@router.get("/sessions/{sid}/runs/{rid}/events", response_model_exclude_none=True)
def events(sid: str, rid: str, after: int = Query(default=0, ge=0)) -> list[AntiEvent]:
    return _call("events", sid, rid, after)


@router.get("/sessions/{sid}/runs/{rid}/events/stream")
async def events_stream(sid: str, rid: str, request: Request, after: int = Query(default=0, ge=0)):
    sessions_svc = AntiSessions()
    try:
        cursor, eph_cursor, initial_chunks, done = await asyncio.to_thread(
            sessions_svc.poll_stream_step, sid, rid, after, 0
        )
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc

    async def iter_sse():
        cur, eph_cur = cursor, eph_cursor
        for chunk in initial_chunks:
            yield chunk
        if done:
            return
        key = (sessions_svc._db_key, rid)
        while not await request.is_disconnected():
            await asyncio.to_thread(
                anti_engine._EVENT_BUS.wait, key, 0.6, after_eph_seq=eph_cur
            )
            if await request.is_disconnected():
                return
            try:
                cur, eph_cur, chunks, finished = await asyncio.to_thread(
                    sessions_svc.poll_stream_step, sid, rid, cur, eph_cur
                )
            except AntiError:
                return
            for chunk in chunks:
                yield chunk
            if finished:
                return

    return StreamingResponse(iter_sse(), media_type="text/event-stream")


@router.post("/sessions/{sid}/runs/{rid}/cancel", response_model=AntiRunResp)
def cancel(sid: str, rid: str, force: bool = Query(default=False)):
    return _call("cancel", sid, rid, force=True) if force else _call("cancel", sid, rid)


@router.post("/sessions/{sid}/runs/{rid}/steer", response_model=AntiRunResp)
def steer_run(sid: str, rid: str, body: AntiRunSteer):
    return _call(
        "steer",
        sid,
        rid,
        body.prompt,
        [(ref.id, ref.path) for ref in body.references],
        [att.model_dump() for att in body.attachments],
    )


class AntiApprovalDecision(BaseModel):
    model_config = {"extra": "forbid"}
    approval_id: Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{32}$")]
    decision: Literal["allow", "allow_always", "reject"]
    option_id: Annotated[str, StringConstraints(min_length=1, max_length=256)] | None = None


@router.post("/sessions/{sid}/runs/{rid}/approval", response_model=AntiRunResp)
def approve(sid: str, rid: str, body: AntiApprovalDecision, request: Request):
    _require_action(request, "approve-agy", "Approval action header required")
    return _call("approve", sid, rid, body.approval_id, body.decision, body.option_id)


@router.get("/sessions/{sid}/queue", response_model=AntiQueueStateResp)
def get_queue(sid: str):
    return _call("queue_state", sid)


@router.post("/sessions/{sid}/queue", response_model=AntiQueueStateResp)
def enqueue_prompt(sid: str, body: AntiQueueEnqueueReq):
    return _call(
        "enqueue",
        sid,
        body.prompt,
        body.model,
        body.effort,
        [(ref.id, ref.path) for ref in body.references],
        [att.model_dump() for att in body.attachments],
        body.mode,
        body.permission_mode,
        body.orchestrator_planner,
        body.orchestrator_executor,
    )


@router.delete("/sessions/{sid}/queue", response_model=AntiQueueStateResp)
def clear_queue(sid: str):
    return _call("clear_queue", sid)


@router.delete("/sessions/{sid}/queue/{qid}", response_model=AntiQueueStateResp)
def remove_queued_prompt(sid: str, qid: str):
    return _call("remove_queued", sid, qid)


@router.post("/sessions/{sid}/queue/{qid}/move", response_model=AntiQueueStateResp)
def move_queued_prompt(sid: str, qid: str, body: AntiQueueMoveReq):
    return _call("move_queued", sid, qid, body.direction)


@router.post("/sessions/{sid}/queue/{qid}/steer", response_model=AntiQueuePromoteResp)
def steer_queued_prompt(sid: str, qid: str):
    return _call("steer_queued", sid, qid)


@router.post("/sessions/{sid}/queue/dispatch", response_model=AntiQueuePromoteResp)
def dispatch_queued_prompt(sid: str, body: AntiQueueDispatchReq | None = None):
    try:
        with daemon.submission() as profile_id:
            return _call(
                "dispatch_queued",
                sid,
                body.item_id if body else None,
                profile_id=profile_id,
            )
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc
