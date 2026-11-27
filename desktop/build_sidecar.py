#!/usr/bin/env python3
"""Build the target-specific, self-contained Tauri production sidecar (--onedir)."""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BIN = ROOT / "src-tauri" / "binaries"
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from desktop.runtime_dependencies import (
    hidden_import_args, conda_runtime_binary_args, runtime_binary_args,
)
from desktop.sidecar_archive import EXCLUDED_MODULES, verify_sidecar_archive

# Desktop Nova only needs the shared gateway core. Standalone deployment/UI,
# tests, build scripts, docs and caches remain in the source/connector package.
RUNTIME_ASSETS = {
    "nova": ("connector.py",),
    "remote_access": ("gateway.py", "artifacts.py", "remote_progress.py"),
}
MEI_BUNDLE_SENTINEL = "gahub_sidecar_bundle.json"


def write_bundle_sentinel(staging_root: Path) -> Path:
    """Write a marker file bundled into the sidecar root for diagnostics."""
    staging_root.mkdir(parents=True, exist_ok=True)
    sentinel = staging_root / MEI_BUNDLE_SENTINEL
    sentinel.write_text('{"app":"ga-hub-sidecar","layout":"onedir"}\n', encoding="utf-8")
    return sentinel


def stage_assets(staging_root: Path) -> dict[str, Path]:
    """Copy only declared runtime resources; missing input aborts the build."""
    staged: dict[str, Path] = {}
    for name, files in RUNTIME_ASSETS.items():
        source = ROOT / "assets" / name
        destination = staging_root / name
        shutil.rmtree(destination, ignore_errors=True)
        destination.mkdir(parents=True)
        for filename in files:
            if not (source / filename).is_file():
                raise RuntimeError(f"Required desktop asset missing: {source / filename}")
            shutil.copy2(source / filename, destination / filename)
        staged[name] = destination
    return staged


def _add_data_args(staged: dict[str, Path], sentinel: Path | None = None) -> list[str]:
    args: list[str] = []
    for name, path in staged.items():
        args.extend(["--add-data", f"{path};assets/{name}"])
    if sentinel is not None:
        args.extend(["--add-data", f"{sentinel};."])
    pricing_catalog = ROOT / "server" / "services" / "agy_pricing_catalog.json"
    if not pricing_catalog.is_file():
        raise RuntimeError(f"Missing pricing catalog: {pricing_catalog}")
    args.extend(["--add-data", f"{pricing_catalog};server/services"])
    return args


def sidecar_dir_for_target(target: str) -> Path:
    return BIN / f"sidecar-{target}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", required=True, help="Rust target triple used by Tauri")
    parser.add_argument("--pyinstaller", default=sys.executable)
    args = parser.parse_args()
    suffix = ".exe" if "windows" in args.target else ""
    destination_dir = sidecar_dir_for_target(args.target)
    destination_exe = destination_dir / f"ga-hub-sidecar{suffix}"

    # Keep PyInstaller's build scratch out of the repository tree.
    workspace = Path(tempfile.gettempdir()) / "gahub-desktop-sidecar-build"
    workpath = workspace / "work"
    distpath = workspace / "dist"
    specpath = workspace / "spec"
    command = [
        args.pyinstaller, "-m", "PyInstaller", "--clean", "--noconfirm", "--onedir",
        "--name", "ga-hub-sidecar", "--paths", str(ROOT),
        "--workpath", str(workpath), "--distpath", str(distpath),
        "--specpath", str(specpath), "--collect-submodules", "server",
        *(arg for name in EXCLUDED_MODULES for arg in ("--exclude-module", name)),
        "--collect-all", "websockets",
        "--collect-all", "aiohttp",
        *hidden_import_args(sys.platform),
        *(_add_data_args(stage_assets(workspace / "assets-stage"), write_bundle_sentinel(workspace))),
        "--noconsole",
        "--add-data", f"{ROOT / 'webui' / 'dist'};webui/dist",
    ]
    if suffix:
        command.extend(runtime_binary_args(Path(sys.prefix)))
    command.append(str(ROOT / "server" / "desktop_sidecar.py"))

    built_dir = distpath / "ga-hub-sidecar"
    built_exe = built_dir / f"ga-hub-sidecar{suffix}"
    # Never let a previous successful build masquerade as this run's output.
    shutil.rmtree(built_dir, ignore_errors=True)

    env = os.environ.copy()
    for name in ("PYTHONPATH", "PYTHONHOME", "GA_ROOT"):
        env.pop(name, None)
    result = subprocess.run(command, cwd=ROOT, env=env)
    if result.returncode:
        return result.returncode
    if not built_exe.is_file() or built_exe.stat().st_size == 0:
        print(f"expected PyInstaller onedir output missing/empty: {built_exe}", file=sys.stderr)
        return 2
    try:
        verify_sidecar_archive(built_exe)
    except ValueError as exc:
        print(exc, file=sys.stderr)
        return 2

    destination_dir.parent.mkdir(parents=True, exist_ok=True)
    staged = destination_dir.with_name(destination_dir.name + ".new")
    backup = destination_dir.with_name(destination_dir.name + ".old")
    shutil.rmtree(staged, ignore_errors=True)
    shutil.rmtree(backup, ignore_errors=True)
    try:
        shutil.copytree(built_dir, staged)
        if destination_dir.exists():
            destination_dir.replace(backup)
        staged.replace(destination_dir)
        shutil.rmtree(backup, ignore_errors=True)
    except BaseException:
        if not destination_dir.exists() and backup.exists():
            backup.replace(destination_dir)
        shutil.rmtree(staged, ignore_errors=True)
        raise

    print(destination_exe)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
