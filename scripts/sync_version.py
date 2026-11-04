"""Sync/check first-party release versions; pyproject.toml is authoritative.

Usage: python scripts/sync_version.py [--check]
Edit pyproject.toml first, then run this script. Dependency versions are untouched.
"""
from __future__ import annotations

import argparse
import json
import re
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def expected_files(root: Path = ROOT) -> dict[Path, str]:
    version = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", version):
        raise ValueError(f"Invalid release version: {version}")
    updates = {}
    for name in ("package.json", "package-lock.json", "webui/package.json", "webui/package-lock.json", "src-tauri/tauri.conf.json"):
        path = root / name
        source = path.read_text(encoding="utf-8")
        count = 2 if name.endswith("package-lock.json") else 1
        # First version fields belong to the project/root package, not dependencies.
        updates[path] = re.sub(r'"version": "[^"]+"', f'"version": "{version}"', source, count=count)
    substitutions = {
        "src-tauri/Cargo.toml": (r'(\[package\][\s\S]*?\nversion = ")[^"]+', rf'\g<1>{version}'),
        "src-tauri/Cargo.lock": (r'(name = "ga-hub-desktop"\nversion = ")[^"]+', rf'\g<1>{version}'),
        "server/main.py": (r'(FastAPI\([\s\S]*?version=")[^"]+', rf'\g<1>{version}'),
    }
    for name, (pattern, replacement) in substitutions.items():
        path = root / name
        updated, count = re.subn(pattern, replacement, path.read_text(encoding="utf-8"), count=1)
        if count != 1:
            raise ValueError(f"Missing version field: {name}")
        updates[path] = updated
    path = root / "docs/api/openapi.json"
    source = path.read_text(encoding="utf-8")
    old = json.loads(source)["info"]["version"]
    updates[path] = source.replace(f'"version": "{old}"', f'"version": "{version}"', 1)
    return updates


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    changed = []
    for path, expected in expected_files().items():
        if path.read_text(encoding="utf-8") != expected:
            changed.append(str(path.relative_to(ROOT)))
            if not args.check:
                path.write_text(expected, encoding="utf-8")
    if args.check and changed:
        print("Version mismatch: " + ", ".join(changed))
        return 1
    print("Release versions aligned" + (": " + ", ".join(changed) if changed else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
