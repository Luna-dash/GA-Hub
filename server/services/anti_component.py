"""Locate the trusted packaged AntiCLI or a developer's PATH install."""
from pathlib import Path
import os
import shutil
import sys

from .. import _paths


def _bundled() -> Path | None:
    resources = getattr(sys, "_MEIPASS", None)
    if resources:
        candidate = Path(resources) / "runtime" / "anticli" / ("anticli.exe" if os.name == "nt" else "anticli")
        if candidate.is_file():
            return candidate
    return None


def executable() -> str | None:
    bundled = _bundled()
    return str(bundled) if bundled is not None else shutil.which("anticli")


def child_options(executable_path: str) -> dict:
    bundled = _bundled()
    if bundled is None or Path(executable_path) != bundled:
        return {}
    directory = _paths.ADMIN_DATA / "anticli"
    directory.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    for key in tuple(env):
        if key.startswith("_PYI_") or key in {"_MEIPASS2", "PYTHONHOME", "PYTHONPATH"}:
            env.pop(key, None)
    env.update(PYINSTALLER_RESET_ENVIRONMENT="1", ANTICLI_DATA_DIR=str(directory / "data"))
    return {"cwd": directory, "env": env}
