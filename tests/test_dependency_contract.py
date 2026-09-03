"""Keep pyproject.toml and requirements.txt from drifting apart.

requirements.txt is the pinned, reproducible snapshot of the dependency
ranges declared in pyproject.toml.  The BUILD.md fresh-machine flow installs
only from requirements.txt, so a dependency declared in pyproject but not
pinned here produces an environment where lazy runtime imports (qrcode,
python-multipart, PIL, ...) fail with ImportError — historically exactly the
gap that shipped.  Normalization: dist name lowercased, ``-``/``_`` folded.
"""
from __future__ import annotations

import re
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _canonical(name: str) -> str:
    return re.sub(r"[-_]+", "-", name).lower()


def _dep_name(requirement: str) -> str:
    """'requests[socks]>=2.28' -> 'requests' (extras/markers/version stripped)."""
    return _canonical(re.split(r"[<>=!~\[; ]", requirement.strip(), maxsplit=1)[0])


def _pyproject_runtime_deps() -> set[str]:
    data = tomllib.loads((ROOT / "pyproject.toml").read_text("utf-8"))
    return {_dep_name(dep) for dep in data["project"]["dependencies"]}


def _requirements_names() -> set[str]:
    names = set()
    for line in (ROOT / "requirements.txt").read_text("utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        names.add(_dep_name(line))
    return names


def test_every_pyproject_runtime_dependency_is_pinned_in_requirements():
    missing = _pyproject_runtime_deps() - _requirements_names()
    assert not missing, (
        "dependencies declared in pyproject.toml but missing from "
        f"requirements.txt (the BUILD.md install path): {sorted(missing)}"
    )


def test_requirements_carries_no_ghost_runtime_packages():
    """Catch deps that linger in requirements.txt after pyproject removal."""
    ghosts = _requirements_names() - _pyproject_runtime_deps() - {
        # Build/test toolchain intentionally lives only in requirements.txt.
        "httpx", "pyinstaller", "pytest",
    }
    assert not ghosts, (
        f"requirements.txt pins packages pyproject no longer declares: {sorted(ghosts)}"
    )
