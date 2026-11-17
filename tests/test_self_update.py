"""Self-update tests use fake EXEs; never touch the running desktop."""
import hashlib
import json
import zipfile
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.services.self_update import DATA_EPOCH, EXECUTABLES, UpdateStore, digest


def release(tmp_path, *, extra=None, epoch=DATA_EPOCH, hashes=None):
    files = {name: b"MZ-fake-" + name.encode() for name in EXECUTABLES}
    info = {"version": "0.1.0", "commit": "abc123", "sha256": hashes or {
        name: hashlib.sha256(data).hexdigest() for name, data in files.items()
    }}
    files.update({"build-info.json": json.dumps(info), "update-manifest.json": json.dumps({
        "schema": 1, "platform": "windows-x64", "data_epoch": epoch,
    })})
    files.update(extra or {})
    archive = tmp_path / "release.zip"
    with zipfile.ZipFile(archive, "w") as package:
        for name, data in files.items():
            package.writestr(name, data)
    return archive


def prepare(store, archive):
    return store.prepare(archive, digest(archive), trusted=True)


def test_prepare_persist_verify_cancel(tmp_path):
    store = UpdateStore(tmp_path / "updates")
    archive = release(tmp_path)
    plan = prepare(store, archive)
    assert plan["state"] == "prepared"
    assert UpdateStore(store.root).read() == plan
    assert (store.verify(plan) / EXECUTABLES[0]).read_bytes().startswith(b"MZ")
    assert store.cancel(plan["id"])["state"] == "cancelled"
    with pytest.raises(ValueError):
        store.cancel(plan["id"])


@pytest.mark.parametrize("extra", [{"../escape.exe": b"bad"}, {"nested/file": b"bad"}, {"RUN.bat": b"bad"}])
def test_reject_unexpected_paths(tmp_path, extra):
    store = UpdateStore(tmp_path / "updates")
    with pytest.raises(ValueError, match="unexpected"):
        prepare(store, release(tmp_path, extra=extra))
    assert store.read()["state"] == "idle"
    assert not (tmp_path / "escape.exe").exists()


def test_requires_trusted_source_and_checksum(tmp_path):
    archive = release(tmp_path)
    store = UpdateStore(tmp_path / "updates")
    with pytest.raises(ValueError, match="confirmation"):
        store.prepare(archive, digest(archive), trusted=False)
    with pytest.raises(ValueError, match="does not match"):
        store.prepare(archive, "0" * 64, trusted=True)


@pytest.mark.parametrize("checksum", ["", None])
def test_prepare_without_external_checksum(tmp_path, checksum):
    archive = release(tmp_path)
    store = UpdateStore(tmp_path / "updates")
    with pytest.raises(ValueError, match="confirmation"):
        store.prepare(archive, trusted=False)
    plan = store.prepare(archive, trusted=True) if checksum is None else store.prepare(archive, checksum, trusted=True)
    assert plan["archive_sha256"] == digest(archive)
    assert store.verify(plan).is_dir()


def test_invalid_optional_checksum_rejected(tmp_path):
    with pytest.raises(ValueError, match="64 hexadecimal"):
        UpdateStore(tmp_path / "updates").prepare(release(tmp_path), "bad", trusted=True)


def test_without_external_checksum_still_rejects_tampered_executable(tmp_path):
    store = UpdateStore(tmp_path / "updates")
    archive = release(tmp_path, hashes={name: "0" * 64 for name in EXECUTABLES})
    with pytest.raises(ValueError, match="integrity"):
        store.prepare(archive, trusted=True)
    assert store.read()["state"] == "idle"


def test_incompatible_data_epoch(tmp_path):
    with pytest.raises(ValueError, match="compatibility"):
        prepare(UpdateStore(tmp_path / "updates"), release(tmp_path, epoch=2))


def test_tampered_executable_never_prepared(tmp_path):
    store = UpdateStore(tmp_path / "updates")
    with pytest.raises(ValueError, match="integrity"):
        prepare(store, release(tmp_path, hashes={name: "0" * 64 for name in EXECUTABLES}))
    assert store.read()["state"] == "idle"
    assert list((store.root / "versions").iterdir()) == []


def test_verify_again_before_apply(tmp_path):
    store = UpdateStore(tmp_path / "updates")
    plan = prepare(store, release(tmp_path))
    (store.candidate(plan) / EXECUTABLES[1]).write_bytes(b"modified")
    with pytest.raises(ValueError, match="integrity"):
        store.verify(plan)


def test_stale_cancel_and_active_update_rejected(tmp_path):
    store = UpdateStore(tmp_path / "updates")
    archive = release(tmp_path)
    plan = prepare(store, archive)
    with pytest.raises(ValueError):
        store.cancel("a" * 32)
    store.transition(plan["id"], {"prepared"}, "armed")
    with pytest.raises(ValueError):
        store.cancel(plan["id"])
    with pytest.raises(ValueError, match="already"):
        prepare(store, archive)


def test_instances_share_lock(tmp_path):
    root = tmp_path / "updates"
    assert UpdateStore(root).lock is UpdateStore(root).lock


def test_api(tmp_path, monkeypatch):
    from server.routes import updates
    monkeypatch.setattr(updates._paths, "ADMIN_DATA", tmp_path / "admin")
    app = FastAPI()
    app.include_router(updates.router)
    client = TestClient(app)
    archive = release(tmp_path)
    assert client.get("/api/updates").json()["plan"]["state"] == "idle"
    body = {"archive": str(archive), "sha256": digest(archive)}
    assert client.post("/api/updates/prepare", json=body).status_code == 400
    body["trusted_source_confirmed"] = True
    result = client.post("/api/updates/prepare", json=body)
    assert result.status_code == 200, result.text
    assert client.post("/api/updates/cancel", json={"id": result.json()["id"]}).status_code == 200
    assert client.post("/api/updates/prepare", json={**body, "sha256": "bad"}).status_code == 422


@pytest.mark.parametrize("checksum", [None, ""])
def test_api_optional_checksum(tmp_path, monkeypatch, checksum):
    from server.routes import updates
    monkeypatch.setattr(updates._paths, "ADMIN_DATA", tmp_path / "admin")
    app = FastAPI()
    app.include_router(updates.router)
    client = TestClient(app)
    archive = release(tmp_path)
    body = {"archive": str(archive)}
    if checksum is not None:
        body["sha256"] = checksum
    assert client.post("/api/updates/prepare", json=body).status_code == 400
    body["trusted_source_confirmed"] = True
    result = client.post("/api/updates/prepare", json=body)
    assert result.status_code == 200, result.text
    assert result.json()["archive_sha256"] == digest(archive)


@pytest.mark.parametrize("state", ["prepared", "armed", "switching", "verifying", "failed"])
def test_unresolved_plan_cannot_be_replaced(tmp_path, state):
    store = UpdateStore(tmp_path / "updates")
    archive = release(tmp_path)
    plan = prepare(store, archive)
    store.transition(plan["id"], {"prepared"}, state)
    with pytest.raises(ValueError, match="already"):
        prepare(store, archive)
    assert store.read()["id"] == plan["id"]


def test_invalid_zip_api_returns_client_error(tmp_path, monkeypatch):
    from server.routes import updates
    monkeypatch.setattr(updates._paths, "ADMIN_DATA", tmp_path / "admin")
    app = FastAPI()
    app.include_router(updates.router)
    archive = tmp_path / "bad.zip"
    archive.write_bytes(b"not a zip")
    result = TestClient(app).post("/api/updates/prepare", json={
        "archive": str(archive), "sha256": digest(archive), "trusted_source_confirmed": True,
    })
    assert result.status_code == 400
