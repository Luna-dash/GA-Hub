from types import SimpleNamespace
from unittest import mock

from server.services.service_registry import ServicePanelItem, ServiceRegistry


def test_session_panel_does_not_construct_idle_runtimes(session_domain) -> None:
    registry = ServiceRegistry(sessions=session_domain)
    with mock.patch.object(session_domain, "runtime_factory", side_effect=AssertionError("status created runtime")):
        assert registry._agent().state == "ready"
        assert registry._agent().summary == "等待任务"
        assert session_domain.peek_coordinator() is None
        session_domain.begin_shutdown()
        assert registry._agent().activity == "standby"


def test_session_panel_observes_concurrent_start_run_and_abort(session_domain) -> None:
    import threading
    from concurrent.futures import ThreadPoolExecutor
    from server.services.session_coordinator import SessionCoordinator

    starting = threading.Event()
    release = threading.Event()
    completed = threading.Event()
    handles = {sid: SimpleNamespace(stream_id=sid, finished=False) for sid in ("running", "starting")}

    def runtime_factory(sid):
        if sid == "starting":
            starting.set()
            assert release.wait(5), "test did not release runtime creation"
        return SimpleNamespace(submit=lambda *a, **k: handles[sid], abort=lambda: None,
                               shutdown=lambda **k: True)

    def changed(state):
        if state.session_id == "running" and state.status == "idle":
            completed.set()

    coordinator = SessionCoordinator(runtime_factory, capacity=2, poll_interval=0.001, on_state_change=changed)
    session_domain.attach_coordinator(coordinator)
    registry = ServiceRegistry(sessions=session_domain)
    # An idle legacy singleton must no longer hide session work.
    with mock.patch("server.services.agent_service.AgentService.instance", side_effect=AssertionError("legacy agent read")):
        with ThreadPoolExecutor(max_workers=1) as executor:
            try:
                coordinator.submit("first", session_id="running")
                future = executor.submit(coordinator.submit, "second", session_id="starting")
                assert starting.wait(5)
                item = registry._agent()
                assert item.activity == "active"
                assert item.health == "healthy"
                assert item.metrics == {"运行中": 1, "启动中": 1, "停止中": 0, "异常": 0}
                assert item.summary == "2 个会话正在执行"
                snapshot = session_domain.runtime_states()

                coordinator.abort_if_current(session_id="running")
                assert registry._agent().metrics == {"运行中": 0, "启动中": 1, "停止中": 1, "异常": 0}
                assert next(s for s in snapshot if s.session_id == "running").status == "running"
                handles["running"].finished = True
                assert completed.wait(5)
                assert registry._agent().metrics["停止中"] == 0
                release.set()
                future.result(timeout=5)
                assert registry._agent().metrics["运行中"] == 1
            finally:
                release.set()
                for handle in handles.values():
                    handle.finished = True
                assert coordinator.shutdown(timeout=2)


def test_session_panel_reports_abort_timeout_as_needing_attention(session_domain) -> None:
    import threading
    from server.services.session_coordinator import SessionCoordinator

    failed = threading.Event()
    handle = SimpleNamespace(stream_id="stuck", finished=False)
    runtime = SimpleNamespace(submit=lambda *a, **k: handle, abort=lambda: None,
                              shutdown=lambda **k: True)
    coordinator = SessionCoordinator(
        lambda sid: runtime, poll_interval=0.001, abort_timeout=0,
        on_state_change=lambda state: failed.set() if state.status == "error" else None,
    )
    session_domain.attach_coordinator(coordinator)
    try:
        coordinator.submit("test", session_id="stuck")
        coordinator.abort_if_current(session_id="stuck")
        assert failed.wait(5)
        item = ServiceRegistry(sessions=session_domain)._agent()
        assert item.health == "attention"
        assert item.metrics["异常"] == 1
        assert "1 个会话异常" in item.summary
    finally:
        handle.finished = True
        assert coordinator.shutdown(timeout=2)


def test_autonomous_panel_uses_public_status_and_reports_running() -> None:
    service = SimpleNamespace(panel_status=mock.Mock(return_value={"running": True, "total": 1, "enabled": 1}))

    with mock.patch("server.services.autonomous_scheduler.AutonomousScheduler._instance", service):
        item = ServiceRegistry()._autonomous()

    assert item.state == "running"
    assert item.activity == "active"
    assert item.health == "healthy"
    assert item.expected_running is True
    assert item.metrics == {"计划": 1, "启用": 1}
    service.panel_status.assert_called_once_with()


def test_stopped_scheduler_only_needs_attention_when_a_plan_is_enabled() -> None:
    service = SimpleNamespace(panel_status=lambda: {"running": False, "total": 1, "enabled": 1})

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

    host_service = SimpleNamespace(panel_status=lambda: {"running": True, "total": 1, "enabled": 1})
    singleton_service = SimpleNamespace(panel_status=lambda: {"running": False, "total": 1, "enabled": 1})
    host = SimpleNamespace(service_of=mock.Mock(return_value=host_service))

    bound = ServiceRegistry(AppServices(scheduler_host=host))

    with mock.patch(
        "server.services.autonomous_scheduler.AutonomousScheduler._instance", singleton_service
    ):
        item = bound._autonomous()

    assert item.state == "running"
    assert item.metrics == {"计划": 1, "启用": 1}

    host.service_of.assert_called_once_with("autonomous")

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


def test_feishu_autostart_states_surface_in_registry_panel() -> None:
    from server.services.app_services import AppServices

    feishu = mock.Mock()
    bound = ServiceRegistry(AppServices(feishu=feishu))

    feishu.status.return_value = {
        "running": False,
        "fsapp_exists": True,
        "pid": None,
        "external": False,
        "autostart_state": "waiting",
        "autostart_remaining_seconds": 120,
        "autostart_error": None,
    }
    item = bound._feishu()
    assert (item.state, item.health) == ("ready", "healthy")
    assert item.summary == "等待自动启动（约 120s 后）"

    feishu.status.return_value = {
        "running": False,
        "fsapp_exists": True,
        "pid": None,
        "external": False,
        "autostart_state": "starting",
        "autostart_remaining_seconds": None,
        "autostart_error": None,
    }
    item = bound._feishu()
    assert (item.state, item.summary, item.health) == ("ready", "正在自动启动…", "healthy")

    feishu.status.return_value = {
        "running": False,
        "fsapp_exists": True,
        "pid": None,
        "external": False,
        "autostart_state": "failed",
        "autostart_remaining_seconds": None,
        "autostart_error": "missing app_secret",
    }
    item = bound._feishu()
    assert (item.state, item.health, item.error) == ("error", "attention", "missing app_secret")
    assert item.summary == "自动启动失败：missing app_secret"


def test_goalhive_panel_read_never_constructs_service() -> None:
    from server.services import goalhive_service
    from server.services.app_services import AppServices

    goalhive_factory = mock.Mock(side_effect=AssertionError("status must not construct GoalHive"))

    with (
        mock.patch.object(goalhive_service, "_service", None),
        mock.patch.object(goalhive_service, "get_goalhive_service", goalhive_factory),
    ):
        goalhive_item = ServiceRegistry()._goalhive()

    assert (goalhive_item.state, goalhive_item.summary) == ("stopped", "尚未启用")
    goalhive_factory.assert_not_called()

    owned_goalhive = mock.Mock()
    owned_goalhive.panel_status.return_value = {"running": True, "message_count": 4}
    bound = ServiceRegistry(AppServices(goalhive=owned_goalhive))

    with (
        mock.patch.object(goalhive_service, "_service", None),
    ):
        g_item = bound._goalhive()

    assert (g_item.state, g_item.metrics) == ("running", {"消息": 4})


def test_scheduler_host_service_of_returns_registered_service() -> None:
    from server.services.app_services import AppServices
    from server.services.scheduler_host import SchedulerHost

    host = SchedulerHost(runtime_factory=mock.Mock())
    svc = SimpleNamespace(panel_status=lambda: {"running": True, "total": 1, "enabled": 1})
    host.register("autonomous", lambda: svc, starter="start", stopper="shutdown")
    assert host.service_of("autonomous") is None

    svc.start = mock.Mock()
    svc.shutdown = mock.Mock()
    host.start_all()
    assert host.service_of("autonomous") is svc
    assert host.service_of("missing") is None

    item = ServiceRegistry(AppServices(scheduler_host=host))._autonomous()
    assert (item.state, item.metrics) == ("running", {"计划": 1, "启用": 1})


def test_scheduler_panel_waits_for_schedule_updates() -> None:
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event, Lock

    from server.services.autonomous_scheduler import AutonomousScheduler

    lock = Lock()
    reading = Event()

    class ObservedLock:
        def __enter__(self):
            reading.set()
            return lock.__enter__()

        def __exit__(self, *exc):
            return lock.__exit__(*exc)

    scheduler = object.__new__(AutonomousScheduler)
    scheduler._lock = ObservedLock()
    scheduler._sched = SimpleNamespace(running=True)
    scheduler._stop_event = Event()
    scheduler.schedules = {"disabled": SimpleNamespace(enabled=False)}
    registry = ServiceRegistry()
    registry._readers = (registry._autonomous,)

    def read_panel():
        try:
            return registry.panel()["services"][0]
        finally:
            # Also signal if a reader bypasses the lock and completes early.
            reading.set()

    with mock.patch.object(AutonomousScheduler, "_instance", scheduler), ThreadPoolExecutor() as pool:
        with lock:
            future = pool.submit(read_panel)
            assert reading.wait(5), "panel reader did not run"
            scheduler.schedules["new"] = SimpleNamespace(enabled=True)
        item = future.result(timeout=5)

    assert item["state"] == "running"
    assert item["error"] is None
    assert item["metrics"] == {"计划": 2, "启用": 1}


def test_scheduler_panel_status_and_peek_instance_never_construct() -> None:
    from threading import Lock

    from server.services.autonomous_scheduler import AutonomousScheduler
    from server.services.task_scheduler import TaskScheduler

    sched = SimpleNamespace(
        _lock=Lock(),
        _sched=SimpleNamespace(running=True),
        _stop_event=SimpleNamespace(is_set=lambda: False),
        schedules={
            "a": SimpleNamespace(enabled=True),
            "b": SimpleNamespace(enabled=False),
        },
    )
    assert AutonomousScheduler.panel_status(sched) == {"running": True, "total": 2, "enabled": 1}

    stopped_sched = SimpleNamespace(
        _lock=Lock(),
        _sched=SimpleNamespace(running=True),
        _stop_event=SimpleNamespace(is_set=lambda: True),
        schedules={"a": SimpleNamespace(enabled=True)},
    )
    assert TaskScheduler.panel_status(stopped_sched) == {"running": False, "total": 1, "enabled": 1}

    with (
        mock.patch.object(AutonomousScheduler, "_instance", None),
        mock.patch.object(TaskScheduler, "_instance", None),
        mock.patch.object(AutonomousScheduler, "instance", side_effect=AssertionError("must not construct")),
        mock.patch.object(TaskScheduler, "instance", side_effect=AssertionError("must not construct")),
    ):
        assert AutonomousScheduler.peek_instance() is None
        assert TaskScheduler.peek_instance() is None
        assert ServiceRegistry()._autonomous().state == "stopped"
        assert ServiceRegistry()._tasks().state == "stopped"
