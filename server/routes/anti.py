"""Direct Anti conversations, independent of the GA session engine."""
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, StringConstraints

from ..origin_policy import is_allowed_ui_origin
from ..services.anti_daemon import AntiDaemonStatus, daemon
from ..services.anti_engine import DEFAULT_EFFORT, DEFAULT_MODEL, AntiError, AntiSessions

router = APIRouter(prefix="/api/anti", tags=["anti"])


class AntiSessionCreate(BaseModel):
    project: Annotated[str, StringConstraints(min_length=1, max_length=160)]
    title: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=160)] = "Anti"


class AntiRunCreate(BaseModel):
    operation: Annotated[str, StringConstraints(pattern=r"^[a-zA-Z0-9_-]{1,80}$")]
    prompt: Annotated[str, StringConstraints(min_length=1, max_length=24000)]
    model: Annotated[str, StringConstraints(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/+@-]*$")] = DEFAULT_MODEL
    effort: Literal["low", "medium", "high", "xhigh", "max"] = DEFAULT_EFFORT


def _call(method, *args):
    try:
        return getattr(AntiSessions(), method)(*args)
    except AntiError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.get("/status", response_model=AntiDaemonStatus)
def daemon_status():
    try:
        return daemon.status()
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
        return daemon.start()
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


@router.get("/sessions/{sid}/runs")
def runs(sid: str):
    return _call("history", sid)


@router.post("/sessions/{sid}/runs")
def submit_run(sid: str, body: AntiRunCreate):
    return _call("submit", sid, body.operation, body.prompt, body.model, body.effort)


@router.get("/sessions/{sid}/runs/{rid}")
def run(sid: str, rid: str):
    return _call("refresh", sid, rid)


@router.get("/sessions/{sid}/runs/{rid}/events")
def events(sid: str, rid: str, after: int = Query(default=0, ge=0)):
    return _call("events", sid, rid, after)


@router.post("/sessions/{sid}/runs/{rid}/cancel")
def cancel(sid: str, rid: str):
    return _call("cancel", sid, rid)
