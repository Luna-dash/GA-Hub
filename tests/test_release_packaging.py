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
    (directory / "sidecar" / "_internal").mkdir(parents=True)
    (directory / "ga-hub-desktop.exe").write_bytes(b"ga-hub-desktop.exe")
    (directory / "ga-hub-update.exe").write_bytes(b"ga-hub-update.exe")
    (directory / "sidecar" / "ga-hub-sidecar.exe").write_bytes(b"ga-hub-sidecar.exe")
    (directory / "sidecar" / "_internal" / "python312.dll").write_bytes(b"python312.dll")


def test_package_contains_both_exes_and_traceable_metadata(checkout, monkeypatch):
    artifacts(checkout)
    module = load("package_release")
    checked = []
    monkeypatch.setattr(module, "verify_sidecar_archive", checked.append)
    archive = module.package(checkout, checkout / "output", "v1.0.0")
    assert [path.name for path in checked] == ["ga-hub-sidecar.exe"]
    assert archive.name == "GA-Hub-1.0.0-windows-x64.zip"
    with zipfile.ZipFile(archive) as z:
        assert set(z.namelist()) == {
            "ga-hub-desktop.exe",
            "ga-hub-update.exe",
            "sidecar/ga-hub-sidecar.exe",
            "sidecar/_internal/python312.dll",
            "README.txt",
            "build-info.json",
            "update-manifest.json",
        }
        assert json.loads(z.read("update-manifest.json")) == {
            "schema": 2,
            "data_epoch": 2,
            "platform": "windows-x64",
            "layout": "onedir",
        }
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
    side = checkout / "src-tauri/target/x86_64-pc-windows-msvc/release/sidecar/ga-hub-sidecar.exe"
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


def test_package_accepts_normalized_line_endings(checkout, monkeypatch):
    module = load("package_release")
    monkeypatch.setattr(module, "verify_sidecar_archive", lambda _: None)
    subprocess.run(["git", "config", "core.autocrlf", "true"], cwd=checkout, check=True)
    # Reproduce Tauri rewriting a CRLF checkout using LF without changing content.
    path = checkout / "pyproject.toml"
    path.write_bytes(b'[project]\r\nversion = "1.0.0"\r\n')
    subprocess.run(["git", "add", "pyproject.toml"], cwd=checkout, check=True)
    subprocess.run(["git", "update-index", "--refresh"], cwd=checkout, check=True)
    path.write_bytes(b'[project]\nversion = "1.0.0"\n')
    artifacts(checkout)
    module.package(checkout, checkout / "output", "v1.0.0")
    info = json.loads((checkout / "output/build-info.json").read_text())
    assert info["dirty"] is False and info["channel"] == "stable"


def test_preview_is_distinguishable(checkout, monkeypatch):
    module = load("package_release")
    monkeypatch.setattr(module, "verify_sidecar_archive", lambda _: None)
    artifacts(checkout)
    archive = module.package(checkout, checkout / "output")
    assert archive.name.startswith("GA-Hub-1.0.0-")
    info = json.loads((checkout / "output/build-info.json").read_text())
    assert info["channel"] == "preview" and info["tag"] is None



def test_portable_packaging_rejects_unverifiable_sidecar(checkout):
    artifacts(checkout)
    # Plant a forbidden module inside sidecar/_internal/ to verify packaging rejects it
    (checkout / "src-tauri/target/x86_64-pc-windows-msvc/release/sidecar/_internal/numpy.py").write_text("", encoding="utf-8")
    out = checkout / "output"
    with pytest.raises(ValueError, match="excluded modules"):
        load("package_release").package(checkout, out, "v1.0.0")
    assert not list(out.glob("*.zip"))
