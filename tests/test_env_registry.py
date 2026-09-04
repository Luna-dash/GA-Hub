"""GA_HUB_* / GAHUB_* / GA_MYKEY_* names must be registered in
server/constants.py (or whitelisted as protocol markers). A static scan keeps
the registry from drifting."""
from __future__ import annotations

import re
from pathlib import Path

from server import constants

ROOT = Path(__file__).resolve().parents[1]
SCAN_TARGETS = [
    ROOT / "server",
    ROOT / "scripts",
    ROOT / "src-tauri" / "src",
]

# Protocol markers are GA_HUB_-namespaced strings but NOT environment inputs.
MARKERS = {
    "GA_HUB_MYKEY_PYTHON",  # stdout probe marker (routes/mykey.py)
    "GA_HUB_HIDE_LOADING",  # Tauri loading gate (main.rs)
    "GA_HUB_RUNTIME",       # window global injected by main.rs
    "GAHUB_FEISHU_CHAT",    # chat id marker in feishu messages (feishu_service)
}


def _registered_names() -> set[str]:
    return {
        constants.ENV_RUNTIME_HOST,
        constants.ENV_RUNTIME_PORT,
        constants.ENV_ENABLE_EXTERNAL_SITE_PATHS,
        constants.ENV_SIDECAR_PYTHON,
        constants.ENV_SIDECAR,
        constants.ENV_BRIDGE_PORT,
        constants.ENV_SESSION_RUN_CAPACITY,
        constants.ENV_GAHUB_TEMP_DIR,
        constants.ENV_GAHUB_JOURNAL_PATH,
        constants.ENV_GAHUB_ALLOWED_HOSTS,
        constants.ENV_MYKEY_SYNC_URL,
        constants.ENV_MYKEY_SYNC_PASSPHRASE,
        constants.ENV_MYKEY_UPLOAD_TOKEN,
        # conductor_client builds these dynamically (GAHUB_ + config key
        # upper-cased); registration is by hand, the scan cannot see them.
        constants.ENV_GAHUB_GAHUB_PYTHON,
        constants.ENV_GAHUB_GAHUB_PORT,
        constants.ENV_GAHUB_GAHUB_TOKEN,
    }


def _scan_files() -> list[Path]:
    files: list[Path] = []
    for target in SCAN_TARGETS:
        files.extend(target.rglob("*.py"))
        files.extend(target.rglob("*.rs"))
    return sorted(files)


def test_every_ga_hub_name_is_registered() -> None:
    registered = _registered_names() | MARKERS
    pattern = re.compile(r"(?:GA_HUB_|GAHUB_|GA_MYKEY_)[A-Z_]+")
    offenders: list[str] = []
    for path in _scan_files():
        for lineno, line in enumerate(
            path.read_text(encoding="utf-8").splitlines(), 1
        ):
            for match in pattern.findall(line):
                normalized = match.strip("_")
                if normalized not in registered:
                    offenders.append(f"{path.name}:{lineno}: {match}")
    assert offenders == [], "unregistered GA_HUB_* names:\n" + "\n".join(offenders)


def test_registry_names_do_not_collide_with_markers() -> None:
    assert not (_registered_names() & MARKERS)
