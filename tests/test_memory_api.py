"""Conflict-safe editing contracts for GA-owned Memory files."""
from __future__ import annotations

import hashlib
import os
import subprocess
from pathlib import Path
from urllib.parse import quote

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from server import _paths
from server.routes import memory


def _make_link(link: Path, target: Path, *, directory: bool) -> bool:
    """Create `link` -> `target`; False when the OS refuses (caller decides).

    A junction needs no SeCreateSymbolicLinkPrivilege and — unlike a symlink —
    os.path.islink() reports False for it, so it also covers the case that
    os.walk(followlinks=False) would not have stopped.
    """
    try:
        link.symlink_to(target, target_is_directory=directory)
        return True
    except (OSError, NotImplementedError, AttributeError):
        pass
    if directory and os.name == "nt":
        result = subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(link), str(target)],
            capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL,
        )
        if result.returncode == 0 and link.exists():
            return True
    return False


def _link_or_skip(link: Path, target: Path, *, directory: bool) -> None:
    """Variant for cases where a skipped test is a genuine loss of coverage."""
    if not _make_link(link, target, directory=directory):
        pytest.skip(f"cannot create a {directory and 'junction' or 'symlink'} on this host")


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


@pytest.mark.parametrize(
    "unsafe_path",
    [
        "../outside.md",
        r"..\outside.md",
        r"C:\outside.md",
        "C:/outside.md",
        r"\\server\share\outside.md",
        "safe.md:stream.md",
    ],
)
def test_skill_read_rejects_paths_outside_skill_root(memory_client, unsafe_path: str) -> None:
    client, memory_dir, _admin_data = memory_client
    skill_dir = memory_dir / "skill_search"
    skill_dir.mkdir()
    (memory_dir / "outside.md").write_text("secret", encoding="utf-8")

    response = client.get("/api/memory/skills/read", params={"path": unsafe_path})

    assert response.status_code == 400
    assert response.json()["detail"] == "bad path"


def test_skill_read_allows_nested_relative_skill(memory_client) -> None:
    client, memory_dir, _admin_data = memory_client
    target = memory_dir / "skill_search" / "nested" / "guide.md"
    target.parent.mkdir(parents=True)
    target.write_bytes(b"# Guide\n")

    response = client.get("/api/memory/skills/read", params={"path": "nested/guide.md"})

    assert response.status_code == 200
    assert response.json() == {"path": "nested/guide.md", "content": "# Guide\n"}


def test_skill_read_rejects_symlink_outside_skill_root(memory_client) -> None:
    client, memory_dir, _admin_data = memory_client
    skill_dir = memory_dir / "skill_search"
    skill_dir.mkdir()
    outside = memory_dir / "outside.md"
    outside.write_text("secret", encoding="utf-8")
    _link_or_skip(skill_dir / "linked.md", outside, directory=False)

    response = client.get("/api/memory/skills/read", params={"path": "linked.md"})

    assert response.status_code == 400
    assert response.json()["detail"] == "bad path"


def test_skill_read_rejects_junction_outside_skill_root(memory_client) -> None:
    client, memory_dir, _admin_data = memory_client
    skill_dir = memory_dir / "skill_search"
    skill_dir.mkdir()
    outside = memory_dir / "private"
    outside.mkdir()
    (outside / "secret.md").write_bytes(b"secret\n")
    _link_or_skip(skill_dir / "linked_dir", outside, directory=True)

    response = client.get("/api/memory/skills/read", params={"path": "linked_dir/secret.md"})

    assert response.status_code == 400
    assert response.json()["detail"] == "bad path"


def test_skill_read_allows_junction_that_stays_inside_root(memory_client) -> None:
    client, memory_dir, _admin_data = memory_client
    skill_dir = memory_dir / "skill_search"
    (skill_dir / "real").mkdir(parents=True)
    (skill_dir / "real" / "guide.md").write_bytes(b"# Guide\n")
    _link_or_skip(skill_dir / "alias", skill_dir / "real", directory=True)

    response = client.get("/api/memory/skills/read", params={"path": "alias/guide.md"})

    assert response.status_code == 200
    assert response.json() == {"path": "alias/guide.md", "content": "# Guide\n"}


def _plant_linked_outside_tree(memory_dir: Path) -> None:
    """A skill dir holding one real skill plus a link to a secret folder."""
    skill_dir = memory_dir / "skill_search"
    skill_dir.mkdir()
    (skill_dir / "real_skill.md").write_bytes(b"needle inside the root\n")
    outside = memory_dir / "private"
    outside.mkdir()
    (outside / "secret.md").write_bytes(b"needle outside the root\n")
    assert _make_link(skill_dir / "linked_dir", outside, directory=True)


def test_skill_search_ignores_links_outside_skill_root(memory_client) -> None:
    client, memory_dir, _admin_data = memory_client
    _plant_linked_outside_tree(memory_dir)

    response = client.get("/api/memory/skills/search", params={"q": "needle"})

    assert response.status_code == 200
    payload = response.json()
    assert [hit["path"] for hit in payload["hits"]] == ["real_skill.md"]
    assert payload["scanned"] == 1
    assert "outside the root" not in str(payload)


def test_skill_search_still_reads_nested_files_inside_root(memory_client) -> None:
    client, memory_dir, _admin_data = memory_client
    skill_dir = memory_dir / "skill_search" / "family" / "child"
    skill_dir.mkdir(parents=True)
    (skill_dir / "deep.md").write_bytes(b"deep needle\n")

    response = client.get("/api/memory/skills/search", params={"q": "needle"})

    assert response.status_code == 200
    payload = response.json()
    assert [hit["path"] for hit in payload["hits"]] == [os.path.join("family", "child", "deep.md")]
    assert payload["hits"][0]["matches"][0]["line"] == 1


def test_skill_list_skips_links_outside_skill_root(memory_client) -> None:
    client, memory_dir, _admin_data = memory_client
    _plant_linked_outside_tree(memory_dir)

    response = client.get("/api/memory/skills")

    assert response.status_code == 200
    payload = response.json()
    assert [item["path"] for item in payload["skills"]] == ["real_skill.md"]
    assert payload["count"] == 1


def test_skill_endpoints_agree_on_which_files_are_skills(memory_client) -> None:
    """list, search and read must agree on the same set of text skills.

    They used to carry three drifting copies of the extension allow-list, so
    search could report a hit that read then refused to open, and read could
    serve a file the list never advertised.
    """
    client, memory_dir, _admin_data = memory_client
    skill_dir = memory_dir / "skill_search"
    skill_dir.mkdir()
    # name -> bytes: every extension the shared allow-list has to accept, plus
    # one extensionless binary that has to stay out of all three endpoints.
    planted = {
        "plain.md": b"# plain needle\n",
        "notes.txt": b"txt needle\n",
        "conf.yml": b"yml needle\n",
        "run.sh": b"echo needle\n",
        "README": b"extensionless needle\n",
        "legacy": "\u975eutf8 needle \u6807\u9898\n".encode("gbk"),
        "bundle": b"\x89PNG\r\n\x1a\n\x00\x00binary\n",
    }
    for name, data in planted.items():
        (skill_dir / name).write_bytes(data)

    listed = {item["path"] for item in client.get("/api/memory/skills").json()["skills"]}
    hits = {hit["path"] for hit in client.get("/api/memory/skills/search", params={"q": "needle"}).json()["hits"]}

    expected = set(planted) - {"bundle"}
    assert listed == expected
    assert hits == expected

    for name in sorted(expected):
        detail = client.get("/api/memory/skills/read", params={"path": name})
        assert detail.status_code == 200, f"{name} advertised but read refused it"
        assert detail.json()["path"] == name
        assert detail.json()["content"]


def test_skill_read_serves_non_utf8_bytes_instead_of_failing(memory_client) -> None:
    """A skill that is not valid UTF-8 is lossy-decoded, never a 500."""
    client, memory_dir, _admin_data = memory_client
    skill_dir = memory_dir / "skill_search"
    skill_dir.mkdir()
    (skill_dir / "gbk.md").write_bytes("\u6807\u9898 needle\n".encode("gbk"))

    response = client.get("/api/memory/skills/read", params={"path": "gbk.md"})

    assert response.status_code == 200
    content = response.json()["content"]
    assert "needle" in content
    assert "\ufffd" in content


def test_skill_endpoints_reject_binary_even_without_an_extension(memory_client) -> None:
    """The allow-list admits extensionless names, so binary is sniffed out."""
    client, memory_dir, _admin_data = memory_client
    skill_dir = memory_dir / "skill_search"
    skill_dir.mkdir()
    (skill_dir / "bundle").write_bytes(b"\x89PNG\r\n\x1a\n\x00\x00binary\n")

    detail = client.get("/api/memory/skills/read", params={"path": "bundle"})

    assert detail.status_code == 400
    assert "binary" in detail.json()["detail"]
    assert client.get("/api/memory/skills").json()["skills"] == []
    assert client.get("/api/memory/skills/search", params={"q": "binary"}).json()["hits"] == []
