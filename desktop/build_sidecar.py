#!/usr/bin/env python3
"""Build the target-specific, self-contained Tauri production sidecar."""
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
from desktop.node_runtime import stage_node
from desktop.sidecar_archive import EXCLUDED_MODULES, verify_sidecar_archive

# Desktop Nova only needs the shared gateway core. Standalone deployment/UI,
# tests, build scripts, docs and caches remain in the source/connector package.
RUNTIME_ASSETS = {
    "nova": ("connector.py",),
    "remote_access": ("gateway.py", "artifacts.py", "remote_progress.py"),
}
MEI_BUNDLE_SENTINEL = "gahub_sidecar_bundle.json"


def write_bundle_sentinel(staging_root: Path) -> Path:
    """Write a marker file bundled into `_MEI*` root so cleanup identifies our unpack dir."""
    staging_root.mkdir(parents=True, exist_ok=True)
    sentinel = staging_root / MEI_BUNDLE_SENTINEL
    sentinel.write_text('{"app":"ga-hub-sidecar"}\n', encoding="utf-8")
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
    worker = ROOT / "server" / "services" / "message-presentation-worker.cjs"
    if not worker.is_file():
        raise RuntimeError("Build message presentation with node assets/remote_access/build-remote.cjs")
    args.extend(["--add-data", f"{worker};server/services"])
    pricing_catalog = ROOT / "server" / "services" / "agy_pricing_catalog.json"
    if not pricing_catalog.is_file():
        raise RuntimeError(f"Missing pricing catalog: {pricing_catalog}")
    args.extend(["--add-data", f"{pricing_catalog};server/services"])
    return args


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", required=True, help="Rust target triple used by Tauri")
    parser.add_argument("--pyinstaller", default=sys.executable)
    args = parser.parse_args()
    suffix = ".exe" if "windows" in args.target else ""
    destination = BIN / f"ga-hub-sidecar-{args.target}{suffix}"
    # PyInstaller's workpath/distpath/specpath churn ~150MB per build; keep
    # that out of the repo tree so temp/ holds no irreplaceable weight.
    workspace = Path(tempfile.gettempdir()) / "gahub-desktop-sidecar-build"
    workpath = workspace / "work"
    distpath = workspace / "dist"
    specpath = workspace / "spec"
    command = [args.pyinstaller, "-m", "PyInstaller", "--clean", "--noconfirm", "--onefile",
               "--name", "ga-hub-sidecar", "--paths", str(ROOT),
               "--workpath", str(workpath), "--distpath", str(distpath),
               "--specpath", str(specpath), "--collect-submodules", "server",
               *(arg for name in EXCLUDED_MODULES for arg in ("--exclude-module", name)),
               "--collect-all", "websockets",
               "--collect-all", "aiohttp",
               *hidden_import_args(sys.platform),
               *(_add_data_args(stage_assets(workspace / "assets-stage"), write_bundle_sentinel(workspace))),
               "--add-binary", f"{stage_node(workspace / 'node-stage', args.target) / ('node.exe' if suffix else 'node')};runtime/node",
               "--add-data", f"{workspace / 'node-stage' / 'LICENSE'};runtime/node",
               "--add-data", f"{workspace / 'node-stage' / 'runtime.json'};runtime/node",
               "--noconsole",
               "--add-data", f"{ROOT / 'webui' / 'dist'};webui/dist"]
    if suffix:
        command.extend(runtime_binary_args(Path(sys.prefix)))
    command.append(str(ROOT / "server" / "desktop_sidecar.py"))
    built = distpath / f"ga-hub-sidecar{suffix}"
    # Never let a previous successful build masquerade as this run's output.
    built.unlink(missing_ok=True)
    env = os.environ.copy()
    for name in ("PYTHONPATH", "PYTHONHOME", "GA_ROOT"):
        env.pop(name, None)
    result = subprocess.run(command, cwd=ROOT, env=env)
    if result.returncode:
        return result.returncode
    if not built.is_file():
        print(f"expected PyInstaller output missing: {built}", file=sys.stderr)
        return 2
    if built.stat().st_size == 0:
        print(f"PyInstaller output is empty: {built}", file=sys.stderr)
        return 2
    try:
        verify_sidecar_archive(built)
    except ValueError as exc:
        print(exc, file=sys.stderr)
        return 2
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Stage next to destination and atomically replace: a failed copy never
    # truncates the last known-good sidecar; Windows also refuses replacement
    # when a running process holds the image open.
    staged = destination.with_name(destination.name + ".new")
    try:
        shutil.copy2(built, staged)
        staged.replace(destination)
    finally:
        staged.unlink(missing_ok=True)
    print(destination)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
