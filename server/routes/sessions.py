"""Session metadata API (message-free GA-Hub sidecar)."""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, WebSocket, WebSocketDisconnect, status

# _paths must be imported before `frontends`: its module-level bootstrap
# puts the GA checkout on sys.path, and a fresh process importing this
# route directly (e.g. test_sessions_api alone) otherwise fails here.
from .. import _paths as _ga_paths_bootstrap  # noqa: F401  (bootstrap order)
from frontends.gahub.bridge import workspace as workspace_bridge

from ..origin_policy import is_allowed_ui_origin
from ..schemas import (
    BtwReq,
    BtwResp,
    RewindReq,
    RewindResp,
    SessionCreate,
    SessionUpdate,
    SessionModelUpdate,
    HubSession,
    SessionListResp,
    ProjectItem,
    ProjectListResp,
    ProjectCreate,
    SessionProjectUpdate,
    RunSubmit,
    ScheduledChatCreate,
    ScheduledChatResp,
    ScheduledChatListResp,
    SessionRuntimeResp,
    SessionRuntimePayload,
    SessionMessagesResp,
)
from ..services.archive_messages import HistoryUnavailableError, read_archive_messages
from ..services.event_bus import Event, bus
from ..services.event_cursor import parse_event_cursor, subscribe_with_cursor
from ..services.llm_registry import (
    LlmRegistryError,
    LlmUnavailableError,
)
from ..services.session_coordinator import (
    RuntimeState,
    SessionControlBusyError,
)
from ..services.session_lifecycle import SessionLifecycle, session_lifecycle_of
from ..services.session_metadata import SessionNotFoundError
from ..services.project_runtime import activate_project, deactivate_project
from ..services.ui_preferences_store import UiPreferencesStore
from .. import _paths
from ..services.session_runtime_factory import RuntimeRestoreError

# Display metadata belongs to GA-Hub; the native workspace key stays immutable.
_project_names = UiPreferencesStore(_paths.ADMIN_DATA / "project_names.json")


def _with_project_display_name(item: dict, names: dict) -> dict:
    saved = names.get(item["name"])
    if isinstance(saved, dict) and saved.get("path") == item["path"]:
        return {**item, "display_name": saved["display_name"]}
    return item

router = APIRouter()
log = logging.getLogger(__name__)


def _request_lifecycle(request: Request) -> SessionLifecycle:
    return session_lifecycle_of(request.app)


# Route handlers take the process-owned session domain as an injected
# dependency; server.main binds it to the app. The domain used to live in this
# module as process globals, which made an HTTP module the composition root.
SessionDomain = Annotated[SessionLifecycle, Depends(_request_lifecycle)]


def _state_payload(state: RuntimeState, *, ok: bool | None = None) -> dict:
    """WS/REST frames share one assembly: SessionRuntimePayload.from_state.

    The bus frame published by ``services.session_lifecycle._publish_runtime_state``
    deliberately differs (error key always present) — that shape is locked by
    test_session_websocket.py.
    """
    return SessionRuntimePayload.from_state(state, ok=ok).model_dump(exclude_unset=True)


def _session(lifecycle: SessionLifecycle, session_id: str) -> dict:
    try:
        return lifecycle.store.get(session_id)
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


@router.get("/api/projects", response_model_exclude_unset=True)
async def list_projects() -> ProjectListResp:
    # Native listing opens workspaces.json plus one memory file per entry.
    items = await asyncio.to_thread(workspace_bridge.list_workspaces)
    names = await asyncio.to_thread(_project_names.read)
    return ProjectListResp(total=len(items), items=[_with_project_display_name(item, names) for item in items])


@router.post(
    "/api/projects",
    status_code=status.HTTP_201_CREATED,
    response_model_exclude_unset=True,
)
async def create_project(req: ProjectCreate) -> ProjectItem:
    # Native preparation may shell out to `cmd /c mklink` and create
    # directories, so the subprocess wait stays off the event loop.
    result = await asyncio.to_thread(workspace_bridge.prepare_workspace, req.path.strip())
    if not result.get("ok"):
        raise _api_error(400, "project_prepare_failed", result.get("error") or "项目创建失败。")
    item = ProjectItem(
        name=result["name"],
        path=result.get("path") or result.get("target") or req.path.strip(),
        memory_path=result.get("memory_path") or "",
        dangling=False,
    )
    if req.display_name is not None:
        await asyncio.to_thread(_project_names.update, {
            item.name: {"path": item.path, "display_name": req.display_name},
        })
    names = await asyncio.to_thread(_project_names.read)
    return ProjectItem(**_with_project_display_name(item.model_dump(exclude_unset=True), names))


@router.delete("/api/projects/{project_name}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(lifecycle: SessionDomain, project_name: str):
    project = await asyncio.to_thread(workspace_bridge.get_workspace, project_name)
    if project is None:
        raise _api_error(404, "project_not_found", "项目索引不存在")
    bound_sessions = [
        row for row in await asyncio.to_thread(lifecycle.store.list)
        if row.get("project_name") == project_name
    ]
    if bound_sessions:
        raise _api_error(
            409,
            "project_still_bound",
            "仍有其他会话绑定此项目，请先在这些会话中取消绑定。",
            session_ids=[row["id"] for row in bound_sessions],
        )
    result = await asyncio.to_thread(workspace_bridge.remove_workspace, project_name)
    if not result.get("ok"):
        raise _api_error(
            500,
            "project_remove_failed",
            result.get("error") or "项目目录映射移除失败，请稍后重试。",
        )


@router.put("/api/sessions/{session_id}/project")
async def bind_session_project(
    lifecycle: SessionDomain, session_id: str, req: SessionProjectUpdate
) -> HubSession:
    await asyncio.to_thread(_session, lifecycle, session_id)
    project = await asyncio.to_thread(
        workspace_bridge.get_workspace, req.name, req.path
    )
    if project is None or project.get("dangling"):
        raise HTTPException(404, "project not found")

    def configure(runtime):
        if runtime is not None:
            activate_project(runtime.agent, req.name)
        return lifecycle.store.update(session_id, {
            "project_name": req.name,
            "project_path": req.path,
        })

    # configure_if_idle runs the callback on the caller's thread; hand the
    # whole thing (runtime activation + sidecar write) to a worker.
    # AgentBusyError propagates to the app-level mapper (409
    # session_active/agent_busy).
    return await asyncio.to_thread(
        lifecycle.coordinator().configure_if_idle, session_id, configure
    )


@router.delete("/api/sessions/{session_id}/project")
async def unbind_session_project(lifecycle: SessionDomain, session_id: str) -> HubSession:
    await asyncio.to_thread(_session, lifecycle, session_id)

    def configure(runtime):
        if runtime is not None:
            deactivate_project(runtime.agent)
        return lifecycle.store.update(session_id, {
            "project_name": None,
            "project_path": None,
        })

    return await asyncio.to_thread(
        lifecycle.coordinator().configure_if_idle, session_id, configure
    )


@router.get("/api/sessions")
async def list_sessions(
    lifecycle: SessionDomain, include_system: bool = False
) -> SessionListResp:
    # Full-file JSON read of the sidecar — keep it off the loop, like every
    # other blocking call in this file.
    rows = await asyncio.to_thread(lifecycle.store.list)
    if not include_system:
        # System channels (wechat / autonomous / scheduled tasks) are hub
        # plumbing, not user chats: hide them unless explicitly asked for.
        rows = [row for row in rows if row.get("kind") != "system"]
    return SessionListResp(total=len(rows), items=rows)


@router.post("/api/sessions", status_code=status.HTTP_201_CREATED)
async def create_session(lifecycle: SessionDomain, req: SessionCreate) -> HubSession:
    return await asyncio.to_thread(
        lifecycle.store.create, title=req.title, llm_key=req.llm_key, llm_index=req.llm_index
    )


@router.get("/api/sessions/{session_id}")
async def get_session(lifecycle: SessionDomain, session_id: str) -> HubSession:
    try:
        return await asyncio.to_thread(lifecycle.store.get, session_id)
    except SessionNotFoundError:
        raise _not_found()


@router.get("/api/sessions/{session_id}/messages")
async def get_session_messages(
    lifecycle: SessionDomain,
    session_id: str,
    before: int | None = Query(default=None, ge=0),
    limit: int | None = Query(default=None, ge=1, le=200),
    max_chars: int | None = Query(default=None, ge=10_000, le=8_000_000),
    turns: int | None = Query(default=None, ge=1, le=500),
) -> SessionMessagesResp:
    row = await asyncio.to_thread(_session, lifecycle, session_id)
    try:
        projection = await asyncio.to_thread(
            read_archive_messages,
            row.get("archive_path"),
            before=before,
            limit=limit,
            max_chars=max_chars,
            turns=turns,
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
async def update_session(
    lifecycle: SessionDomain, session_id: str, req: SessionUpdate
) -> HubSession:
    changes = req.model_dump(exclude_unset=True)
    if changes.get("title") is None:
        changes.pop("title", None)
    try:
        row = await asyncio.to_thread(lifecycle.store.update, session_id, changes)
        if "theme_task" in changes and changes["theme_task"] is None:
            from ..services import theme_task_runs
            await asyncio.to_thread(theme_task_runs.discard, session_id)
        return row
    except SessionNotFoundError:
        raise _not_found()


@router.put("/api/sessions/{session_id}/model")
async def update_session_model(
    lifecycle: SessionDomain, session_id: str, req: SessionModelUpdate
) -> HubSession:
    if req.llm_key is None and req.llm_index is None:
        return await _clear_session_llm_binding(lifecycle, session_id)
    if req.llm_key is not None and req.llm_index is not None:
        raise _api_error(400, "llm_conflict", "llm_key 与 llm_index 不能同时提交。")
    if req.llm_key is not None:
        key, index = req.llm_key, None
    else:
        try:
            from ..services.agent_service import get_agent_service
            from ..services.llm_registry import LlmRegistry
            # reload_and_snapshot re-execs mykey.py and rebuilds clients.
            entries = await asyncio.to_thread(
                LlmRegistry.reload_and_snapshot, get_agent_service().agent
            )
            key = dict((index, assignment) for assignment, index in entries).get(req.llm_index)
            if not key:
                raise LlmUnavailableError(f"llm index has no assignment: {req.llm_index}")
        except (LlmUnavailableError, LlmRegistryError) as exc:
            raise _api_error(409, "llm_unavailable", f"当前模型不可用，请重新选择。{exc}")
        index = req.llm_index
    try:
        return await asyncio.to_thread(
            lifecycle.store.update, session_id, {"llm_key": key, "llm_index": index}
        )
    except SessionNotFoundError:
        raise _not_found()


async def _clear_session_llm_binding(
    lifecycle: SessionLifecycle, session_id: str
) -> HubSession:
    try:
        return await asyncio.to_thread(
            lifecycle.store.update, session_id, {"llm_key": None, "llm_index": None}
        )
    except SessionNotFoundError:
        raise _not_found()


@router.post(
    "/api/sessions/{session_id}/runs",
    status_code=status.HTTP_202_ACCEPTED,
    response_model_exclude_unset=True,
)
async def submit_run(
    lifecycle: SessionDomain, session_id: str, req: RunSubmit
) -> SessionRuntimeResp:
    row = await asyncio.to_thread(_session, lifecycle, session_id)
    # LlmUnconfirmedError/AgentBusyError/SessionControlBusyError/
    # RuntimeRestoreError/LlmUnavailableError/LlmRegistryError all carry the
    # same-session serial-guard semantics and propagate to the app-level
    # mapper (409 with their stable codes).
    llm_key = lifecycle.effective_llm_key(row)
    # submit_stream may cold-start the runtime (birth lock + GA restore)
    # inside its admission critical section — worker thread, like every
    # other runtime touch in this file.
    state = await asyncio.to_thread(
        lifecycle.coordinator().submit,
        req.text,
        session_id=session_id,
        source=req.source,
        images=req.images,
        llm_key=llm_key,
    )
    await asyncio.to_thread(lifecycle.store.touch, session_id)
    return SessionRuntimePayload.from_state(state)


@router.post("/api/sessions/{session_id}/btw", response_model=BtwResp)
async def session_btw(lifecycle: SessionDomain, session_id: str, req: BtwReq):
    """Run a side question against the selected session runtime."""
    await asyncio.to_thread(_session, lifecycle, session_id)
    question = (req.text or "").strip()
    if not question:
        raise _api_error(400, "invalid_btw", "BTW 问题不能为空。")
    try:
        content = await asyncio.to_thread(
            lifecycle.coordinator().side_question, session_id, question
        )
        await asyncio.to_thread(lifecycle.store.touch, session_id)
        return BtwResp(ok=True, content=content)
    except (SessionControlBusyError, RuntimeRestoreError):
        # Explicit: the blanket catch below must not swallow these into
        # ok=False — they are 409 refusals (app-level mapper shapes).
        raise
    except Exception as exc:
        log.exception("session BTW failed for %s: %s", session_id, exc)
        return BtwResp(ok=False, error=str(exc))


@router.post("/api/sessions/{session_id}/rewind", response_model=RewindResp)
async def session_rewind(lifecycle: SessionDomain, session_id: str, req: RewindReq):
    """Exclusively rewind one session and its GA-native archive."""
    await asyncio.to_thread(_session, lifecycle, session_id)
    if not req.sid and req.n is None:
        raise _api_error(400, "invalid_rewind", "必须提供 sid 或 n。")
    try:
        result = await asyncio.to_thread(
            lifecycle.coordinator().rewind,
            session_id,
            sid=req.sid,
            n=req.n,
        )
    except ValueError as exc:
        raise _api_error(400, "invalid_rewind", str(exc))
    except RuntimeError as exc:
        raise _api_error(409, "rewind_unavailable", str(exc))
    await asyncio.to_thread(lifecycle.store.touch, session_id)
    return result


@router.get("/api/sessions/{session_id}/scheduled-chats")
async def list_scheduled_chats(
    lifecycle: SessionDomain, session_id: str
) -> ScheduledChatListResp:
    await asyncio.to_thread(_session, lifecycle, session_id)
    items = await asyncio.to_thread(lifecycle.scheduled_chats().list, session_id)
    return {"total": len(items), "items": items}


@router.post(
    "/api/sessions/{session_id}/scheduled-chats",
    status_code=status.HTTP_201_CREATED,
)
async def create_scheduled_chat(
    lifecycle: SessionDomain, session_id: str, req: ScheduledChatCreate
) -> ScheduledChatResp:
    await asyncio.to_thread(_session, lifecycle, session_id)
    now = time.time()
    if req.scheduled_for <= now:
        raise _api_error(422, "invalid_schedule", "定时时间必须晚于当前时间。")
    if req.scheduled_for > now + 48 * 60 * 60:
        raise _api_error(422, "invalid_schedule", "定时时间不能超过未来48小时。")
    try:
        return await asyncio.to_thread(
            lifecycle.scheduled_chats().create,
            session_id=session_id,
            text=req.text,
            images=req.images,
            scheduled_for=req.scheduled_for,
        )
    except ValueError as exc:
        # Service-side guard; the route's own 422 checks above run first.
        raise _api_error(422, "invalid_schedule", str(exc))


@router.delete(
    "/api/sessions/{session_id}/scheduled-chats/{task_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def cancel_scheduled_chat(
    lifecycle: SessionDomain, session_id: str, task_id: str
):
    await asyncio.to_thread(_session, lifecycle, session_id)
    try:
        # The service signals by exception (missing id -> KeyError, non-
        # pending -> ValueError); it never returns a falsy value.
        await asyncio.to_thread(lifecycle.scheduled_chats().cancel, session_id, task_id)
    except KeyError:
        raise _api_error(404, "scheduled_chat_not_found", "定时消息不存在。")
    except ValueError:
        raise _api_error(409, "not_cancellable", "定时消息不存在或已无法取消。")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/api/session-runtimes", response_model_exclude_unset=True)
async def list_session_runtimes(
    lifecycle: SessionDomain,
) -> dict[str, SessionRuntimeResp]:
    coordinator = lifecycle.coordinator()
    return {
        row["id"]: SessionRuntimePayload.from_state(
            coordinator.runtime_state(row["id"])
        )
        for row in await asyncio.to_thread(lifecycle.store.list)
    }


@router.get(
    "/api/sessions/{session_id}/runtime",
    response_model_exclude_unset=True,
)
async def get_runtime(lifecycle: SessionDomain, session_id: str) -> SessionRuntimeResp:
    await asyncio.to_thread(_session, lifecycle, session_id)
    return SessionRuntimePayload.from_state(
        lifecycle.coordinator().runtime_state(session_id)
    )


@router.post(
    "/api/sessions/{session_id}/abort",
    response_model_exclude_unset=True,
)
async def abort_run(lifecycle: SessionDomain, session_id: str) -> SessionRuntimeResp:
    await asyncio.to_thread(_session, lifecycle, session_id)
    coordinator = lifecycle.coordinator()
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
    # WebSocket routes get no HTTP dependency; the domain still comes from the
    # app that mounted this router. Resolved after the origin guard so an
    # untrusted socket is refused before any app state is read.
    lifecycle = session_lifecycle_of(ws.app)
    try:
        await asyncio.to_thread(_session, lifecycle, session_id)
    except HTTPException:
        await ws.close(code=4404, reason="session not found")
        return

    await ws.accept()

    raw_after = ws.query_params.get("after_event_id")
    client_epoch = ws.query_params.get("epoch")
    after_event_id, _ = parse_event_cursor(raw_after)

    connection_id = uuid.uuid4().hex
    subscription = await subscribe_with_cursor(bus, raw_after, prefix="chat:", epoch=client_epoch)
    log.info(
        "session_ws_connected session_id=%s ws_connection_id=%s "
        "resume_after=%s replay_count=%s boundary_event_id=%s",
        session_id, connection_id, after_event_id,
        len(subscription.replay), subscription.boundary_id,
    )

    async def send_snapshot() -> None:
        state, active_message = lifecycle.coordinator().session_snapshot(session_id)
        runtime_payload = _state_payload(state)
        await ws.send_json({
            "type": "snapshot",
            **runtime_payload,
            "runtime": runtime_payload,
            "streams": active_message.get("streams", []) if active_message else [],
            "active_message": ({k: v for k, v in active_message.items() if k != "streams"}
                               if active_message else None),
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

        # Replay first; a fresh baseline is required even for a valid cursor:
        # a transport cursor says nothing about whether the UI retained its view.
        if after_event_id is not None and subscription.resync_reason is None:
            for event in subscription.replay:
                frame = _session_event_frame(session_id, event)
                if frame is not None:
                    await ws.send_json(frame)
        await send_snapshot()

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
async def delete_session(lifecycle: SessionDomain, session_id: str):
    # Existence check only: get() raises SessionNotFoundError -> 404.
    try:
        await asyncio.to_thread(lifecycle.store.get, session_id)
    except SessionNotFoundError:
        raise _not_found()

    def _delete() -> None:
        lifecycle.store.delete(session_id)
        from ..services import theme_task_runs
        theme_task_runs.discard(session_id)

    if lifecycle.peek_coordinator() is None:
        await asyncio.to_thread(_delete)
    else:
        # Go through the accessor so the shutdown admission gate applies
        # to delete like every other runtime-touching endpoint.  The mapper
        # turns AgentBusyError/SessionControlBusyError into 409s.
        # runtime.shutdown() joins worker threads — keep it off the loop.
        await asyncio.to_thread(
            lifecycle.coordinator().release_runtime,
            session_id,
            shutdown=lambda runtime: runtime.shutdown(),
            operation="delete",
            after_release=_delete,
        )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/api/sessions/{session_id}/theme-run")
async def theme_run(lifecycle: SessionDomain, session_id: str) -> dict:
    await asyncio.to_thread(_session, lifecycle, session_id)
    from ..services import theme_task_runs
    coordinator = lifecycle.peek_coordinator()
    state = coordinator.runtime_state(session_id) if coordinator else None
    active_id = state.run_id if state and state.status in {"starting", "running", "aborting", "recovering"} else None
    return {"run": await asyncio.to_thread(theme_task_runs.get, session_id, active_id)}


@router.post("/api/sessions/{session_id}/theme-run", status_code=status.HTTP_202_ACCEPTED)
async def start_theme_run(lifecycle: SessionDomain, session_id: str, req: RunSubmit) -> SessionRuntimeResp:
    row = await asyncio.to_thread(_session, lifecycle, session_id)
    if not row.get("theme_task"):
        raise _api_error(409, "not_theme_task", "该会话不是主题任务。")
    key = str(row.get("llm_key") or "").strip()
    if not key:
        raise _api_error(409, "llm_unconfirmed", "请先在任务设置中选择执行模型。")
    return await submit_run(lifecycle, session_id, req)
