"""Unified service panel routes."""
from fastapi import APIRouter, Request

from ..schemas import ServicePanelResp
from ..services.service_registry import ServiceRegistry, registry

router = APIRouter()


@router.get("/api/services/panel")
def service_panel(request: Request) -> ServicePanelResp:
    # Prefer the app-bound registry (lifespan-owned instances); the module
    # global stays as a compatibility seam for unbound/test callers.
    bound = getattr(request.app.state, "service_registry", None)
    return (bound if isinstance(bound, ServiceRegistry) else registry).panel()
