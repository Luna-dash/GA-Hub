"""Package a verified Windows portable build (--onedir sidecar + Rust updater) with checksums."""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import tomllib
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from desktop.sidecar_archive import verify_sidecar_archive

DATA_EPOCH = 2


def _collect_release_files(source: Path) -> list[tuple[Path, str]]:
    """Return (absolute_path, archive_relative_posix_path) for every deliverable file."""
    desktop_exe = source / "ga-hub-desktop.exe"
    updater_exe = source / "ga-hub-update.exe"
    sidecar_dir = source / "sidecar"
    sidecar_exe = sidecar_dir / "ga-hub-sidecar.exe"

    for required in (desktop_exe, updater_exe, sidecar_exe):
        if not required.is_file() or required.stat().st_size == 0:
            raise ValueError(f"Missing/empty build artifact: {required}")

    entries: list[tuple[Path, str]] = [
        (desktop_exe, "ga-hub-desktop.exe"),
        (updater_exe, "ga-hub-update.exe"),
    ]
    for path in sorted(sidecar_dir.rglob("*")):
        if path.is_file():
            rel = path.relative_to(source).as_posix()
            entries.append((path, rel))
    return entries


def package(root: Path, output: Path, tag: str | None = None) -> Path:
    version = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]
    if tag is not None and tag != f"v{version}":
        raise ValueError(f"Tag {tag} does not match v{version}")
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    diff = subprocess.run(["git", "diff", "--quiet", "HEAD", "--"], cwd=root)
    if diff.returncode not in (0, 1):
        diff.check_returncode()
    dirty = diff.returncode == 1
    if tag and dirty:
        raise ValueError("Refusing to release a dirty tracked tree")

    source = root / "src-tauri/target/x86_64-pc-windows-msvc/release"
    entries = _collect_release_files(source)
    verify_sidecar_archive(source / "sidecar" / "ga-hub-sidecar.exe")

    file_hashes = {
        rel: hashlib.sha256(path.read_bytes()).hexdigest()
        for path, rel in entries
    }
    metadata = {
        "version": version,
        "commit": commit,
        "dirty": dirty,
        "channel": "stable" if tag else "preview",
        "tag": tag,
        "built_at": datetime.now(timezone.utc).isoformat(),
        "platform": "windows-x64",
        "layout": "onedir",
        "sha256": file_hashes,
    }
    output.mkdir(parents=True, exist_ok=True)
    (output / "build-info.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    suffix = "" if tag else f"-{commit[:7]}" + ("-dirty" if dirty else "")
    archive = output / f"GA-Hub-{version}{suffix}-windows-x64.zip"
    readme = (
        f"GA-Hub {version}\nCommit: {commit}\n\n"
        "Extract ALL files and the sidecar/ directory together; launch ga-hub-desktop.exe.\n"
        "Keep sidecar/ and ga-hub-update.exe beside ga-hub-desktop.exe.\n"
        "Settings > Updates supports one-click GitHub Release updates and local ZIP updates with automatic rollback.\n"
        "Portable green folder: no installer, no registry entries, no administrator rights required.\n"
        "The GA core checkout/interpreter still requires setup; the Hub backend is bundled.\n"
    )
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as z:
        for path, rel in entries:
            z.write(path, rel)
        z.write(output / "build-info.json", "build-info.json")
        z.writestr("update-manifest.json", json.dumps({
            "schema": 2,
            "data_epoch": DATA_EPOCH,
            "platform": "windows-x64",
            "layout": "onedir",
        }, indent=2))
        z.writestr("README.txt", readme)

    top_checksums = {
        "ga-hub-desktop.exe": file_hashes["ga-hub-desktop.exe"],
        "sidecar/ga-hub-sidecar.exe": file_hashes["sidecar/ga-hub-sidecar.exe"],
        "ga-hub-update.exe": file_hashes["ga-hub-update.exe"],
        archive.name: hashlib.sha256(archive.read_bytes()).hexdigest(),
    }
    (output / "SHA256SUMS.txt").write_text(
        "".join(f"{digest}  {name}\n" for name, digest in top_checksums.items()),
        encoding="utf-8",
    )
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
