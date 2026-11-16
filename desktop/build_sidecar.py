#!/usr/bin/env python3
"""Build the target-specific, self-contained Tauri production sidecar."""
from __future__ import annotations
import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BIN = ROOT / "src-tauri" / "binaries"
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from desktop.runtime_dependencies import hidden_import_args
ASSET_DIRS = ("nova", "remote_access")
# PyInstaller 的 --add-data 会整棵目录收进包，连解释器缓存一起带走。
# __pycache__ 里的 .pyc 可能是早已删除的模块（例如撤回的 nova 云端 server.py），
# 于是「源码撤了、成品里还留着字节码」。资源目录一律先过滤再入包。
EXCLUDED_ASSET_DIRS = frozenset({"__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache"})
EXCLUDED_ASSET_SUFFIXES = frozenset({".pyc", ".pyo"})

# PyInstaller does not automatically retain Conda's runtime DLLs: C extensions in
# DLLs/*.pyd link against libraries that live in Library/bin, outside the
# interpreter's DLL search path.  A missing one is invisible during Analysis and
# only surfaces at process start -- on 2026-11-16 pyexpat.pyd lost libexpat.dll,
# and the pkg_resources runtime hook crashed the sidecar before any business code.
# Every critical dependency must therefore be explicit, and a glob that matches
# nothing must fail the build instead of silently shipping a broken onefile.
CONDA_RUNTIME_DLL_PATTERNS = (
    "libssl-*.dll", "libcrypto-*.dll",
    "libexpat*.dll", "expat.dll",
    "ffi.dll", "libbz2.dll", "liblzma.dll", "sqlite3.dll", "zlib.dll",
)
CRITICAL_CONDA_DLLS = ("libexpat.dll", "ffi.dll", "libbz2.dll", "liblzma.dll", "sqlite3.dll")


def conda_runtime_binary_args(conda_bin: Path) -> list[str]:
    """Build --add-binary args for Conda DLLs, rejecting a silent miss."""
    matches = {
        dependency.name.lower(): dependency
        for pattern in CONDA_RUNTIME_DLL_PATTERNS
        for dependency in conda_bin.glob(pattern)
    }
    missing = [name for name in CRITICAL_CONDA_DLLS if name not in matches]
    if missing:
        raise RuntimeError(
            f"Conda runtime DLLs missing from {conda_bin}: {', '.join(missing)}"
        )
    args: list[str] = []
    for dependency in sorted(matches.values(), key=lambda path: path.name.lower()):
        args.extend(["--add-binary", f"{dependency};."])
    return args


def asset_ignore(directory: str, names: list[str]) -> set[str]:
    """copytree 的 ignore 回调：拦解释器/工具缓存，其余原样保留。"""
    return {
        name for name in names
        if name in EXCLUDED_ASSET_DIRS or Path(name).suffix.lower() in EXCLUDED_ASSET_SUFFIXES
    }


def stage_assets(staging_root: Path) -> dict[str, Path]:
    """把资源目录复制一份（已过滤缓存）并返回 {资源名: 暂存路径}。"""
    staged: dict[str, Path] = {}
    for name in ASSET_DIRS:
        source = ROOT / "assets" / name
        if not source.is_dir():
            continue
        destination = staging_root / name
        # 暂存目录跨构建复用，先清空：否则仓库里删掉的文件会以旧副本继续入包。
        shutil.rmtree(destination, ignore_errors=True)
        shutil.copytree(source, destination, ignore=asset_ignore)
        staged[name] = destination
    return staged


def _add_data_args(staged: dict[str, Path]) -> list[str]:
    args: list[str] = []
    for name, path in staged.items():
        args.extend(["--add-data", f"{path};assets/{name}"])
    worker = ROOT / "server" / "services" / "message-presentation-worker.cjs"
    if not worker.is_file():
        raise RuntimeError("Build message presentation with node assets/remote_access/build-remote.cjs")
    args.extend(["--add-data", f"{worker};server/services"])
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
               "--specpath", str(specpath), "--collect-all", "server",
               "--collect-all", "websockets",
               "--collect-all", "aiohttp",
               *hidden_import_args(sys.platform),
               *(_add_data_args(stage_assets(workspace / "assets-stage"))),
               "--noconsole",
               "--add-data", f"{ROOT / 'webui' / 'dist'};webui/dist"]
    if suffix:
        command.extend(conda_runtime_binary_args(Path(sys.prefix) / "Library" / "bin"))
    command.append(str(ROOT / "server" / "desktop_sidecar.py"))
    built = distpath / f"ga-hub-sidecar{suffix}"
    # Never let a previous successful build masquerade as this run's output.
    built.unlink(missing_ok=True)
    result = subprocess.run(command, cwd=ROOT)
    if result.returncode:
        return result.returncode
    if not built.is_file():
        print(f"expected PyInstaller output missing: {built}", file=sys.stderr)
        return 2
    if built.stat().st_size == 0:
        print(f"PyInstaller output is empty: {built}", file=sys.stderr)
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
