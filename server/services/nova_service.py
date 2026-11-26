"""Opt-in Nova connector service, owned by the Hub lifespan.

Pure runtime/domain service: keeps FastAPI and Pydantic out of ``services/``
while preserving optional-connector isolation (startup failures degrade into
``self.error`` and never block Hub boot).
"""
from __future__ import annotations

import asyncio
import contextlib
import importlib
import inspect
import json
import secrets
import sys
import time
from collections.abc import Awaitable, Callable
from pathlib import Path

PUBLIC = "https://nova.lunadash.me"
_ERROR_NOT_FOUND = 1168  # Win32: credential was already removed.
_SAFE_USER_ERRORS = ("ConnectorAuthError", "ConnectorConflictError")


def _clear_binding(connector, config: Path, data: dict) -> None:
    try:
        connector.win32cred.CredDelete(connector.credential_target(data["server"]), 1)
    except Exception as exc:
        if getattr(exc, "winerror", None) != _ERROR_NOT_FOUND:
            raise
    config.unlink(missing_ok=True)


def _save_revocation(config: Path, data: dict) -> None:
    staged = config.with_suffix(".new")
    staged.write_text(json.dumps(data), encoding="utf-8")
    staged.replace(config)


def _read_device_name(config: Path) -> str | None:
    try:
        if config.exists():
            raw = json.loads(config.read_text(encoding="utf-8"))
            name = raw.get("name")
            return str(name) if isinstance(name, str) and name.strip() else None
    except (OSError, ValueError):
        return None
    return None


class NovaServiceError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


class NovaService:
    def __init__(self) -> None:
        self.connector = None
        self.task = None
        self.pending = None
        self.lock = asyncio.Lock()
        self.nonce = secrets.token_urlsafe(32)
        self.error: str | None = None
        self.error_detail: str | None = None
        self.connected = False
        self.paused = False
        self.last_connected_at: float | None = None
        self.rtt_ms: int | None = None

    def load(self):
        if self.connector is None:
            repo_root = Path(__file__).resolve().parents[2]
            root = Path(getattr(sys, "_MEIPASS", repo_root))
            sys.path.insert(0, str(root / "assets" / "nova"))
            self.connector = importlib.import_module("connector")
            # Bundled assets live in _MEIPASS, while deliverables live in GA's
            # configured workspace. Never derive the latter from the bundle.
            from .._paths import conductor_deliverables_dir

            roots = [conductor_deliverables_dir()]
            if not getattr(sys, "frozen", False):
                roots.append(repo_root / "temp")
            self.connector.ARTIFACT_ROOTS = tuple(roots)
        return self.connector

    def _require_connector(self):
        if self.connector is None and sys.platform != "win32":
            raise NovaServiceError(503, "此平台不支持 Nova 的 Windows 凭据服务")
        try:
            return self.load()
        except ImportError as exc:
            raise NovaServiceError(503, "Nova 组件或本机凭据服务不可用") from exc

    async def start(self) -> None:
        # An unavailable optional connector must never prevent Hub startup.
        if self.paused or (self.task and not self.task.done()):
            return
        self.connected = False
        self.error = None
        self.error_detail = None
        self.rtt_ms = None
        try:
            c = self._require_connector()
            if await asyncio.to_thread((c.STATE / "device.json").exists):
                from ..constants import DEFAULT_WEBUI_PORT
                from ..runtime_endpoint import runtime_http_origin

                kwargs: dict[str, object] = {
                    "backend": runtime_http_origin("127.0.0.1", DEFAULT_WEBUI_PORT),
                    "on_connection": self._set_connected,
                }
                with contextlib.suppress(TypeError, ValueError):
                    if "on_heartbeat" in inspect.signature(c.run).parameters:
                        kwargs["on_heartbeat"] = self._on_heartbeat
                self.task = asyncio.create_task(c.run(**kwargs), name="nova-connector")
                self.task.add_done_callback(self._done)
        except Exception as exc:
            if isinstance(exc, NovaServiceError) and exc.__cause__ is None:
                self.error = exc.detail
                self.error_detail = exc.detail
            else:
                self.error = type(exc.__cause__ or exc).__name__

    def _set_connected(self, connected: bool) -> None:
        self.connected = connected
        if connected:
            self.last_connected_at = time.time()
            self.error = None
            self.error_detail = None
        else:
            self.rtt_ms = None

    def _on_heartbeat(self, *, ready: bool, rtt_ms: int | None = None) -> None:
        if rtt_ms is not None:
            self.rtt_ms = rtt_ms

    def _done(self, task) -> None:
        if task is self.task:
            self.connected = False
            self.rtt_ms = None
        if not task.cancelled() and (exc := task.exception()) and task is self.task:
            name = type(exc).__name__
            self.error = name
            if name in _SAFE_USER_ERRORS:
                self.error_detail = str(exc)

    async def stop(self) -> None:
        if self.task:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
            self.task = None
        self.connected = False
        self.rtt_ms = None

    def runtime_status(self) -> dict[str, object]:
        # A panel read must not load the connector, access credentials, or start it.
        c = self.connector
        task = self.task
        running = task is not None and not task.done()
        return {
            "paired": (c.STATE / "device.json").exists() if c is not None else None,
            "running": running,
            "connected": running and self.connected,
            "paused": self.paused,
            "error": self.error,
            "error_detail": self.error_detail,
        }

    def snapshot(self) -> dict[str, object]:
        try:
            c = self._require_connector()
            config = c.STATE / "device.json"
            running = bool(self.task and not self.task.done())
            connected = running and self.connected
            return {
                "device": c.identity(),
                "device_name": _read_device_name(config),
                "paired": config.exists(),
                "running": running,
                "connected": connected,
                "paused": self.paused,
                "rtt_ms": self.rtt_ms if connected else None,
                "last_connected_at": self.last_connected_at,
                "error": self.error,
                "error_detail": self.error_detail,
                "connector_version": getattr(c, "CONNECTOR_VERSION", None),
                "server": PUBLIC,
            }
        except Exception as exc:
            detail = exc.detail if isinstance(exc, NovaServiceError) else type(exc).__name__
            return {"error": detail, "error_detail": exc.detail if isinstance(exc, NovaServiceError) else None, "running": False}

    async def unpair(self) -> dict[str, object]:
        async with self.lock:
            c = self._require_connector()
            await self.stop()
            config = c.STATE / "device.json"
            try:
                if await asyncio.to_thread(config.exists):
                    data = json.loads(await asyncio.to_thread(config.read_text, encoding="utf-8"))
                    await asyncio.to_thread(_clear_binding, c, config, data)
                device = await asyncio.to_thread(c.identity)
            except Exception as exc:
                raise NovaServiceError(502, "本机 Nova 绑定清理未完成，请重试") from exc
            self.pending = None
            self.error = None
            self.error_detail = None
            self.paused = False
            return {"paired": False, "device": device}

    async def start_pair(self, read_name: Callable[[], Awaitable[str]]) -> dict[str, object]:
        async with self.lock:
            c = self._require_connector()
            if await asyncio.to_thread((c.STATE / "device.json").exists):
                raise NovaServiceError(409, "Already paired; revoke the device in Nova before rebinding")
            # Preserve conflict precedence without moving HTTP parsing into the service.
            name = await read_name()
            async with c.aiohttp.ClientSession(timeout=c.aiohttp.ClientTimeout(total=20)) as http:
                async with http.post(PUBLIC + "/v1/agent/pair/start", json={"name": name}) as response:
                    response.raise_for_status()
                    data = await response.json()
            self.pending = {**data, "name": name}
            return {"code": data["code"], "confirm_url": PUBLIC + "/devices", "device": await asyncio.to_thread(c.identity)}

    async def finish_pair(self) -> dict[str, object]:
        async with self.lock:
            c = self._require_connector()
            if not self.pending:
                raise NovaServiceError(409, "Start pairing first")
            p = self.pending
            async with c.aiohttp.ClientSession(timeout=c.aiohttp.ClientTimeout(total=20)) as http:
                async with http.post(
                    PUBLIC + "/v1/agent/pair/poll",
                    json={"code": p["code"], "secret": p["secret"]},
                ) as response:
                    response.raise_for_status()
                    approved = await response.json()
                if approved.get("status") != "approved":
                    raise NovaServiceError(409, "Approve the pairing code in your Nova account first")
                token = secrets.token_urlsafe(48)
                async with http.post(
                    PUBLIC + "/v1/agent/pair/finish",
                    json={"code": p["code"], "secret": p["secret"], "token": token, "device_id": await asyncio.to_thread(c.identity)},
                ) as response:
                    if response.status != 200:
                        raise NovaServiceError(response.status, (await response.text())[:200])
                    done = await response.json()
            await asyncio.to_thread(c.save_pair, PUBLIC, done["device"], p["name"], token)
            self.pending = None
            self.error = None
            self.error_detail = None
            self.paused = False
            await self.stop()
            await self.start()
            return {"paired": True, "device": done["device"]}

    async def reconnect(self) -> dict[str, object]:
        async with self.lock:
            self.paused = False
            await self.stop()
            self.error = None
            self.error_detail = None
            await self.start()
            return await asyncio.to_thread(self.snapshot)

    async def pause(self) -> dict[str, object]:
        async with self.lock:
            self.paused = True
            await self.stop()
            return await asyncio.to_thread(self.snapshot)

    async def resume(self) -> dict[str, object]:
        async with self.lock:
            self.paused = False
            self.error = None
            self.error_detail = None
            await self.start()
            return await asyncio.to_thread(self.snapshot)

    async def account_action(
        self,
        *,
        username: str,
        password: str,
        name: str = "GA-Hub",
        invite: str | None = None,
        confirm: bool = False,
        unlink: bool = False,
    ) -> dict[str, object]:
        if not confirm:
            raise NovaServiceError(400, "请先确认远程操作授权或撤销操作")
        async with self.lock:
            c = self._require_connector()
            config = c.STATE / "device.json"
            if (await asyncio.to_thread(config.exists)) != unlink:
                raise NovaServiceError(409, "请先撤销已有绑定" if not unlink else "本机尚未绑定")
            async with c.aiohttp.ClientSession(timeout=c.aiohttp.ClientTimeout(total=30)) as http:
                async def post(path: str, *, form=None, payload=None, json_result: bool = False):
                    async with http.post(
                        PUBLIC + path,
                        data=form,
                        json=payload,
                        headers={"Origin": PUBLIC},
                        allow_redirects=False,
                    ) as response:
                        if response.status not in (200, 302, 303):
                            raise NovaServiceError(502, "Nova请求失败，请检查账号密码、邀请码、网络或稍后重试")
                        if path in ("/login", "/register") and response.status == 200:
                            raise NovaServiceError(401, "账号登录或注册未成功")
                        return await response.json() if json_result else None

                try:
                    auth = {"name": username.strip(), "password": password}
                    if invite and not unlink:
                        auth["invite"] = invite
                    await post("/register" if "invite" in auth else "/login", form=auth)
                    if unlink:
                        async with http.get(PUBLIC + "/v1/me") as response:
                            response.raise_for_status()
                            devices = await response.json()
                        rows = devices.get("devices", [])
                        data = json.loads(await asyncio.to_thread(config.read_text, encoding="utf-8"))
                        device = await asyncio.to_thread(c.identity)
                        owned = next((d for d in rows if d.get("id") == device), None)
                        # Persist confirmed cloud revocation before touching Credential Manager.
                        # /v1/me hides revoked devices; this marker permits a same-owner retry.
                        already_revoked = data.get("revoked_owner") == devices["name"]
                        if owned is None and not already_revoked:
                            raise NovaServiceError(403, "此账号不拥有当前设备，未清除本机绑定")
                        if owned is not None:
                            await post("/v1/devices/" + device + "/revoke", form={})
                            data["revoked_owner"] = devices["name"]
                            await asyncio.to_thread(_save_revocation, config, data)
                        await self.stop()
                        # If credential deletion fails, retain configuration for a safe retry.
                        try:
                            await asyncio.to_thread(_clear_binding, c, config, data)
                        except Exception as exc:
                            raise NovaServiceError(502, "云端已撤销，本机清理未完成；请用同一账号重试") from exc
                    else:
                        pending = await post("/v1/agent/pair/start", payload={"name": name}, json_result=True)
                        await post("/v1/pair/approve", payload={"code": pending["code"]})
                        token = secrets.token_urlsafe(48)
                        done = await post(
                            "/v1/agent/pair/finish",
                            payload={
                                "code": pending["code"],
                                "secret": pending["secret"],
                                "token": token,
                                "device_id": await asyncio.to_thread(c.identity),
                            },
                            json_result=True,
                        )
                        await asyncio.to_thread(c.save_pair, PUBLIC, done["device"], name, token)
                        self.error = None
                        self.error_detail = None
                        self.paused = False
                        await self.stop()
                        await self.start()
                    self.pending = None
                    if unlink:
                        self.error = None
                        self.error_detail = None
                        self.paused = False
                    return await asyncio.to_thread(self.snapshot)
                except NovaServiceError:
                    raise
                except Exception as exc:
                    raise NovaServiceError(502, "Nova操作未完成，请检查网络或本机凭据服务") from exc
                finally:
                    with contextlib.suppress(Exception):
                        await post("/logout", form={})
