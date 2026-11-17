"""Background updates survive page navigation; no network or desktop processes."""
import threading
import time

import pytest
import requests
from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.services import update_download as download
from server.services.self_update import UpdateStore, atomic_json


def wait_for(store, phase):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        task = download.status(store)
        if task and task["phase"] == phase:
            return task
        time.sleep(.01)
    pytest.fail(f"Did not reach {phase}: {task}")


def test_background_progress_duplicate_start_and_api_reconnect(tmp_path, monkeypatch):
    from server.routes import updates
    store = UpdateStore(tmp_path / "updates")
    monkeypatch.setattr(updates, "store", lambda: store)
    running, finish = threading.Event(), threading.Event()
    calls = []
    plan = {"id": "a" * 32, "state": "prepared", "version": "1.2.0"}

    def prepare(store, progress):
        calls.append(1)
        progress("downloading", received_bytes=512, total_bytes=1024)
        running.set()
        assert finish.wait(5)
        progress("verifying", received_bytes=1024)
        atomic_json(store.state_file, plan)
        return plan

    monkeypatch.setattr(download.update_release, "prepare", prepare)
    app = FastAPI()
    app.include_router(updates.router)
    try:
        with TestClient(app) as client:
            assert client.post("/api/updates/release/download").status_code == 202
            assert running.wait(3)
            duplicate = client.post("/api/updates/release/download").json()
            assert duplicate["phase"] == "downloading"
            assert duplicate["received_bytes"] == 512
        # Closing and reopening the client is independent of the worker.
        with TestClient(app) as client:
            task = client.get("/api/updates").json()["download"]
            assert task["phase"] == "downloading"
            assert task["total_bytes"] == 1024
            assert len(calls) == 1
            finish.set()
            wait_for(store, "succeeded")
            assert client.post("/api/updates/release/download").json()["phase"] == "succeeded"
            assert len(calls) == 1
    finally:
        finish.set()
        wait_for(store, "succeeded")


def test_restart_marks_unowned_active_task_interrupted(tmp_path):
    store = UpdateStore(tmp_path / "updates")
    atomic_json(store.root / "download-task.json", {"phase": "downloading", "received_bytes": 123})
    task = download.status(UpdateStore(store.root))
    assert task["phase"] == "interrupted"
    assert task["received_bytes"] == 123
    assert "可重新下载" in task["error"]["message"]
    assert download.status(store) == task


def test_failure_persists_and_retry_can_succeed(tmp_path, monkeypatch):
    store = UpdateStore(tmp_path / "updates")
    def fail(store, progress):
        raise requests.Timeout("read timed out")
    monkeypatch.setattr(download.update_release, "prepare", fail)
    download.start(store)
    failed = wait_for(store, "failed")
    assert "超时" in failed["error"]["message"]
    assert failed["error"]["detail"] == "read timed out"
    # Wait for worker lock release, not merely the final JSON write.
    with download.FileMutex(store.root / "download-task.lock"):
        pass
    monkeypatch.setattr(download.update_release, "prepare", lambda store, progress: {"id": "b" * 32})
    download.start(store)
    assert wait_for(store, "succeeded")["plan_id"] == "b" * 32


@pytest.mark.parametrize(("exc", "message"), [
    (requests.exceptions.ProxyError("proxy down"), "代理"),
    (ValueError("Release archive checksum/size mismatch"), "校验未通过"),
    (TimeoutError("Updater lock busy: download.lock"), "另一个更新操作"),
    (PermissionError("denied"), "权限"),
])
def test_readable_errors_keep_diagnostics(exc, message):
    assert message in download.failure(exc)["message"]
    assert download.failure(exc)["detail"] == str(exc)
