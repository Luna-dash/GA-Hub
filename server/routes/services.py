"""Unified service panel routes."""
from fastapi import APIRouter

from ..schemas import ServicePanelResp
from ..services.service_registry import registry

router = APIRouter()


@router.get("/api/services/panel")
def service_panel() -> ServicePanelResp:
    return registry.panel()
