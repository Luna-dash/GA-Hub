"""Conflict-safe editing contracts for GA-owned Memory files."""
from __future__ import annotations

import hashlib
from pathlib import Path
from urllib.parse import quote

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from server import _paths
from server.routes import memory


@pytest.fixture
def memory_client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    ga_root = tmp_path / "ga"
    memory_dir = ga_root / "memory"
    memory_dir.mkdir(parents=True)
    admin_data = tmp_path / "admin"
    monkeypatch.setattr(_paths, "GA_ROOT", ga_root)
    monkeypatch.setattr(_paths, "ADMIN_DATA", admin_data)

    app = FastAPI()
    app.include_router(memory.router)
    with TestClient(app) as client:
        yield client, memory_dir, admin_data


def _preconditions(snapshot: dict) -> dict:
    return {
        "expected_mtime_ns": snapshot["mtime_ns"],
        "expected_sha256": snapshot["sha256"],
    }


def test_global_write_requires_explicit_snapshot_preconditions(memory_client) -> None:
    client, memory_dir, _admin_data = memory_client
    (memory_dir / "global_mem.txt").write_text("before\n", encoding="utf-8")

    response = client.put("/api/memory/global", json={"content": "unsafe overwrite"})

    assert response.status_code == 422
    assert (memory_dir / "global_mem.txt").read_text(encoding="utf-8") == "before\n"


def test_global_write_preserves_bom_newlines_and_backs_up_original_bytes(memory_client) -> None:
    client, memory_dir, admin_data = memory_client
    target = memory_dir / "global_mem.txt"
    original = b"\xef\xbb\xbfline one\r\nline two\r\n"
    target.write_bytes(original)

    loaded = client.get("/api/memory/global")
    assert loaded.status_code == 200
    snapshot = loaded.json()
    assert snapshot["content"] == "line one\r\nline two\r\n"
    assert snapshot["sha256"] == hashlib.sha256(original).hexdigest()
    assert snapshot["mtime_ns"].isdigit()

    saved = client.put(
        "/api/memory/global",
        json={"content": "line one\nchanged\n", **_preconditions(snapshot)},
    )

    assert saved.status_code == 200
    result = saved.json()
    expected = b"\xef\xbb\xbfline one\r\nchanged\r\n"
    assert target.read_bytes() == expected
    assert result == {
        "ok": True,
        "size": len(expected),
        "mtime_ns": str(target.stat().st_mtime_ns),
        "sha256": hashlib.sha256(expected).hexdigest(),
    }
    backups = list((admin_data / "memory-backups").glob("global_mem.txt.*.bak"))
    assert len(backups) == 1
    assert backups[0].read_bytes() == original


def test_unchanged_save_does_not_rewrite_or_create_another_backup(memory_client) -> None:
    client, memory_dir, admin_data = memory_client
    target = memory_dir / "global_mem.txt"
    target.write_text("same\n", encoding="utf-8", newline="")
    snapshot = client.get("/api/memory/global").json()

    first = client.put(
        "/api/memory/global",
        json={"content": "same\n", **_preconditions(snapshot)},
    )

    assert first.status_code == 200
    assert first.json()["mtime_ns"] == snapshot["mtime_ns"]
    assert first.json()["sha256"] == snapshot["sha256"]
    assert not (admin_data / "memory-backups").exists()


def test_external_edit_returns_conflict_and_preserves_local_file(memory_client) -> None:
    client, memory_dir, admin_data = memory_client
    target = memory_dir / "global_mem.txt"
    target.write_text("loaded\n", encoding="utf-8", newline="")
    snapshot = client.get("/api/memory/global").json()
    target.write_text("external change\n", encoding="utf-8", newline="")

    response = client.put(
        "/api/memory/global",
        json={"content": "stale browser draft\n", **_preconditions(snapshot)},
    )

    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["error"] == "memory_conflict"
    assert detail["current_sha256"] == hashlib.sha256(target.read_bytes()).hexdigest()
    assert target.read_text(encoding="utf-8") == "external change\n"
    assert not (admin_data / "memory-backups").exists()


def test_sop_endpoint_uses_the_same_versioned_write_contract(memory_client) -> None:
    client, memory_dir, _admin_data = memory_client
    target = memory_dir / "example_sop.md"
    target.write_text("# Before\n", encoding="utf-8", newline="")

    loaded = client.get("/api/memory/sops/example_sop.md")
    assert loaded.status_code == 200
    snapshot = loaded.json()
    assert snapshot["name"] == "example_sop.md"
    assert snapshot["mtime_ns"].isdigit()

    saved = client.put(
        "/api/memory/sops/example_sop.md",
        json={"content": "# After\n", **_preconditions(snapshot)},
    )

    assert saved.status_code == 200
    assert target.read_text(encoding="utf-8") == "# After\n"
    assert saved.json()["sha256"] == hashlib.sha256(target.read_bytes()).hexdigest()


@pytest.mark.parametrize(
    "unsafe_name",
    [r"..\escape.md", r"C:\escape.md", "safe.md:stream.md"],
)
def test_sop_endpoint_rejects_windows_path_and_ads_syntax(memory_client, unsafe_name: str) -> None:
    client, memory_dir, admin_data = memory_client

    response = client.put(
        f"/api/memory/sops/{quote(unsafe_name, safe='')}",
        json={
            "content": "must not be written",
            "expected_mtime_ns": None,
            "expected_sha256": None,
        },
    )

    assert response.status_code == 400
    assert list(memory_dir.iterdir()) == []
    assert not admin_data.exists()
