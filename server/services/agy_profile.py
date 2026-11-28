"""Standalone Antigravity (agy) unified workspace + credential vault manager.

Runs all Agy ACP sessions inside one shared `GEMINI_HOME` workspace
(`ADMIN_DATA/agy-profiles/workspace`) so conversation history, brain artifacts,
and Orchestrator configuration persist seamlessly across account switches while
keeping each account's OAuth credentials isolated in its own vault.
"""
from __future__ import annotations

import errno
import json
import logging
import os
import re
import shutil
import sqlite3
import subprocess
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from tempfile import NamedTemporaryFile, mkdtemp
from typing import Any, BinaryIO, Iterator
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

from .. import _paths
from ..constants import ENV_AGY_PATH
from ..process_utils import hidden_process_kwargs
from . import child_job

log = logging.getLogger(__name__)

DEFAULT = "default"
WORKSPACE_LOCK_ID = "workspace"
PROFILE_ID = r"(?:default|[0-9a-f]{32})"
_LOCK_ID = r"(?:default|workspace|[0-9a-f]{32})"
APP_DATA_DIR_NAME = "antigravity-cli"

_PROXY_KEYS = {"http_proxy", "https_proxy", "all_proxy", "no_proxy"}
_LOOPBACK = "localhost,127.0.0.1,::1"
_VAULT_CREDENTIAL_FILES = (
    "antigravity-oauth-token",
    "acp_token.json",
    "jetski_state.pbtxt",
)
_CLI_CREDENTIAL_FILES = (
    *_VAULT_CREDENTIAL_FILES,
    "settings.json",
    "installation_id",
)

# Match T3 Code's removedEnvironmentKeys so host Gemini/Vertex overrides or dead
# PyInstaller/Electron handles do not leak into isolated agy ACP sessions.
_REMOVED_ENV_KEYS = frozenset({
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
    "GOOGLE_CLOUD_QUOTA_PROJECT",
    "GOOGLE_GENAI_USE_VERTEXAI",
    "GCLOUD_PROJECT",
    "CLOUDSDK_CORE_PROJECT",
    "AGY_ACP_CCPA_PROJECT",
    "AGY_ACP_ENABLE_OAUTH",
    "GEMINI_HOME",
    "AGY_ACP_FORCE_FILE_STORAGE",
    "AGY_CLI_DISABLE_AUTO_UPDATE",
    "BROWSER",
    "PYTHONUNBUFFERED",
    "ELECTRON_RUN_AS_NODE",
    "CHROME_CRASHPAD_PIPE_NAME",
    "WSL_INTEROP",
    "WSLENV",
    "WSL_DISTRO_NAME",
    "ANTIGRAVITY_AGENT",
    "ANTIGRAVITY_AGENTAPI_EXE",
    "ANTIGRAVITY_APP_DATA_DIR",
    "ANTIGRAVITY_AUTH_SUCCESS_APP",
    "ANTIGRAVITY_CONVERSATION_ID",
    "ANTIGRAVITY_CSRF_TOKEN",
    "ANTIGRAVITY_LS_ADDRESS",
    "ANTIGRAVITY_LS_VERSION",
    "ANTIGRAVITY_PROJECT_ID",
    "ANTIGRAVITY_SOURCE_METADATA",
    "ANTIGRAVITY_TRAJECTORY_ID",
    "ANTIGRAVITY_VSCODE_HOST",
})

_USER_SKILL_DIRS = (
    ("skills",),
    ("..", ".agents", "skills"),
)
_USER_CONFIG_FILES = (
    ("AGENTS.md",),
    ("GEMINI.md",),
    ("config", "skills.json"),
)
_RULE_COPIES_MANIFEST = ".ga-rule-copies.json"
_RETIRED_TEMP_PREFIX = "agy-tmp.old-"
_AUTH_CODE_REDIRECT_URI = "https://antigravity.google/oauth-callback"
_RAW_AUTH_CODE_RE = re.compile(r"^[\w./~-]{1,2048}$")


class AgyProfileError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status


@dataclass(frozen=True)
class Profile:
    id: str
    name: str


def _root() -> Path:
    return _paths.ADMIN_DATA / "agy-profiles"


def _load_raw() -> tuple[str, list[Profile], dict[str, dict[str, Any]]]:
    default = Profile(DEFAULT, "系统默认")
    try:
        raw = json.loads((_root() / "profiles.json").read_text(encoding="utf-8"))
        profiles = [default, *(Profile(id=item["id"], name=item["name"]) for item in raw["profiles"])]
        active = raw["active"]
        ids = {p.id for p in profiles}
        if (
            len(ids) != len(profiles)
            or active not in ids
            or any(not re.fullmatch(PROFILE_ID, p.id) or not isinstance(p.name, str) for p in profiles)
        ):
            raise ValueError("Invalid profile metadata")
        meta = raw.get("meta")
        clean_meta = {k: v for k, v in meta.items() if k in ids and isinstance(v, dict)} if isinstance(meta, dict) else {}
        return active, profiles, clean_meta
    except FileNotFoundError:
        return DEFAULT, [default], {}
    except (OSError, ValueError, TypeError, KeyError) as exc:
        raise AgyProfileError(503, "无法读取 Agy 账号设置") from exc


def snapshot() -> tuple[str, list[Profile]]:
    active, profiles, _ = _load_raw()
    return active, profiles


# Serialize in-process profiles.json and workspace credential transactions.
_profile_metadata_lock = threading.RLock()


def _atomic_write_bytes(path: Path, data: bytes, *, mode: int = 0o600) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    stage: Path | None = None
    try:
        with NamedTemporaryFile(mode="wb", dir=path.parent, delete=False) as fp:
            stage = Path(fp.name)
            fp.write(data)
        for attempt in range(6):
            try:
                stage.replace(path)
                break
            except PermissionError as exc:
                if getattr(exc, "winerror", None) not in {5, 32, 33} or attempt == 5:
                    raise
                time.sleep(0.01 * (2 ** attempt))
        try:
            os.chmod(path, mode)
        except OSError:
            pass
    finally:
        if stage is not None:
            stage.unlink(missing_ok=True)


def _atomic_write_json(path: Path, payload: Any, *, mode: int = 0o600, indent: int | None = None) -> None:
    text = json.dumps(payload, ensure_ascii=False, indent=indent)
    if indent is not None:
        text += "\n"
    _atomic_write_bytes(path, text.encode("utf-8"), mode=mode)


def _save(active: str, profiles: list[Profile], meta: dict[str, dict[str, Any]] | None = None) -> None:
    path = _root() / "profiles.json"
    if meta is None:
        _, _, existing_meta = _load_raw()
        ids = {p.id for p in profiles}
        meta = {k: v for k, v in existing_meta.items() if k in ids}
    payload: dict[str, Any] = {
        "active": active,
        "profiles": [{"id": item.id, "name": item.name} for item in profiles if item.id != DEFAULT],
    }
    if meta:
        payload["meta"] = meta
    try:
        _atomic_write_json(path, payload)
    except OSError as exc:
        raise AgyProfileError(503, "无法保存 Agy 账号设置") from exc


def workspace_home() -> Path:
    return _root() / WORKSPACE_LOCK_ID / "home"


def workspace_gemini_dir() -> Path:
    return workspace_home() / ".gemini"


def workspace_app_data_dir() -> Path:
    return workspace_gemini_dir() / APP_DATA_DIR_NAME


def workspace_runtime_temp_root() -> Path:
    return _root() / WORKSPACE_LOCK_ID / "runtime-tmp"


def _workspace_active_marker() -> Path:
    return _root() / WORKSPACE_LOCK_ID / ".active-profile"


def _workspace_migrated_marker() -> Path:
    return _root() / WORKSPACE_LOCK_ID / ".migrated_v1"


def _default_host_import_disabled() -> Path:
    return _root() / DEFAULT / ".host_import_disabled"


def _host_default_gemini_dir() -> Path:
    return Path.home() / ".gemini"


def profile_vault_home(profile_id: str) -> Path:
    if not re.fullmatch(PROFILE_ID, profile_id):
        raise AgyProfileError(404, "找不到 Agy 账号")
    return _root() / profile_id / "home"


def profile_vault_gemini_dir(profile_id: str) -> Path:
    return profile_vault_home(profile_id) / ".gemini"


def profile_vault_app_data_dir(profile_id: str) -> Path:
    return profile_vault_gemini_dir(profile_id) / APP_DATA_DIR_NAME


def profile_home(profile_id: str) -> Path:
    return profile_vault_home(profile_id)


def profile_gemini_dir(profile_id: str) -> Path:
    return profile_vault_gemini_dir(profile_id)


def profile_app_data_dir(profile_id: str) -> Path:
    return profile_vault_app_data_dir(profile_id)


def profile_runtime_temp_root(profile_id: str) -> Path:
    if profile_id == WORKSPACE_LOCK_ID:
        return workspace_runtime_temp_root()
    if profile_id == DEFAULT:
        return _root() / "default-runtime-tmp"
    if not re.fullmatch(PROFILE_ID, profile_id):
        raise AgyProfileError(404, "找不到 Agy 账号")
    return _root() / profile_id / "runtime-tmp"


def active_workspace_profile() -> str | None:
    try:
        raw = _workspace_active_marker().read_text(encoding="utf-8").strip()
        return raw if raw and re.fullmatch(PROFILE_ID, raw) else None
    except OSError:
        return None


def _find_file_in_gemini_dir(gemini_dir: Path, filename: str) -> Path | None:
    for app_dir in (APP_DATA_DIR_NAME, "antigravity-acp"):
        candidate = gemini_dir / app_dir / filename
        try:
            if candidate.is_symlink():
                continue
            if candidate.is_file() and candidate.stat().st_size > 0:
                return candidate
        except OSError:
            continue
    return None


def find_credential_file(profile_id: str, filename: str) -> Path | None:
    """Return existing credential file for `profile_id` (preferring fresher active workspace copy)."""
    if not re.fullmatch(PROFILE_ID, profile_id):
        return None
    vault_candidate = _find_file_in_gemini_dir(profile_vault_gemini_dir(profile_id), filename)
    if active_workspace_profile() == profile_id:
        ws_candidate = _find_file_in_gemini_dir(workspace_gemini_dir(), filename)
        if ws_candidate is not None:
            if vault_candidate is None:
                return ws_candidate
            try:
                if ws_candidate.stat().st_mtime_ns >= vault_candidate.stat().st_mtime_ns:
                    return ws_candidate
            except OSError:
                return ws_candidate
    if vault_candidate is not None:
        return vault_candidate
    if profile_id == DEFAULT and not _default_host_import_disabled().exists():
        return _find_file_in_gemini_dir(_host_default_gemini_dir(), filename)
    return None


def _read_windows_keyring_safely() -> bytes | None:
    if os.name != "nt":
        return None
    try:
        from .agy_usage import read_windows_cli_credential
        return read_windows_cli_credential()
    except Exception:
        return None


def _read_host_default_credentials() -> tuple[dict[str, bytes], str | None]:
    """Read host `~/.gemini` / keyring credentials strictly read-only."""
    host_gemini = _host_default_gemini_dir()
    creds: dict[str, bytes] = {}
    for fname in _VAULT_CREDENTIAL_FILES:
        src = _find_file_in_gemini_dir(host_gemini, fname)
        if src is not None:
            try:
                if src.resolve() == src:
                    creds[fname] = src.read_bytes()
            except OSError:
                continue
    if "antigravity-oauth-token" not in creds:
        keyring_blob = _read_windows_keyring_safely()
        if keyring_blob:
            creds["antigravity-oauth-token"] = keyring_blob
    auth_type: str | None = None
    settings_src = host_gemini / APP_DATA_DIR_NAME / "settings.json"
    try:
        if settings_src.is_file() and not settings_src.is_symlink() and settings_src.resolve() == settings_src:
            parsed = json.loads(settings_src.read_text(encoding="utf-8"))
            raw_auth = parsed.get("auth") if isinstance(parsed, dict) else None
            if isinstance(raw_auth, dict) and isinstance(raw_auth.get("type"), str):
                auth_type = raw_auth["type"].strip() or None
    except (OSError, ValueError):
        pass
    return creds, auth_type


def _seed_default_vault_if_empty() -> bool:
    """Copy host `~/.gemini` or keyring credentials once into Hub's `default` vault."""
    with _profile_metadata_lock:
        if _default_host_import_disabled().exists():
            return False
        vault_gemini = profile_vault_gemini_dir(DEFAULT)
        if (
            _find_file_in_gemini_dir(vault_gemini, "antigravity-oauth-token") is not None
            or _find_file_in_gemini_dir(vault_gemini, "acp_token.json") is not None
        ):
            return False
        creds, auth_type = _read_host_default_credentials()
        if "antigravity-oauth-token" not in creds and "acp_token.json" not in creds:
            return False
        vault_app = profile_vault_app_data_dir(DEFAULT)
        try:
            for fname, blob in creds.items():
                if blob:
                    _atomic_write_bytes(vault_app / fname, blob, mode=0o600)
            settings_path = vault_app / "settings.json"
            if auth_type and not settings_path.exists():
                _atomic_write_json(settings_path, {"auth": {"type": auth_type}}, mode=0o600, indent=2)
            return True
        except OSError:
            log.debug("Failed to seed default Agy vault from host credentials", exc_info=True)
            return False


def has_local_credentials(profile_id: str) -> bool:
    if not re.fullmatch(PROFILE_ID, profile_id):
        return False
    for fname in ("acp_token.json", "antigravity-oauth-token"):
        if find_credential_file(profile_id, fname) is not None:
            return True
    if profile_id == DEFAULT and not _default_host_import_disabled().exists():
        return _read_windows_keyring_safely() is not None
    return False


def effective_auth_state(profile_id: str, meta_entry: dict[str, Any] | None = None) -> str | None:
    """Resolve auth state from local credentials + metadata, invalidating stale warnings."""
    has_creds = has_local_credentials(profile_id)
    entry = profile_meta(profile_id) if meta_entry is None else meta_entry
    raw_state = entry.get("auth_state") if isinstance(entry.get("auth_state"), str) else None
    if not has_creds:
        return "login_required" if raw_state == "login_required" else None
    if raw_state != "login_required":
        return raw_state
    marked_at_raw = entry.get("auth_state_at") if isinstance(entry.get("auth_state_at"), str) else None
    if marked_at_raw:
        try:
            marked_dt = datetime.fromisoformat(marked_at_raw.replace("Z", "+00:00"))
            marked_ns = marked_dt.timestamp() * 1_000_000_000
            for fname in ("acp_token.json", "antigravity-oauth-token"):
                cred = find_credential_file(profile_id, fname)
                if cred is not None and cred.stat().st_mtime_ns > marked_ns:
                    return "authenticated"
        except (ValueError, OSError):
            pass
    return "login_required"


def snapshot_details() -> tuple[str, list[dict[str, Any]]]:
    active, profiles, meta = _load_raw()
    items: list[dict[str, Any]] = []
    for p in profiles:
        entry: dict[str, Any] = {
            "id": p.id,
            "name": p.name,
            "has_credentials": has_local_credentials(p.id),
        }
        p_meta = meta.get(p.id)
        eff_auth = effective_auth_state(p.id, p_meta or {})
        if eff_auth:
            entry["auth_state"] = eff_auth
        if p_meta and isinstance(p_meta.get("usage"), dict):
            entry["usage"] = p_meta["usage"]
        if p_meta and isinstance(p_meta.get("account_tier"), str) and p_meta["account_tier"].strip():
            entry["account_tier"] = p_meta["account_tier"].strip().lower()
        if p_meta and isinstance(p_meta.get("account_tier_name"), str) and p_meta["account_tier_name"].strip():
            entry["account_tier_name"] = p_meta["account_tier_name"].strip()[:64]
        items.append(entry)
    return active, items


def add(name: str) -> Profile:
    with _profile_metadata_lock:
        active, profiles, meta = _load_raw()
        if any(p.name.casefold() == name.casefold() for p in profiles):
            raise AgyProfileError(409, "已有同名 Agy 账号")
        profile = Profile(uuid4().hex, name)
        _save(active, [*profiles, profile], meta)
        return profile



def rename(profile_id: str, name: str) -> Profile:
    with _profile_metadata_lock:
        active, profiles, meta = _load_raw()
        if not any(p.id == profile_id for p in profiles):
            raise AgyProfileError(404, "找不到 Agy 账号")
        if profile_id == DEFAULT:
            raise AgyProfileError(409, "系统默认账号不能修改备注")
        if any(p.id != profile_id and p.name.casefold() == name.casefold() for p in profiles):
            raise AgyProfileError(409, "已有同名 Agy 账号")
        renamed = Profile(profile_id, name)
        _save(active, [renamed if p.id == profile_id else p for p in profiles], meta)
        return renamed


VALID_ACCOUNT_TIERS = frozenset({"ultra", "pro", "plus", "enterprise", "free"})


def set_account_tier(profile_id: str, account_tier: str | None) -> dict[str, Any]:
    if not re.fullmatch(PROFILE_ID, profile_id):
        raise AgyProfileError(404, "找不到 Agy 账号")
    cleaned = (account_tier or "").strip().lower()
    if cleaned and cleaned not in VALID_ACCOUNT_TIERS:
        raise AgyProfileError(422, "不支持的账号档位")
    with _profile_metadata_lock:
        active, profiles, meta = _load_raw()
        target = next((p for p in profiles if p.id == profile_id), None)
        if target is None:
            raise AgyProfileError(404, "找不到 Agy 账号")
        entry = dict(meta.get(profile_id) or {})
        if cleaned:
            entry["account_tier"] = cleaned
            entry["account_tier_manual"] = True
            entry.pop("account_tier_name", None)
        else:
            entry.pop("account_tier", None)
            entry.pop("account_tier_name", None)
            entry.pop("account_tier_manual", None)
        meta[profile_id] = entry
        _save(active, profiles, meta)
    _, details = snapshot_details()
    found = next((item for item in details if item["id"] == profile_id), None)
    return found or {"id": target.id, "name": target.name}



def select(profile_id: str) -> None:
    with _profile_metadata_lock:
        active, profiles, meta = _load_raw()
        if not any(p.id == profile_id for p in profiles):
            raise AgyProfileError(404, "找不到 Agy 账号")
        if active != profile_id:
            _save(profile_id, profiles, meta)



def delete(profile_id: str) -> None:
    if profile_id == DEFAULT:
        raise AgyProfileError(409, "系统默认账号不能删除")
    if not re.fullmatch(PROFILE_ID, profile_id):
        raise AgyProfileError(404, "找不到 Agy 账号")
    with profile_lock(profile_id):
        with _profile_metadata_lock:
            active, profiles, meta = _load_raw()
            if not any(p.id == profile_id for p in profiles):
                raise AgyProfileError(404, "找不到 Agy 账号")
            if active == profile_id or active_workspace_profile() == profile_id:
                raise AgyProfileError(409, "请先切换到其他账号后再删除当前账号")
            next_profiles = [p for p in profiles if p.id != profile_id]
            meta.pop(profile_id, None)
            _save(active, next_profiles, meta)
        target = _root() / profile_id
        if target.exists():
            try:
                if target.resolve() != target:
                    raise AgyProfileError(409, "Agy 账号目录不得重定向")
                shutil.rmtree(target, ignore_errors=True)
            except OSError as exc:
                raise AgyProfileError(503, "无法删除 Agy 账号目录") from exc


def capture_default(name: str) -> Profile:
    """Clone the host default CLI/ACP (or default vault) credentials into a new account vault."""
    creds, auth_type = _read_host_default_credentials()
    if "antigravity-oauth-token" not in creds and "acp_token.json" not in creds:
        # Also allow capturing from default vault if already seeded/logged in via Hub.
        default_gemini = profile_vault_gemini_dir(DEFAULT)
        for fname in _VAULT_CREDENTIAL_FILES:
            cand = _find_file_in_gemini_dir(default_gemini, fname)
            if cand is not None:
                try:
                    creds[fname] = cand.read_bytes()
                except OSError:
                    pass
    if "antigravity-oauth-token" not in creds and "acp_token.json" not in creds:
        raise AgyProfileError(409, "系统默认账号尚未登录 agy CLI，无法另存")

    profile = Profile(uuid4().hex, name)
    dest_cli = profile_vault_app_data_dir(profile.id)
    try:
        for fname, blob in creds.items():
            if blob:
                _atomic_write_bytes(dest_cli / fname, blob, mode=0o600)
        _atomic_write_json(
            dest_cli / "settings.json",
            {"auth": {"type": auth_type or "oauth-personal"}},
            mode=0o600,
            indent=2,
        )
    except OSError as exc:
        shutil.rmtree(_root() / profile.id, ignore_errors=True)
        raise AgyProfileError(503, "无法复制系统默认 agy 凭据") from exc

    try:
        with _profile_metadata_lock:
            active, profiles, meta = _load_raw()
            if any(p.name.casefold() == name.casefold() for p in profiles):
                raise AgyProfileError(409, "已有同名 Agy 账号")
            if DEFAULT in meta:
                meta[profile.id] = dict(meta[DEFAULT])
            _save(active, [*profiles, profile], meta)
    except AgyProfileError:
        shutil.rmtree(_root() / profile.id, ignore_errors=True)
        raise
    return profile


def _remove_vault_credentials_in_gemini(gemini_dir: Path) -> None:
    if not gemini_dir.exists():
        return
    for sub in (APP_DATA_DIR_NAME, "antigravity-acp"):
        cli_dir = gemini_dir / sub
        if not cli_dir.exists():
            continue
        if cli_dir.resolve() != cli_dir:
            raise AgyProfileError(409, "Agy 账号目录不得重定向")
        for fname in _VAULT_CREDENTIAL_FILES:
            candidate = cli_dir / fname
            if candidate.is_symlink():
                raise AgyProfileError(409, "Agy 账号凭据文件不得重定向")
            if candidate.is_file():
                candidate.unlink(missing_ok=True)


def clear_credentials(profile_id: str) -> dict[str, Any]:
    if not re.fullmatch(PROFILE_ID, profile_id):
        raise AgyProfileError(404, "找不到 Agy 账号")
    with profile_lock(profile_id), _profile_metadata_lock:
        active, profiles, meta = _load_raw()
        target_profile = next((p for p in profiles if p.id == profile_id), None)
        if target_profile is None:
            raise AgyProfileError(404, "找不到 Agy 账号")
        try:
            _remove_vault_credentials_in_gemini(profile_vault_gemini_dir(profile_id))
            if active_workspace_profile() == profile_id:
                _remove_vault_credentials_in_gemini(workspace_gemini_dir())
            if profile_id == DEFAULT:
                disabled_marker = _default_host_import_disabled()
                disabled_marker.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                disabled_marker.write_text(datetime.now(timezone.utc).isoformat(), encoding="utf-8")
        except OSError as exc:
            raise AgyProfileError(503, "无法清除 Agy 账号凭据") from exc
        retire_runtime_temp_dirs(profile_runtime_temp_root(profile_id))
        meta.pop(profile_id, None)
        _save(active, profiles, meta)
        return {
            "id": target_profile.id,
            "name": target_profile.name,
            "has_credentials": False,
        }


def clear_host_import_disabled(profile_id: str) -> None:
    if profile_id == DEFAULT:
        try:
            _default_host_import_disabled().unlink(missing_ok=True)
        except OSError:
            pass


def record_auth_state(profile_id: str, auth_state: str | None) -> None:
    if not re.fullmatch(PROFILE_ID, profile_id):
        return
    with _profile_metadata_lock:
        try:
            active, profiles, meta = _load_raw()
        except AgyProfileError:
            return
        if not any(p.id == profile_id for p in profiles):
            return
        entry = dict(meta.get(profile_id) or {})
        if auth_state:
            entry["auth_state"] = auth_state
            entry["auth_state_at"] = datetime.now(timezone.utc).isoformat()
        else:
            entry.pop("auth_state", None)
            entry.pop("auth_state_at", None)
        meta[profile_id] = entry
        try:
            _save(active, profiles, meta)
        except AgyProfileError:
            pass


def profile_meta(profile_id: str) -> dict[str, Any]:
    if not re.fullmatch(PROFILE_ID, profile_id):
        return {}
    try:
        _, _, meta = _load_raw()
        return dict(meta.get(profile_id) or {})
    except AgyProfileError:
        return {}


def record_usage(
    profile_id: str,
    auth_state: str,
    rows: list[dict[str, Any]],
    *,
    account_tier: str | None = None,
    account_tier_name: str | None = None,
) -> None:
    if not re.fullmatch(PROFILE_ID, profile_id):
        return
    with _profile_metadata_lock:
        try:
            active, profiles, meta = _load_raw()
        except AgyProfileError:
            return
        if not any(p.id == profile_id for p in profiles):
            return
        now_iso = datetime.now(timezone.utc).isoformat()
        pcts = [float(r["remaining_pct"]) for r in rows if isinstance(r.get("remaining_pct"), (int, float))]
        entry = dict(meta.get(profile_id) or {})
        entry["auth_state"] = auth_state
        entry["auth_state_at"] = now_iso
        if isinstance(account_tier, str) and account_tier.strip() and not entry.get("account_tier_manual"):
            entry["account_tier"] = account_tier.strip().lower()
            if isinstance(account_tier_name, str) and account_tier_name.strip():
                entry["account_tier_name"] = account_tier_name.strip()[:64]
            else:
                entry.pop("account_tier_name", None)
        existing_usage = entry.get("usage")
        has_existing_rows = isinstance(existing_usage, dict) and bool(existing_usage.get("rows"))
        if rows or not has_existing_rows:
            entry["usage"] = {
                "checked_at": now_iso,
                "min_remaining_pct": min(pcts) if pcts else None,
                "rows": rows,
            }
        meta[profile_id] = entry
        try:
            _save(active, profiles, meta)
        except AgyProfileError:
            pass



def agy_executable_or_none() -> str | None:
    name = "agy.exe" if os.name == "nt" else "agy"
    candidates: list[str | None] = [
        os.environ.get(ENV_AGY_PATH),
        os.environ.get("ANTICLI_AGY_PATH"),
        shutil.which(name),
        str(Path.home() / ".gemini" / "bin" / name),
    ]
    if os.name == "nt":
        local_app = os.environ.get("LOCALAPPDATA")
        prog_files = os.environ.get("ProgramFiles")
        if local_app:
            candidates.extend([
                str(Path(local_app) / "Programs" / "Antigravity" / "bin" / name),
                str(Path(local_app) / "Antigravity" / "bin" / name),
            ])
        if prog_files:
            candidates.append(str(Path(prog_files) / "Antigravity" / "bin" / name))
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return str(Path(candidate).resolve())
    return None


def agy_executable() -> str:
    found = agy_executable_or_none()
    if found is None:
        raise AgyProfileError(503, "找不到官方 agy CLI，请先安装")
    return found


def _parse_proxy_url(value: str) -> str | None:
    value = value.strip()
    if not value:
        return None
    try:
        url = urlsplit(value if "://" in value else f"http://{value}")
        if (
            url.scheme in {"http", "https"}
            and url.hostname
            and url.port
            and url.username is None
            and url.password is None
            and url.path in {"", "/"}
            and not url.query
            and not url.fragment
            and not any(c.isspace() or c in "\\,;" for c in value)
        ):
            return f"{url.scheme}://{url.netloc}"
    except ValueError:
        pass
    return None


def system_proxy_env(env: dict[str, str]) -> dict[str, str]:
    """Best-effort injection of Windows manual HTTP/HTTPS proxy for agy."""
    result = env.copy()
    if os.name != "nt":
        return result
    try:
        import winreg

        settings = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings"
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, settings) as key:
            def read(name: str):
                try:
                    return winreg.QueryValueEx(key, name)[0]
                except FileNotFoundError:
                    return None

            if read("AutoConfigURL") or read("ProxyEnable") != 1:
                return result
            server = read("ProxyServer")
    except OSError:
        return result
    if not isinstance(server, str) or not server.strip():
        return result
    http = https = None
    if "=" not in server:
        http = https = _parse_proxy_url(server)
    else:
        routes: dict[str, str] = {}
        for entry in server.split(";"):
            proto, sep, addr = entry.partition("=")
            if sep and proto.strip().lower() in {"http", "https"}:
                parsed = _parse_proxy_url(addr)
                if parsed:
                    routes[proto.strip().lower()] = parsed
        http = routes.get("http") or routes.get("https")
        https = routes.get("https") or routes.get("http")
    if not http or not https:
        return result
    for k in tuple(result):
        if k.lower() in _PROXY_KEYS:
            result.pop(k, None)
    result.update({"HTTP_PROXY": http, "HTTPS_PROXY": https, "ALL_PROXY": https, "NO_PROXY": _LOOPBACK})
    return result


def retire_runtime_temp_dirs(temp_root: Path) -> None:
    """Reclaim leftover per-process unpacked agy temp directories asynchronously on launch."""
    try:
        if not temp_root.exists():
            return
        for entry in list(temp_root.iterdir()):
            if entry.is_dir() and (entry.name.startswith("run-") or entry.name.startswith(_RETIRED_TEMP_PREFIX)):
                shutil.rmtree(entry, ignore_errors=True)
    except OSError:
        log.debug("Failed to sweep leftover agy runtime temp directories", exc_info=True)


def make_runtime_temp_dir(profile_id: str) -> Path:
    root = profile_runtime_temp_root(profile_id)
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    return Path(mkdtemp(prefix="run-", dir=root))


def _is_pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(0x1000, False, int(pid))
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            if kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return code.value == 259  # STILL_ACTIVE
            return True
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _profile_lock_file(profile_id: str) -> Path:
    return profile_runtime_temp_root(profile_id) / "runtime.pid"


def _read_live_lock_pid(profile_id: str) -> int | None:
    if not re.fullmatch(_LOCK_ID, profile_id):
        return None
    lock_file = _profile_lock_file(profile_id)
    try:
        if not lock_file.is_file() or lock_file.is_symlink():
            return None
        raw = lock_file.read_text(encoding="utf-8").strip()
        pid = int(json.loads(raw)["pid"]) if raw.startswith("{") else int(raw)
    except (OSError, ValueError, TypeError, KeyError):
        return None
    if _is_pid_alive(pid):
        return pid
    return None


_profile_locks_guard = threading.Lock()
_profile_locks: dict[Path, tuple[BinaryIO, int]] = {}


def _profile_guard_file(profile_id: str) -> Path:
    # Never unlink this file: waiters must always contend on the same inode.
    return _root() / ".locks" / f"{profile_id}.lock"


def claim_profile_lock(profile_id: str) -> None:
    if not re.fullmatch(_LOCK_ID, profile_id):
        raise AgyProfileError(404, "找不到 Agy 账号")
    legacy = _profile_lock_file(profile_id)
    path = _profile_guard_file(profile_id)
    with _profile_locks_guard:
        held = _profile_locks.get(path)
        if held is not None:
            _profile_locks[path] = (held[0], held[1] + 1)
            return
        stream = None
        try:
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            stream = path.open("a+b")
            stream.seek(0)
            try:
                if os.name == "nt":
                    import msvcrt

                    msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as exc:
                if exc.errno in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                    msg = (
                        "当前 Agy 工作区正被另一个 GA-Hub 进程占用"
                        if profile_id == WORKSPACE_LOCK_ID
                        else "当前隔离账号正被另一个 GA-Hub 进程占用"
                    )
                    raise AgyProfileError(409, msg) from exc
                raise
            pid = _read_live_lock_pid(profile_id)
            if pid is not None and pid != os.getpid():
                msg = (
                    f"当前 Agy 工作区正被另一个 GA-Hub 进程（PID {pid}）占用"
                    if profile_id == WORKSPACE_LOCK_ID
                    else f"当前隔离账号正被另一个 GA-Hub 进程（PID {pid}）占用"
                )
                raise AgyProfileError(409, msg)
            # Keep the PID marker for older Hub builds. Only the OS lock
            # arbitrates concurrent claims by upgraded builds.
            legacy.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            legacy.write_text(json.dumps({"pid": os.getpid()}), encoding="utf-8")
            _profile_locks[path] = (stream, 1)
            stream = None
        except OSError as exc:
            raise AgyProfileError(503, "无法锁定 Agy 工作区或账号") from exc
        finally:
            if stream is not None:
                stream.close()


def release_profile_lock(profile_id: str) -> None:
    if not re.fullmatch(_LOCK_ID, profile_id):
        return
    path = _profile_guard_file(profile_id)
    with _profile_locks_guard:
        held = _profile_locks.get(path)
        if held is None:
            return
        stream, count = held
        if count > 1:
            _profile_locks[path] = (stream, count - 1)
            return
        try:
            _profile_lock_file(profile_id).unlink(missing_ok=True)
        except OSError:
            log.warning("Failed to remove legacy agy PID marker for %s", profile_id, exc_info=True)
        finally:
            del _profile_locks[path]
            stream.close()


def claim_workspace_lock() -> None:
    claim_profile_lock(WORKSPACE_LOCK_ID)


def release_workspace_lock() -> None:
    release_profile_lock(WORKSPACE_LOCK_ID)


@contextmanager
def profile_lock(profile_id: str) -> Iterator[None]:
    claim_profile_lock(profile_id)
    try:
        yield
    finally:
        release_profile_lock(profile_id)


def _load_rule_copies_manifest(manifest_path: Path) -> dict[str, str]:
    try:
        if not manifest_path.is_file() or manifest_path.is_symlink():
            return {}
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return {str(k): v for k, v in data.items() if isinstance(k, str) and isinstance(v, str)}
    except (OSError, ValueError):
        pass
    return {}


def sync_user_customizations_to(dest_gemini: Path) -> None:
    """Mirror global skills & instruction files from host `~/.gemini` into `dest_gemini`."""
    user_gemini = _host_default_gemini_dir()
    if dest_gemini == user_gemini:
        return
    dest_gemini.mkdir(mode=0o700, parents=True, exist_ok=True)
    manifest_path = dest_gemini / _RULE_COPIES_MANIFEST
    manifest = _load_rule_copies_manifest(manifest_path)
    manifest_dirty = False
    for segments in _USER_CONFIG_FILES:
        src = user_gemini.joinpath(*segments)
        dst = dest_gemini.joinpath(*segments)
        rel_key = "/".join(segments)
        try:
            if not src.is_file() or src.is_symlink():
                continue
            src_text = src.read_text(encoding="utf-8")
            if dst.is_symlink():
                dst.unlink(missing_ok=True)
            elif dst.exists():
                dst_text = dst.read_text(encoding="utf-8")
                if dst_text == src_text:
                    if manifest.get(rel_key) != src_text:
                        manifest[rel_key] = src_text
                        manifest_dirty = True
                    continue
                if manifest.get(rel_key) != dst_text:
                    # Keep user-edited overrides untouched once initialized.
                    continue
            dst.parent.mkdir(parents=True, exist_ok=True)
            _atomic_write_bytes(dst, src_text.encode("utf-8"), mode=0o600)
            manifest[rel_key] = src_text
            manifest_dirty = True
        except (OSError, UnicodeDecodeError):
            continue
    if manifest_dirty:
        try:
            _atomic_write_json(manifest_path, manifest, mode=0o600)
        except OSError:
            pass
    for segments in _USER_SKILL_DIRS:
        src = (user_gemini.joinpath(*segments)).resolve() if user_gemini.joinpath(*segments).exists() else None
        if src is None or not src.is_dir():
            continue
        dst = dest_gemini.joinpath(*segments)
        if dst.exists() or dst.is_symlink():
            continue
        try:
            dst.parent.mkdir(parents=True, exist_ok=True)
            if os.name == "nt":
                subprocess.run(
                    ["cmd", "/c", "mklink", "/J", str(dst), str(src)],
                    capture_output=True,
                    check=False,
                    **hidden_process_kwargs(),
                )
            else:
                os.symlink(src, dst, target_is_directory=True)
        except OSError:
            continue


def sync_user_customizations(profile_id: str) -> None:
    """Mirror global skills & instruction files from `~/.gemini` into a profile vault."""
    sync_user_customizations_to(profile_vault_gemini_dir(profile_id))


def _copy_sqlite_safe(src: Path, dst: Path) -> None:
    if not src.is_file() or src.is_symlink() or src.resolve() != src:
        return
    dst.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    stage: Path | None = None
    try:
        with NamedTemporaryFile(mode="wb", dir=dst.parent, delete=False) as fp:
            stage = Path(fp.name)
        try:
            src_conn = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
            try:
                dst_conn = sqlite3.connect(stage)
                try:
                    src_conn.backup(dst_conn)
                finally:
                    dst_conn.close()
            finally:
                src_conn.close()
        except sqlite3.Error:
            shutil.copy2(src, stage)
        for attempt in range(6):
            try:
                stage.replace(dst)
                break
            except PermissionError as exc:
                if getattr(exc, "winerror", None) not in {5, 32, 33} or attempt == 5:
                    raise
                time.sleep(0.01 * (2 ** attempt))
        try:
            os.chmod(dst, 0o600)
        except OSError:
            pass
    finally:
        if stage is not None:
            stage.unlink(missing_ok=True)


def _legacy_conversation_roots() -> list[Path]:
    roots: list[Path] = []
    try:
        active, profiles, _ = _load_raw()
        ordered = [active, *(p.id for p in profiles if p.id != active)]
    except AgyProfileError:
        ordered = [DEFAULT]
    for pid in ordered:
        cand = profile_vault_app_data_dir(pid)
        if cand not in roots:
            roots.append(cand)
    host_app = _host_default_gemini_dir() / APP_DATA_DIR_NAME
    if host_app not in roots:
        roots.append(host_app)
    return roots


def rescue_conversation_files(conv_id: str, extra_roots: list[Path] | None = None) -> bool:
    """Ensure `conversations/{conv_id}.db` and `brain/{conv_id}/` live in workspace on demand."""
    clean_id = (conv_id or "").strip()
    if not clean_id or "/" in clean_id or "\\" in clean_id or clean_id in {".", ".."}:
        return False
    ws_app = workspace_app_data_dir()
    dst_db = ws_app / "conversations" / f"{clean_id}.db"
    dst_brain = ws_app / "brain" / clean_id
    if dst_db.is_file():
        return True
    roots = list(extra_roots) if extra_roots is not None else _legacy_conversation_roots()
    found = False
    for root in roots:
        if root == ws_app:
            continue
        src_db = root / "conversations" / f"{clean_id}.db"
        if src_db.is_file() and not src_db.is_symlink():
            try:
                _copy_sqlite_safe(src_db, dst_db)
                found = True
            except OSError:
                log.debug("Failed to rescue conversation DB %s", src_db, exc_info=True)
        src_brain = root / "brain" / clean_id
        if src_brain.is_dir() and not src_brain.is_symlink() and not dst_brain.exists():
            try:
                shutil.copytree(src_brain, dst_brain, dirs_exist_ok=True)
            except OSError:
                log.debug("Failed to rescue brain dir %s", src_brain, exc_info=True)
        if found:
            break
    return found


def _read_settings_dict(path: Path) -> dict[str, Any]:
    if not path.is_file() or path.is_symlink():
        return {}
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
        return dict(loaded) if isinstance(loaded, dict) else {}
    except (OSError, ValueError):
        return {}


def _migrate_legacy_workspace_locked() -> None:
    ws_app = workspace_app_data_dir()
    try:
        active, profiles, _ = _load_raw()
        ordered = [active, *(p.id for p in profiles if p.id != active)]
    except AgyProfileError:
        active = DEFAULT
        ordered = [DEFAULT]

    legacy_dirs: list[Path] = []
    for pid in ordered:
        app_dir = profile_vault_app_data_dir(pid)
        if app_dir.is_dir() and not app_dir.is_symlink():
            legacy_dirs.append(app_dir)

    for src_app in legacy_dirs:
        conv_dir = src_app / "conversations"
        if conv_dir.is_dir() and not conv_dir.is_symlink():
            for db_file in conv_dir.glob("*.db"):
                dst_db = ws_app / "conversations" / db_file.name
                if not dst_db.exists():
                    try:
                        _copy_sqlite_safe(db_file, dst_db)
                    except OSError:
                        log.debug("Failed migrating conversation %s", db_file, exc_info=True)
        brain_dir = src_app / "brain"
        if brain_dir.is_dir() and not brain_dir.is_symlink():
            for entry in brain_dir.iterdir():
                if entry.is_dir() and not entry.is_symlink():
                    dst_brain = ws_app / "brain" / entry.name
                    if not dst_brain.exists():
                        try:
                            shutil.copytree(entry, dst_brain, dirs_exist_ok=True)
                        except OSError:
                            log.debug("Failed migrating brain %s", entry, exc_info=True)

    active_legacy_app = profile_vault_app_data_dir(active)
    sum_dst = ws_app / "conversation_summaries.db"
    if not sum_dst.exists():
        for src_app in (active_legacy_app, *legacy_dirs):
            sum_src = src_app / "conversation_summaries.db"
            if sum_src.is_file() and not sum_src.is_symlink():
                try:
                    _copy_sqlite_safe(sum_src, sum_dst)
                    break
                except OSError:
                    pass

    ws_settings_path = ws_app / "settings.json"
    ws_settings = _read_settings_dict(ws_settings_path)
    if "orchestrator" not in ws_settings:
        orch_sources = [active_legacy_app / "settings.json"]
        if active == DEFAULT:
            orch_sources.append(_host_default_gemini_dir() / APP_DATA_DIR_NAME / "settings.json")
        orch_sources.extend(src / "settings.json" for src in legacy_dirs)
        for src_settings in orch_sources:
            parsed = _read_settings_dict(src_settings)
            if isinstance(parsed.get("orchestrator"), dict) and parsed["orchestrator"]:
                ws_settings["orchestrator"] = dict(parsed["orchestrator"])
                if "auth" not in ws_settings:
                    ws_settings["auth"] = {"type": "oauth-personal"}
                _atomic_write_json(ws_settings_path, ws_settings, mode=0o600, indent=2)
                break


def ensure_workspace_ready() -> Path:
    """Create the single shared GEMINI_HOME workspace and migrate legacy isolated state once."""
    with _profile_metadata_lock:
        home = workspace_home()
        gemini_dir = workspace_gemini_dir()
        app_dir = workspace_app_data_dir()
        try:
            if home.exists() and home.resolve() != home:
                raise AgyProfileError(409, "Agy 工作区目录不得重定向")
            home.mkdir(mode=0o700, parents=True, exist_ok=True)
            gemini_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
            app_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
            settings_path = app_dir / "settings.json"
            if not settings_path.exists():
                _atomic_write_json(settings_path, {"auth": {"type": "oauth-personal"}}, mode=0o600, indent=2)
            sync_user_customizations_to(gemini_dir)
            marker = _workspace_migrated_marker()
            if not marker.exists():
                _migrate_legacy_workspace_locked()
                marker.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                marker.write_text(datetime.now(timezone.utc).isoformat(), encoding="utf-8")
            retire_runtime_temp_dirs(workspace_runtime_temp_root())
        except OSError as exc:
            raise AgyProfileError(503, "无法准备 Agy 运行工作区") from exc
        return gemini_dir


def sync_workspace_credentials_to_vault(expected_profile_id: str | None = None) -> bool:
    """Persist refreshed workspace tokens back into the active account's credential vault."""
    with _profile_metadata_lock:
        loaded_pid = active_workspace_profile()
        if not loaded_pid:
            return False
        if expected_profile_id is not None and loaded_pid != expected_profile_id:
            return False
        try:
            _, profiles, _ = _load_raw()
        except AgyProfileError:
            return False
        if not any(p.id == loaded_pid for p in profiles):
            return False
        ws_gemini = workspace_gemini_dir()
        vault_app = profile_vault_app_data_dir(loaded_pid)
        updated = False
        for fname in _VAULT_CREDENTIAL_FILES:
            src = _find_file_in_gemini_dir(ws_gemini, fname)
            if src is None:
                continue
            dst = vault_app / fname
            try:
                src_bytes = src.read_bytes()
                if not src_bytes:
                    continue
                if dst.is_file() and dst.read_bytes() == src_bytes:
                    continue
                _atomic_write_bytes(dst, src_bytes, mode=0o600)
                updated = True
            except OSError:
                log.debug("Failed syncing workspace %s to vault %s", fname, loaded_pid, exc_info=True)
        return updated


def sync_vault_token_to_workspace_if_newer(profile_id: str) -> None:
    """Push a fresher vault token (e.g. from background refresh) into workspace if active."""
    with _profile_metadata_lock:
        if active_workspace_profile() != profile_id:
            return
        vault_app = profile_vault_app_data_dir(profile_id)
        ws_app = workspace_app_data_dir()
        for fname in _VAULT_CREDENTIAL_FILES:
            src = vault_app / fname
            dst = ws_app / fname
            if not src.is_file() or src.is_symlink():
                continue
            try:
                if not dst.exists() or src.stat().st_mtime_ns > dst.stat().st_mtime_ns:
                    data = src.read_bytes()
                    if data and (not dst.is_file() or dst.read_bytes() != data):
                        _atomic_write_bytes(dst, data, mode=0o600)
            except OSError:
                continue


def activate_profile_in_workspace(profile_id: str, *, force_reload: bool = False) -> Path:
    """Hot-swap credential files inside the unified workspace while keeping context & settings."""
    with _profile_metadata_lock:
        _, profiles, _ = _load_raw()
        if not any(p.id == profile_id for p in profiles):
            raise AgyProfileError(404, "找不到 Agy 账号")
        ensure_workspace_ready()
        loaded_pid = active_workspace_profile()
        if loaded_pid and loaded_pid != profile_id:
            sync_workspace_credentials_to_vault(loaded_pid)
        if profile_id == DEFAULT:
            _seed_default_vault_if_empty()

        vault_gemini = profile_vault_gemini_dir(profile_id)
        vault_app = profile_vault_app_data_dir(profile_id)
        ws_gemini = workspace_gemini_dir()
        ws_app = workspace_app_data_dir()
        try:
            if loaded_pid != profile_id or force_reload:
                _remove_vault_credentials_in_gemini(ws_gemini)
                for fname in _VAULT_CREDENTIAL_FILES:
                    src = _find_file_in_gemini_dir(vault_gemini, fname)
                    if src is not None:
                        _atomic_write_bytes(ws_app / fname, src.read_bytes(), mode=0o600)
            else:
                for fname in _VAULT_CREDENTIAL_FILES:
                    src = _find_file_in_gemini_dir(vault_gemini, fname)
                    dst = ws_app / fname
                    if src is None:
                        continue
                    if not dst.exists() or src.stat().st_mtime_ns > dst.stat().st_mtime_ns:
                        data = src.read_bytes()
                        if data and (not dst.is_file() or dst.read_bytes() != data):
                            _atomic_write_bytes(dst, data, mode=0o600)

            vault_settings = _read_settings_dict(vault_app / "settings.json")
            auth_block = vault_settings.get("auth") if isinstance(vault_settings.get("auth"), dict) else None
            auth_type = (
                str(auth_block.get("type")).strip()
                if auth_block and isinstance(auth_block.get("type"), str) and auth_block["type"].strip()
                else "oauth-personal"
            )
            ws_settings_path = ws_app / "settings.json"
            ws_settings = _read_settings_dict(ws_settings_path)
            cur_auth = ws_settings.get("auth") if isinstance(ws_settings.get("auth"), dict) else {}
            if cur_auth.get("type") != auth_type:
                ws_settings["auth"] = {**cur_auth, "type": auth_type}
                _atomic_write_json(ws_settings_path, ws_settings, mode=0o600, indent=2)

            _atomic_write_bytes(_workspace_active_marker(), profile_id.encode("utf-8"), mode=0o600)
            retire_runtime_temp_dirs(workspace_runtime_temp_root())
        except OSError as exc:
            raise AgyProfileError(503, f"无法切换 Agy 工作区凭据: {exc}") from exc
        return ws_gemini


def prepare_workspace(profile_id: str) -> Path:
    return activate_profile_in_workspace(profile_id)


def prepare_profile(profile_id: str) -> Path:
    """Prepare the isolated credential vault for `profile_id` (used for logins & sandbox probes)."""
    gemini_dir = profile_vault_gemini_dir(profile_id)
    app_dir = profile_vault_app_data_dir(profile_id)
    try:
        home = profile_vault_home(profile_id)
        if home.exists() and home.resolve() != home:
            raise AgyProfileError(409, "Agy 账号目录不得重定向")
        home.mkdir(mode=0o700, parents=True, exist_ok=True)
        gemini_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        app_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        settings_path = app_dir / "settings.json"
        if not settings_path.exists():
            _atomic_write_json(settings_path, {"auth": {"type": "oauth-personal"}}, mode=0o600, indent=2)
        sync_user_customizations(profile_id)
        retire_runtime_temp_dirs(profile_runtime_temp_root(profile_id))
    except OSError as exc:
        raise AgyProfileError(503, "无法准备 Agy 账号运行目录") from exc
    return gemini_dir


def clean_agy_env(
    profile_id: str,
    base_env: dict[str, str] | None = None,
    *,
    temp_dir: Path | None = None,
    headless_login: bool = False,
    vault_only: bool = False,
) -> dict[str, str]:
    """Build a sanitized child environment matching T3 Code's antigravityEnvironment."""
    raw = os.environ if base_env is None else base_env
    env = {k: v for k, v in raw.items() if k.upper() not in _REMOVED_ENV_KEYS}
    use_vault = bool(vault_only or headless_login)
    home = profile_vault_home(profile_id) if use_vault else workspace_home()
    gemini_dir = profile_vault_gemini_dir(profile_id) if use_vault else workspace_gemini_dir()
    # Preserve host toolchain & package caches before redirecting HOME/USERPROFILE
    # so tools run inside ACP sessions do not re-download GB-scale toolchains into
    # agy-profiles (observed: 1.93 GB duplicate .rustup + .cargo).
    host_home_raw = raw.get("USERPROFILE") or raw.get("HOME") if os.name == "nt" else raw.get("HOME")
    host_home = Path(host_home_raw) if host_home_raw else Path.home()
    toolchain_defaults = {
        "RUSTUP_HOME": str(host_home / ".rustup"),
        "CARGO_HOME": str(host_home / ".cargo"),
        "GOMODCACHE": str(host_home / "go" / "pkg" / "mod"),
        "PIP_CACHE_DIR": (
            str(host_home / "AppData" / "Local" / "pip" / "Cache")
            if os.name == "nt"
            else str(host_home / ".cache" / "pip")
        ),
        "UV_CACHE_DIR": (
            str(host_home / "AppData" / "Local" / "uv" / "cache")
            if os.name == "nt"
            else str(host_home / ".cache" / "uv")
        ),
        "NPM_CONFIG_CACHE": (
            str(host_home / "AppData" / "Local" / "npm-cache")
            if os.name == "nt"
            else str(host_home / ".npm")
        ),
    }
    for var_name, default_val in toolchain_defaults.items():
        if not env.get(var_name):
            env[var_name] = default_val
    env.update({
        "GEMINI_HOME": str(gemini_dir),
        "HOME": str(home),
        "AGY_ACP_FORCE_FILE_STORAGE": "1",
        # Official agy Go CLI checks `os.Getenv("AGY_CLI_DISABLE_AUTO_UPDATE") == "true"`
        # (passing "1" is ignored and spawns a detached `--bg-updater` child).
        "AGY_CLI_DISABLE_AUTO_UPDATE": "true",
        "PYTHONUNBUFFERED": "1",
        # Match T3 Code: SSH_CONNECTION forces isolated file-storage OAuth tokens instead of OS keyring.
        "SSH_CONNECTION": raw.get("SSH_CONNECTION") or "127.0.0.1 0 127.0.0.1 0",
    })
    if os.name == "nt":
        env.update(USERPROFILE=str(home), HOMEDRIVE=home.drive, HOMEPATH=str(home)[len(home.drive):])
    if headless_login:
        env.pop("DISPLAY", None)
        env.pop("WAYLAND_DISPLAY", None)
    if temp_dir is not None:
        if os.name == "nt":
            env["TEMP"] = str(temp_dir)
            env["TMP"] = str(temp_dir)
        else:
            env["TMPDIR"] = str(temp_dir)
    executable = agy_executable_or_none()
    if executable:
        env["ANTICLI_AGY_PATH"] = executable
    return system_proxy_env(env)


def profile_env(profile_id: str, env: dict[str, str]) -> dict[str, str]:
    """Compatibility wrapper used by existing profile callers and tests."""
    return clean_agy_env(profile_id, env, vault_only=True)


def acp_spawn_command(
    executable: str,
    profile_id: str,
    *,
    add_dirs: list[str] | tuple[str, ...] = (),
    sandbox: bool = False,
    login: bool = False,
) -> list[str]:
    """Build `agy acp` argv matching T3 Code's --gemini-dir + --app-data-dir contract."""
    gemini_dir = profile_vault_gemini_dir(profile_id) if login else workspace_gemini_dir()
    cmd = [
        executable,
        "acp",
        "--gemini-dir",
        str(gemini_dir),
        "--app-data-dir",
        APP_DATA_DIR_NAME,
    ]
    if login:
        cmd.append("--login")
    if sandbox:
        cmd.append("--sandbox")
    for directory in add_dirs:
        if directory:
            cmd.extend(["--add-dir", directory])
    return cmd


def _parse_oauth_authorization_url(raw_url: str) -> tuple[str, str | None, str | None] | None:
    """Validate an Antigravity `--login` Google OAuth URL (T3 Code parseAntigravityAuthorizationUrl)."""
    url = raw_url.strip()
    if not url or len(url) > 16_384 or any(ch.isspace() for ch in url):
        return None
    parts = urlsplit(url)
    if parts.scheme != "https" or parts.netloc != "accounts.google.com" or parts.fragment:
        return None
    if parts.username is not None or parts.password is not None:
        return None
    if parts.path not in ("/o/oauth2/auth", "/o/oauth2/v2/auth"):
        return None
    # Bare URL without query string is emitted in mocked tests; full CLI URLs carry OAuth params.
    if not parts.query:
        return url, None, None
    qs = parse_qs(parts.query, keep_blank_values=True)
    if (
        qs.get("response_type") != ["code"]
        or len(qs.get("state") or ()) != 1
        or len(qs.get("redirect_uri") or ()) != 1
    ):
        return None
    state = qs["state"][0]
    redirect_uri = qs["redirect_uri"][0]
    if not state or len(state) > 512 or any(ch.isspace() for ch in state):
        return None
    if parts.path == "/o/oauth2/auth":
        if redirect_uri != _AUTH_CODE_REDIRECT_URI:
            return None
    else:
        if not re.fullmatch(r"http://127\.0\.0\.1:[1-9]\d{0,4}/", redirect_uri):
            return None
        port = urlsplit(redirect_uri).port
        if port is None or port < 1024:
            return None
    return url, redirect_uri, state


def _validate_code_login_response(
    response: str,
    expected_redirect_uri: str | None = None,
    expected_state: str | None = None,
) -> str | None:
    """Accept either an authorization code or a validated Google OAuth callback URL."""
    value = response.strip()
    if not value or len(value) > 16_384 or any(ch.isspace() for ch in value):
        return None
    if _RAW_AUTH_CODE_RE.fullmatch(value):
        return value
    parts = urlsplit(value)
    if not parts.scheme or not parts.netloc or parts.username is not None or parts.password is not None:
        return None
    qs = parse_qs(parts.query, keep_blank_values=True)
    if len(qs.get("code") or ()) != 1 or not qs["code"][0]:
        return None
    if expected_redirect_uri and f"{parts.scheme}://{parts.netloc}{parts.path}" != expected_redirect_uri:
        return None
    if expected_state and qs.get("state") != [expected_state]:
        return None
    return value


@dataclass
class CodeLoginFlow:
    """Headless `agy acp --login` session (T3 Code's codeLogin pattern)."""

    flow_id: str
    profile_id: str
    process: subprocess.Popen
    temp_dir: Path | None = None
    phase: str = "starting"  # starting | waiting_code | completed | failed | cancelled
    authorization_url: str | None = None
    redirect_uri: str | None = None
    oauth_state: str | None = None
    error: str | None = None
    expires_at: float = field(default_factory=lambda: time.monotonic() + 300.0)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def check_expired(self, *, now: float | None = None) -> bool:
        current = time.monotonic() if now is None else now
        if current < self.expires_at:
            return False
        return self.cancel(reason="授权码登录已超时，请重新发起")

    def public_state(self) -> dict[str, Any]:
        self.check_expired()
        with self._lock:
            return {
                "flow_id": self.flow_id,
                "profile_id": self.profile_id,
                "phase": self.phase,
                "authorization_url": self.authorization_url,
                "error": self.error,
            }

    def watch(self) -> None:
        stdout = self.process.stdout
        stderr_lines: list[str] = []
        done = threading.Event()

        def _drain_stderr() -> None:
            if self.process.stderr is None:
                return
            try:
                for line in self.process.stderr:
                    text = line.strip()
                    if text:
                        stderr_lines.append(text[:500])
                        if len(stderr_lines) > 20:
                            stderr_lines.pop(0)
            except OSError:
                pass

        def _expire_watchdog() -> None:
            remaining = max(0.0, self.expires_at - time.monotonic())
            if not done.wait(remaining):
                self.check_expired()

        t_err = threading.Thread(target=_drain_stderr, daemon=True)
        t_exp = threading.Thread(target=_expire_watchdog, daemon=True)
        t_err.start()
        t_exp.start()
        try:
            if stdout is not None:
                for raw in stdout:
                    line = raw.strip()
                    if line.startswith("https://"):
                        parsed = _parse_oauth_authorization_url(line)
                        if parsed is None:
                            continue
                        auth_url, redir_uri, oauth_state = parsed
                        with self._lock:
                            self.authorization_url = auth_url
                            self.redirect_uri = redir_uri
                            self.oauth_state = oauth_state
                            if self.phase == "starting":
                                self.phase = "waiting_code"
            code = self.process.wait(timeout=15)
        except Exception:
            code = self.process.poll()
        finally:
            done.set()
            child_job.forget(self.process.pid)
            if self.temp_dir is not None:
                shutil.rmtree(self.temp_dir, ignore_errors=True)
        with self._lock:
            if self.phase not in ("cancelled", "failed"):
                if code == 0:
                    self.phase = "completed"
                else:
                    self.phase = "failed"
                    self.error = stderr_lines[-1] if stderr_lines else f"agy 登录退出码 {code}"

    def submit_code(self, response: str) -> None:
        self.check_expired()
        with self._lock:
            if self.phase in ("completed", "failed", "cancelled"):
                raise AgyProfileError(409, self.error or "登录流程已结束，请重新发起")
            expected_redir = self.redirect_uri
            expected_state = self.oauth_state
        value = _validate_code_login_response(response, expected_redir, expected_state)
        if not value:
            raise AgyProfileError(400, "请输入有效的授权码或匹配的 Google 回调链接")
        stdin = self.process.stdin
        if stdin is None:
            raise AgyProfileError(503, "登录进程输入通道已关闭")
        try:
            stdin.write(value + "\n")
            stdin.flush()
        except OSError as exc:
            raise AgyProfileError(503, "无法向登录进程提交授权码") from exc

    def cancel(self, *, reason: str | None = None) -> bool:
        with self._lock:
            if self.phase in ("completed", "failed", "cancelled"):
                return False
            self.phase = "cancelled"
            if reason:
                self.error = reason
        child_job.terminate_tree(self.process.pid)
        child_job.forget(self.process.pid)
        if self.temp_dir is not None:
            shutil.rmtree(self.temp_dir, ignore_errors=True)
        return True


def _workspace_settings_file() -> Path:
    ensure_workspace_ready()
    app_dir = workspace_app_data_dir()
    settings_file = app_dir / "settings.json"
    if app_dir.is_symlink() or settings_file.is_symlink():
        raise AgyProfileError(409, "Agy 设置文件不得使用符号链接")
    return settings_file


def get_orchestrator_settings(profile_id: str) -> dict[str, str | None]:
    """Read shared workspace Antigravity CLI `"orchestrator": {"planner", "executor"}`."""
    _, profiles = snapshot()
    if not any(p.id == profile_id for p in profiles):
        raise AgyProfileError(404, "找不到 Agy 账号")
    settings_file = _workspace_settings_file()
    if not settings_file.exists():
        return {"profile_id": profile_id, "planner": None, "executor": None}
    try:
        raw = json.loads(settings_file.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise AgyProfileError(503, f"无法读取 Agy 设置文件: {exc}") from exc
    if not isinstance(raw, dict):
        raise AgyProfileError(503, "Agy 设置文件格式无效")
    orch = raw.get("orchestrator")
    if not isinstance(orch, dict):
        return {"profile_id": profile_id, "planner": None, "executor": None}
    planner_raw = orch.get("planner")
    executor_raw = orch.get("executor")
    planner = planner_raw.strip() if isinstance(planner_raw, str) and planner_raw.strip() else None
    executor = executor_raw.strip() if isinstance(executor_raw, str) and executor_raw.strip() else None
    return {"profile_id": profile_id, "planner": planner, "executor": executor}


def set_orchestrator_settings(
    profile_id: str,
    *,
    planner: str | None = None,
    executor: str | None = None,
) -> dict[str, str | None]:
    """Persist shared `"orchestrator": {"planner", "executor"}` in workspace `settings.json`."""
    clean_planner = planner.strip() if isinstance(planner, str) and planner.strip() else None
    clean_executor = executor.strip() if isinstance(executor, str) and executor.strip() else None
    with _profile_metadata_lock:
        _, profiles = snapshot()
        if not any(p.id == profile_id for p in profiles):
            raise AgyProfileError(404, "找不到 Agy 账号")
        settings_file = _workspace_settings_file()
        data: dict[str, Any] = {}
        if settings_file.exists():
            try:
                loaded = json.loads(settings_file.read_text(encoding="utf-8"))
            except (OSError, ValueError) as exc:
                raise AgyProfileError(503, f"无法读取现有 Agy 设置文件: {exc}") from exc
            if not isinstance(loaded, dict):
                raise AgyProfileError(503, "现有 Agy 设置文件格式无效")
            data = loaded
        orch: dict[str, str] = {}
        if clean_planner is not None:
            orch["planner"] = clean_planner
        if clean_executor is not None:
            orch["executor"] = clean_executor
        if orch:
            data["orchestrator"] = orch
        else:
            data.pop("orchestrator", None)

        try:
            _atomic_write_json(settings_file, data, mode=0o600, indent=2)
        except OSError as exc:
            raise AgyProfileError(503, f"无法保存 Agy Orchestrator 设置: {exc}") from exc
        return {"profile_id": profile_id, "planner": clean_planner, "executor": clean_executor}
