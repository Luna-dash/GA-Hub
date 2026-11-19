"""Direct Anti conversations, independent of the GA session engine.

Project workspaces and artifact directories intentionally reuse GA's
registered workspace table rather than duplicating project management.
"""
from dataclasses import asdict
import json
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import AwareDatetime, BaseModel, Field, StringConstraints, ValidationError

from ..origin_policy import is_allowed_ui_origin
from ..services import anti_profiles
from ..services.anti_daemon import AntiAuthState, AntiDaemonState, daemon
from ..services.anti_engine import DEFAULT_EFFORT, DEFAULT_MODEL, AntiAdapter, AntiError, AntiSessions

router = APIRouter(prefix="/api/anti", tags=["anti"])


AntiSessionTitle = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=160)]


class AntiDaemonStatus(BaseModel):
    state: AntiDaemonState
    detail: str | None = None
    agy_available: bool | None = None
    active_count: int | None = None
    auth_state: AntiAuthState | None = None


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


class AntiSessionResp(BaseModel):
    model_config = {"extra": "allow"}

    id: str
    project: str
    title: str
    workspace: str
    updated_at: str | None = None
    active_run_id: str | None = None
    engine: Literal["anti"] = "anti"


class AntiRunResp(BaseModel):
    model_config = {"extra": "allow"}

    id: str
    status: str
    operation: str
    prompt: str
    answer: str | None = None
    error: str | None = None
    error_detail: str | None = None


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
    prompt: Annotated[str, StringConstraints(min_length=1, max_length=24000)]
    model: Annotated[str, StringConstraints(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/+@-]*$")] = DEFAULT_MODEL
    effort: Literal["low", "medium", "high", "xhigh", "max"] = DEFAULT_EFFORT
    references: list[AntiFileReference] = Field(default_factory=list, max_length=8)


class AntiStep(BaseModel):
    index: int
    kind: str
    state: str | None = None
    tool: str | None = None
    duration_seconds: float | None = None
    text_delta: str | None = None


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


@router.get("/status", response_model=AntiDaemonStatus)
def daemon_status(request: Request):
    verify = (request.headers.get("x-ga-hub-action") == "verify-anti-auth"
              and is_allowed_ui_origin(request.headers.get("origin")))
    try:
        return asdict(daemon.status(verify_auth=verify))
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.post("/start", response_model=AntiDaemonStatus)
def start_daemon(request: Request):
    if not is_allowed_ui_origin(request.headers.get("origin")):
        raise HTTPException(403, "Untrusted UI origin")
    # Require a non-simple header so cross-origin forms cannot launch a process.
    if request.headers.get("x-ga-hub-action") != "start-anti":
        raise HTTPException(403, "Missing Anti start action")
    try:
        return asdict(daemon.start())
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.post("/stop", response_model=AntiDaemonStatus)
def stop_daemon(request: Request):
    if not is_allowed_ui_origin(request.headers.get("origin")):
        raise HTTPException(403, "Untrusted UI origin")
    if request.headers.get("x-ga-hub-action") != "stop-anti":
        raise HTTPException(403, "Missing Anti stop action")
    try:
        return asdict(daemon.stop())
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.post("/restart", response_model=AntiDaemonStatus)
def restart_daemon(request: Request):
    if not is_allowed_ui_origin(request.headers.get("origin")):
        raise HTTPException(403, "Untrusted UI origin")
    if request.headers.get("x-ga-hub-action") != "restart-anti":
        raise HTTPException(403, "Missing Anti restart action")
    try:
        return asdict(daemon.restart())
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


class AgyProfileUsageSnapshot(BaseModel):
    checked_at: str
    min_remaining_pct: float | None = None
    rows: list[AntiAccountQuotaRow] = Field(default_factory=list)


class AgyProfileDetail(BaseModel):
    has_credentials: bool = False
    auth_state: str | None = None
    usage: AgyProfileUsageSnapshot | None = None


class AgyProfile(BaseModel):
    id: str
    name: str


class AgyProfiles(BaseModel):
    active: str
    profiles: list[AgyProfile]
    login_profile: str | None = None
    details: dict[str, AgyProfileDetail] | None = None


class AgyProfileCreate(BaseModel):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=64)]


class AntiQuotaPool(BaseModel):
    model_config = {"extra": "allow"}

    model_group: str
    display_name: str
    status: str
    cooldown_remaining_seconds: int = 0
    window_5h_pct: float | None = None
    window_7d_pct: float | None = None


class AntiBreakerResetReq(BaseModel):
    model_group: str | None = Field(default=None, max_length=64)


def _profile_action(request: Request) -> None:
    if not is_allowed_ui_origin(request.headers.get("origin")):
        raise HTTPException(403, "Untrusted UI origin")
    if request.headers.get("x-ga-hub-action") != "manage-agy-profiles":
        raise HTTPException(403, "Missing Agy profile action")


@router.get("/profiles", response_model=AgyProfiles, response_model_exclude_none=True)
def agy_profiles():
    try:
        active, profiles = anti_profiles.snapshot()
        return {
            "active": active,
            "profiles": [asdict(profile) for profile in profiles],
            "login_profile": daemon.active_login_profile(),
            "details": anti_profiles.snapshot_details(),
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
        AntiSessions().delete_profile_conversations(profile_id)
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.post("/profiles/{profile_id}/login", status_code=204)
def login_agy_profile(profile_id: str, request: Request):
    _profile_action(request)
    try:
        daemon.login_profile(profile_id)
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.post("/account-usage", response_model=AntiAccountUsage)
def check_account_usage(request: Request):
    if not is_allowed_ui_origin(request.headers.get("origin")):
        raise HTTPException(403, "Untrusted UI origin")
    if request.headers.get("x-ga-hub-action") != "check-anti-usage":
        raise HTTPException(403, "Missing Anti usage action")
    try:
        with daemon.submission() as profile_id:
            report = AntiAdapter().request("POST", "/v1/account-usage", read_timeout=30,
                                           headers={"X-AntiCLI-Action": "check-account-usage"})
        parsed = AntiAccountUsage.model_validate(report)
        anti_profiles.record_usage(
            profile_id,
            parsed.state,
            [json.loads(row.model_dump_json()) for row in parsed.rows],
        )
        return parsed
    except AntiError as exc:
        if exc.status == 404:
            raise HTTPException(503, "当前 AntiCLI 网关版本不支持额度检测，请更新网关。") from exc
        raise HTTPException(503, "无法连接 AntiCLI 网关，请检查网关状态后重试。") from exc
    except ValidationError as exc:
        raise HTTPException(502, "AntiCLI 返回了无法识别的额度报告。") from exc


@router.get("/quota", response_model=list[AntiQuotaPool])
def gateway_quota():
    try:
        with daemon.submission():
            data = AntiAdapter().request("GET", "/v1/quota")
        if not isinstance(data, list):
            return []
        return [AntiQuotaPool.model_validate(item) for item in data]
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc
    except ValidationError as exc:
        raise HTTPException(502, "AntiCLI 返回了无法识别的配额状态。") from exc


@router.post("/breaker/reset", status_code=204)
def reset_gateway_breaker(body: AntiBreakerResetReq, request: Request):
    if not is_allowed_ui_origin(request.headers.get("origin")):
        raise HTTPException(403, "Untrusted UI origin")
    if request.headers.get("x-ga-hub-action") != "manage-anti-gateway":
        raise HTTPException(403, "Missing Anti gateway action")
    try:
        with daemon.submission():
            AntiAdapter().request("POST", "/v1/breaker/reset", json={"model_group": body.model_group})
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.get("/models", response_model=AntiModelList)
def models():
    try:
        with daemon.submission() as profile_id:
            return _call("models", profile_id == anti_profiles.DEFAULT)
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.get("/sessions", response_model=list[AntiSessionResp])
def sessions():
    return _call("list")


@router.post("/sessions", response_model=AntiSessionResp)
def create_session(body: AntiSessionCreate):
    return _call("create", body.project, body.title)


@router.patch("/sessions/{sid}", response_model=AntiSessionResp)
def rename_session(sid: str, body: AntiSessionRename):
    return _call("rename", sid, body.title)


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
            return _call("submit", sid, body.operation, body.prompt, body.model, body.effort,
                         [(ref.id, ref.path) for ref in body.references], profile_id)
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.get("/sessions/{sid}/runs/{rid}", response_model=AntiRunResp)
def run(sid: str, rid: str):
    return _call("refresh", sid, rid)


@router.get("/sessions/{sid}/runs/{rid}/events", response_model_exclude_none=True)
def events(sid: str, rid: str, after: int = Query(default=0, ge=0)) -> list[AntiEvent]:
    return _call("events", sid, rid, after)


@router.get("/sessions/{sid}/runs/{rid}/events/stream")
def events_stream(sid: str, rid: str):
    try:
        gen = AntiSessions().stream_events(sid, rid)
        first = next(gen, None)
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc

    def iter_sse():
        if first is not None:
            yield first
        try:
            yield from gen
        except AntiError:
            return

    return StreamingResponse(iter_sse(), media_type="text/event-stream")


@router.post("/sessions/{sid}/runs/{rid}/cancel", response_model=AntiRunResp)
def cancel(sid: str, rid: str):
    return _call("cancel", sid, rid)
