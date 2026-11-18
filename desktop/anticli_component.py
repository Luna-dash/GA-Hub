"""Build-time only: verify and freeze the reviewed AntiCLI source snapshot."""
from __future__ import annotations

import hashlib
from pathlib import Path
import subprocess
import sys

from .runtime_dependencies import runtime_binary_args

SOURCE_VERSION = "0.1.0"
SOURCE_SHA256 = "cfbf8282d758c8fbf7d75daaec447399f3c3a7a2452cf91771ffcefb537a3e81"


def stage_source(source: Path, destination: Path) -> Path:
    root = source / "src"
    files = sorted(p for p in (root / "anticli").rglob("*")
                   if p.is_file() and p.suffix in (".py", ".html"))
    snapshot = [(p.relative_to(root), p.read_bytes().replace(b"\r\n", b"\n")) for p in files]
    digest = hashlib.sha256(b"".join(path.as_posix().encode() + b"\0" + hashlib.sha256(data).digest()
                                     for path, data in snapshot)).hexdigest()
    if digest != SOURCE_SHA256:
        raise RuntimeError(f"AntiCLI {SOURCE_VERSION} source checksum mismatch: {digest}")
    for name, content in snapshot:
        path = destination / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    return destination


def build_anticli(source: Path, workspace: Path, *, python: str = sys.executable,
                  windows: bool = sys.platform == "win32") -> Path:
    from tempfile import TemporaryDirectory

    name = "anticli.exe" if windows else "anticli"
    workspace.mkdir(parents=True, exist_ok=True)
    built = workspace / "dist" / name
    built.unlink(missing_ok=True)
    binaries = []
    if windows:
        prefix = subprocess.check_output([python, "-c", "import sys; print(sys.prefix)"],
                                         encoding="utf-8").strip()
        binaries = runtime_binary_args(Path(prefix))
    with TemporaryDirectory(prefix="source-", dir=workspace) as snapshot:
        staged = stage_source(source, Path(snapshot))
        subprocess.run([python, "-m", "PyInstaller", "--clean", "--noconfirm", "--onefile",
                        "--name", "anticli", "--paths", str(staged),
                        "--workpath", str(workspace / "work"), "--specpath", str(workspace),
                        "--distpath", str(built.parent), "--collect-data", "anticli", *binaries,
                        str(Path(__file__).with_name("anticli_entry.py"))], check=True, cwd=staged)
    if not built.is_file() or not built.stat().st_size:
        raise RuntimeError("AntiCLI component build did not produce an executable")
    return built
