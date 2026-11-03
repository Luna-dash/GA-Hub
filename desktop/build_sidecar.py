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
        # PyInstaller does not automatically retain Conda's OpenSSL runtime,
        # even though _ssl.pyd links to it.  A frozen uvicorn import otherwise
        # fails before the lifecycle protocol can emit its first event.
        conda_bin = Path(sys.prefix) / "Library" / "bin"
        for pattern in ("libssl-*.dll", "libcrypto-*.dll"):
            for dependency in sorted(conda_bin.glob(pattern)):
                command.extend(["--add-binary", f"{dependency};."])
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
