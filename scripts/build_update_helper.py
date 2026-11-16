"""Build only the external updater; never builds/restarts desktop or sidecar."""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    # Conda DLLs live outside DLLs/ and may be absent from the invoking PATH.
    binaries = []
    library = Path(sys.prefix) / "Library/bin"
    # Keep in sync with desktop/build_sidecar.py: Conda C extensions link
    # against these Library/bin DLLs and PyInstaller will not collect them.
    for name in ("ffi.dll", "libbz2.dll", "liblzma.dll", "libcrypto-3-x64.dll",
                 "libssl-3-x64.dll", "zlib.dll", "libexpat.dll", "sqlite3.dll"):
        path = library / name
        if path.is_file():
            binaries += ["--add-binary", f"{path}{__import__('os').pathsep}."]
    subprocess.run([
        sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile",
        "--console", "--name", "ga-hub-update", "--paths", str(ROOT),
        "--distpath", str(output / "dist"), "--workpath", str(output / "build"),
        "--specpath", str(output), *binaries, str(ROOT / "scripts/update_helper_entry.py"),
    ], cwd=ROOT, check=True)
    print(output / "dist/ga-hub-update.exe")


if __name__ == "__main__":
    main()
