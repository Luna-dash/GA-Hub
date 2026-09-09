"""Hub routes/client to the real GA ASGI schemas and pool, with no model calls."""
from __future__ import annotations

import importlib
import os
import queue
import sys
import threading
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlsplit

import pytest
import requests
from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.routes import conductor as routes
from server.services import conductor_client
from server.services.conductor_service import ConductorService


class Agent:
    def __init__(self):
        self.task_queue = queue.Queue()
        self.handler = SimpleNamespace(working={})
        self.tasks = []

    def put_task(self, msg, **kwargs):
        self.tasks.append(msg)
        display = queue.Queue()
        self.task_queue.put(display)
        return display

    def run(self):
        while True:
            task = self.task_queue.get()
            self.task_queue.task_done()
            if task == "EXIT":
                return

    def abort(self):
        pass


@pytest.fixture
def chain(tmp_path, monkeypatch):
    ga_root = Path(os.environ.get("TEST_GA_ROOT", Path(__file__).resolve().parents[2] / "GA"))
    if not (ga_root / "frontends/gahub/gahub_app.py").is_file():
        pytest.skip("set TEST_GA_ROOT to the paired GA checkout")
    monkeypatch.syspath_prepend(str(ga_root))
    core = importlib.import_module("frontends.gahub.conductor_core")
    monkeypatch.setattr(core.SubagentPool, "_auto_cleanup_loop", lambda self: None)
    monkeypatch.delenv("GAHUB_JOURNAL_PATH", raising=False)
    engine_api = importlib.import_module("frontends.gahub.gahub_app")
    monkeypatch.setenv("GAHUB_JOURNAL_PATH", str(tmp_path / "events.jsonl"))
    monkeypatch.setenv("GAHUB_PATH_POLICY", "explicit_absolute")
    monkeypatch.setattr(engine_api, "PATH_POLICY_MODE", "explicit_absolute")
    monkeypatch.setattr(engine_api, "TOKEN", "")
    engine = engine_api.GAHubService()
    monkeypatch.setattr(engine_api, "service", engine)
    notices = []
    engine.conductor = SimpleNamespace(
        lifecycle_snapshot=lambda: {"started": True, "stopping": False, "admission_open": True},
        notify=lambda event: notices.append(event) or True,
        request_yield=lambda *args, **kwargs: False,
        agent=None, log=[], stop=lambda **kwargs: True,
    )
    agents = []

    def factory():
        agent = Agent()
        agents.append(agent)
        return agent

    engine.pool.runtime.agent_factory = factory
    engine.pool.runtime.llm_selector = None
    # The tests submit completion explicitly; no polling/model runner is needed.
    engine.pool._start_monitor = lambda *args: None
    ga_http = TestClient(engine_api.app)
    calls, lose_response = [], set()

    def transport(method, url, **kwargs):
        path = urlsplit(url).path
        calls.append((method, path, kwargs.get("json")))
        response = ga_http.request(method, path, json=kwargs.get("json"), params=kwargs.get("params"))
        if (method, path) in lose_response:
            lose_response.remove((method, path))
            raise requests.ConnectionError("response lost after execution")
        return response

    monkeypatch.setattr(conductor_client.requests, "request", transport)
    services = []

    def new_hub():
        hub = ConductorService.for_tests(store_path=tmp_path / "state.sqlite3")
        manager = conductor_client.GahubProcessManager(
            ga_root=str(ga_root), port=18770, token="", python_exe=sys.executable, spawn_enabled=False)
        manager.ensure_running = lambda: None
        hub._process_manager = manager
        hub.client = conductor_client.GaConductorClient(manager)
        hub.pool.client = hub.client
        hub._ensure_relay = lambda: None
        hub.auto_accept = False
        services.append(hub)
        monkeypatch.setattr(routes, "svc", lambda: hub)
        return hub

    hub = new_hub()
    app = FastAPI()
    app.include_router(routes.router)
    http = TestClient(app)
    yield SimpleNamespace(engine=engine, http=http, hub=hub, restart=new_hub, notices=notices,
                          calls=calls, lose=lose_response, agents=agents, root=tmp_path)
    engine.close_maintenance()
    for agent in agents:
        agent.task_queue.put("EXIT")
    for state in engine.pool.subagents.values():
        if state.thread is not None:
            state.thread.join(3)
            assert not state.thread.is_alive()
    for service in services:
        service.store.close()
    http.close()
    ga_http.close()
    if engine.journal._handle is not None:
        engine.journal._handle.close()


def test_chat_response_loss_restart_and_real_receipt(chain):
    body = {"role": "user", "msg": "prepare report", "operation_id": "submit"}
    chain.lose.add(("POST", "/chat"))
    failed = chain.http.post("/api/conductor/chat", json=body)
    assert failed.status_code == 503
    assert failed.json()["detail"]["operation_id"] == "submit"
    request_id = chain.hub.store.command("submit")["payload"]["request_id"]
    restarted = chain.restart()
    response = chain.http.post("/api/conductor/chat", json=body)
    assert response.status_code == 200, response.text
    assert response.json()["request_id"] == request_id
    assert len(chain.engine.chat_messages) == 1
    assert len([call for call in chain.calls if call[:2] == ("POST", "/chat")]) == 1
    assert restarted.workflow_tracker.snapshot(request_id)["admission_state"] == "admitted"
    receipt = chain.http.get("/api/conductor/operations/submit").json()
    assert receipt["state"] == "succeeded"
    assert chain.http.post("/api/conductor/chat", json={**body, "msg": "changed"}).status_code == 409
    chain.restart()
    assert chain.http.get("/api/conductor/chat").json()["items"][0]["msg"] == "prepare report"


def test_dispatch_review_guards_and_force_receipt_use_real_engine(chain):
    user = chain.http.post("/api/conductor/chat", json={"msg": "build report", "role": "user"})
    assert user.status_code == 200, user.text
    rid = user.json()["request_id"]
    dispatched = chain.http.post("/api/conductor/subagent", json={
        "prompt": "build report", "goal": "report", "request_id": rid, "operation_id": "dispatch",
        "deliverables": [{"path": str(chain.root / "missing.txt")}],
    })
    assert dispatched.status_code == 200, dispatched.text
    sid = dispatched.json()["id"]
    chain.engine.pool.on_display(sid, "[[GAHUB_TASK_DONE]]\n<summary>report</summary>", done=True, generation=1)
    assert chain.hub.recovery.sync()
    detail = chain.http.get(f"/api/conductor/subagent/{sid}").json()
    guards = {"expected_boot_id": detail["boot_id"], "expected_generation": detail["active_generation"],
              "expected_command_revision": detail["command_revision"]}
    stale = chain.http.post(f"/api/conductor/subagent/{sid}", json={
        "action": "accept", "operation_id": "stale", **guards, "expected_generation": 0})
    assert stale.status_code == 409
    assert stale.json()["detail"]["error"] == "worker_version_conflict"
    rejected = chain.http.post(f"/api/conductor/subagent/{sid}", json={
        "action": "accept", "operation_id": "plain", **guards})
    assert rejected.status_code == 409, rejected.text
    assert rejected.json()["detail"]["error"] == "completion_unverified"
    assert rejected.json()["detail"]["deliverables_missing"]
    # Failed verification may advance the command revision; fetch the displayed state again.
    detail = chain.http.get(f"/api/conductor/subagent/{sid}").json()
    guards["expected_command_revision"] = detail["command_revision"]
    body = {"action": "accept", "force": True, "msg": "reviewed", "operation_id": "force", **guards}
    chain.lose.add(("POST", f"/subagent/{sid}"))
    assert chain.http.post(f"/api/conductor/subagent/{sid}", json=body).status_code == 503
    chain.restart()
    accepted = chain.http.post(f"/api/conductor/subagent/{sid}", json=body)
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["forced_accept"] is True
    assert chain.engine.pool.get(sid).review_status == "accepted"
    assert len(chain.agents) == 1
    repeat = chain.http.post(f"/api/conductor/subagent/{sid}", json=body)
    assert repeat.json() == accepted.json()


def test_real_schema_rejection_is_persisted_and_old_boot_never_dispatches(chain):
    bad = {"prompt": "invalid contract", "operation_id": "bad"}
    response = chain.http.post("/api/conductor/subagent", json=bad)
    assert response.status_code == 422
    assert chain.hub.store.command("bad")["state"] == "rejected"
    assert chain.agents == []
    valid = {"prompt": "report", "goal": "report", "operation_id": "pending",
             "deliverables": [{"path": str(chain.root / "out.txt")}]}
    chain.lose.add(("POST", "/subagent"))
    assert chain.http.post("/api/conductor/subagent", json=valid).status_code == 503
    chain.engine.boot_id = "new-boot"
    chain.restart()
    result = chain.http.post("/api/conductor/subagent", json=valid)
    assert result.status_code == 409
    assert result.json()["detail"]["error"] == "operation_unknown"
    assert len(chain.agents) == 1
