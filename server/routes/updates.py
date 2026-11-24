"""Local update preparation API; applying is a desktop-shell operation."""
import secrets
import zipfile
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from .. import _paths
from ..desktop_auth import require_desktop_instance
from ..services.self_update import UpdateStore
from ..services import update_handoff, update_preflight, update_release, update_download

router = APIRouter(prefix="/api/updates", tags=["updates"])


class PrepareUpdate(BaseModel):
    archive: str = Field(min_length=1, max_length=4096)
    sha256: str = Field(default="", pattern=r"^(?:[a-fA-F0-9]{64})?$")
    trusted_source_confirmed: bool = False


class UpdateIdentity(BaseModel):
    id: str = Field(pattern=r"^[a-f0-9]{32}$")


class UpdatePlanResp(BaseModel):
    model_config = {"extra": "allow"}

    state: str
    id: str | None = None
    version: str | None = None
    commit: str | None = None


class UpdateReleaseResp(BaseModel):
    model_config = {"extra": "allow"}

    current_version: str
    version: str
    available: bool
    tag: str
    notes: str


class UpdateDownloadErrorResp(BaseModel):
    message: str
    detail: str


class UpdateDownloadResp(BaseModel):
    model_config = {"extra": "allow"}

    phase: str
    received_bytes: int | None = None
    total_bytes: int | None = None
    started_at: float | None = None
    updated_at: float | None = None
    release: UpdateReleaseResp | None = None
    plan_id: str | None = None
    error: UpdateDownloadErrorResp | None = None


class UpdateHandoffResp(BaseModel):
    model_config = {"extra": "allow"}

    id: str
    state: str
    not_before: float | None = None
    error: str | None = None


class UpdateStatusResp(BaseModel):
    model_config = {"extra": "allow"}

    download: UpdateDownloadResp | None = None
    release: UpdateReleaseResp | None = None
    plan: UpdatePlanResp
    supported: bool
    sources: list[str]
    data_epoch: int
    handoff: UpdateHandoffResp | None = None


def store() -> UpdateStore:
    return UpdateStore(_paths.ADMIN_DATA / "updates")


@router.get("", response_model=UpdateStatusResp)
def update_status() -> dict:
    import sys
    updates = store()
    handoff = updates.root / "handoff.json"
    return {"plan": updates.read(), "supported": sys.platform == "win32",
            "sources": ["trusted_local_archive"], "data_epoch": 1,
            "download": update_download.status(updates),
            "release": update_download.read_json(updates.root / "release.json") or None,
            "handoff": update_handoff.read_json(handoff) if handoff.exists() else None}


@router.post("/prepare", response_model=UpdatePlanResp, dependencies=[Depends(require_desktop_instance)])
def prepare_update(body: PrepareUpdate) -> dict:
    try:
        return store().prepare(Path(body.archive), body.sha256, trusted=body.trusted_source_confirmed)
    except (ValueError, OSError, zipfile.BadZipFile, RuntimeError, NotImplementedError) as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("/release", response_model=UpdateReleaseResp)
def check_release() -> dict:
    try:
        return update_release.check(store().root)
    except (ValueError, OSError, update_release.requests.RequestException) as exc:
        raise HTTPException(502, str(exc)) from exc


@router.post("/release/download", status_code=202, response_model=UpdateDownloadResp, dependencies=[Depends(require_desktop_instance)])
def download_release() -> dict:
    try:
        return update_download.start(store())
    except (OSError, ValueError) as exc:
        raise HTTPException(409, update_download.failure(exc)) from exc


@router.post("/release/prepare", response_model=UpdatePlanResp, dependencies=[Depends(require_desktop_instance)])
def prepare_release() -> dict:
    try:
        return update_release.prepare(store())
    except (ValueError, OSError, KeyError, zipfile.BadZipFile, update_release.requests.RequestException) as exc:
        raise HTTPException(409, str(exc)) from exc


def _require_configured_core(request: Request) -> None:
    if getattr(request.app.state, "setup_mode", _paths.GA_ROOT is None):
        raise HTTPException(409, "Complete GA setup and restart GA-Hub before applying updates.")


@router.post("/preflight", dependencies=[Depends(require_desktop_instance)])
def preflight_update(body: UpdateIdentity, request: Request) -> dict:
    _require_configured_core(request)
    import subprocess
    import psutil
    try:
        return update_preflight.preflight(store(), body.id)
    except (ValueError, OSError, subprocess.SubprocessError, psutil.Error) as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post("/cancel", response_model=UpdatePlanResp, dependencies=[Depends(require_desktop_instance)])
def cancel_update(body: UpdateIdentity) -> dict:
    try:
        return store().cancel(body.id)
    except (ValueError, OSError) as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post("/request", dependencies=[Depends(require_desktop_instance)])
def request_update(body: UpdateIdentity, request: Request) -> dict:
    _require_configured_core(request)
    import subprocess
    import psutil
    try:
        # Never accept an arbitrary PID from an HTTP caller. Resolve our owner.
        owners = [p for p in psutil.Process().parents()
                  if p.name().casefold() == "ga-hub-desktop.exe"]
        if len(owners) != 1:
            raise ValueError("Update request requires one owning desktop process")
        update_handoff.ensure_installed(store(), _paths.ADMIN_DATA, Path(owners[0].exe()))
        return update_handoff.request(store(), _paths.ADMIN_DATA, body.id, owners[0].pid)
    except (ValueError, OSError, subprocess.SubprocessError, psutil.Error) as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post("/approve", dependencies=[Depends(require_desktop_instance)])
def approve_update(body: UpdateIdentity, request: Request) -> dict:
    _require_configured_core(request)
    try:
        return update_handoff.approve(store(), body.id)
    except (ValueError, OSError, KeyError) as exc:
        raise HTTPException(409, str(exc)) from exc
