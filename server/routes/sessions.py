"""Session metadata API (message-free GA-Hub sidecar)."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException, Response, WebSocket, WebSocketDisconnect, status
from pydantic import BaseModel, Field

from ..services.archive_messages import HistoryUnavailableError, read_archive_messages
from ..services.event_bus import Event, bus
from ..services.session_coordinator import (
    AgentBusyError,
    RuntimeState,
    SessionCoordinator,
    SessionNotActiveError,
)
from ..services.session_metadata import SessionMetadataStore, SessionNotFoundError
from ..services.session_runtime_factory import RuntimeRestoreError, SessionRuntimeFactory

router = APIRouter()
_store = SessionMetadataStore()
_coordinator: SessionCoordinator | None = None


def _get_coordinator() -> SessionCoordinator:
    global _coordinator
    if _coordinator is None:
        _coordinator = SessionCoordinator(SessionRuntimeFactory(_store))
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
        raise HTTPException(409, {"code": "history_unavailable"})
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
        raise HTTPException(409, {
            "code": "agent_busy",
            "active_session_id": exc.active_session_id,
            "active_run_id": exc.active_run_id,
        })
    except RuntimeRestoreError as exc:
        raise HTTPException(409, {"code": "restore_failed", "message": str(exc)})
    return _state_payload(state)


@router.get("/api/sessions/{session_id}/runtime")
async def get_runtime(session_id: str):
    _session(session_id)
    return _state_payload(_get_coordinator().runtime_state(session_id))


@router.post("/api/sessions/{session_id}/abort")
async def abort_run(session_id: str):
    _session(session_id)
    coordinator = _get_coordinator()
    current = coordinator.runtime_state(session_id)
    if current.status not in {"starting", "running"} or not current.run_id:
        return _state_payload(current, ok=True)
    try:
        current = coordinator.abort(session_id=session_id, run_id=current.run_id)
    except SessionNotActiveError:
        # The watcher may finish between the state read and abort acquisition.
        current = coordinator.runtime_state(session_id)
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
    return {**payload, "type": event.topic.split(":", 1)[1]}


@router.websocket("/ws/sessions/{session_id}")
async def session_events(ws: WebSocket, session_id: str):
    try:
        _session(session_id)
    except HTTPException:
        await ws.close(code=4404, reason="session not found")
        return

    await ws.accept()

    async def forward_events() -> None:
        async for event in bus.subscribe("chat:"):
            frame = _session_event_frame(session_id, event)
            if frame is not None:
                await ws.send_json(frame)

    # Register the queue before taking/sending the snapshot.  The one event-loop
    # yield is intentional: ``subscribe`` is an async generator, so its body
    # (and queue registration) only runs on the first iteration.
    forward_task = asyncio.create_task(forward_events())
    await asyncio.sleep(0)
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
    })

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
