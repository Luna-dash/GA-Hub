"""Keep diagnostics reachable while refusing unavailable runtime operations."""
from __future__ import annotations

from collections.abc import Callable

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send
from starlette.websockets import WebSocket

from .origin_policy import is_allowed_ui_origin
from .services.core_contract import ContractReport, CoreRuntimeUnavailable, require_core_contract


class CoreContractGuard:
    def __init__(
        self, app: ASGIApp, *, enabled: bool,
        report: Callable[[], ContractReport | None],
    ) -> None:
        self.app = app
        self.enabled = enabled
        self.report = report

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        path = scope.get("path", "")
        diagnostics = (
            path in {"/api/status", "/api/health", "/api/health/core-contract", "/ws/events"}
            or path.startswith(("/api/setup/", "/api/events/"))
        )
        guarded = path.startswith(("/api/", "/ws/")) and not diagnostics
        if self.enabled and guarded and scope["type"] in {"http", "websocket"}:
            try:
                require_core_contract(self.report())
            except CoreRuntimeUnavailable as exc:
                if scope["type"] == "websocket":
                    ws = WebSocket(scope, receive, send)
                    if not is_allowed_ui_origin(ws.headers.get("origin")):
                        await ws.close(code=1008, reason="Forbidden origin")
                    else:
                        await ws.accept()
                        await ws.close(code=1013, reason="core_contract_failed")
                else:
                    response = JSONResponse(status_code=503, content={"detail": {
                        "code": "core_contract_failed", "detail": str(exc),
                    }})
                    await response(scope, receive, send)
                return
        await self.app(scope, receive, send)
