"""Direct Anti conversations, independent of the GA session engine."""
from dataclasses import asdict
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field, StringConstraints

from ..origin_policy import is_allowed_ui_origin
from ..services.anti_daemon import AntiAuthState, AntiDaemonState, daemon
from ..services.anti_engine import DEFAULT_EFFORT, DEFAULT_MODEL, AntiError, AntiSessions

router = APIRouter(prefix="/api/anti", tags=["anti"])


AntiSessionTitle = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=160)]


class AntiDaemonStatus(BaseModel):
    state: AntiDaemonState
    detail: str | None = None
    agy_available: bool | None = None
    active_count: int | None = None
    auth_state: AntiAuthState | None = None


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


@router.get("/models")
def models():
    return _call("models")


@router.get("/sessions")
def sessions():
    return _call("list")


@router.post("/sessions")
def create_session(body: AntiSessionCreate):
    return _call("create", body.project, body.title)


@router.patch("/sessions/{sid}")
def rename_session(sid: str, body: AntiSessionRename):
    return _call("rename", sid, body.title)


@router.delete("/sessions/{sid}", status_code=204)
def delete_session(sid: str):
    _call("delete", sid)


@router.get("/sessions/{sid}/runs")
def runs(sid: str):
    return _call("history", sid)


@router.post("/sessions/{sid}/runs")
def submit_run(sid: str, body: AntiRunCreate):
    return _call("submit", sid, body.operation, body.prompt, body.model, body.effort,
                 [(ref.id, ref.path) for ref in body.references])


@router.get("/sessions/{sid}/runs/{rid}")
def run(sid: str, rid: str):
    return _call("refresh", sid, rid)


@router.get("/sessions/{sid}/runs/{rid}/events", response_model_exclude_none=True)
def events(sid: str, rid: str, after: int = Query(default=0, ge=0)) -> list[AntiEvent]:
    return _call("events", sid, rid, after)


@router.post("/sessions/{sid}/runs/{rid}/cancel")
def cancel(sid: str, rid: str):
    return _call("cancel", sid, rid)
