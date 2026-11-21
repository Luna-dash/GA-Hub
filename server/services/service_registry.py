"""Unified local service status registry for the WebUI dashboard.

Adapts in-process GA-Hub services to one stable panel contract.  This mirrors
the useful registry idea from Bridge without depending on a Bridge process.
Status reads never instantiate optional/heavy services.

An application-bound registry prefers the lifespan-owned instances recorded
in ``AppServices`` (agent, feishu, scheduler host) so ``/api/status``,
``/api/health`` and ``/api/services/panel`` observe the same objects during
partial startup/teardown. The module-global ``registry`` stays as a
compatibility seam for tests and unbound callers, including Goal/Hive
when it has not yet been registered with the app.
"""
from __future__ import annotations

import time
from dataclasses import asdict, dataclass, field
from typing import TYPE_CHECKING, Any, Callable

if TYPE_CHECKING:  # pragma: no cover - runtime imports stay minimal
    from .app_services import AppServices
    from .nova_service import NovaService
    from .scheduler_domain_base import SchedulerDomainBase
    from .session_lifecycle import SessionLifecycle


@dataclass
class ServicePanelItem:
    id: str
    name: str
    state: str
    summary: str
    href: str
    metrics: dict[str, Any] = field(default_factory=dict)
    error: str | None = None
    activity: str = ""
    health: str = ""
    expected_running: bool = False

    def __post_init__(self) -> None:
        """Keep the legacy state while exposing unambiguous UI semantics."""
        if not self.activity:
            self.activity = {
                "running": "active",
                "ready": "standby",
                "stopped": "inactive",
                "error": "inactive",
            }.get(self.state, "inactive")
        if not self.health:
            self.health = "unknown" if self.state == "error" else "healthy"


class ServiceRegistry:
    def __init__(
        self, services: "AppServices | None" = None,
        *, sessions: "SessionLifecycle | None" = None, nova: "NovaService | None" = None,
    ) -> None:
        # Lifespan-owned instances win over singleton probes when present.
        self._services = services
        self._sessions = sessions
        self._nova_component = nova
        self._readers: list[Callable[[], ServicePanelItem | None]] = [
            self._agent, self._feishu, self._conductor,
            self._goalhive, self._anti, self._autonomous, self._tasks,
        ]
        if nova is not None:
            self._readers.append(self._nova)

    def _nova(self) -> ServicePanelItem | None:
        if self._nova_component is None:
            return None
        name = 'Nova 连通器'
        try:
            status = self._nova_component.runtime_status()
        except OSError:
            return ServicePanelItem('nova', name, 'error', '无法读取本机绑定状态', '/dashboard')
        paired = status['paired']
        if status['error']:
            return ServicePanelItem('nova', name, 'error', '连通器异常，请检查远程连接设置', '/dashboard',
                                    health='attention' if paired else 'unknown', expected_running=bool(paired))
        if paired is None:
            return ServicePanelItem('nova', name, 'error', '状态尚未读取', '/dashboard')
        if not paired:
            return ServicePanelItem('nova', name, 'stopped', '未绑定 Nova 账号', '/dashboard')
        if status['connected']:
            return ServicePanelItem('nova', name, 'running', '已连接 Nova 云端', '/dashboard',
                                    expected_running=True)
        if status['running']:
            return ServicePanelItem('nova', name, 'ready', '正在连接或重试', '/dashboard',
                                    health='attention', expected_running=True)
        return ServicePanelItem('nova', name, 'stopped', '已绑定，连通器未运行', '/dashboard',
                                health='attention', expected_running=True)

    def _owned_services(self) -> "AppServices | None":
        return self._services

    def panel(self) -> dict[str, Any]:
        items: list[ServicePanelItem] = []
        for reader in self._readers:
            try:
                item = reader()
                if item is not None:
                    items.append(item)
            except Exception as exc:
                name = reader.__name__.lstrip("_").replace("goalhive", "Goal / Hive")
                items.append(ServicePanelItem(name, name, "error", "状态读取失败", "/dashboard", error=str(exc)))
        return {"services": [asdict(item) for item in items], "timestamp": int(time.time())}

    def health_summary(self) -> dict[str, Any]:
        """Return a stable health vocabulary derived from one panel snapshot.

        Every real panel item fills ``health`` in ``__post_init__``
        (healthy / attention / unknown); ``stopped`` items count as healthy —
        an inactive optional service is not an incident. The process-level
        ``unavailable`` verdict lives in ``/api/health`` (core-contract gate),
        not here.
        """
        snapshot = self.panel()
        services = [
            {
                "id": item["id"],
                "status": item.get("health") or "unknown",
                "summary": item["summary"],
            }
            for item in snapshot["services"]
        ]
        statuses = {item["status"] for item in services}
        if not statuses or statuses == {"unknown"}:
            overall = "unknown"
        elif statuses == {"healthy"}:
            overall = "healthy"
        else:
            overall = "degraded"
        return {"status": overall, "services": services, "timestamp": snapshot["timestamp"]}

    def _agent(self) -> ServicePanelItem:
        if self._sessions is not None:
            return self._session_activity()
        from .agent_service import AgentService
        service = getattr(self._owned_services(), "agent", None) or AgentService.peek_instance()
        if service is None:
            return ServicePanelItem(
                "agent", "Agent", "stopped", "服务尚未初始化", "/chat",
                health="attention", expected_running=True,
            )
        status = service.status()
        return ServicePanelItem(
            "agent", "Agent", "running" if status.is_running else "ready",
            "正在执行任务" if status.is_running else "等待任务", "/chat",
            {"LLM": status.llm_name, "队列": status.queued_tasks, "上下文": status.history_lines},
            expected_running=True,
        )

    def _session_activity(self) -> ServicePanelItem:
        from .core_contract import CoreRuntimeUnavailable
        from .session_runtime_status import STATUS_STARTING, STATUS_RUNNING, STATUS_ABORTING, STATUS_ERROR

        try:
            self._sessions.assert_runtime_available()
        except CoreRuntimeUnavailable as exc:
            return ServicePanelItem(
                "agent", "Agent", "error", str(exc), "/settings",
                health="attention", expected_running=True,
            )
        states = self._sessions.runtime_states()
        starting = sum(state.status == STATUS_STARTING for state in states)
        running = sum(state.status == STATUS_RUNNING for state in states)
        aborting = sum(state.status == STATUS_ABORTING for state in states)
        errors = sum(state.status == STATUS_ERROR for state in states)
        active = starting + running + aborting
        summary = f"{active} 个会话正在执行" if active else "等待任务"
        if errors:
            summary += f"；{errors} 个会话异常"
        return ServicePanelItem(
            "agent", "Agent", "running" if active else "ready", summary, "/chat",
            {"运行中": running, "启动中": starting, "停止中": aborting, "异常": errors},
            health="attention" if errors else "healthy", expected_running=True,
        )

    def _feishu(self) -> ServicePanelItem:
        from .. import _paths
        from .feishu_service import FeishuService
        service = getattr(self._owned_services(), "feishu", None) or FeishuService.peek_instance()
        if service is None:
            script = (
                _paths.ga_fsapp_path()
                if _paths.GA_ROOT is not None else None
            )
            exists = bool(script is not None and script.is_file())
            return ServicePanelItem(
                "feishu", "飞书 Bot", "ready" if exists else "stopped",
                "已配置，当前未运行" if exists else "服务脚本未配置", "/dashboard",
            )
        status = service.status()
        exists = bool(status.get("fsapp_exists"))
        running = bool(status.get("running"))
        autostart_state = status.get("autostart_state")
        autostart_error = status.get("autostart_error")
        autostart_remaining = status.get("autostart_remaining_seconds")

        if running:
            state = "running"
            summary = "Bot 进程运行中"
            health = "healthy"
            err = None
        elif autostart_state == "starting":
            state = "ready"
            summary = "正在自动启动…"
            health = "healthy"
            err = None
        elif autostart_state == "waiting" and exists:
            state = "ready"
            summary = (
                f"等待自动启动（约 {autostart_remaining}s 后）"
                if isinstance(autostart_remaining, int) and autostart_remaining > 0
                else "等待自动启动…"
            )
            health = "healthy"
            err = None
        elif autostart_state == "failed" and autostart_error:
            state = "error"
            err = str(autostart_error)
            summary = f"自动启动失败：{err}"
            health = "attention"
        else:
            state = "ready" if exists else "stopped"
            summary = "已配置，当前未运行" if exists else "服务脚本未配置"
            health = "healthy"
            err = None

        return ServicePanelItem(
            "feishu", "飞书 Bot", state, summary, "/dashboard",
            {"PID": status.get("pid") or "—", "模式": "外部" if status.get("external") else "内建"},
            error=err,
            health=health,
        )

    def _conductor(self) -> ServicePanelItem:
        from .conductor_service import ConductorService
        svc = getattr(self._owned_services(), "conductor", None) or ConductorService.peek_instance()
        if svc is None:
            return ServicePanelItem("conductor", "Conductor", "stopped", "尚未启用", "/conductor")
        running, stopped = svc.pool.counts()
        lifecycle_status = getattr(svc, "lifecycle_status", None)
        if callable(lifecycle_status):
            started = bool(lifecycle_status()["started"])
        else:
            started = bool(getattr(svc, "_started", False))
        return ServicePanelItem(
            "conductor", "Conductor", "running" if started else "stopped",
            "编排器运行中" if started else "当前未运行", "/conductor",
            {"子 Agent": running, "已停止": stopped, "消息": len(svc.chat_messages)},
        )

    def _goalhive(self=None) -> ServicePanelItem:
        from . import goalhive_service

        owned = getattr(self._owned_services(), "goalhive", None) if self is not None else None
        status = goalhive_service.peek_goalhive_status(owned)
        if status is None:
            return ServicePanelItem("goalhive", "Goal / Hive", "stopped", "尚未启用", "/goal-hive")
        running = bool(status.get("running"))
        return ServicePanelItem(
            "goalhive", "Goal / Hive", "running" if running else "stopped",
            "独立 Agent 正在执行" if running else "当前未运行", "/goal-hive",
            {"消息": status.get("message_count", 0)},
        )

    @staticmethod
    def _anti() -> ServicePanelItem:
        from .anti_daemon import daemon
        from .anti_engine import AntiError

        try:
            status = daemon.panel_status()
        except AntiError as exc:
            return ServicePanelItem(
                "anti", "Agy ACP", "error", str(exc), "/anti",
                error=str(exc), health="attention",
            )

        if status.state == "ready":
            if status.agy_available is False:
                msg = status.detail or "找不到官方 agy CLI"
                return ServicePanelItem(
                    "anti", "Agy ACP", "error", msg, "/anti",
                    error=msg, health="attention",
                )
            active = status.active_count or 0
            summary = f"ACP 就绪（{active} 个运行中任务）" if active > 0 else "ACP 就绪，按需拉起会话"
            metrics = {"运行任务": active}
            if status.version:
                metrics["版本"] = status.version
            return ServicePanelItem(
                "anti", "Agy ACP", "running", summary, "/anti",
                metrics,
            )

        if status.state == "starting":
            return ServicePanelItem(
                "anti", "Agy ACP", "ready",
                status.detail or "正在初始化 Agy ACP…", "/anti",
            )

        if status.state == "unavailable":
            msg = status.detail or "Agy ACP 不可用"
            return ServicePanelItem(
                "anti", "Agy ACP", "error", msg, "/anti",
                error=msg, health="attention",
            )

        if status.detail:
            return ServicePanelItem(
                "anti", "Agy ACP", "stopped", status.detail, "/anti",
            )

        return ServicePanelItem(
            "anti", "Agy ACP", "stopped", "按需启动，当前未运行", "/anti",
        )

    def _scheduler_service(self, domain: str) -> "SchedulerDomainBase | None":
        """Return the app-owned scheduler domain without constructing it."""
        services = self._owned_services()
        host = services.scheduler_host if services is not None else None
        return host.service_of(domain) if host is not None else None

    @staticmethod
    def _scheduler_panel(
        service_id: str,
        name: str,
        href: str,
        svc: "SchedulerDomainBase | None",
    ) -> ServicePanelItem:
        if svc is None:
            return ServicePanelItem(service_id, name, "stopped", "调度器尚未初始化", href)
        status = svc.panel_status()
        running = status["running"]
        total = status["total"]
        enabled = status["enabled"]
        expected = enabled > 0
        needs_attention = expected and not running
        return ServicePanelItem(
            service_id, name, "running" if running else "stopped",
            ("调度器运行中" if running else
             "已启用计划，但调度器已停止" if needs_attention else "当前没有运行计划"),
            href, {"计划": total, "启用": enabled},
            health="attention" if needs_attention else "healthy",
            expected_running=expected,
        )

    def _autonomous(self) -> ServicePanelItem:
        from .autonomous_scheduler import AutonomousScheduler
        svc = self._scheduler_service("autonomous") or AutonomousScheduler.peek_instance()
        return self._scheduler_panel("autonomous", "自主进化", "/autonomous", svc)

    def _tasks(self) -> ServicePanelItem:
        from .task_scheduler import TaskScheduler
        svc = self._scheduler_service("tasks") or TaskScheduler.peek_instance()
        return self._scheduler_panel("task_scheduler", "定时任务", "/tasks", svc)


registry = ServiceRegistry()
