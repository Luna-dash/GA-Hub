"""Unified local service status registry for the WebUI dashboard.

Adapts in-process GA-Hub services to one stable panel contract.  This mirrors
the useful registry idea from Bridge without depending on a Bridge process.
Status reads never instantiate optional/heavy services.
"""
from __future__ import annotations

import time
from dataclasses import asdict, dataclass, field
from typing import Any, Callable


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
    _HEALTH_BY_STATE = {
        "running": "healthy",
        "ready": "healthy",
        "stopped": "unavailable",
        "error": "unknown",
    }

    def __init__(self) -> None:
        self._readers: list[Callable[[], ServicePanelItem | None]] = [
            self._agent, self._feishu, self._wechat, self._conductor,
            self._goalhive, self._autonomous, self._tasks,
        ]

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
        """Return a stable health vocabulary derived from one panel snapshot."""
        snapshot = self.panel()
        services = [
            {
                "id": item["id"],
                "status": item.get("health")
                or self._HEALTH_BY_STATE.get(item.get("state"), "unknown"),
                "summary": item["summary"],
            }
            for item in snapshot["services"]
        ]
        statuses = {item["status"] for item in services}
        if not statuses or statuses == {"unknown"}:
            overall = "unknown"
        elif statuses == {"healthy"}:
            overall = "healthy"
        elif statuses == {"unavailable"}:
            overall = "unavailable"
        else:
            overall = "degraded"
        return {"status": overall, "services": services, "timestamp": snapshot["timestamp"]}

    @staticmethod
    def _agent() -> ServicePanelItem:
        from .agent_service import AgentService
        service = AgentService._instance
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

    @staticmethod
    def _feishu() -> ServicePanelItem:
        from .. import _paths
        from .feishu_service import FeishuService
        service = FeishuService._instance
        if service is None:
            script = (
                _paths.GA_ROOT / "frontends" / "fsapp.py"
                if _paths.GA_ROOT is not None else None
            )
            exists = bool(script is not None and script.is_file())
            return ServicePanelItem(
                "feishu", "飞书 Bot", "ready" if exists else "stopped",
                "已配置，当前未运行" if exists else "服务脚本未配置", "/feishu",
            )
        status = service.status()
        exists = bool(status.get("fsapp_exists"))
        return ServicePanelItem(
            "feishu", "飞书 Bot", "running" if status.get("running") else ("ready" if exists else "stopped"),
            "Bot 进程运行中" if status.get("running") else ("已配置，当前未运行" if exists else "服务脚本未配置"), "/feishu",
            {"PID": status.get("pid") or "—", "模式": "外部" if status.get("external") else "内建"},
        )

    @staticmethod
    def _wechat() -> ServicePanelItem | None:
        from .wechat_service import WX_LOG_FILE, WeChatService
        from .wx_bot_client import TOKEN_FILE_DEFAULT

        svc = WeChatService._instance
        persisted = any(
            path.is_file() and path.stat().st_size > 0
            for path in (TOKEN_FILE_DEFAULT, WX_LOG_FILE)
        )
        if svc is None:
            if not persisted:
                return None
            return ServicePanelItem(
                "wechat", "微信 Bot", "stopped", "已连接过，当前未运行", "/feishu",
            )

        status = svc.status()
        connected = bool(
            persisted or status.get("logged_in") or status.get("polling")
            or status.get("contacts") or status.get("log_count")
        )
        if not connected:
            return None
        active = bool(status.get("polling"))
        return ServicePanelItem(
            "wechat", "微信 Bot", "running" if active else "stopped",
            "消息轮询中" if active else "已连接过，当前未运行", "/feishu",
            {"联系人": status.get("contacts", 0), "日志": status.get("log_count", 0)},
        )

    @staticmethod
    def _conductor() -> ServicePanelItem:
        from .conductor_service import ConductorService
        svc = ConductorService._instance
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

    @staticmethod
    def _goalhive() -> ServicePanelItem:
        from . import goalhive_service
        svc = goalhive_service._service
        if svc is None:
            return ServicePanelItem("goalhive", "Goal / Hive", "stopped", "尚未启用", "/goal-hive")
        running = svc.is_running()
        return ServicePanelItem(
            "goalhive", "Goal / Hive", "running" if running else "stopped",
            "独立 Agent 正在执行" if running else "当前未运行", "/goal-hive",
            {"消息": len(svc.get_messages())},
        )

    @staticmethod
    def _autonomous() -> ServicePanelItem:
        from .autonomous_scheduler import AutonomousScheduler
        svc = AutonomousScheduler._instance
        if svc is None:
            return ServicePanelItem("autonomous", "自主进化", "stopped", "调度器尚未初始化", "/autonomous")
        running = bool(svc._sched.running and not svc._stop_event.is_set())
        enabled = sum(1 for item in svc.schedules.values() if item.enabled)
        expected = enabled > 0
        needs_attention = expected and not running
        return ServicePanelItem(
            "autonomous", "自主进化", "running" if running else "stopped",
            ("调度器运行中" if running else
             "已启用计划，但调度器已停止" if needs_attention else "当前没有运行计划"),
            "/autonomous", {"计划": len(svc.schedules), "启用": enabled},
            health="attention" if needs_attention else "healthy",
            expected_running=expected,
        )

    @staticmethod
    def _tasks() -> ServicePanelItem:
        from .task_scheduler import TaskScheduler
        svc = TaskScheduler._instance
        if svc is None:
            return ServicePanelItem("task_scheduler", "定时任务", "stopped", "调度器尚未初始化", "/tasks")
        running = bool(svc._sched.running)
        enabled = sum(1 for item in svc.schedules.values() if item.enabled)
        expected = enabled > 0
        needs_attention = expected and not running
        return ServicePanelItem(
            "task_scheduler", "定时任务", "running" if running else "stopped",
            ("调度器运行中" if running else
             "已启用计划，但调度器已停止" if needs_attention else "当前没有运行计划"),
            "/tasks", {"计划": len(svc.schedules), "启用": enabled},
            health="attention" if needs_attention else "healthy",
            expected_running=expected,
        )


registry = ServiceRegistry()
