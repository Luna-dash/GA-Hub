#!/usr/bin/env python3
"""Build the target-specific, self-contained Tauri production sidecar."""
from __future__ import annotations
import argparse
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BIN = ROOT / "src-tauri" / "binaries"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", required=True, help="Rust target triple used by Tauri")
    parser.add_argument("--pyinstaller", default=sys.executable)
    args = parser.parse_args()
    suffix = ".exe" if "windows" in args.target else ""
    destination = BIN / f"ga-hub-sidecar-{args.target}{suffix}"
    workspace = ROOT / "temp" / "desktop-sidecar-build"
    workpath = workspace / "work"
    distpath = workspace / "dist"
    specpath = workspace / "spec"
    command = [args.pyinstaller, "-m", "PyInstaller", "--clean", "--noconfirm", "--onefile",
               "--name", "ga-hub-sidecar", "--paths", str(ROOT),
               "--workpath", str(workpath), "--distpath", str(distpath),
               "--specpath", str(specpath), "--collect-all", "server"]
    if suffix:
        # PyInstaller does not automatically retain Conda's OpenSSL runtime,
        # even though _ssl.pyd links to it.  A frozen uvicorn import otherwise
        # fails before the lifecycle protocol can emit its first event.
        conda_bin = Path(sys.prefix) / "Library" / "bin"
        for pattern in ("libssl-*.dll", "libcrypto-*.dll"):
            for dependency in sorted(conda_bin.glob(pattern)):
                command.extend(["--add-binary", f"{dependency};."])
    command.append(str(ROOT / "server" / "desktop_sidecar.py"))
    result = subprocess.run(command, cwd=ROOT)
    if result.returncode:
        return result.returncode
    built = distpath / f"ga-hub-sidecar{suffix}"
    if not built.is_file():
        print(f"expected PyInstaller output missing: {built}", file=sys.stderr)
        return 2
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(built, destination)
    print(destination)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
