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


class ServiceRegistry:
    _HEALTH_BY_STATE = {
        "running": "healthy",
        "ready": "healthy",
        "stopped": "unavailable",
        "error": "unknown",
    }

    def __init__(self) -> None:
        self._readers: list[Callable[[], ServicePanelItem]] = [
            self._agent, self._feishu, self._wechat, self._conductor,
            self._goalhive, self._autonomous, self._tasks,
        ]

    def panel(self) -> dict[str, Any]:
        items: list[ServicePanelItem] = []
        for reader in self._readers:
            try:
                items.append(reader())
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
                "status": self._HEALTH_BY_STATE.get(item["state"], "unknown"),
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
        status = AgentService.instance().status()
        return ServicePanelItem(
            "agent", "Agent", "running" if status.is_running else "ready",
            "正在执行任务" if status.is_running else "等待任务", "/chat",
            {"LLM": status.llm_name, "队列": status.queued_tasks, "上下文": status.history_lines},
        )

    @staticmethod
    def _feishu() -> ServicePanelItem:
        from .feishu_service import FeishuService
        status = FeishuService.instance().status()
        exists = bool(status.get("fsapp_exists"))
        return ServicePanelItem(
            "feishu", "飞书 Bot", "running" if status.get("running") else ("ready" if exists else "stopped"),
            "Bot 进程运行中" if status.get("running") else ("已配置，当前未运行" if exists else "服务脚本未配置"), "/feishu",
            {"PID": status.get("pid") or "—", "模式": "外部" if status.get("external") else "内建"},
        )

    @staticmethod
    def _wechat() -> ServicePanelItem:
        from .wechat_service import WeChatService
        svc = WeChatService._instance
        if svc is None:
            return ServicePanelItem("wechat", "微信 Bot", "stopped", "服务尚未初始化", "/feishu")
        status = svc.status()
        active = bool(status.get("polling"))
        return ServicePanelItem(
            "wechat", "微信 Bot", "running" if active else ("ready" if status.get("logged_in") else "stopped"),
            "消息轮询中" if active else ("已登录，轮询未启动" if status.get("logged_in") else "等待扫码登录"), "/feishu",
            {"联系人": status.get("contacts", 0), "日志": status.get("log_count", 0)},
        )

    @staticmethod
    def _conductor() -> ServicePanelItem:
        from .conductor_service import ConductorService
        svc = ConductorService._instance
        if svc is None:
            return ServicePanelItem("conductor", "Conductor", "stopped", "尚未启动", "/conductor")
        running, stopped = svc.pool.counts()
        return ServicePanelItem(
            "conductor", "Conductor", "running" if svc._started else "stopped",
            "编排器运行中" if svc._started else "编排器已停止", "/conductor",
            {"子 Agent": running, "已停止": stopped, "消息": len(svc.chat_messages)},
        )

    @staticmethod
    def _goalhive() -> ServicePanelItem:
        from . import goalhive_service
        svc = goalhive_service._service
        if svc is None:
            return ServicePanelItem("goalhive", "Goal / Hive", "ready", "按需启动，尚无会话", "/goal-hive")
        running = svc.is_running()
        return ServicePanelItem(
            "goalhive", "Goal / Hive", "running" if running else "ready",
            "独立 Agent 正在执行" if running else "独立 Agent 就绪", "/goal-hive",
            {"消息": len(svc.get_messages())},
        )

    @staticmethod
    def _autonomous() -> ServicePanelItem:
        from .autonomous_scheduler import AutonomousScheduler
        svc = AutonomousScheduler._instance
        if svc is None:
            return ServicePanelItem("autonomous", "自主进化", "stopped", "调度器尚未初始化", "/autonomous")
        running = bool(svc._sched.running and not svc._stop)
        enabled = sum(1 for item in svc.schedules.values() if item.enabled)
        return ServicePanelItem(
            "autonomous", "自主进化", "running" if running else "stopped",
            "调度器运行中" if running else "调度器已停止", "/autonomous",
            {"计划": len(svc.schedules), "启用": enabled},
        )

    @staticmethod
    def _tasks() -> ServicePanelItem:
        from .task_scheduler import TaskScheduler
        svc = TaskScheduler._instance
        if svc is None:
            return ServicePanelItem("task_scheduler", "定时任务", "stopped", "调度器尚未初始化", "/tasks")
        running = bool(svc._sched.running)
        enabled = sum(1 for item in svc.schedules.values() if item.enabled)
        return ServicePanelItem(
            "task_scheduler", "定时任务", "running" if running else "stopped",
            "调度器运行中" if running else "调度器已停止", "/tasks",
            {"计划": len(svc.schedules), "启用": enabled},
        )


registry = ServiceRegistry()
