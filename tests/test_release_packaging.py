"""Release version synchronization and portable packaging contracts."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import subprocess
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_sync_is_idempotent_and_does_not_touch_dependencies():
    sync = load("sync_version")
    expected = sync.expected_files()
    assert all(path.read_text(encoding="utf-8") == text for path, text in expected.items())
    cargo = expected[ROOT / "src-tauri/Cargo.lock"]
    assert 'name = "getrandom"\nversion = "0.3.4"' in cargo


@pytest.fixture
def checkout(tmp_path):
    (tmp_path / "pyproject.toml").write_text('[project]\nversion = "1.0.0"\n')
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    subprocess.run(["git", "add", "."], cwd=tmp_path, check=True)
    subprocess.run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], cwd=tmp_path, check=True)
    return tmp_path


def artifacts(root):
    directory = root / "src-tauri/target/x86_64-pc-windows-msvc/release"
    directory.mkdir(parents=True)
    for name in ("ga-hub-desktop.exe", "ga-hub-sidecar.exe"):
        (directory / name).write_bytes(name.encode())


def test_package_contains_both_exes_and_traceable_metadata(checkout):
    artifacts(checkout)
    archive = load("package_release").package(checkout, checkout / "output", "v1.0.0")
    assert archive.name == "GA-Hub-1.0.0-windows-x64.zip"
    with zipfile.ZipFile(archive) as z:
        assert set(z.namelist()) == {"ga-hub-desktop.exe", "ga-hub-sidecar.exe", "README.txt", "build-info.json"}
        info = json.loads(z.read("build-info.json"))
        assert info["version"] == "1.0.0" and info["channel"] == "stable" and not info["dirty"]
        for name, digest in info["sha256"].items():
            assert hashlib.sha256(z.read(name)).hexdigest() == digest
    assert hashlib.sha256(archive.read_bytes()).hexdigest() in (checkout / "output/SHA256SUMS.txt").read_text()


def test_package_rejects_wrong_tag(checkout):
    with pytest.raises(ValueError, match="Tag"):
        load("package_release").package(checkout, checkout / "output", "v0.3.4")


def test_package_rejects_missing_or_empty_exe(checkout):
    artifacts(checkout)
    side = checkout / "src-tauri/target/x86_64-pc-windows-msvc/release/ga-hub-sidecar.exe"
    side.write_bytes(b"")
    with pytest.raises(ValueError, match="Missing/empty"):
        load("package_release").package(checkout, checkout / "output", "v1.0.0")
    side.unlink()
    with pytest.raises(ValueError, match="Missing/empty"):
        load("package_release").package(checkout, checkout / "output", "v1.0.0")


@pytest.mark.parametrize("staged", [False, True])
def test_package_rejects_dirty_release(checkout, staged):
    (checkout / "pyproject.toml").write_text('[project]\nversion = "1.0.0"\n# dirty\n')
    if staged:
        subprocess.run(["git", "add", "pyproject.toml"], cwd=checkout, check=True)
    with pytest.raises(ValueError, match="dirty"):
        load("package_release").package(checkout, checkout / "output", "v1.0.0")


def test_package_accepts_normalized_line_endings(checkout):
    subprocess.run(["git", "config", "core.autocrlf", "true"], cwd=checkout, check=True)
    # Reproduce Tauri rewriting a CRLF checkout using LF without changing content.
    path = checkout / "pyproject.toml"
    path.write_bytes(b'[project]\r\nversion = "1.0.0"\r\n')
    subprocess.run(["git", "add", "pyproject.toml"], cwd=checkout, check=True)
    subprocess.run(["git", "update-index", "--refresh"], cwd=checkout, check=True)
    path.write_bytes(b'[project]\nversion = "1.0.0"\n')
    artifacts(checkout)
    load("package_release").package(checkout, checkout / "output", "v1.0.0")
    info = json.loads((checkout / "output/build-info.json").read_text())
    assert info["dirty"] is False and info["channel"] == "stable"


def test_preview_is_distinguishable(checkout):
    artifacts(checkout)
    archive = load("package_release").package(checkout, checkout / "output")
    assert archive.name.startswith("GA-Hub-1.0.0-")
    info = json.loads((checkout / "output/build-info.json").read_text())
    assert info["channel"] == "preview" and info["tag"] is None
