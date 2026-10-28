"""Fingerprint jobs are local; only numerical samples go to the scoring service."""
from __future__ import annotations
import copy
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from ..services.model_fingerprint import FingerprintService
from ..services.session_lifecycle import session_lifecycle_of
from ..services.session_metadata import SessionNotFoundError

router = APIRouter(prefix="/api/sessions", tags=["model-fingerprint"])

class StartRequest(BaseModel):
    confirm_paid_sampling: bool = False

def service(request: Request) -> FingerprintService:
    instance = getattr(request.app.state, "fingerprint_service", None)
    if instance is None:
        instance = FingerprintService()
        request.app.state.fingerprint_service = instance
    return instance

@router.post("/{session_id}/model-fingerprint", status_code=202)
async def start(session_id: str, body: StartRequest, request: Request):
    if not body.confirm_paid_sampling:
        raise HTTPException(400, "需要确认本次检测将发起三次付费模型请求")
    lifecycle = session_lifecycle_of(request.app)
    try:
        row = lifecycle.store.get(session_id)
    except SessionNotFoundError:
        raise HTTPException(404, "会话不存在")
    try:
        key = lifecycle.effective_llm_key(row)
        if not key:
            raise ValueError("model_unavailable")
        return service(request).start(session_id, key)
    except ValueError as error:
        code = str(error)
        safe = {"fingerprint_busy", "scoring_not_configured", "scoring_https_required",
                "model_unavailable", "single_model_required"}
        raise HTTPException(409 if code == "fingerprint_busy" else 400,
                            code if code in safe else "模型绑定不可用")
    except Exception:
        raise HTTPException(400, "模型绑定不可用，请重新选择模型")

@router.get("/{session_id}/model-fingerprint/{job_id}")
async def status(session_id: str, job_id: str, request: Request):
    job = service(request).jobs.get(job_id)
    if not job or job["session_id"] != session_id:
        raise HTTPException(404, "检测任务不存在或已过期")
    return copy.deepcopy(job)
