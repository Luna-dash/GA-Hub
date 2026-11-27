"""Minimalist one-click portable update API (DATA_EPOCH = 2).

Supports checking/downloading official GitHub Releases and preparing trusted
local ZIP archives, then switching via the lightweight pure-Rust `ga-hub-update`
helper with automatic startup health verification and rollback.
"""
from __future__ import annotations

import sys
import zipfile
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from .. import _paths
from ..desktop_auth import require_desktop_instance
from ..services import update_download, update_release
from ..services.self_update import DATA_EPOCH, UpdateStore

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
    error: str | None = None
    switch_started: bool | None = None


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


class UpdateStatusResp(BaseModel):
    model_config = {"extra": "allow"}

    download: UpdateDownloadResp | None = None
    release: UpdateReleaseResp | None = None
    plan: UpdatePlanResp
    supported: bool
    sources: list[str]
    data_epoch: int


def store() -> UpdateStore:
    return UpdateStore(_paths.ADMIN_DATA / "updates")


@router.get("", response_model=UpdateStatusResp)
def update_status() -> dict:
    updates = store()
    return {
        "plan": updates.read(),
        "supported": sys.platform == "win32",
        "sources": ["github_release", "trusted_local_archive"],
        "data_epoch": DATA_EPOCH,
        "download": update_download.status(updates),
        "release": update_download.read_json(updates.root / "release.json") or None,
    }


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


@router.post("/apply", response_model=UpdatePlanResp, dependencies=[Depends(require_desktop_instance)])
def apply_update(body: UpdateIdentity, request: Request) -> dict:
    """One-click restart & update via the lightweight Rust helper."""
    _require_configured_core(request)
    import psutil

    try:
        owners = [
            p for p in psutil.Process().parents()
            if p.name().casefold() == "ga-hub-desktop.exe"
        ]
        if len(owners) != 1:
            raise ValueError("Apply update requires one owning desktop process")
        owner = owners[0]
        return store().apply(
            body.id,
            _paths.ADMIN_DATA,
            old_pid=owner.pid,
            old_exe=Path(owner.exe()),
        )
    except (ValueError, OSError, psutil.Error) as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post("/cancel", response_model=UpdatePlanResp, dependencies=[Depends(require_desktop_instance)])
def cancel_update(body: UpdateIdentity) -> dict:
    try:
        return store().cancel(body.id)
    except (ValueError, OSError) as exc:
        raise HTTPException(409, str(exc)) from exc
