"""Session metadata API (message-free GA-Hub sidecar)."""
from __future__ import annotations

import asyncio
import logging
import os
import uuid

from fastapi import APIRouter, HTTPException, Response, WebSocket, WebSocketDisconnect, status
from pydantic import BaseModel, Field

from ..services.archive_messages import HistoryUnavailableError, read_archive_messages
from ..services.event_bus import Event, bus
from ..services.session_coordinator import (
    AgentBusyError,
    RuntimeState,
    SessionCoordinator,
)
from ..services.session_metadata import SessionMetadataStore, SessionNotFoundError
from ..services.session_runtime_factory import RuntimeRestoreError, SessionRuntimeFactory

router = APIRouter()
log = logging.getLogger(__name__)
_store = SessionMetadataStore()
_coordinator: SessionCoordinator | None = None


def _publish_runtime_state(state: RuntimeState) -> None:
    if state.status != "error" or not state.run_id or not state.stream_id:
        return
    details = {
        "abort_timeout": "停止请求超时；底层任务尚未终止，如持续占用请重启服务。",
    }
    log.warning(
        "session_runtime_error session_id=%s run_id=%s stream_id=%s "
        "code=%s runtime_before=aborting runtime_after=%s",
        state.session_id, state.run_id, state.stream_id,
        state.error or "runtime_error", state.status,
    )
    bus.publish(
        "chat:error",
        {
            "session_id": state.session_id,
            "run_id": state.run_id,
            "stream_id": state.stream_id,
            "code": state.error or "runtime_error",
            "detail": details.get(state.error, "会话运行失败，请稍后重试。"),
        },
    )


def _session_run_capacity() -> int:
    """Return the opt-in bounded capacity; production remains K=1 by default."""
    raw = os.environ.get("GAHUB_SESSION_RUN_CAPACITY", "1").strip()
    try:
        capacity = int(raw)
    except ValueError:
        log.warning("invalid GAHUB_SESSION_RUN_CAPACITY=%r; using 1", raw)
        return 1
    if capacity not in {1, 2}:
        log.warning("unsupported GAHUB_SESSION_RUN_CAPACITY=%r; using 1", raw)
        return 1
    return capacity


def _get_coordinator() -> SessionCoordinator:
    global _coordinator
    if _coordinator is None:
        capacity = _session_run_capacity()
        kwargs = {"on_state_change": _publish_runtime_state}
        if capacity != 1:
            kwargs["capacity"] = capacity
        _coordinator = SessionCoordinator(
            SessionRuntimeFactory(_store),
            **kwargs,
        )
    return _coordinator


class SessionCreate(BaseModel):
    title: str = Field(default="", max_length=200)
    llm_index: int | None = Field(default=None, ge=0)


class SessionUpdate(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    llm_index: int | None = Field(default=None, ge=0)


class SessionModelUpdate(BaseModel):
    llm_index: int = Field(ge=0)


class RunSubmit(BaseModel):
    text: str = Field(min_length=1)
    images: list[str] = Field(default_factory=list)
    source: str = Field(default="webui", min_length=1, max_length=50)


def _state_payload(state: RuntimeState, *, ok: bool | None = None) -> dict:
    payload = {
        "session_id": state.session_id,
        "status": state.status,
        "run_id": state.run_id,
        "stream_id": state.stream_id,
    }
    if state.error is not None:
        payload["error"] = state.error
    if ok is not None:
        payload = {"ok": ok, **payload}
    return payload


def _session(session_id: str) -> dict:
    try:
        return _store.get(session_id)
    except SessionNotFoundError:
        raise _not_found()


def _api_error(status_code: int, code: str, detail: str, **context) -> HTTPException:
    """Build a backwards-compatible FastAPI error with a stable machine code."""
    return HTTPException(status_code, {
        "code": code,
        "detail": detail,
        **context,
    })


def _not_found() -> HTTPException:
    return HTTPException(404, "session not found")


@router.get("/api/sessions")
async def list_sessions():
    items = _store.list()
    return {"total": len(items), "items": items}


@router.post("/api/sessions", status_code=status.HTTP_201_CREATED)
async def create_session(req: SessionCreate):
    return _store.create(title=req.title, llm_index=req.llm_index)


@router.get("/api/sessions/{session_id}")
async def get_session(session_id: str):
    try:
        return _store.get(session_id)
    except SessionNotFoundError:
        raise _not_found()


@router.get("/api/sessions/{session_id}/messages")
async def get_session_messages(session_id: str):
    row = _session(session_id)
    try:
        projection = read_archive_messages(row.get("archive_path"))
    except HistoryUnavailableError:
        log.warning(
            "session_history_unavailable session_id=%s code=history_unavailable",
            session_id,
        )
        raise _api_error(
            409,
            "history_unavailable",
            "历史消息暂时不可用，请稍后重试。",
        )
    return {"session_id": session_id, **projection}


@router.patch("/api/sessions/{session_id}")
async def update_session(session_id: str, req: SessionUpdate):
    changes = req.model_dump(exclude_unset=True)
    if changes.get("title") is None:
        changes.pop("title", None)
    try:
        return _store.update(session_id, changes)
    except SessionNotFoundError:
        raise _not_found()


@router.put("/api/sessions/{session_id}/model")
async def update_session_model(session_id: str, req: SessionModelUpdate):
    try:
        return _store.update(session_id, {"llm_index": req.llm_index})
    except SessionNotFoundError:
        raise _not_found()


@router.post("/api/sessions/{session_id}/runs", status_code=status.HTTP_202_ACCEPTED)
async def submit_run(session_id: str, req: RunSubmit):
    row = _session(session_id)
    try:
        state = _get_coordinator().submit(
            req.text,
            session_id=session_id,
            source=req.source,
            images=req.images,
            llm_index=row.get("llm_index"),
        )
    except AgentBusyError as exc:
        raise _api_error(
            409,
            "agent_busy",
            "另一个会话正在运行，请等待当前任务结束后重试。",
            active_session_id=exc.active_session_id,
            active_run_id=exc.active_run_id,
            capacity=exc.capacity,
            active_count=exc.active_count,
        )
    except RuntimeRestoreError:
        raise _api_error(
            409,
            "restore_failed",
            "会话运行环境恢复失败，请稍后重试。",
        )
    return _state_payload(state)


@router.get("/api/sessions/{session_id}/runtime")
async def get_runtime(session_id: str):
    _session(session_id)
    return _state_payload(_get_coordinator().runtime_state(session_id))


@router.post("/api/sessions/{session_id}/abort")
async def abort_run(session_id: str):
    _session(session_id)
    coordinator = _get_coordinator()
    current = coordinator.abort_if_current(session_id=session_id)
    return _state_payload(current, ok=True)


def _session_event_frame(session_id: str, event: Event) -> dict | None:
    """Map only fully identified chat events owned by this session."""
    if not event.topic.startswith("chat:"):
        return None
    payload = event.payload
    if payload.get("session_id") != session_id:
        return None
    if not payload.get("run_id") or not payload.get("stream_id"):
        return None
    return {
        **payload,
        "type": event.topic.split(":", 1)[1],
        "event_id": event.event_id,
        "epoch": bus.epoch,
    }


@router.websocket("/ws/sessions/{session_id}")
async def session_events(ws: WebSocket, session_id: str):
    try:
        _session(session_id)
    except HTTPException:
        await ws.close(code=4404, reason="session not found")
        return

    await ws.accept()

    raw_after = ws.query_params.get("after_event_id")
    client_epoch = ws.query_params.get("epoch")
    after_event_id: int | None = None
    invalid_cursor = False
    if raw_after is not None:
        try:
            after_event_id = int(raw_after)
            invalid_cursor = after_event_id < 0
        except ValueError:
            invalid_cursor = True

    connection_id = uuid.uuid4().hex
    subscription = await bus.subscribe_after(
        "chat:",
        after_event_id=None if invalid_cursor else after_event_id,
        epoch=client_epoch,
    )
    if invalid_cursor:
        subscription.resync_reason = "invalid_cursor"
    log.info(
        "session_ws_connected session_id=%s ws_connection_id=%s "
        "resume_after=%s replay_count=%s boundary_event_id=%s",
        session_id, connection_id, after_event_id,
        len(subscription.replay), subscription.boundary_id,
    )

    async def send_snapshot() -> None:
        state, active_message = _get_coordinator().session_snapshot(session_id)
        runtime_payload = _state_payload(state)
        await ws.send_json({
            "type": "snapshot",
            **runtime_payload,
            "runtime": {
                "status": state.status,
                "run_id": state.run_id,
                "stream_id": state.stream_id,
                "error": state.error,
            },
            "active_message": active_message,
            "epoch": bus.epoch,
        })

    try:
        if subscription.resync_reason is not None:
            log.warning(
                "session_ws_resync session_id=%s ws_connection_id=%s "
                "resume_after=%s resync_reason=%s",
                session_id, connection_id, after_event_id,
                subscription.resync_reason,
            )
            await ws.send_json({
                "type": "resync_required",
                "session_id": session_id,
                "reason": subscription.resync_reason,
                "epoch": bus.epoch,
            })

        if after_event_id is None or subscription.resync_reason is not None:
            await send_snapshot()
        else:
            for event in subscription.replay:
                frame = _session_event_frame(session_id, event)
                if frame is not None:
                    await ws.send_json(frame)

        await ws.send_json({
            "type": "replay_done",
            "session_id": session_id,
            "event_id": subscription.boundary_id,
            "epoch": bus.epoch,
        })
        log.info(
            "session_ws_replay session_id=%s ws_connection_id=%s "
            "resume_after=%s replay_count=%s boundary_event_id=%s source=%s",
            session_id, connection_id, after_event_id,
            len(subscription.replay), subscription.boundary_id,
            "snapshot" if after_event_id is None or subscription.resync_reason else "replay",
        )

        async def forward_events() -> None:
            async for event in subscription.live():
                frame = _session_event_frame(session_id, event)
                if frame is not None:
                    await ws.send_json(frame)
            if subscription.live_resync_reason is not None:
                log.warning(
                    "session_ws_resync session_id=%s ws_connection_id=%s "
                    "resume_after=%s resync_reason=%s",
                    session_id, connection_id, subscription.boundary_id,
                    subscription.live_resync_reason,
                )
                await ws.send_json({
                    "type": "resync_required",
                    "session_id": session_id,
                    "reason": subscription.live_resync_reason,
                    "epoch": bus.epoch,
                })
                await ws.close(code=1013, reason="resync required")

        forward_task = asyncio.create_task(forward_events())
        try:
            while True:
                message = await ws.receive_json()
                if message.get("type") == "ping":
                    await ws.send_json({"type": "pong", "session_id": session_id})
        except WebSocketDisconnect:
            pass
        finally:
            forward_task.cancel()
            try:
                await forward_task
            except asyncio.CancelledError:
                pass
    finally:
        await subscription.close()
        log.info(
            "session_ws_disconnected session_id=%s ws_connection_id=%s",
            session_id, connection_id,
        )


@router.delete("/api/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_session(session_id: str):
    try:
        _store.get(session_id)
        runtime = (
            _coordinator.runtime_state(session_id)
            if _coordinator is not None
            else RuntimeState(session_id)
        )
        if runtime.status != "idle":
            raise HTTPException(409, {
                "code": "session_active",
                "run_id": runtime.run_id,
                "status": runtime.status,
            })
        _store.delete(session_id)
    except SessionNotFoundError:
        raise _not_found()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
