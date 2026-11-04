"""Package a verified Windows portable build with provenance and checksums."""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import tomllib
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def package(root: Path, output: Path, tag: str | None = None) -> Path:
    version = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]
    if tag is not None and tag != f"v{version}":
        raise ValueError(f"Tag {tag} does not match v{version}")
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    dirty = bool(subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=no"], cwd=root, text=True).strip())
    if tag and dirty:
        raise ValueError("Refusing to release a dirty tracked tree")
    source = root / "src-tauri/target/x86_64-pc-windows-msvc/release"
    files = [source / "ga-hub-desktop.exe", source / "ga-hub-sidecar.exe"]
    for path in files:
        if not path.is_file() or path.stat().st_size == 0:
            raise ValueError(f"Missing/empty build artifact: {path}")
    metadata = {
        "version": version, "commit": commit, "dirty": dirty,
        "channel": "stable" if tag else "preview", "tag": tag,
        "built_at": datetime.now(timezone.utc).isoformat(), "platform": "windows-x64",
        "sha256": {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in files},
    }
    output.mkdir(parents=True, exist_ok=True)
    (output / "build-info.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    suffix = "" if tag else f"-{commit[:7]}" + ("-dirty" if dirty else "")
    archive = output / f"GA-Hub-{version}{suffix}-windows-x64.zip"
    readme = (
        f"GA-Hub {version}\nCommit: {commit}\n\n"
        "Extract ALL files together; launch ga-hub-desktop.exe.\n"
        "ga-hub-sidecar.exe must remain beside the desktop EXE.\n"
        "The GA core checkout/interpreter still requires setup; the Hub backend is bundled.\n"
        "Do not overwrite a running instance. Back up your data before upgrading.\n"
    )
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as z:
        for path in files:
            z.write(path, path.name)
        z.write(output / "build-info.json", "build-info.json")
        z.writestr("README.txt", readme)
    checksums = {**metadata["sha256"], archive.name: hashlib.sha256(archive.read_bytes()).hexdigest()}
    (output / "SHA256SUMS.txt").write_text("".join(f"{digest}  {name}\n" for name, digest in checksums.items()), encoding="utf-8")
    print(archive)
    return archive


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--tag")
    args = parser.parse_args()
    package(ROOT, args.output, args.tag)


if __name__ == "__main__":
    main()
