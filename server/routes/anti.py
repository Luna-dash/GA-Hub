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
from ..services import agy_usage, anti_engine, anti_profiles
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


class AntiDaemonLogsResp(BaseModel):
    lines: list[str]
    log_path: str


class AntiAccountQuotaRow(BaseModel):
    model: str = Field(min_length=1, max_length=128)
    limit: str = Field(min_length=1, max_length=128)
    remaining_pct: float = Field(ge=0, le=100)
    resets_at: AwareDatetime


class AntiAccountUsage(BaseModel):
    state: Literal["authenticated", "login_required", "unverified"]
    rows: list[AntiAccountQuotaRow]


class AntiModelItem(BaseModel):
    id: str
    display_name: str


class AntiModelList(BaseModel):
    items: list[AntiModelItem]


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
    has_conversation: bool | None = None
    acp_connected: bool | None = None
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
    thinking_tokens: int = 0


class AntiRunResp(BaseModel):
    model_config = {"extra": "allow"}

    id: str
    status: str
    operation: str
    prompt: str
    answer: str | None = None
    error: str | None = None
    error_detail: str | None = None
    mode: Literal["plan", "accept-edits"] = "plan"
    permission_mode: Literal["approval-required", "auto-accept-edits", "auto", "full-access"] = "approval-required"
    approval: AntiApprovalPrompt | None = None
    usage: AntiRunUsage | None = None
    attachments: list[AttachmentRef] = Field(default_factory=list)


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
    model: Annotated[str, StringConstraints(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/+@-]*$")] = DEFAULT_MODEL
    effort: Literal["low", "medium", "high", "xhigh", "max"] = DEFAULT_EFFORT
    references: list[AntiFileReference] = Field(default_factory=list, max_length=8)
    attachments: list[AttachmentRef] = Field(default_factory=list, max_length=256)
    mode: Literal["plan", "accept-edits"] = "plan"
    permission_mode: Literal["approval-required", "auto-accept-edits", "auto", "full-access"] | None = None

    @model_validator(mode="after")
    def _require_input(self) -> "AntiRunCreate":
        if not (self.prompt.strip() or self.references or self.attachments):
            raise ValueError("请输入内容或添加附件")
        return self


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


def _call(method, *args):
    try:
        return getattr(AntiSessions(), method)(*args)
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
def stop_daemon(request: Request):
    _require_action(request, "stop-anti", "Missing Anti stop action")
    try:
        return asdict(daemon.stop())
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.post("/restart", response_model=AntiDaemonStatus)
def restart_daemon(request: Request):
    _require_action(request, "restart-anti", "Missing Anti restart action")
    try:
        return asdict(daemon.restart())
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.get("/logs", response_model=AntiDaemonLogsResp)
def daemon_logs(lines: int = Query(default=80, ge=1, le=500)):
    tail, log_path = daemon.tail_logs(lines)
    return {"lines": tail, "log_path": log_path}


class AgyProfileUsageSnapshot(BaseModel):
    checked_at: str
    min_remaining_pct: float | None = None
    rows: list[AntiAccountQuotaRow] = Field(default_factory=list)


class AgyProfile(BaseModel):
    id: str
    name: str
    has_credentials: bool | None = None
    auth_state: str | None = None
    usage: AgyProfileUsageSnapshot | None = None
    cooldown_seconds: int | None = None


class AgyProfiles(BaseModel):
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


class AntiQuotaCalibrateReq(BaseModel):
    model_group: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=64)]
    remaining_pct: float = Field(ge=0, le=100)
    note: str | None = Field(default=None, max_length=200)


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
        sessions_svc = AntiSessions()
        sessions_svc.delete_profile_conversations(profile_id)
        sessions_svc.ledger.delete_profile(profile_id)
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
        AntiSessions().ledger.clear_quota_state(profile_id)
        return res
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.post("/account-usage", response_model=AntiAccountUsage)
def check_account_usage(request: Request):
    _require_action(request, "check-anti-usage", "Missing Anti usage action")
    try:
        profile_id = anti_profiles.snapshot()[0]
        report = agy_usage.probe_account_usage(profile_id)
        parsed = AntiAccountUsage.model_validate(report)
        anti_profiles.record_usage(
            profile_id,
            parsed.state,
            [json.loads(row.model_dump_json()) for row in parsed.rows],
        )
        return parsed
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc
    except ValidationError as exc:
        raise HTTPException(502, "返回了无法识别的额度报告。") from exc


@router.get("/quota", response_model=list[AntiQuotaPool])
def gateway_quota():
    try:
        profile_id = anti_profiles.snapshot()[0]
        data = AntiSessions().ledger.quota_pools(profile_id=profile_id)
        return [AntiQuotaPool.model_validate(item) for item in data]
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc
    except ValidationError as exc:
        raise HTTPException(502, "返回了无法识别的配额状态。") from exc


@router.post("/breaker/reset", status_code=204)
def reset_gateway_breaker(body: AntiBreakerResetReq, request: Request):
    _require_action(request, "manage-anti-gateway", "Missing Anti gateway action")
    try:
        profile_id = anti_profiles.snapshot()[0]
        AntiSessions().ledger.reset_breaker(body.model_group, profile_id=profile_id)
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.post("/quota/calibrate", response_model=AntiQuotaPool)
def calibrate_gateway_quota(body: AntiQuotaCalibrateReq, request: Request):
    _require_action(request, "manage-anti-gateway", "Missing Anti gateway action")
    try:
        profile_id = anti_profiles.snapshot()[0]
        data = AntiSessions().ledger.calibrate_quota(body.model_group, body.remaining_pct, body.note, profile_id=profile_id)
        return AntiQuotaPool.model_validate(data)
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc
    except ValidationError as exc:
        raise HTTPException(502, "返回了无法识别的校准结果。") from exc


@router.get("/stats", response_model=AntiUsageStats)
def gateway_stats(window_hours: int = Query(default=24, ge=0, le=8760)):
    try:
        profile_id = anti_profiles.snapshot()[0]
        data = AntiSessions().ledger.stats(window_hours, profile_id=profile_id)
        return AntiUsageStats.model_validate(data)
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc
    except ValidationError as exc:
        raise HTTPException(502, "返回了无法识别的统计信息。") from exc


@router.get("/models", response_model=AntiModelList)
def models():
    return _call("models")


@router.get("/commands", response_model=AntiCommandList)
def commands():
    return _call("commands")


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
def reset_session(sid: str):
    return _call("reset_runtime", sid)


@router.delete("/sessions/{sid}", status_code=204)
def delete_session(sid: str):
    _call("delete", sid)


@router.get("/sessions/{sid}/runs", response_model=list[AntiRunResp])
def runs(sid: str):
    return _call("history", sid)


@router.post("/sessions/{sid}/runs", response_model=AntiRunResp)
def submit_run(sid: str, body: AntiRunCreate):
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
async def events_stream(sid: str, rid: str, request: Request):
    sessions_svc = AntiSessions()
    try:
        cursor, eph_cursor, initial_chunks, done = await asyncio.to_thread(
            sessions_svc.poll_stream_step, sid, rid, 0, 0
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
def cancel(sid: str, rid: str):
    return _call("cancel", sid, rid)


class AntiApprovalDecision(BaseModel):
    model_config = {"extra": "forbid"}
    approval_id: Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{32}$")]
    decision: Literal["allow", "allow_always", "reject"]
    option_id: Annotated[str, StringConstraints(min_length=1, max_length=256)] | None = None


@router.post("/sessions/{sid}/runs/{rid}/approval", response_model=AntiRunResp)
def approve(sid: str, rid: str, body: AntiApprovalDecision, request: Request):
    _require_action(request, "approve-agy", "Approval action header required")
    return _call("approve", sid, rid, body.approval_id, body.decision, body.option_id)
