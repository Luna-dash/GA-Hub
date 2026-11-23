"""Build only the external updater; never builds/restarts desktop or sidecar."""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from desktop.runtime_dependencies import runtime_binary_args


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    binaries = runtime_binary_args(Path(sys.prefix)) if sys.platform == "win32" else []
    built = output / "dist" / "ga-hub-update.exe"
    built.unlink(missing_ok=True)
    subprocess.run([
        sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile",
        "--console", "--name", "ga-hub-update", "--paths", str(ROOT),
        "--distpath", str(output / "dist"), "--workpath", str(output / "build"),
        "--specpath", str(output), "--add-data", f"{ROOT / 'scripts/install_update_task.ps1'};scripts", *binaries, str(ROOT / "scripts/update_helper_entry.py"),
    ], cwd=ROOT, check=True)
    if not built.is_file() or built.stat().st_size == 0:
        raise RuntimeError(f"Expected non-empty update helper output missing: {built}")
    print(built)


if __name__ == "__main__":
    main()
