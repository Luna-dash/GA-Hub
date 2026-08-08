"""Keep release metadata aligned with the Python project version."""
from __future__ import annotations

import json
import re
import tomllib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _toml(relative: str) -> dict:
    with (ROOT / relative).open("rb") as handle:
        return tomllib.load(handle)


def _json(relative: str) -> dict:
    return json.loads((ROOT / relative).read_text(encoding="utf-8"))


def test_release_versions_match_pyproject() -> None:
    version = _toml("pyproject.toml")["project"]["version"]

    assert _json("webui/package.json")["version"] == version
    webui_lock = _json("webui/package-lock.json")
    assert webui_lock["version"] == version
    assert webui_lock["packages"][""]["version"] == version

    assert _json("src-tauri/tauri.conf.json")["version"] == version
    assert _toml("src-tauri/Cargo.toml")["package"]["version"] == version
    cargo_packages = [
        package
        for package in _toml("src-tauri/Cargo.lock")["package"]
        if package["name"] == "ga-hub-desktop"
    ]
    assert len(cargo_packages) == 1
    assert cargo_packages[0]["version"] == version

    main_source = (ROOT / "server/main.py").read_text(encoding="utf-8")
    assert re.search(rf"FastAPI\(.*?version=[\"']{re.escape(version)}[\"']", main_source, re.DOTALL)

    spec_source = (ROOT / "build/admin.spec").read_text(encoding="utf-8")
    bundle_versions = re.findall(r'"CFBundle(?:ShortVersionString|Version)": "([^"]+)"', spec_source)
    assert bundle_versions
    assert set(bundle_versions) == {version}
