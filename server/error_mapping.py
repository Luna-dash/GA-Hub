"""App-level mapping from service exceptions to HTTP responses.

Routes translate the exceptions they want to shape specially (their
``HTTPException`` always wins — FastAPI's own handler runs first). This
module is the safety net for everything a route forgets: before it existed,
missing exactly one ``except`` clause turned a semantic refusal into an
unexplained 500 (round-5 scan: submitting during a rewind, cancelling a
scheduled chat). Adding a semantic exception family means adding it here
once, not re-auditing every route.
"""
from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .services.llm_registry import (
    LlmRegistryError,
    LlmUnavailableError,
    LlmUnconfirmedError,
)
from .services.session_coordinator import (
    AgentBusyError,
    SessionControlBusyError,
    SessionCoordinatorStoppedError,
)
from .services.session_runtime_factory import RuntimeRestoreError


def _payload(code: str, message: str, **context) -> dict:
    body = {"code": code, "detail": message}
    body.update(context)
    return body


def _agent_busy_payload(exc: AgentBusyError) -> dict:
    # The *same* session being busy is a serial guard, not a capacity
    # overflow — the route layer relies on this mapper for that shape.
    if exc.reason == AgentBusyError.REASON_SESSION_ACTIVE:
        return _payload(
            "session_active",
            "当前会话仍有任务运行中（或正在停止中），请等待结束后重试。",
            active_session_id=exc.active_session_id,
            active_run_id=exc.active_run_id,
            capacity=exc.capacity,
            active_count=exc.active_count,
        )
    return _payload(
        "agent_busy",
        "会话正在运行，请等待当前任务结束后重试。",
        active_session_id=exc.active_session_id,
        active_run_id=exc.active_run_id,
        capacity=exc.capacity,
        active_count=exc.active_count,
    )


def install_error_handlers(app: FastAPI) -> None:
    """Register the service-exception safety net on ``app``."""

    def _json(status_code: int, payload: dict) -> JSONResponse:
        return JSONResponse(status_code=status_code, content={"detail": payload})

    @app.exception_handler(SessionControlBusyError)
    async def _control_busy(request: Request, exc: SessionControlBusyError) -> JSONResponse:
        return _json(409, _payload(
            "session_control_active",
            "当前会话正在执行互斥控制操作，请稍后重试。",
            operation=exc.operation,
        ))

    @app.exception_handler(AgentBusyError)
    async def _agent_busy(request: Request, exc: AgentBusyError) -> JSONResponse:
        return _json(409, _agent_busy_payload(exc))

    @app.exception_handler(RuntimeRestoreError)
    async def _restore_failed(request: Request, exc: RuntimeRestoreError) -> JSONResponse:
        return _json(409, _payload(
            "restore_failed", "会话运行环境恢复失败，请稍后重试。"))

    @app.exception_handler(SessionCoordinatorStoppedError)
    async def _lifecycle_stopping(request: Request, exc: SessionCoordinatorStoppedError) -> JSONResponse:
        # Teardown window: "unavailable" (503), not a generic 500 — clients
        # may legitimately retry after restart.
        return _json(503, _payload(
            "session_runtime_stopping", "服务正在关闭，请稍后重试。"))

    @app.exception_handler(LlmUnconfirmedError)
    async def _llm_unconfirmed(request: Request, exc: LlmUnconfirmedError) -> JSONResponse:
        return _json(409, _payload(
            "llm_unconfirmed", "该会话的模型绑定需要重新确认。"))

    @app.exception_handler(LlmUnavailableError)
    async def _llm_unavailable(request: Request, exc: LlmUnavailableError) -> JSONResponse:
        return _json(409, _payload(
            "llm_unavailable", "该会话绑定的 LLM 已不存在，请重新选择。"))

    @app.exception_handler(LlmRegistryError)
    async def _llm_registry(request: Request, exc: LlmRegistryError) -> JSONResponse:
        return _json(409, _payload(
            "llm_registry_error", "LLM 配置映射校验失败，请检查 MyKey 配置。"))
