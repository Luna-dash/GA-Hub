"""System status, health probe, and desktop update readiness endpoints."""
from __future__ import annotations

import os
import secrets
import sys
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import PlainTextResponse

from .. import _paths
from ..schemas import AppStatusResp

router = APIRouter()


@router.get("/api/status", response_model=AppStatusResp, response_model_exclude_unset=True)
def status(request: Request):
    setup_mode = bool(getattr(request.app.state, "setup_mode", _paths.GA_ROOT is None))
    out: dict[str, Any] = {
        "configured": _paths.GA_ROOT is not None,
        "ga_root": str(_paths.GA_ROOT) if _paths.GA_ROOT else None,
        **_paths.python_status(),
    }
    if setup_mode:
        out["mode"] = "setup"
        return out

    services = request.app.state.services
    out.update(services.status_snapshot())
    return out


@router.get("/api/updates/ready", include_in_schema=False)
def update_ready(request: Request):
    nonce = os.environ.get("GA_HUB_UPDATE_NONCE", "")
    provided = request.headers.get("x-update-nonce", "")
    if not nonce or not secrets.compare_digest(nonce, provided):
        return PlainTextResponse("Not found", status_code=404)
    return {
        "ready": bool(getattr(request.app.state, "update_ready", False)),
        "diagnostic_ready": bool(getattr(request.app.state, "update_diagnostic_ready", False)),
        "nonce": nonce,
        "pid": os.getpid(),
        "executable": str(Path(sys.executable).resolve()),
        "admin_data": str(_paths.ADMIN_DATA.resolve()),
    }


@router.get("/api/health")
def health_summary(request: Request):
    """Stable process/service health vocabulary for diagnostics."""
    setup_mode = bool(getattr(request.app.state, "setup_mode", _paths.GA_ROOT is None))
    report = getattr(request.app.state, "core_contract", None)
    if setup_mode:
        return {
            "status": "unavailable",
            "services": [{
                "id": "core_contract",
                "status": "unavailable",
                "summary": "GA core 尚未配置",
            }],
            "timestamp": int(time.time()),
        }
    if report is None or not report.ok:
        return {
            "status": "unavailable",
            "services": [{
                "id": "core_contract",
                "status": "unknown" if report is None else "unavailable",
                "summary": "GA core 尚未探测" if report is None else "GA core 契约不兼容",
            }],
            "timestamp": int(time.time()),
        }
    return request.app.state.service_registry.health_summary()


@router.get("/api/health/core-contract")
async def core_contract_health(request: Request):
    """P0: surface the GA core contract probe result.

    Returns ``ga_root``, ``core_commit``, per-item capability bits and
    error list — no secrets. In setup mode (no GA_ROOT) or if the probe
    has not run (e.g. crashed), reports that explicitly rather than 500.
    """
    report = getattr(request.app.state, "core_contract", None)
    if report is None:
        return {"ok": False, "status": "not_probed", "ga_root": None}
    return report.to_dict()
