from types import SimpleNamespace
from unittest import mock

from server.services.service_registry import ServicePanelItem, ServiceRegistry


def test_autonomous_panel_uses_stop_event_and_reports_running() -> None:
    service = SimpleNamespace(
        _sched=SimpleNamespace(running=True),
        _stop_event=mock.Mock(),
        schedules={"active": SimpleNamespace(enabled=True)},
    )
    service._stop_event.is_set.return_value = False

    with mock.patch("server.services.autonomous_scheduler.AutonomousScheduler._instance", service):
        item = ServiceRegistry()._autonomous()

    assert item.state == "running"
    assert item.activity == "active"
    assert item.health == "healthy"
    assert item.expected_running is True
    assert item.metrics == {"计划": 1, "启用": 1}
    service._stop_event.is_set.assert_called_once_with()


def test_stopped_scheduler_only_needs_attention_when_a_plan_is_enabled() -> None:
    service = SimpleNamespace(
        _sched=SimpleNamespace(running=False),
        schedules={"daily": SimpleNamespace(enabled=True)},
    )

    with mock.patch("server.services.task_scheduler.TaskScheduler._instance", service):
        item = ServiceRegistry()._tasks()

    assert item.activity == "inactive"
    assert item.health == "attention"
    assert item.expected_running is True
    assert item.summary == "已启用计划，但调度器已停止"


def test_inactive_optional_service_does_not_degrade_overall_health() -> None:
    items = [
        ServicePanelItem("agent", "Agent", "ready", "等待任务", "/chat", expected_running=True),
        ServicePanelItem("optional", "可选服务", "stopped", "尚未启用", "/optional"),
    ]
    registry = ServiceRegistry()

    with mock.patch.object(registry, "panel", return_value={
        "services": [item.__dict__ for item in items],
        "timestamp": 1,
    }):
        summary = registry.health_summary()

    assert summary["status"] == "healthy"
    assert [item["status"] for item in summary["services"]] == ["healthy", "healthy"]


def test_panel_omits_hidden_service() -> None:
    registry = ServiceRegistry()
    registry._readers = [
        lambda: None,
        lambda: ServicePanelItem("visible", "Visible", "stopped", "尚未启用", "/visible"),
    ]

    panel = registry.panel()

    assert [item["id"] for item in panel["services"]] == ["visible"]


def test_wechat_is_hidden_until_it_has_really_connected(tmp_path) -> None:
    token_file = tmp_path / "token.json"
    log_file = tmp_path / "wechat_log.jsonl"

    with (
        mock.patch("server.services.wechat_service.WeChatService._instance", None),
        mock.patch("server.services.wechat_service.WX_LOG_FILE", log_file),
        mock.patch("server.services.wx_bot_client.TOKEN_FILE_DEFAULT", token_file),
    ):
        assert ServiceRegistry()._wechat() is None
        token_file.write_text("persisted", encoding="utf-8")
        item = ServiceRegistry()._wechat()

    assert item is not None
    assert item.state == "stopped"
    assert item.summary == "已连接过，当前未运行"
    assert item.href == "/dashboard"


def test_wechat_running_instance_is_visible_without_persisted_files(tmp_path) -> None:
    service = mock.Mock()
    service.status.return_value = {
        "logged_in": True,
        "polling": True,
        "contacts": 0,
        "log_count": 0,
    }

    with (
        mock.patch("server.services.wechat_service.WeChatService._instance", service),
        mock.patch("server.services.wechat_service.WX_LOG_FILE", tmp_path / "missing-log"),
        mock.patch("server.services.wx_bot_client.TOKEN_FILE_DEFAULT", tmp_path / "missing-token"),
    ):
        item = ServiceRegistry()._wechat()

    assert item is not None
    assert item.state == "running"
    assert item.summary == "消息轮询中"
    assert item.href == "/dashboard"


def test_conductor_and_goalhive_share_inactive_semantics_before_use() -> None:
    with (
        mock.patch("server.services.conductor_service.ConductorService._instance", None),
        mock.patch("server.services.goalhive_service._service", None),
    ):
        conductor = ServiceRegistry()._conductor()
        goalhive = ServiceRegistry._goalhive()

    assert (conductor.state, conductor.summary) == ("stopped", "尚未启用")
    assert (goalhive.state, goalhive.summary) == ("stopped", "尚未启用")


def test_conductor_and_goalhive_share_inactive_semantics_when_idle() -> None:
    conductor_service = SimpleNamespace(
        _started=False,
        pool=SimpleNamespace(counts=lambda: (0, 0)),
        chat_messages=[],
    )
    goalhive_service = SimpleNamespace(
        is_running=lambda: False,
        get_messages=lambda: [],
    )

    with (
        mock.patch("server.services.conductor_service.ConductorService._instance", conductor_service),
        mock.patch("server.services.goalhive_service._service", goalhive_service),
    ):
        conductor = ServiceRegistry()._conductor()
        goalhive = ServiceRegistry._goalhive()

    assert (conductor.state, conductor.summary) == ("stopped", "当前未运行")
    assert (goalhive.state, goalhive.summary) == ("stopped", "当前未运行")


def test_conductor_panel_uses_live_lifecycle_instead_of_cached_started() -> None:
    lifecycle_status = mock.Mock(return_value={"started": False})
    conductor_service = SimpleNamespace(
        _started=True,
        lifecycle_status=lifecycle_status,
        pool=SimpleNamespace(counts=lambda: (0, 1)),
        chat_messages=[],
    )

    with mock.patch(
        "server.services.conductor_service.ConductorService._instance",
        conductor_service,
    ):
        conductor = ServiceRegistry()._conductor()

    assert (conductor.state, conductor.summary) == ("stopped", "当前未运行")
    lifecycle_status.assert_called_once_with()


def test_agent_and_feishu_status_readers_never_construct_services(tmp_path) -> None:
    from server import _paths
    from server.services.agent_service import AgentService
    from server.services.feishu_service import FeishuService

    agent_factory = mock.Mock(side_effect=AssertionError("status must not construct Agent"))
    feishu_factory = mock.Mock(side_effect=AssertionError("status must not construct Feishu"))

    with (
        mock.patch.object(_paths, "GA_ROOT", tmp_path),
        mock.patch.object(AgentService, "_instance", None),
        mock.patch.object(AgentService, "instance", agent_factory),
        mock.patch.object(FeishuService, "_instance", None),
        mock.patch.object(FeishuService, "instance", feishu_factory),
    ):
        agent = ServiceRegistry()._agent()
        feishu = ServiceRegistry()._feishu()

    assert (agent.state, agent.health, agent.summary) == (
        "stopped", "attention", "服务尚未初始化",
    )
    assert (feishu.state, feishu.summary) == ("stopped", "服务脚本未配置")
    assert feishu.href == "/dashboard"
    agent_factory.assert_not_called()
    feishu_factory.assert_not_called()


def test_app_bound_registry_prefers_owned_services_over_singletons(tmp_path) -> None:
    """Ownership binding: the lifespan-owned instance wins over class singletons,
    so /api/status, /api/health and /api/services/panel cannot disagree."""
    from server import _paths
    from server.services.agent_service import AgentService
    from server.services.app_services import AppServices

    owned_status = SimpleNamespace(is_running=True, llm_name="owned-model", queued_tasks=1, history_lines=7)
    owned_agent = mock.Mock()
    owned_agent.status.return_value = owned_status
    singleton_agent = mock.Mock()
    singleton_agent.status.return_value = SimpleNamespace(
        is_running=False, llm_name="singleton-model", queued_tasks=0, history_lines=0
    )

    services = AppServices(agent=owned_agent)
    bound = ServiceRegistry(services)
    unbound = ServiceRegistry()

    with (
        mock.patch.object(_paths, "GA_ROOT", tmp_path),
        mock.patch.object(AgentService, "_instance", singleton_agent),
        mock.patch.object(AgentService, "instance", mock.Mock(side_effect=AssertionError("must not construct"))),
    ):
        owned_item = bound._agent()
        singleton_item = unbound._agent()

    assert owned_item.metrics["LLM"] == "owned-model"
    assert owned_item.state == "running"
    assert singleton_item.metrics["LLM"] == "singleton-model"


def test_scheduler_domain_reader_prefers_the_host_registration() -> None:
    from server.services.app_services import AppServices

    host_service = SimpleNamespace(
        _sched=SimpleNamespace(running=True),
        _stop_event=mock.Mock(),
        schedules={"host-plan": SimpleNamespace(enabled=True)},
    )
    host_service._stop_event.is_set.return_value = False
    singleton_service = SimpleNamespace(
        _sched=SimpleNamespace(running=False),
        schedules={"stale": SimpleNamespace(enabled=True)},
    )
    host = SimpleNamespace(
        _registrations=[SimpleNamespace(name="autonomous", service=host_service)],
    )

    bound = ServiceRegistry(AppServices(scheduler_host=host))

    with mock.patch(
        "server.services.autonomous_scheduler.AutonomousScheduler._instance", singleton_service
    ):
        item = bound._autonomous()

    assert item.state == "running"
    assert item.metrics == {"计划": 1, "启用": 1}

    # Without an owner, the singleton fallback keeps the legacy behavior.
    unbound = ServiceRegistry()
    with mock.patch(
        "server.services.autonomous_scheduler.AutonomousScheduler._instance", singleton_service
    ):
        item = unbound._autonomous()
    assert item.state == "stopped"


def test_cleared_app_services_do_not_degrade_to_stale_owned_references() -> None:
    """After lifespan teardown clears AppServices, readers fall back to the
    singleton probes (which report 'not initialized') instead of observing
    a torn-down instance."""
    from server.services.agent_service import AgentService
    from server.services.app_services import AppServices

    services = AppServices(agent=mock.Mock())
    bound = ServiceRegistry(services)
    services.clear()

    with (
        mock.patch.object(AgentService, "_instance", None),
        mock.patch.object(AgentService, "instance", mock.Mock(side_effect=AssertionError("must not construct"))),
    ):
        item = bound._agent()

    assert (item.state, item.summary) == ("stopped", "服务尚未初始化")


def test_services_panel_route_reads_the_app_bound_registry() -> None:
    """The route prefers app.state.service_registry and falls back to the
    module global only for unbound apps."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from server.routes.services import service_panel
    from server.services.service_registry import registry as global_registry

    app = FastAPI()
    app.router.routes.clear()
    app.add_api_route("/api/services/panel", service_panel, methods=["GET"])
    client = TestClient(app)

    marker = {"services": [{"id": "marker", "name": "Marker", "state": "running", "summary": "bound",
                            "href": "/chat", "metrics": {}, "error": None, "activity": "inactive",
                            "health": "healthy", "expected_running": False}], "timestamp": 1}
    bound_registry = mock.Mock(spec=ServiceRegistry)
    bound_registry.panel.return_value = marker

    app.state.service_registry = bound_registry
    with client:
        response = client.get("/api/services/panel")
    assert response.status_code == 200
    assert response.json()["services"][0]["id"] == "marker"
    bound_registry.panel.assert_called_once()

    del app.state.service_registry
    with mock.patch.object(global_registry, "panel", return_value=marker):
        with client:
            response = client.get("/api/services/panel")
    assert response.status_code == 200
    assert response.json()["services"][0]["id"] == "marker"
