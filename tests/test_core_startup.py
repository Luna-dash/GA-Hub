"""An incompatible GA must leave a usable shell without admitting runtime work."""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from unittest import mock

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from server import _paths, main
from server.services import core_contract
from server.services.core_contract import ContractReport, CoreRuntimeUnavailable


@pytest.mark.parametrize("failure", ["contract", "probe_crash", "route_import"])
def test_failed_core_keeps_diagnostics_and_rejects_work(monkeypatch, tmp_path, failure):
    monkeypatch.setattr(main, "WEBUI_DIST", tmp_path / "no-dist")
    report = ContractReport(
        ga_root=str(_paths.GA_ROOT), core_commit="test", ok=failure == "route_import",
        errors=[] if failure == "route_import" else ["bridge runtime unavailable"],
    )
    probe = mock.Mock(return_value=report)
    if failure == "probe_crash":
        probe.side_effect = RuntimeError("probe crashed")
    if failure == "route_import":
        monkeypatch.setattr(main, "_normal_routers", mock.Mock(side_effect=ImportError("missing bridge")))
    monkeypatch.setattr(core_contract, "probe_core_contract", probe)
    monkeypatch.setattr("server.services.child_job.sweep_registry", lambda: [])

    with (
        mock.patch("server.services.agent_service.AgentService.instance") as agent,
        mock.patch("server.services.scheduler_host.SchedulerHost") as scheduler,
        mock.patch("server.services.conductor_service.ConductorService.instance") as conductor,
        mock.patch("server.services.feishu_service.FeishuService.instance") as feishu,
        mock.patch("server.routes.tokens.initialize_usage_tracking") as usage,
    ):
        app = main.create_app()
        lifecycle = app.state.session_lifecycle
        with TestClient(app, base_url="http://127.0.0.1") as client:
            assert client.get("/").status_code == 200
            assert client.get("/api/setup/status").json()["configured"] is True
            assert client.get("/api/status").status_code == 200
            assert client.get("/api/health").json()["status"] == "unavailable"
            health = client.get("/api/health/core-contract").json()
            assert health["ok"] is False
            assert health["errors"]
            assert client.post("/api/setup/validate", json={"ga_root": str(tmp_path)}).status_code == 200

            with mock.patch.object(_paths, "set_ga_root", return_value=_paths.GA_ROOT) as save:
                assert client.post("/api/setup/save", json={"ga_root": str(_paths.GA_ROOT)}).status_code == 200
                save.assert_called_once()

            for path, payload in (
                ("/api/sessions", {"title": "must not be created"}),
                ("/api/sessions/test/runs", {"text": "must not run"}),
                ("/api/agent/new", {}),
                ("/api/conductor/start", {}),
            ):
                response = client.post(path, json=payload, headers={"Origin": "http://localhost:5173"})
                assert response.status_code == 503
                assert response.json()["detail"]["code"] == "core_contract_failed"
                assert response.headers["access-control-allow-origin"] == "http://localhost:5173"

            with client.websocket_connect("/ws/sessions/test") as socket:
                with pytest.raises(WebSocketDisconnect) as refused:
                    socket.receive_json()
                assert refused.value.code == 1013
            with pytest.raises(WebSocketDisconnect) as forbidden:
                with client.websocket_connect("/ws/sessions/test", headers={"Origin": "https://evil.example"}):
                    pass
            assert forbidden.value.code == 1008
            with client.websocket_connect("/ws/events?cursor=1") as socket:
                assert socket.receive_json()["type"] == "replay_done"

            # Background producers use the same gate before metadata writes.
            with mock.patch.object(lifecycle.store, "ensure") as ensure:
                with pytest.raises(CoreRuntimeUnavailable):
                    lifecycle.system_channels().channel("autonomous").submit("blocked", source="autonomous")
                ensure.assert_not_called()
            with pytest.raises(CoreRuntimeUnavailable):
                lifecycle.runtime_factory()
            assert lifecycle.peek_coordinator() is None
            assert lifecycle.runtime_states() == ()

        for factory in (agent, scheduler, conductor, feishu, usage):
            factory.assert_not_called()


def _fresh_python(source: str, tmp_path: Path) -> None:
    env = {**os.environ, "GA_ROOT": str(_paths.GA_ROOT),
           "GA_ADMIN_DATA": str(tmp_path / "admin"), "PYTHONDONTWRITEBYTECODE": "1"}
    run = subprocess.run(
        [sys.executable, "-c", source], cwd=Path(__file__).resolve().parents[1],
        env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=45,
    )
    assert run.returncode == 0, run.stdout + run.stderr


def test_missing_bridge_still_boots_in_a_fresh_process(tmp_path):
    _fresh_python('''
import importlib.abc
import sys
class MissingRuntime(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname == "frontends.gahub.bridge.runtime":
            raise ModuleNotFoundError("runtime bridge deliberately unavailable")
sys.meta_path.insert(0, MissingRuntime())
from server.main import app
from fastapi.testclient import TestClient
assert app.state.route_load_error
with TestClient(app, base_url="http://127.0.0.1") as client:
    assert client.get("/api/setup/status").status_code == 200
    report = client.get("/api/health/core-contract").json()
    assert report["ok"] is False, report
    assert any("runtime" in error for error in report["errors"]), report
    assert client.post("/api/sessions", json={}).status_code == 503
    assert app.state.services.agent is None
    assert app.state.session_lifecycle.peek_coordinator() is None
''', tmp_path)


def test_importing_app_does_not_patch_tools_or_initialize_ledger(tmp_path):
    _fresh_python('''
from unittest import mock
from server import _paths
import ga
from frontends.gahub.bridge import usage
from server.services import ga_subprocess_patch
original_scan, original_execute = ga.web_scan, ga.web_execute_js
with mock.patch.object(ga_subprocess_patch, "_patch_ga_subprocess") as patch, \\
     mock.patch.object(usage, "initialize_usage_tracking") as initialize:
    from server.main import app
    assert app.state.route_load_error is None, app.state.route_load_error
    patch.assert_not_called()
    initialize.assert_not_called()
    assert ga.web_scan is original_scan
    assert ga.web_execute_js is original_execute
''', tmp_path)
