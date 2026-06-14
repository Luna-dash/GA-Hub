"""FastAPI app for the GenericAgent Web Admin.

Two startup modes:

* **Setup mode**: when ``_paths.GA_ROOT`` is None — only mounts ``/api/setup/*``
  plus a static SPA. The user picks a GenericAgent directory; backend then
  needs to be restarted to enter normal mode.

* **Normal mode**: full router set, agent + wechat + scheduler bootstrap.

This module is path-agnostic: it doesn't compute its own ROOT, instead it
relies on ``server._paths`` for everything that involves the GA project.
The webui ``dist/`` folder lives next to ``server/`` in the admin checkout
(``ADMIN_ROOT/webui/dist``).
"""
from __future__ import annotations

import asyncio
import ipaddress
import logging
import mimetypes
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import APIRouter, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import _paths
from .routes import events as event_routes  # safe to import in setup mode
from .services.event_bus import bus

log = logging.getLogger(__name__)


# ── Host-header allow-list (anti DNS-rebinding) ──────────────────────────────
# The backend binds to 127.0.0.1 by default, but a malicious web page can still
# reach it via a DNS-rebinding attack: the attacker's domain resolves to
# 127.0.0.1, so the browser sends our backend a request carrying
# ``Host: evil.example``. Since rebinding always uses a *domain name* (never a
# raw IP), we defeat it by only accepting Host values that are either:
#   * a literal IP address (loopback / LAN — what a real user types), or
#   * ``localhost`` / ``*.localhost``.
# Power users who front the app with a custom hostname can extend the list via
# the ``GAHUB_ALLOWED_HOSTS`` env var (comma-separated). This adds **zero**
# friction to the default localhost workflow.
_EXTRA_ALLOWED_HOSTS = {
    h.strip().lower()
    for h in os.environ.get("GAHUB_ALLOWED_HOSTS", "").split(",")
    if h.strip()
}


def _host_only(host_header: str) -> str:
    """Strip the optional ``:port`` from a Host header, handling ``[::1]``."""
    h = host_header.strip()
    if not h:
        return ""
    if h.startswith("["):  # bracketed IPv6, e.g. [::1]:8765
        return h[1 : h.index("]")] if "]" in h else h[1:]
    if h.count(":") == 1:  # host:port  (bare IPv6 never appears unbracketed here)
        return h.rsplit(":", 1)[0]
    return h


def _is_allowed_host(host_header: str) -> bool:
    host = _host_only(host_header).lower()
    if not host:
        return False
    if host in _EXTRA_ALLOWED_HOSTS:
        return True
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        ipaddress.ip_address(host)  # any IP literal is safe vs rebinding
        return True
    except ValueError:
        return False

# Force-correct MIME types for SPA assets. On Windows, the registry can have
# .js mapped to text/plain (legacy IIS / dev-tool installs), which makes
# Starlette serve ES modules with the wrong Content-Type and the browser
# refuses to execute them with a strict-MIME error → black screen.
# add_type() overrides whatever the registry says.
for _ext, _mime in (
    (".js", "application/javascript"),
    (".mjs", "application/javascript"),
    (".css", "text/css"),
    (".wasm", "application/wasm"),
    (".svg", "image/svg+xml"),
    (".json", "application/json"),
    (".map", "application/json"),
):
    mimetypes.add_type(_mime, _ext)

WEBUI_DIST = _paths.ADMIN_ROOT / "webui" / "dist"


class SetupReq(BaseModel):
    ga_root: str
    python_path: str | None = None


def _setup_router() -> APIRouter:
    """Endpoints available in BOTH setup mode and normal mode.

    Lets the React UI:
      * read the current configured ga_root + suggested candidates
      * test a path for validity (without saving)
      * save a path → backend will need to restart to pick it up
    """
    r = APIRouter(prefix="/api/setup", tags=["setup"])

    @r.get("/status")
    async def setup_status():
        # Per-path try/except so a single broken path (e.g. an unmounted
        # volume on macOS, a permission error on Windows) doesn't 500 the
        # whole endpoint and leave the SPA stuck on "正在连接后端…".
        candidates = []
        try:
            for c in _paths.candidate_paths():
                try:
                    candidates.append({"path": str(c), "valid": _paths.is_valid_ga_root(c)})
                except Exception as e:
                    log.warning("candidate_paths probe failed for %r: %s", c, e)
                    candidates.append({"path": str(c), "valid": False, "error": str(e)})
        except Exception as e:
            log.exception("candidate_paths enumeration failed")
            candidates = [{"path": "<error>", "valid": False, "error": str(e)}]
        return {
            "configured": _paths.GA_ROOT is not None,
            "ga_root": str(_paths.GA_ROOT) if _paths.GA_ROOT else None,
            "admin_data": str(_paths.ADMIN_DATA),
            "candidates": candidates,
            **_paths.python_status(),
        }

    @r.post("/validate")
    async def setup_validate(req: SetupReq):
        return {
            "valid": _paths.is_valid_ga_root(req.ga_root),
            "resolved": str(Path(req.ga_root).expanduser().resolve()),
        }

    @r.post("/save")
    async def setup_save(req: SetupReq):
        try:
            python_arg = req.python_path if "python_path" in req.model_fields_set else _paths._UNSET
            p = _paths.set_ga_root(req.ga_root, python_arg)
        except ValueError as e:
            raise HTTPException(400, str(e))
        return {"ok": True, "ga_root": str(p), "restart_required": True, **_paths.python_status(p)}

    return r


def _mount_static(app: FastAPI) -> None:
    if not WEBUI_DIST.is_dir():
        @app.get("/", include_in_schema=False)
        async def _root_hint():
            return {
                "hint": "webui/dist not built. Run install_webui.sh / install_webui.bat",
                "docs": "/docs",
                "configured": _paths.GA_ROOT is not None,
            }
        return

    app.mount("/assets", StaticFiles(directory=str(WEBUI_DIST / "assets")), name="assets")

    # `index.html` MUST NOT be cached. Vite emits hashed asset filenames
    # (e.g. /assets/index-zHuouAyB.js) and the index points at the current
    # hash — if WKWebView/Edge serves a stale cached index after a rebuild,
    # the browser will request a hash that no longer exists, fall through
    # to the SPA catch-all, and end up parsing HTML as JS. Symptom seen in
    # the wild: half-mounted React tree, sidebar NavLink stuck on "/".
    # The hashed assets themselves are immutable so they can be cached
    # aggressively (StaticFiles default is fine).
    _NO_CACHE = {"Cache-Control": "no-store, must-revalidate"}

    @app.get("/", include_in_schema=False)
    async def _root():
        return FileResponse(str(WEBUI_DIST / "index.html"), headers=_NO_CACHE)

    @app.get("/{path:path}", include_in_schema=False)
    async def _spa(path: str):
        # Resolve and confine to WEBUI_DIST so a crafted path (e.g.
        # ``../../etc/passwd`` or backslash variants on Windows) can never
        # escape the static root and serve arbitrary files.
        dist_root = WEBUI_DIST.resolve()
        try:
            full = (dist_root / path).resolve()
            within = full == dist_root or full.is_relative_to(dist_root)
        except (ValueError, OSError):
            within = False
        if within and full.is_file():
            return FileResponse(str(full))
        idx = dist_root / "index.html"
        if idx.is_file():
            return FileResponse(str(idx), headers=_NO_CACHE)
        return JSONResponse({"detail": "not found"}, status_code=404)


def create_app() -> FastAPI:
    setup_mode = _paths.GA_ROOT is None
    @asynccontextmanager
    async def _lifespan(_app: FastAPI):
        await _startup()
        try:
            yield
        finally:
            await _shutdown()

    app = FastAPI(
        title="GenericAgent Admin API" + (" (setup mode)" if setup_mode else ""),
        version="0.2.0",
        lifespan=_lifespan,
    )

    # CORS: the SPA is served same-origin, so a wildcard policy only serves to
    # let *arbitrary* external web pages script the local API. Restrict to
    # localhost origins (covers the Vite dev server too).
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$",
        allow_credentials=False,
        allow_methods=["*"], allow_headers=["*"],
    )

    # Host-header guard: reject requests whose Host isn't localhost or an IP
    # literal — defeats DNS-rebinding attacks against the loopback-bound backend.
    @app.middleware("http")
    async def _host_guard(request: Request, call_next):
        host_header = request.headers.get("host", "")
        allowed = _is_allowed_host(host_header)
        log.info(f"[HOST-GUARD] Host={host_header!r} allowed={allowed}")
        if not allowed:
            return PlainTextResponse("Forbidden host", status_code=403)
        return await call_next(request)

    async def _startup():
        bus.attach_loop(asyncio.get_running_loop())
        if setup_mode:
            log.warning(
                "GA_ROOT not configured — running in SETUP MODE.\n"
                "  Open the UI to pick your GenericAgent directory,\n"
                "  or set $GA_ROOT and restart."
            )
            return

        # Lazy imports after _paths is set
        from .services.agent_service import AgentService
        from .services.autonomous_scheduler import AutonomousScheduler
        from .services.task_scheduler import TaskScheduler
        from .services.feishu_service import FeishuService

        agent_svc = AgentService.instance()
        agent_svc.start_run_thread()

        try:
            fs = FeishuService.instance()
            fs.start_log_watcher()
            log.info("feishu log watcher started")
        except Exception as e:
            log.warning("feishu log watcher init skipped: %s", e)

        try:
            sched = AutonomousScheduler.instance(agent_svc)
            sched.start()
            log.info("autonomous scheduler started (%d schedules)", len(sched.schedules))
        except Exception as e:
            log.warning("autonomous scheduler init skipped: %s", e)

        try:
            task_sched = TaskScheduler.instance(agent_svc)
            task_sched.start()
            log.info("task scheduler started (%d schedules)", len(task_sched.schedules))
        except Exception as e:
            log.warning("task scheduler init skipped: %s", e)

    async def _shutdown():
        if not setup_mode:
            # Archive current WebUI conversation so it persists across restarts
            try:
                from .services.agent_service import AgentService
                AgentService.instance()._archive_snapshots_to_chat_history()
            except Exception:
                pass
            try:
                from .services.feishu_service import FeishuService
                FeishuService.instance().shutdown()
            except Exception:
                pass
            try:
                from .services.autonomous_scheduler import AutonomousScheduler
                AutonomousScheduler.instance().shutdown()
            except Exception:
                pass
            try:
                from .services.task_scheduler import TaskScheduler
                TaskScheduler.instance().shutdown()
            except Exception:
                pass

    # ── always-available endpoints ──
    app.include_router(_setup_router())
    app.include_router(event_routes.router)

    @app.get("/api/status")
    async def status():
        out: dict[str, Any] = {
            "configured": _paths.GA_ROOT is not None,
            "ga_root": str(_paths.GA_ROOT) if _paths.GA_ROOT else None,
            **_paths.python_status(),
        }
        if setup_mode:
            out["mode"] = "setup"
            return out

        from .services.agent_service import AgentService
        out["agent"] = AgentService.instance().status().__dict__
        try:
            from .services.feishu_service import FeishuService
            out["feishu"] = FeishuService.instance().status()
        except Exception as e:
            out["feishu"] = {"error": str(e)}
        try:
            from .services.autonomous_scheduler import AutonomousScheduler
            out["autonomous"] = {
                "schedule_count": len(AutonomousScheduler.instance().schedules),
            }
        except Exception:
            pass
        try:
            from .services.task_scheduler import TaskScheduler
            out["tasks"] = {
                "schedule_count": len(TaskScheduler.instance().schedules),
            }
        except Exception:
            pass
        return out

    if not setup_mode:
        from .routes import (
            agent as agent_routes,
            autonomous as autonomous_routes,
            conductor as conductor_routes,
            conversations as conv_routes,
            logs as log_routes,
            memory as memory_routes,
            mykey as mykey_routes,
            notify as notify_routes,
            tasks as task_routes,
            upload as upload_routes,
            feishu as feishu_routes,
        )
        app.include_router(agent_routes.router)
        app.include_router(feishu_routes.router)
        app.include_router(conv_routes.router)
        app.include_router(memory_routes.router)
        app.include_router(autonomous_routes.router)
        app.include_router(conductor_routes.router)
        app.include_router(upload_routes.router)
        app.include_router(log_routes.router)
        app.include_router(mykey_routes.router)
        app.include_router(notify_routes.router)
        app.include_router(task_routes.router)

    _mount_static(app)
    return app


app = create_app()
