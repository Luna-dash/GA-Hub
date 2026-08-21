"""Session metadata API (message-free GA-Hub sidecar)."""
from __future__ import annotations

import asyncio
import logging
import os
import threading
import time
import uuid

from fastapi import APIRouter, HTTPException, Query, Response, WebSocket, WebSocketDisconnect, status
from typing import Literal
from pydantic import BaseModel, Field

from frontends import workspace_cmd

from ..origin_policy import is_allowed_ui_origin
from ..schemas import BtwReq, BtwResp, RewindReq, RewindResp
from ..services.archive_messages import HistoryUnavailableError, read_archive_messages
from ..services.event_bus import Event, bus
from ..services.llm_preference_store import LlmPreferenceStore
from ..services.llm_registry import LlmUnavailableError, LlmRegistryError
from ..services.session_coordinator import (
    AgentBusyError,
    RuntimeState,
    SessionControlBusyError,
    SessionCoordinator,
    SessionCoordinatorStoppedError,
)
from ..services.session_metadata import SessionMetadataStore, SessionNotFoundError
from ..services.project_runtime import activate_project, deactivate_project
from ..services.session_runtime_factory import RuntimeRestoreError, SessionRuntimeFactory
from ..services.scheduled_chat_service import ScheduledChat, ScheduledChatService

router = APIRouter()
log = logging.getLogger(__name__)
_store = SessionMetadataStore()
_coordinator: SessionCoordinator | None = None
_coordinator_lifecycle_lock = threading.Lock()
_coordinator_stopping = False
_scheduled_chats: ScheduledChatService | None = None


def _publish_runtime_state(state: RuntimeState) -> None:
    bus.publish(
        "session:runtime",
        {
            "session_id": state.session_id,
            "status": state.status,
            "run_id": state.run_id,
            "stream_id": state.stream_id,
            "completed_run_id": state.completed_run_id,
            "error": state.error,
        },
    )
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
    """Return the bounded session-run capacity; three sessions may run concurrently by default."""
    raw = os.environ.get("GAHUB_SESSION_RUN_CAPACITY", "3").strip()
    try:
        capacity = int(raw)
    except ValueError:
        log.warning("invalid GAHUB_SESSION_RUN_CAPACITY=%r; using 3", raw)
        return 3
    if capacity not in {1, 2, 3}:
        log.warning("unsupported GAHUB_SESSION_RUN_CAPACITY=%r; using 3", raw)
        return 3
    return capacity


def _get_coordinator() -> SessionCoordinator:
    global _coordinator, _coordinator_stopping
    with _coordinator_lifecycle_lock:
        if _coordinator_stopping:
            raise SessionCoordinatorStoppedError(
                "session runtime lifecycle is stopping"
            )
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


def prepare_session_runtime_lifecycle() -> None:
    """Allow a fresh lifespan to construct runtimes after clean teardown."""
    global _coordinator_stopping
    with _coordinator_lifecycle_lock:
        if _coordinator is None:
            _coordinator_stopping = False


def begin_session_runtime_shutdown() -> None:
    """Close the route-level admission gate before stopping task producers."""
    global _coordinator_stopping
    with _coordinator_lifecycle_lock:
        _coordinator_stopping = True


def finish_session_runtime_shutdown() -> None:
    """Reopen runtime admission after the owning app lifespan has torn down."""
    global _coordinator_stopping
    with _coordinator_lifecycle_lock:
        _coordinator_stopping = False


def _dispatch_scheduled_chat(task: ScheduledChat) -> None:
    row = _store.get(task.session_id)
    try:
        llm_key = _effective_llm_key(row)
    except LlmUnconfirmedError:
        log.warning(
            "scheduled chat skipped: session model must be reconfirmed session_id=%s",
            task.session_id,
        )
        return
    _get_coordinator().submit(
        task.text,
        session_id=task.session_id,
        images=task.images,
        source="scheduled",
        llm_key=llm_key,
    )
    _store.touch(task.session_id)


class LlmUnconfirmedError(RuntimeError):
    """A legacy session still stores only a positional LLM reference."""


def _effective_llm_key(row: dict) -> str | None:
    key = row.get("llm_key")
    if isinstance(key, str) and key.strip():
        return key.strip()
    if row.get("llm_index") is not None:
        raise LlmUnconfirmedError("session llm binding must be reconfirmed")
    return LlmPreferenceStore().get_key()


def _get_scheduled_chats() -> ScheduledChatService:
    global _scheduled_chats
    if _scheduled_chats is None:
        _scheduled_chats = ScheduledChatService(_dispatch_scheduled_chat)
    return _scheduled_chats


def scheduled_chat_service() -> ScheduledChatService:
    """Return the process-owned scheduled-chat domain for lifecycle hosts."""
    return _get_scheduled_chats()


def start_scheduled_chats() -> None:
    _get_scheduled_chats().start()


def stop_scheduled_chats() -> None:
    if _scheduled_chats is not None:
        _scheduled_chats.shutdown()


def stop_session_runtimes(
    timeout: float = 3.0, *, keep_admission_closed: bool = False
) -> bool:
    """Stop all session runtimes without letting teardown exceed ``timeout``."""
    global _coordinator, _coordinator_stopping
    begin_session_runtime_shutdown()
    with _coordinator_lifecycle_lock:
        coordinator = _coordinator
    if coordinator is None:
        if not keep_admission_closed:
            with _coordinator_lifecycle_lock:
                _coordinator_stopping = False
        return True
    try:
        stopped = coordinator.shutdown(timeout=timeout)
    except Exception:
        log.exception("session runtime shutdown failed")
        return False
    if stopped:
        with _coordinator_lifecycle_lock:
            if _coordinator is coordinator:
                # A fresh app lifespan must construct fresh AgentService
                # runtimes; keeping this process-global coordinator would
                # reuse stopped threads.
                _coordinator = None
            if not keep_admission_closed:
                _coordinator_stopping = False
    if not stopped:
        log.warning("session runtime shutdown exceeded its graceful deadline")
    return stopped


class SessionCreate(BaseModel):
    title: str = Field(default="", max_length=200)
    llm_key: str | None = Field(default=None, min_length=1, max_length=200)
    llm_index: int | None = Field(default=None, ge=0)


class SessionUpdate(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    llm_key: str | None = Field(default=None, min_length=1, max_length=200)
    llm_index: int | None = Field(default=None, ge=0)


class SessionModelUpdate(BaseModel):
    llm_key: str | None = Field(default=None, min_length=1, max_length=200)
    llm_index: int | None = Field(default=None, ge=0)


class HubSession(BaseModel):
    id: str
    title: str
    llm_key: str | None = None
    llm_index: int | None
    archive_path: str | None
    status: str = "idle"
    project_name: str | None = None
    project_path: str | None = None
    created_at: str
    updated_at: str


class SessionListResp(BaseModel):
    total: int
    items: list[HubSession]


class ProjectItem(BaseModel):
    name: str
    path: str
    last_used: int = 0
    mem_lines: int = 0
    memory_path: str | None = None
    source: str | None = None
    dangling: bool = False


class ProjectListResp(BaseModel):
    total: int
    items: list[ProjectItem]


class ProjectCreate(BaseModel):
    path: str = Field(min_length=1, max_length=1000)


class SessionProjectUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    path: str = Field(min_length=1, max_length=1000)


class RunSubmit(BaseModel):
    text: str = Field(min_length=1)
    images: list[str] = Field(default_factory=list)
    source: str = Field(default="webui", min_length=1, max_length=50)


class ScheduledChatCreate(BaseModel):
    text: str = Field(min_length=1)
    images: list[str] = Field(default_factory=list)
    scheduled_for: float


class ScheduledChatResp(BaseModel):
    id: str
    session_id: str
    text: str
    images: list[str]
    scheduled_for: float
    created_at: float
    status: Literal["pending", "dispatching", "sent", "cancelled"]
    sent_at: float | None
    cancelled_at: float | None
    last_error: str | None
    retry_at: float | None


class ScheduledChatListResp(BaseModel):
    total: int
    items: list[ScheduledChatResp]


class SessionRuntimeResp(BaseModel):
    session_id: str
    status: str
    run_id: str | None
    stream_id: str | None
    completed_run_id: str | None = None
    error: str | None = None
    ok: bool | None = None


class SessionRuntimePayload(SessionRuntimeResp):
    @classmethod
    def from_state(
        cls, state: RuntimeState, *, ok: bool | None = None
    ) -> "SessionRuntimePayload":
        fields = {
            "session_id": state.session_id,
            "status": state.status,
            "run_id": state.run_id,
            "stream_id": state.stream_id,
            "completed_run_id": state.completed_run_id,
        }
        if state.error is not None:
            fields["error"] = state.error
        if ok is not None:
            fields["ok"] = ok
        return cls(**fields)


class SessionMessageProjection(BaseModel):
    id: str
    role: Literal["user", "assistant"]
    content: str
    ordinal: int
    timestamp: str | None = None


class SessionMessagesResp(BaseModel):
    session_id: str
    archive_bound: bool
    revision: str | None
    items: list[SessionMessageProjection]
    total: int = 0
    has_more: bool = False
    next_before: int | None = None


def _state_payload(state: RuntimeState, *, ok: bool | None = None) -> dict:
    payload = {
        "session_id": state.session_id,
        "status": state.status,
        "run_id": state.run_id,
        "stream_id": state.stream_id,
        "completed_run_id": state.completed_run_id,
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


def _busy_error(exc: AgentBusyError) -> HTTPException:
    # configure_if_idle path: the *same* session is busy, which is a serial
    # guard, not a capacity overflow. Surface it with a distinct code so the
    # UI can explain "stop this session's task" rather than "capacity full".
    if exc.reason == AgentBusyError.REASON_SESSION_ACTIVE:
        return _api_error(
            409,
            "session_active",
            "当前会话仍有任务运行中（或正在停止中），请等待结束后重试。",
            active_session_id=exc.active_session_id,
            active_run_id=exc.active_run_id,
            capacity=exc.capacity,
            active_count=exc.active_count,
        )
    return _api_error(
        409,
        "agent_busy",
        "会话正在运行，请等待当前任务结束后重试。",
        active_session_id=exc.active_session_id,
        active_run_id=exc.active_run_id,
        capacity=exc.capacity,
        active_count=exc.active_count,
    )


@router.get("/api/projects", response_model_exclude_unset=True)
async def list_projects() -> ProjectListResp:
    items = workspace_cmd.registry_list()
    return ProjectListResp(total=len(items), items=items)


@router.post(
    "/api/projects",
    status_code=status.HTTP_201_CREATED,
    response_model_exclude_unset=True,
)
async def create_project(req: ProjectCreate) -> ProjectItem:
    result = workspace_cmd.prepare(req.path.strip())
    if not result.get("ok"):
        raise _api_error(400, "project_prepare_failed", result.get("error") or "项目创建失败。")
    return ProjectItem(
        name=result["name"],
        path=result.get("path") or result.get("target") or req.path.strip(),
        memory_path=result.get("memory_path") or "",
        dangling=False,
    )


@router.delete("/api/projects/{project_name}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(project_name: str):
    projects = workspace_cmd.registry_list()
    if not any(item.get("name") == project_name for item in projects):
        raise _api_error(404, "project_not_found", "项目索引不存在")
    bound_sessions = [
        row for row in _store.list()
        if row.get("project_name") == project_name
    ]
    if bound_sessions:
        raise _api_error(
            409,
            "project_still_bound",
            "仍有其他会话绑定此项目，请先在这些会话中取消绑定。",
            session_ids=[row["id"] for row in bound_sessions],
        )
    result = workspace_cmd.remove(project_name)
    if not result.get("ok"):
        raise _api_error(
            500,
            "project_remove_failed",
            result.get("error") or "项目目录映射移除失败，请稍后重试。",
        )


@router.put("/api/sessions/{session_id}/project")
async def bind_session_project(session_id: str, req: SessionProjectUpdate) -> HubSession:
    _session(session_id)
    project = next(
        (
            item for item in workspace_cmd.registry_list()
            if item.get("name") == req.name and item.get("path") == req.path
        ),
        None,
    )
    if project is None or project.get("dangling"):
        raise HTTPException(404, "project not found")

    def configure(runtime):
        if runtime is not None:
            activate_project(runtime.agent, req.name)
        return _store.update(session_id, {
            "project_name": req.name,
            "project_path": req.path,
        })

    try:
        return _get_coordinator().configure_if_idle(session_id, configure)
    except AgentBusyError as exc:
        raise _busy_error(exc)


@router.delete("/api/sessions/{session_id}/project")
async def unbind_session_project(session_id: str) -> HubSession:
    _session(session_id)

    def configure(runtime):
        if runtime is not None:
            deactivate_project(runtime.agent)
        return _store.update(session_id, {
            "project_name": None,
            "project_path": None,
        })

    try:
        return _get_coordinator().configure_if_idle(session_id, configure)
    except AgentBusyError as exc:
        raise _busy_error(exc)


@router.get("/api/sessions")
async def list_sessions() -> SessionListResp:
    items = _store.list()
    return SessionListResp(total=len(items), items=items)


@router.post("/api/sessions", status_code=status.HTTP_201_CREATED)
async def create_session(req: SessionCreate) -> HubSession:
    return _store.create(title=req.title, llm_key=req.llm_key, llm_index=req.llm_index)


@router.get("/api/sessions/{session_id}")
async def get_session(session_id: str) -> HubSession:
    try:
        return _store.get(session_id)
    except SessionNotFoundError:
        raise _not_found()


@router.get("/api/sessions/{session_id}/messages")
async def get_session_messages(
    session_id: str,
    before: int | None = Query(default=None, ge=0),
    limit: int | None = Query(default=None, ge=1, le=200),
    max_chars: int | None = Query(default=None, ge=10_000, le=2_000_000),
) -> SessionMessagesResp:
    row = _session(session_id)
    try:
        projection = await asyncio.to_thread(
            read_archive_messages,
            row.get("archive_path"),
            before=before,
            limit=limit,
            max_chars=max_chars,
        )
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
    return SessionMessagesResp(session_id=session_id, **projection)


@router.patch("/api/sessions/{session_id}")
async def update_session(session_id: str, req: SessionUpdate) -> HubSession:
    changes = req.model_dump(exclude_unset=True)
    if changes.get("title") is None:
        changes.pop("title", None)
    try:
        return _store.update(session_id, changes)
    except SessionNotFoundError:
        raise _not_found()


@router.put("/api/sessions/{session_id}/model")
async def update_session_model(session_id: str, req: SessionModelUpdate) -> HubSession:
    if req.llm_key is None and req.llm_index is None:
        return _clear_session_llm_binding(session_id)
    if req.llm_key is not None and req.llm_index is not None:
        raise _api_error(400, "llm_conflict", "llm_key 与 llm_index 不能同时提交。")
    if req.llm_key is not None:
        key, index = req.llm_key, None
    else:
        try:
            from ..services.agent_service import get_agent_service
            from ..services.llm_registry import LlmRegistry
            entries = LlmRegistry.reload_and_snapshot(get_agent_service().agent)
            key = dict((index, assignment) for assignment, index in entries).get(req.llm_index)
            if not key:
                raise LlmUnavailableError(f"llm index has no assignment: {req.llm_index}")
        except (LlmUnavailableError, LlmRegistryError) as exc:
            raise _api_error(409, "llm_unavailable", f"当前模型不可用，请重新选择。{exc}")
        index = req.llm_index
    try:
        return _store.update(session_id, {"llm_key": key, "llm_index": index})
    except SessionNotFoundError:
        raise _not_found()


def _clear_session_llm_binding(session_id: str) -> HubSession:
    try:
        return _store.update(session_id, {"llm_key": None, "llm_index": None})
    except SessionNotFoundError:
        raise _not_found()


@router.post(
    "/api/sessions/{session_id}/runs",
    status_code=status.HTTP_202_ACCEPTED,
    response_model_exclude_unset=True,
)
async def submit_run(session_id: str, req: RunSubmit) -> SessionRuntimeResp:
    row = _session(session_id)
    try:
        llm_key = _effective_llm_key(row)
    except LlmUnconfirmedError:
        raise _api_error(409, "llm_unconfirmed", "该会话的模型绑定需要重新确认。")
    try:
        state = _get_coordinator().submit(
            req.text,
            session_id=session_id,
            source=req.source,
            images=req.images,
            llm_key=llm_key,
        )
    except LlmUnavailableError:
        raise _api_error(409, "llm_unavailable", "该会话绑定的 LLM 已不存在，请重新选择。")
    except LlmRegistryError:
        raise _api_error(409, "llm_registry_error", "LLM 配置映射校验失败，请检查 MyKey 配置。")
    except AgentBusyError as exc:
        # Same-session busy (run still aborting) vs. genuine capacity overflow
        # are now distinct codes so the UI can tell the user the right thing.
        raise _busy_error(exc)
    except RuntimeRestoreError:
        raise _api_error(
            409,
            "restore_failed",
            "会话运行环境恢复失败，请稍后重试。",
        )
    _store.touch(session_id)
    return SessionRuntimePayload.from_state(state)


@router.post("/api/sessions/{session_id}/btw", response_model=BtwResp)
async def session_btw(session_id: str, req: BtwReq):
    """Run a side question against the selected session runtime."""
    _session(session_id)
    question = (req.text or "").strip()
    if not question:
        raise _api_error(400, "invalid_btw", "BTW 问题不能为空。")
    try:
        content = await asyncio.to_thread(
            _get_coordinator().side_question, session_id, question
        )
        _store.touch(session_id)
        return BtwResp(ok=True, content=content)
    except SessionControlBusyError as exc:
        raise _api_error(
            409,
            "session_control_active",
            "当前会话正在执行互斥控制操作，请稍后重试。",
            operation=exc.operation,
        )
    except RuntimeRestoreError:
        raise _api_error(
            409,
            "restore_failed",
            "会话运行环境恢复失败，请稍后重试。",
        )
    except Exception as exc:
        log.exception("session BTW failed for %s: %s", session_id, exc)
        return BtwResp(ok=False, error=str(exc))


@router.post("/api/sessions/{session_id}/rewind", response_model=RewindResp)
async def session_rewind(session_id: str, req: RewindReq):
    """Exclusively rewind one session and its GA-native archive."""
    _session(session_id)
    if not req.sid and req.n is None:
        raise _api_error(400, "invalid_rewind", "必须提供 sid 或 n。")
    try:
        result = await asyncio.to_thread(
            _get_coordinator().rewind,
            session_id,
            sid=req.sid,
            n=req.n,
        )
    except AgentBusyError as exc:
        raise _busy_error(exc)
    except SessionControlBusyError as exc:
        raise _api_error(
            409,
            "session_control_active",
            "当前会话正在执行互斥控制操作，请稍后重试。",
            operation=exc.operation,
        )
    except RuntimeRestoreError:
        raise _api_error(
            409,
            "restore_failed",
            "会话运行环境恢复失败，请稍后重试。",
        )
    except ValueError as exc:
        raise _api_error(400, "invalid_rewind", str(exc))
    except RuntimeError as exc:
        raise _api_error(409, "rewind_unavailable", str(exc))
    _store.touch(session_id)
    return result


@router.get("/api/sessions/{session_id}/scheduled-chats")
async def list_scheduled_chats(session_id: str) -> ScheduledChatListResp:
    _session(session_id)
    items = _get_scheduled_chats().list(session_id)
    return {"total": len(items), "items": items}


@router.post(
    "/api/sessions/{session_id}/scheduled-chats",
    status_code=status.HTTP_201_CREATED,
)
async def create_scheduled_chat(
    session_id: str, req: ScheduledChatCreate
) -> ScheduledChatResp:
    _session(session_id)
    now = time.time()
    if req.scheduled_for <= now:
        raise _api_error(422, "invalid_schedule", "定时时间必须晚于当前时间。")
    if req.scheduled_for > now + 48 * 60 * 60:
        raise _api_error(422, "invalid_schedule", "定时时间不能超过未来48小时。")
    return _get_scheduled_chats().create(
        session_id=session_id,
        text=req.text,
        images=req.images,
        scheduled_for=req.scheduled_for,
    )


@router.delete(
    "/api/sessions/{session_id}/scheduled-chats/{task_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def cancel_scheduled_chat(session_id: str, task_id: str):
    _session(session_id)
    if not _get_scheduled_chats().cancel(session_id, task_id):
        raise _api_error(409, "not_cancellable", "定时消息不存在或已无法取消。")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/api/session-runtimes", response_model_exclude_unset=True)
async def list_session_runtimes() -> dict[str, SessionRuntimeResp]:
    coordinator = _get_coordinator()
    return {
        row["id"]: SessionRuntimePayload.from_state(
            coordinator.runtime_state(row["id"])
        )
        for row in _store.list()
    }


@router.get(
    "/api/sessions/{session_id}/runtime",
    response_model_exclude_unset=True,
)
async def get_runtime(session_id: str) -> SessionRuntimeResp:
    _session(session_id)
    return SessionRuntimePayload.from_state(
        _get_coordinator().runtime_state(session_id)
    )


@router.post(
    "/api/sessions/{session_id}/abort",
    response_model_exclude_unset=True,
)
async def abort_run(session_id: str) -> SessionRuntimeResp:
    _session(session_id)
    coordinator = _get_coordinator()
    current = coordinator.abort_if_current(session_id=session_id)
    return SessionRuntimePayload.from_state(current, ok=True)


def _session_event_frame(session_id: str, event: Event) -> dict | None:
    """Map only fully identified chat events owned by this session."""
    if not event.topic.startswith("chat:"):
        return None
    payload = event.payload
    if payload.get("session_id") != session_id:
        return None
    event_type = event.topic.split(":", 1)[1]
    # Rewind is a session-level archive mutation, not a run/stream event.  It
    # still carries an explicit session identity so other tabs can rehydrate
    # the same durable archive without weakening ordinary event isolation.
    if event_type != "rewound" and (
        not payload.get("run_id") or not payload.get("stream_id")
    ):
        return None
    return {
        **payload,
        "type": event_type,
        "event_id": event.event_id,
        "epoch": bus.epoch,
    }


@router.websocket("/ws/sessions/{session_id}")
async def session_events(ws: WebSocket, session_id: str):
    origin = ws.headers.get("origin")
    if not is_allowed_ui_origin(origin):
        log.warning(
            "Rejected session WebSocket session_id=%s from origin %r",
            session_id,
            origin,
        )
        await ws.close(code=1008, reason="Forbidden origin")
        return
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
        row = _store.get(session_id)
    except SessionNotFoundError:
        raise _not_found()

    def _delete() -> None:
        _store.delete(session_id)

    try:
        if _coordinator is None:
            _delete()
        else:
            _coordinator.release_runtime(
                session_id,
                shutdown=lambda runtime: runtime.shutdown(),
                operation="delete",
                after_release=_delete,
            )
    except AgentBusyError as exc:
        raise _busy_error(exc)
    except SessionControlBusyError as exc:
        raise HTTPException(409, {
            "code": "session_control_active",
            "operation": exc.operation,
        })
    return Response(status_code=status.HTTP_204_NO_CONTENT)
