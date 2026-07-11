"""Unified service panel routes."""
from fastapi import APIRouter

from ..services.service_registry import registry

router = APIRouter()


@router.get("/api/services/panel")
async def service_panel():
    return registry.panel()
