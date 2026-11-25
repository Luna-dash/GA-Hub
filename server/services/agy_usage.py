"""Official Antigravity quota probing & local SQLite usage ledger.

Ports T3 Code's `antigravityUsageLimits.ts` CloudCode quota probe (including
Windows Credential Manager CredReadW for `gemini:antigravity` via stdlib ctypes)
and absorbs AntiCLI's 5h/7d quota pool, circuit-breaker, calibration, and stats
bookkeeping directly into GA-Hub's SQLite store.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import platform
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

import requests

from .. import _paths
from ..process_utils import hidden_process_kwargs
from . import agy_profile, child_job

log = logging.getLogger(__name__)


def _antigravity_user_agent() -> str:
    raw_platform = sys.platform
    os_type = "win32" if raw_platform.startswith("win") else "darwin" if raw_platform == "darwin" else "linux"
    raw_arch = platform.machine().lower()
    if raw_arch in {"amd64", "x86_64", "x64"}:
        arch = "x64"
    elif raw_arch in {"arm64", "aarch64"}:
        arch = "arm64"
    else:
        arch = raw_arch or "x64"
    return f"antigravity/hub/2.24.0 (aidev_client; os_type={os_type}; arch={arch}; cl=963137146)"


DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com"
PROD_ENDPOINT = "https://cloudcode-pa.googleapis.com"
USER_AGENT = _antigravity_user_agent()
PROBE_CONNECT_TIMEOUT = 4.0
PROBE_READ_TIMEOUT = 10.0
PROBE_TIMEOUT: tuple[float, float] = (PROBE_CONNECT_TIMEOUT, PROBE_READ_TIMEOUT)
CLI_REFRESH_TIMEOUT = 8.0
_SUMMARY_WINDOW_MINS = {"5h": 5 * 60, "weekly": 7 * 24 * 60}

_token_cache_lock = threading.Lock()
# fingerprint -> (access_token, project_id, expires_monotonic, profile_id)
_acp_token_cache: dict[str, tuple[str, str | None, float, str]] = {}


def clear_token_cache(profile_id: str | None = None) -> None:
    """Clear cached CloudCode OAuth access tokens (on logout/delete)."""
    with _token_cache_lock:
        if profile_id is None:
            _acp_token_cache.clear()
            return
        stale = [fp for fp, entry in _acp_token_cache.items() if entry[3] == profile_id]
        for fp in stale:
            _acp_token_cache.pop(fp, None)

_QUOTA_GROUPS: dict[str, dict[str, Any]] = {
    "gemini-4": {
        "display_name": "Gemini 4",
        "window_5h_soft_tokens": 1_500_000,
        "window_5h_hard_tokens": 2_500_000,
        "window_7d_soft_tokens": 12_000_000,
        "window_7d_hard_tokens": 20_000_000,
        "input_rate": 1.25,
        "cached_rate": 0.3125,
        "output_rate": 5.0,
    },
    "gemini-3": {
        "display_name": "Gemini 3",
        "window_5h_soft_tokens": 2_000_000,
        "window_5h_hard_tokens": 3_500_000,
        "window_7d_soft_tokens": 15_000_000,
        "window_7d_hard_tokens": 25_000_000,
        "input_rate": 0.5,
        "cached_rate": 0.125,
        "output_rate": 2.0,
    },
    "claude-3p": {
        "display_name": "Claude & GPT (shared)",
        "window_5h_soft_tokens": 800_000,
        "window_5h_hard_tokens": 1_500_000,
        "window_7d_soft_tokens": 6_000_000,
        "window_7d_hard_tokens": 10_000_000,
        "input_rate": 3.0,
        "cached_rate": 0.3,
        "output_rate": 15.0,
    },
}


def read_windows_cli_credential() -> bytes | None:
    """Read `gemini:antigravity` from Windows Credential Manager (go-keyring target)."""
    if os.name != "nt":
        return None
    import ctypes
    from ctypes import wintypes

    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)

    class _CREDENTIALW(ctypes.Structure):
        _fields_ = [
            ("Flags", wintypes.DWORD),
            ("Type", wintypes.DWORD),
            ("TargetName", wintypes.LPWSTR),
            ("Comment", wintypes.LPWSTR),
            ("LastWritten", wintypes.FILETIME),
            ("CredentialBlobSize", wintypes.DWORD),
            ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)),
            ("Persist", wintypes.DWORD),
            ("AttributeCount", wintypes.DWORD),
            ("Attributes", ctypes.c_void_p),
            ("TargetAlias", wintypes.LPWSTR),
            ("UserName", wintypes.LPWSTR),
        ]

    advapi32.CredReadW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        ctypes.POINTER(ctypes.POINTER(_CREDENTIALW)),
    ]
    advapi32.CredReadW.restype = wintypes.BOOL
    advapi32.CredFree.argtypes = [ctypes.c_void_p]
    advapi32.CredFree.restype = None

    cred_ptr = ctypes.POINTER(_CREDENTIALW)()
    ok = advapi32.CredReadW("gemini:antigravity", 1, 0, ctypes.byref(cred_ptr))
    if not ok:
        return None
    try:
        cred = cred_ptr.contents
        if cred.CredentialBlobSize <= 0 or not cred.CredentialBlob:
            return None
        raw = bytes(cred.CredentialBlob[: cred.CredentialBlobSize])
        text = raw.decode("utf-8", errors="replace").strip("\x00 \t\r\n")
        if text.startswith("go-keyring-base64:"):
            import base64
            try:
                return base64.b64decode(text[len("go-keyring-base64:") :])
            except ValueError:
                return raw
        if text.startswith("go-keyring-encoded:"):
            try:
                return bytes.fromhex(text[len("go-keyring-encoded:") :])
            except ValueError:
                return raw
        return raw
    finally:
        advapi32.CredFree(cred_ptr)


def _model_group(model: str) -> str:
    try:
        from .agy_models import match_quota_group

        matched = match_quota_group(model)
        if matched:
            return matched
    except Exception:
        pass
    lower = (model or "").lower()
    if "claude" in lower or "gpt" in lower or lower.startswith("3p-"):
        return "claude-3p"
    if "gemini-3" in lower:
        return "gemini-3"
    return "gemini-4"


def _parse_iso(raw: str | None) -> datetime | None:
    if not raw:
        return None
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _iso_utc_optional(raw: str | None) -> str | None:
    parsed = _parse_iso(raw)
    if parsed is not None:
        return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return None


def _iso_utc(raw: str | None) -> str:
    return _iso_utc_optional(raw) or (datetime.now(timezone.utc) + timedelta(days=7)).isoformat().replace("+00:00", "Z")


def _make_http_session() -> requests.Session:
    """Create a requests session honoring both env and Windows manual proxy settings."""
    session = requests.Session()
    session.trust_env = True
    try:
        env = agy_profile.system_proxy_env(dict(os.environ))
    except Exception:
        env = {}
    proxies: dict[str, str] = {}
    http_proxy = env.get("HTTP_PROXY") or env.get("http_proxy")
    https_proxy = env.get("HTTPS_PROXY") or env.get("https_proxy")
    if isinstance(http_proxy, str) and http_proxy:
        proxies["http"] = http_proxy
    if isinstance(https_proxy, str) and https_proxy:
        proxies["https"] = https_proxy
    if proxies:
        session.proxies.update(proxies)
    return session


def _probe_endpoints(profile_id: str) -> tuple[str, ...]:
    """Match T3 Code ENDPOINTS priority (`oauth-business` -> prod first, else daily first)."""
    auth_type = "oauth-personal"
    candidates = [agy_profile.profile_vault_app_data_dir(profile_id) / "settings.json"]
    if agy_profile.active_workspace_profile() == profile_id:
        candidates.append(agy_profile.workspace_app_data_dir() / "settings.json")
    for settings_path in candidates:
        try:
            if settings_path.is_file() and not settings_path.is_symlink():
                raw = json.loads(settings_path.read_text(encoding="utf-8"))
                auth_obj = raw.get("auth") if isinstance(raw, dict) else None
                if isinstance(auth_obj, dict) and auth_obj.get("type") == "oauth-business":
                    auth_type = "oauth-business"
                    break
        except Exception:
            continue
    return (PROD_ENDPOINT, DAILY_ENDPOINT) if auth_type == "oauth-business" else (DAILY_ENDPOINT, PROD_ENDPOINT)


def workspace_token_fingerprint() -> str | None:
    """Return a short non-secret digest of the active workspace's OAuth token file."""
    path = agy_profile.workspace_app_data_dir() / "antigravity-oauth-token"
    try:
        if path.is_file() and not path.is_symlink() and path.stat().st_size > 0:
            return hashlib.sha256(path.read_bytes()).hexdigest()[:16]
    except OSError:
        pass
    return None


def _read_cli_token_raw(profile_id: str) -> bytes | None:
    try:
        agy_profile.sync_workspace_credentials_to_vault(profile_id)
    except Exception:
        pass
    cli_tok_path = agy_profile.find_credential_file(profile_id, "antigravity-oauth-token")
    if cli_tok_path is not None:
        try:
            return cli_tok_path.read_bytes()
        except OSError:
            return None
    if (
        profile_id == agy_profile.DEFAULT
        and not agy_profile._default_host_import_disabled().exists()
        and os.name == "nt"
    ):
        return read_windows_cli_credential()
    return None


def _read_cli_token_record(profile_id: str) -> tuple[str | None, datetime | None]:
    """Read `(access_token, expiry)` from vault, workspace, or Windows keyring."""
    raw_cli = _read_cli_token_raw(profile_id)
    if not raw_cli:
        return None, None
    try:
        text = raw_cli.decode("utf-8", errors="replace").strip("\x00 \t\r\n")
        parsed = json.loads(text)
    except Exception:
        log.debug("Failed to parse CLI oauth token", exc_info=True)
        return None, None
    token_obj = parsed.get("token") if isinstance(parsed, dict) else None
    if not isinstance(token_obj, dict):
        return None, None
    access = token_obj.get("access_token")
    if not isinstance(access, str) or not access:
        return None, None
    return access, _parse_iso(token_obj.get("expiry") if isinstance(token_obj.get("expiry"), str) else None)


def _has_cli_refresh_token(profile_id: str) -> bool:
    raw_cli = _read_cli_token_raw(profile_id)
    if not raw_cli:
        return False
    try:
        text = raw_cli.decode("utf-8", errors="replace").strip("\x00 \t\r\n")
        parsed = json.loads(text)
    except Exception:
        return False
    token_obj = parsed.get("token") if isinstance(parsed, dict) else None
    if not isinstance(token_obj, dict):
        return False
    rtok = token_obj.get("refresh_token")
    return isinstance(rtok, str) and bool(rtok.strip())


def _refresh_cli_token_status(profile_id: str, timeout: float = CLI_REFRESH_TIMEOUT) -> str:
    """Refresh an expired 1.5.x CLI OAuth token via bounded `agy models` inside profile's vault.

    Returns `"ok"`, `"exited_nonzero"`, `"timeout"`, or `"unavailable"`.
    """
    executable = agy_profile.agy_executable_or_none()
    if not executable:
        return "unavailable"
    if profile_id == agy_profile.DEFAULT:
        agy_profile._seed_default_vault_if_empty()
    temp_dir = agy_profile.make_runtime_temp_dir(profile_id)
    gemini_dir = agy_profile.profile_vault_gemini_dir(profile_id)
    proc: subprocess.Popen | None = None
    group: child_job.ProcessGroupHandle | None = None
    try:
        gemini_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        env = agy_profile.clean_agy_env(profile_id, temp_dir=temp_dir, vault_only=True)
        proc = child_job.spawn(
            [executable, "models"],
            kind="agy-token-refresh",
            marker=executable,
            cwd=str(gemini_dir),
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            **hidden_process_kwargs(),
        )
        group = child_job.create_process_group(proc)
        proc.wait(timeout=timeout)
        if proc.returncode == 0:
            agy_profile.sync_vault_token_to_workspace_if_newer(profile_id)
            return "ok"
        return "exited_nonzero"
    except subprocess.TimeoutExpired:
        if group is not None and proc is not None:
            group.terminate(proc.pid)
        elif proc is not None:
            child_job.terminate_tree(proc.pid)
        return "timeout"
    except (OSError, subprocess.SubprocessError):
        return "unavailable"
    finally:
        if group is not None:
            group.close()
        if proc is not None:
            child_job.forget(proc.pid)
        shutil.rmtree(temp_dir, ignore_errors=True)


def _refresh_cli_token_via_models(profile_id: str, timeout: float = CLI_REFRESH_TIMEOUT) -> bool:
    """Refresh an expired 1.5.x CLI OAuth token via bounded `agy models` inside profile's vault."""
    return _refresh_cli_token_status(profile_id, timeout=timeout) == "ok"


def _resolve_access_token(
    profile_id: str,
    *,
    allow_cli_refresh: bool = True,
) -> tuple[str | None, str | None, str, str]:
    """Return `(access_token, project_id, source, status)` with T3 Code caching & CLI renewal."""
    acp_tok_path = agy_profile.find_credential_file(profile_id, "acp_token.json")
    if acp_tok_path is not None:
        try:
            tok = json.loads(acp_tok_path.read_text(encoding="utf-8"))
            cid = tok.get("client_id")
            csecret = tok.get("client_secret")
            rtok = tok.get("refresh_token")
            pid = tok.get("project_id") if isinstance(tok.get("project_id"), str) else None
            if all(isinstance(v, str) and v for v in (cid, csecret, rtok)):
                fp = hashlib.sha256(f"{cid}\0{rtok}\0{pid or ''}".encode("utf-8")).hexdigest()
                now_mono = time.monotonic()
                with _token_cache_lock:
                    cached = _acp_token_cache.get(fp)
                    if cached and cached[2] > now_mono + 60.0 and cached[3] == profile_id:
                        return cached[0], cached[1], "acp_token", "ok"
                session = _make_http_session()
                res = session.post(
                    "https://oauth2.googleapis.com/token",
                    data={
                        "client_id": cid,
                        "client_secret": csecret,
                        "refresh_token": rtok,
                        "grant_type": "refresh_token",
                    },
                    timeout=PROBE_TIMEOUT,
                    allow_redirects=False,
                )
                if res.status_code == 200:
                    payload = res.json()
                    access = payload.get("access_token")
                    if isinstance(access, str) and access:
                        try:
                            expires_in = float(payload.get("expires_in") or 3600)
                        except (TypeError, ValueError):
                            expires_in = 3600.0
                        with _token_cache_lock:
                            _acp_token_cache[fp] = (access, pid, time.monotonic() + max(60.0, expires_in), profile_id)
                        return access, pid, "acp_token", "ok"
                elif res.status_code in (400, 401, 403):
                    return None, None, "acp_token", "refresh_failed"
        except requests.RequestException:
            return None, None, "acp_token", "network_error"
        except Exception:
            log.debug("Failed to refresh acp_token.json", exc_info=True)

    access, expiry = _read_cli_token_record(profile_id)
    now = datetime.now(timezone.utc)
    if access:
        if expiry is None or expiry > now + timedelta(seconds=60):
            return access, None, "cli_token", "ok"
        if allow_cli_refresh:
            refresh_status = _refresh_cli_token_status(profile_id)
            if refresh_status == "ok":
                refreshed_access, refreshed_expiry = _read_cli_token_record(profile_id)
                now_after = datetime.now(timezone.utc)
                if refreshed_access and (refreshed_expiry is None or refreshed_expiry > now_after + timedelta(seconds=60)):
                    return refreshed_access, None, "cli_token", "ok"
            if refresh_status == "exited_nonzero" and not _has_cli_refresh_token(profile_id):
                return None, None, "cli_token", "refresh_failed"
        return None, None, "cli_token", "expired"

    return None, None, "none", "missing"


def refresh_profile_token(profile_id: str) -> str:
    """Attempt silent vault token renewal and classify outcome (`ok` | `login_required` | `transient_error`)."""
    access, _, _, status = _resolve_access_token(profile_id, allow_cli_refresh=True)
    if access:
        agy_profile.record_auth_state(profile_id, "authenticated")
        return "ok"
    if status in {"refresh_failed", "missing"}:
        return "login_required"
    return "transient_error"


def _extract_access_token(profile_id: str) -> tuple[str | None, str | None]:
    """Return `(access_token, project_id)` for a profile without spawning CLI refresh."""
    access, project_id, _, _ = _resolve_access_token(profile_id, allow_cli_refresh=False)
    return access, project_id


def _summary_reset_time(bucket: dict[str, Any], window: str, requested_at: datetime) -> str | None:
    """Suppress rolling full-window reset timestamps for untouched 100% buckets (T3 Code)."""
    raw_reset = bucket.get("resetTime")
    mins = _SUMMARY_WINDOW_MINS.get(window)
    frac = bucket.get("remainingFraction")
    if (
        frac == 1
        and bucket.get("description") is None
        and mins is not None
        and isinstance(raw_reset, str)
    ):
        parsed = _parse_iso(raw_reset)
        if parsed is not None and abs((parsed - requested_at).total_seconds() - mins * 60) <= 60.0:
            return None
    return _iso_utc_optional(raw_reset if isinstance(raw_reset, str) else None)


def _parse_summary_rows(
    data: dict[str, Any],
    *,
    requested_at: datetime | None = None,
) -> list[tuple[str, dict[str, Any]]]:
    req_at = requested_at or datetime.now(timezone.utc)
    rows: list[tuple[str, dict[str, Any]]] = []
    seen_ids: set[str] = set()
    groups = data.get("groups")
    if not isinstance(groups, list) or not any(isinstance(g, dict) and g.get("buckets") for g in groups):
        groups = [{"buckets": data.get("buckets")}]
    for group in groups:
        if not isinstance(group, dict):
            continue
        display_group = str(group.get("displayName") or "").strip()
        for bucket in group.get("buckets") or []:
            if not isinstance(bucket, dict) or bucket.get("disabled"):
                continue
            bid = str(bucket.get("bucketId") or "").strip()
            frac = bucket.get("remainingFraction")
            if not bid or not isinstance(frac, (int, float)):
                continue
            pct = round(max(0.0, min(1.0, float(frac))) * 100.0, 1)
            if bid.startswith("gemini-argon-"):
                family = display_group or "Gemini Argon"
            elif bid.startswith("gemini-carbon-"):
                family = display_group or "Gemini Carbon"
            elif bid.startswith("gemini-"):
                family = "Gemini"
            elif bid.startswith("3p-"):
                family = "Claude & GPT (shared)"
            else:
                family = display_group or bid
            win = str(bucket.get("window") or "")
            limit = (
                "Weekly Limit Remaining"
                if win == "weekly"
                else "Five Hour Limit Remaining"
                if win == "5h"
                else str(bucket.get("displayName") or "Quota").strip() or "Quota"
            )
            if bid in seen_ids:
                continue
            seen_ids.add(bid)
            rows.append((
                bid,
                {
                    "model": family,
                    "limit": limit,
                    "remaining_pct": pct,
                    "resets_at": _summary_reset_time(bucket, win, req_at),
                },
            ))
    return rows


def _parse_model_rows(
    data: dict[str, Any],
    *,
    requested_at: datetime | None = None,  # noqa: ARG001
) -> list[tuple[str, dict[str, Any]]]:
    models = data.get("models")
    if not isinstance(models, dict):
        return []
    merged: dict[str, dict[str, Any]] = {}
    for model_id, info in models.items():
        if not isinstance(info, dict):
            continue
        prov = str(info.get("modelProvider") or "")
        if prov == "MODEL_PROVIDER_GOOGLE" or str(model_id).startswith("gemini-"):
            family = "Gemini"
        elif prov == "MODEL_PROVIDER_ANTHROPIC" or str(model_id).startswith("claude-"):
            family = "Claude"
        elif prov == "MODEL_PROVIDER_OPENAI" or str(model_id).startswith("gpt-"):
            family = "GPT"
        else:
            continue
        for suffix, label, quota in (
            ("quota", "Reported Quota", info.get("quotaInfo")),
            ("weekly", "Weekly Limit Remaining", info.get("weeklyQuotaInfo")),
        ):
            if not isinstance(quota, dict):
                continue
            frac = quota.get("remainingFraction")
            if not isinstance(frac, (int, float)):
                continue
            pct = round(max(0.0, min(1.0, float(frac))) * 100.0, 1)
            dedup_id = f"{family.lower()}-{suffix}"
            prev = merged.get(dedup_id)
            if prev is None or pct < prev["remaining_pct"]:
                merged[dedup_id] = {
                    "model": family,
                    "limit": label,
                    "remaining_pct": pct,
                    "resets_at": _iso_utc_optional(quota.get("resetTime") if isinstance(quota.get("resetTime"), str) else None),
                }
    return list(merged.items())


def _parse_available_model_catalog(data: dict[str, Any]) -> list[dict[str, Any]]:
    models = data.get("models")
    if not isinstance(models, dict):
        return []
    default_id = data.get("defaultAgentModelId") if isinstance(data.get("defaultAgentModelId"), str) else None
    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    for model_id, info in models.items():
        if not isinstance(model_id, str) or not model_id.strip() or not isinstance(info, dict):
            continue
        if info.get("isInternal") is True:
            continue
        mid = model_id.strip()
        if mid in seen:
            continue
        seen.add(mid)
        entry: dict[str, Any] = {
            "id": mid,
            "display_name": str(info.get("displayName") or info.get("name") or mid).strip() or mid,
        }
        if "orchestrator" in mid.lower():
            entry["is_orchestrator"] = True
        else:
            raw_levels = info.get("supportedThinkingLevels") or info.get("thinkingLevels") or info.get("supportedEfforts")
            if isinstance(raw_levels, list):
                efforts = [str(lvl).strip().lower() for lvl in raw_levels if isinstance(lvl, str) and str(lvl).strip()]
                if efforts:
                    entry["efforts"] = list(dict.fromkeys(efforts))
            if isinstance(info.get("defaultThinkingLevel"), str) and info["defaultThinkingLevel"].strip():
                entry["default_effort"] = info["defaultThinkingLevel"].strip().lower()
        if mid == default_id or info.get("isDefault") is True:
            entry["is_default"] = True
        items.append(entry)
    return items


def probe_available_models(profile_id: str) -> dict[str, Any]:
    """Fetch upstream model catalog directly via CloudCode `fetchAvailableModels`."""
    access_token, project_id, _, _ = _resolve_access_token(profile_id, allow_cli_refresh=True)
    if not access_token:
        return {"state": "login_required", "items": []}
    session = _make_http_session()
    headers = {
        "Authorization": f"Bearer {access_token}",
        "User-Agent": _antigravity_user_agent(),
        "Content-Type": "application/json",
    }
    body = {"project": project_id} if project_id else {}
    for endpoint in _probe_endpoints(profile_id):
        try:
            res = session.post(
                f"{endpoint}/v1internal:fetchAvailableModels",
                headers=headers,
                json=body,
                timeout=PROBE_TIMEOUT,
                allow_redirects=False,
            )
            if res.status_code != 200:
                continue
            items = _parse_available_model_catalog(res.json())
            if items:
                return {"state": "authenticated", "items": items}
        except Exception:
            continue
    return {"state": "authenticated", "items": []}


def _fetch_operation_rows(
    access_token: str,
    project_id: str | None,
    endpoints: tuple[str, ...],
    operation: str,
    parser: Callable[..., list[tuple[str, dict[str, Any]]]],
) -> tuple[list[dict[str, Any]], bool, bool]:
    """Query `endpoints` concurrently in priority order (first endpoint wins per bucket ID)."""
    headers = {
        "Authorization": f"Bearer {access_token}",
        "User-Agent": _antigravity_user_agent(),
        "Content-Type": "application/json",
    }
    body = {"project": project_id} if project_id else {}

    def query_one(endpoint: str) -> tuple[list[tuple[str, dict[str, Any]]], bool, bool]:
        session = _make_http_session()
        requested_at = datetime.now(timezone.utc)
        try:
            res = session.post(
                f"{endpoint}/v1internal:{operation}",
                headers=headers,
                json=body,
                timeout=PROBE_TIMEOUT,
                allow_redirects=False,
            )
        except requests.RequestException:
            return [], False, True
        if res.status_code in (401, 403):
            return [], True, False
        if res.status_code != 200:
            return [], False, False
        try:
            return parser(res.json(), requested_at=requested_at), False, False
        except Exception:
            return [], False, False

    if len(endpoints) == 1:
        results = [query_one(endpoints[0])]
    else:
        with ThreadPoolExecutor(max_workers=len(endpoints)) as pool:
            results = list(pool.map(query_one, endpoints))

    merged: dict[str, dict[str, Any]] = {}
    unauthorized = False
    had_network_error = False
    for rows, unauth, net_err in results:
        unauthorized = unauthorized or unauth
        had_network_error = had_network_error or net_err
        for dedup_id, row in rows:
            if dedup_id not in merged:
                merged[dedup_id] = row
    return list(merged.values()), unauthorized, had_network_error


def probe_account_usage(
    profile_id: str,
    *,
    allow_cli_fallback: bool | None = None,
    allow_cli_refresh: bool = True,
) -> dict[str, Any]:
    """Query live official quota windows directly from CloudCode APIs (T3 Code method)."""
    effective_refresh = allow_cli_refresh if allow_cli_fallback is None else bool(allow_cli_fallback)
    access_token, project_id, source, token_status = _resolve_access_token(
        profile_id,
        allow_cli_refresh=effective_refresh,
    )
    if not access_token:
        if token_status == "expired":
            return {
                "state": "unverified",
                "rows": [],
                "detail": "本地短效访问凭据已过期且后台静默续期未完成，请稍后重试；如多次失败再重新登录。",
            }
        if token_status == "refresh_failed":
            agy_profile.record_auth_state(profile_id, "login_required")
            return {
                "state": "login_required",
                "rows": [],
                "detail": "当前账号登录态已失效，请重新登录 Agy 账号。",
            }
        if token_status == "network_error":
            return {
                "state": "unverified",
                "rows": [],
                "detail": "连接 Google 鉴权服务超时或网络不可达，请检查网络与代理设置后重试。",
            }
        state = "unverified" if agy_profile.has_local_credentials(profile_id) else "login_required"
        if state == "login_required":
            agy_profile.record_auth_state(profile_id, "login_required")
        return {
            "state": state,
            "rows": [],
            "detail": "当前账号尚未登录或未找到可用凭据，请先完成登录后再检测额度。",
        }

    endpoints = _probe_endpoints(profile_id)
    for attempt in range(2):
        summary_rows, sum_unauth, sum_net = _fetch_operation_rows(
            access_token,
            project_id,
            endpoints,
            "retrieveUserQuotaSummary",
            _parse_summary_rows,
        )
        if summary_rows:
            agy_profile.record_auth_state(profile_id, "authenticated")
            return {"state": "authenticated", "rows": summary_rows}
        model_rows, mod_unauth, mod_net = _fetch_operation_rows(
            access_token,
            project_id,
            endpoints,
            "fetchAvailableModels",
            _parse_model_rows,
        )
        if model_rows:
            agy_profile.record_auth_state(profile_id, "authenticated")
            return {"state": "authenticated", "rows": model_rows}

        unauthorized = sum_unauth or mod_unauth
        had_network_error = sum_net or mod_net
        if attempt == 0 and unauthorized and source == "cli_token" and effective_refresh:
            if _refresh_cli_token_via_models(profile_id):
                new_access, new_expiry = _read_cli_token_record(profile_id)
                now_after = datetime.now(timezone.utc)
                if new_access and new_access != access_token and (new_expiry is None or new_expiry > now_after + timedelta(seconds=60)):
                    access_token = new_access
                    continue
        if unauthorized:
            agy_profile.record_auth_state(profile_id, "login_required")
            return {
                "state": "login_required",
                "rows": [],
                "detail": "当前账号登录态已失效，请重新登录 Agy 账号。",
            }
        if had_network_error:
            return {
                "state": "unverified",
                "rows": [],
                "detail": "连接 Google CloudCode 超时或网络不可达，请检查网络与代理设置后重试。",
            }
        break

    agy_profile.record_auth_state(profile_id, "authenticated")
    return {
        "state": "authenticated",
        "rows": [],
        "detail": "Google CloudCode 未返回该账号的可用额度窗口。",
    }


def normalize_ledger_input(
    input_tokens: int,
    cache_read_tokens: int,
    cache_write_tokens: int = 0,
) -> tuple[int, int, int, int]:
    """Return canonical `(total_input, fresh_input, cache_read, cache_write)`.

    Folds exclusive `input_tokens` (where `cache_read + cache_write > input_tokens`)
    into `total_input` so `0 <= cache_read + cache_write <= total_input` holds.
    """
    inp = max(0, int(input_tokens or 0))
    cr = max(0, int(cache_read_tokens or 0))
    cw = max(0, int(cache_write_tokens or 0))
    total_in = inp + cr + cw if (cr + cw) > inp else inp
    fresh_in = max(0, total_in - cr - cw)
    return total_in, fresh_in, cr, cw


class AgyLedger:
    """Built-in SQLite per-profile quota pool, rate-limit breaker, and usage ledger."""

    _schema_lock = threading.Lock()
    _initialized_dbs: dict[Path, int] = {}

    def __init__(self, db: Path | None = None):
        self.db = db or (_paths.ADMIN_DATA / "anti_sessions.sqlite3")
        self._db_key = self.db.resolve()

    def ensure_schema(self, conn: sqlite3.Connection) -> None:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS usage_ledger (
                run_id TEXT PRIMARY KEY,
                profile_id TEXT NOT NULL DEFAULT 'default',
                model TEXT NOT NULL,
                model_group TEXT NOT NULL,
                status TEXT NOT NULL,
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                cache_read_tokens INTEGER NOT NULL DEFAULT 0,
                cache_write_tokens INTEGER NOT NULL DEFAULT 0,
                thinking_tokens INTEGER NOT NULL DEFAULT 0,
                estimated_cost_usd REAL NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS quota_state (
                profile_id TEXT NOT NULL DEFAULT 'default',
                model_group TEXT NOT NULL,
                cooldown_until TEXT,
                calibrated_remaining_pct REAL,
                calibrated_at TEXT,
                calibrated_note TEXT,
                PRIMARY KEY (profile_id, model_group)
            );
        """)
        ledger_cols = {row[1] for row in conn.execute("PRAGMA table_info(usage_ledger)")}
        if "profile_id" not in ledger_cols:
            with conn:
                conn.execute("ALTER TABLE usage_ledger ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'default'")
        if "cache_write_tokens" not in ledger_cols:
            with conn:
                conn.execute("ALTER TABLE usage_ledger ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_usage_ledger_profile_created ON usage_ledger(profile_id, created_at)"
        )
        quota_cols = {row[1] for row in conn.execute("PRAGMA table_info(quota_state)")}
        if "profile_id" not in quota_cols:
            with conn:
                conn.executescript("""
                    CREATE TABLE quota_state_v2 (
                        profile_id TEXT NOT NULL DEFAULT 'default',
                        model_group TEXT NOT NULL,
                        cooldown_until TEXT,
                        calibrated_remaining_pct REAL,
                        calibrated_at TEXT,
                        calibrated_note TEXT,
                        PRIMARY KEY (profile_id, model_group)
                    );
                    INSERT INTO quota_state_v2 (
                        profile_id, model_group, cooldown_until,
                        calibrated_remaining_pct, calibrated_at, calibrated_note
                    )
                    SELECT 'default', model_group, cooldown_until,
                           calibrated_remaining_pct, calibrated_at, calibrated_note
                    FROM quota_state;
                    DROP TABLE quota_state;
                    ALTER TABLE quota_state_v2 RENAME TO quota_state;
                """)

    def _connect(self):
        self.db.parent.mkdir(parents=True, exist_ok=True)
        existed = self.db.exists()
        ctime = self.db.stat().st_ctime_ns if existed else None
        conn = sqlite3.connect(self.db, timeout=15.0)
        conn.row_factory = sqlite3.Row
        if not existed or self._initialized_dbs.get(self._db_key) != ctime:
            with self._schema_lock:
                conn.execute("PRAGMA journal_mode=WAL")
                conn.execute("PRAGMA synchronous=NORMAL")
                self.ensure_schema(conn)
                try:
                    self._initialized_dbs[self._db_key] = self.db.stat().st_ctime_ns
                except OSError:
                    pass
        else:
            conn.execute("PRAGMA synchronous=NORMAL")
        return closing(conn)

    def record_run(
        self,
        run_id: str,
        model: str,
        status: str,
        *,
        profile_id: str = agy_profile.DEFAULT,
        input_tokens: int = 0,
        output_tokens: int = 0,
        cache_read_tokens: int = 0,
        cache_write_tokens: int = 0,
        thinking_tokens: int = 0,
        cooldown_seconds: int = 0,
    ) -> None:
        pid = profile_id or agy_profile.DEFAULT
        group = _model_group(model)
        cfg = _QUOTA_GROUPS.get(group, _QUOTA_GROUPS["gemini-4"])
        total_in, fresh_in, cached, cache_write = normalize_ledger_input(
            input_tokens, cache_read_tokens, cache_write_tokens
        )
        # Antigravity 1.5+ output_tokens already includes thinking_tokens (T3 Code reasoningTokens subset).
        total_out = max(max(0, int(output_tokens or 0)), max(0, int(thinking_tokens or 0)))
        cost = round(
            ((fresh_in + cache_write) / 1_000_000) * cfg["input_rate"]
            + (cached / 1_000_000) * cfg["cached_rate"]
            + (total_out / 1_000_000) * cfg["output_rate"],
            6,
        )
        now = datetime.now(timezone.utc)
        with self._connect() as db, db:
            db.execute(
                """
                INSERT INTO usage_ledger
                (run_id, profile_id, model, model_group, status, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, thinking_tokens, estimated_cost_usd, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(run_id) DO UPDATE SET
                    profile_id=excluded.profile_id,
                    status=excluded.status,
                    input_tokens=excluded.input_tokens,
                    output_tokens=excluded.output_tokens,
                    cache_read_tokens=excluded.cache_read_tokens,
                    cache_write_tokens=excluded.cache_write_tokens,
                    thinking_tokens=excluded.thinking_tokens,
                    estimated_cost_usd=excluded.estimated_cost_usd
                """,
                (
                    run_id,
                    pid,
                    model,
                    group,
                    status,
                    total_in,
                    max(0, output_tokens),
                    cached,
                    cache_write,
                    max(0, thinking_tokens),
                    cost,
                    now.isoformat(),
                ),
            )
            if cooldown_seconds > 0:
                until = (now + timedelta(seconds=cooldown_seconds)).isoformat()
                db.execute(
                    """
                    INSERT INTO quota_state (profile_id, model_group, cooldown_until) VALUES (?, ?, ?)
                    ON CONFLICT(profile_id, model_group) DO UPDATE SET cooldown_until=excluded.cooldown_until
                    """,
                    (pid, group, until),
                )

    def check_run_allowed(
        self,
        model: str,
        profile_id: str = agy_profile.DEFAULT,
        *,
        conn: sqlite3.Connection | None = None,
    ) -> tuple[bool, str | None]:
        """Guard account safety: fail fast if active profile+model pool is cooling down or calibrated to 0%."""
        pid = profile_id or agy_profile.DEFAULT
        group = _model_group(model)
        cfg = _QUOTA_GROUPS.get(group, {"display_name": group})
        display_name = str(cfg.get("display_name") or group)
        now = datetime.now(timezone.utc)
        query = "SELECT cooldown_until, calibrated_remaining_pct FROM quota_state WHERE profile_id=? AND model_group=?"
        if conn is not None:
            row = conn.execute(query, (pid, group)).fetchone()
        else:
            with self._connect() as db:
                row = db.execute(query, (pid, group)).fetchone()
        if row is None:
            return True, None
        cooldown_dt = _parse_iso(row["cooldown_until"])
        if cooldown_dt and cooldown_dt > now:
            rem = max(1, int((cooldown_dt - now).total_seconds()))
            return (
                False,
                f"当前账号的 {display_name} 配额处于风控冷却期（剩余 {rem} 秒），为保护账号安全请稍后重试、切换其他账号或手动重置熔断。",
            )
        cal = row["calibrated_remaining_pct"]
        if cal is not None and float(cal) <= 0.0:
            return (
                False,
                f"当前账号的 {display_name} 已手动校准为 0% 剩余额度，为防止触发超限风控已暂停发送，请重新校准额度或切换账号。",
            )
        return True, None

    def quota_pools(self, profile_id: str = agy_profile.DEFAULT) -> list[dict[str, Any]]:
        pid = profile_id or agy_profile.DEFAULT
        now = datetime.now(timezone.utc)
        cutoff_5h = (now - timedelta(hours=5)).isoformat()
        cutoff_7d = (now - timedelta(days=7)).isoformat()
        with self._connect() as db:
            states = {
                row["model_group"]: dict(row)
                for row in db.execute("SELECT * FROM quota_state WHERE profile_id=?", (pid,))
            }
            totals_5h = {
                row["model_group"]: row["tok"] or 0
                for row in db.execute(
                    "SELECT model_group, SUM(input_tokens + MAX(output_tokens, thinking_tokens)) AS tok "
                    "FROM usage_ledger WHERE profile_id=? AND created_at>=? GROUP BY model_group",
                    (pid, cutoff_5h),
                )
            }
            totals_7d = {
                row["model_group"]: (row["tok"] or 0, float(row["cost"] or 0.0))
                for row in db.execute(
                    "SELECT model_group, SUM(input_tokens + MAX(output_tokens, thinking_tokens)) AS tok, SUM(estimated_cost_usd) AS cost "
                    "FROM usage_ledger WHERE profile_id=? AND created_at>=? GROUP BY model_group",
                    (pid, cutoff_7d),
                )
            }
        out: list[dict[str, Any]] = []
        for gname, cfg in _QUOTA_GROUPS.items():
            tok_5h = int(totals_5h.get(gname, 0))
            tok_7d, cost_7d = totals_7d.get(gname, (0, 0.0))
            pct_5h = round((tok_5h / cfg["window_5h_hard_tokens"]) * 100.0, 2)
            pct_7d = round((int(tok_7d) / cfg["window_7d_hard_tokens"]) * 100.0, 2)
            st = states.get(gname, {})
            cooldown_dt = _parse_iso(st.get("cooldown_until"))
            cooldown_rem = max(0, int((cooldown_dt - now).total_seconds())) if cooldown_dt and cooldown_dt > now else 0
            if cooldown_rem > 0:
                status = "cooling_down"
            elif tok_5h >= cfg["window_5h_hard_tokens"] or int(tok_7d) >= cfg["window_7d_hard_tokens"]:
                status = "HARD_LIMIT"
            elif tok_5h >= cfg["window_5h_soft_tokens"] or int(tok_7d) >= cfg["window_7d_soft_tokens"]:
                status = "WARN"
            else:
                status = "normal"
            out.append({
                "model_group": gname,
                "display_name": cfg["display_name"],
                "status": status,
                "cooldown_remaining_seconds": cooldown_rem,
                "window_5h_pct": pct_5h,
                "window_7d_pct": pct_7d,
                "calibrated_remaining_pct": st.get("calibrated_remaining_pct"),
                "estimated_cost_7d_usd": round(cost_7d, 4),
            })
        return out

    def reset_breaker(self, model_group: str | None = None, profile_id: str = agy_profile.DEFAULT) -> None:
        pid = profile_id or agy_profile.DEFAULT
        with self._connect() as db, db:
            if model_group:
                db.execute(
                    "UPDATE quota_state SET cooldown_until=NULL WHERE profile_id=? AND model_group=?",
                    (pid, model_group),
                )
            else:
                db.execute("UPDATE quota_state SET cooldown_until=NULL WHERE profile_id=?", (pid,))

    def calibrate_quota(
        self,
        model_group: str,
        remaining_pct: float,
        note: str | None = None,
        profile_id: str = agy_profile.DEFAULT,
    ) -> dict[str, Any]:
        pid = profile_id or agy_profile.DEFAULT
        now = datetime.now(timezone.utc).isoformat()
        with self._connect() as db, db:
            db.execute(
                """
                INSERT INTO quota_state (profile_id, model_group, cooldown_until, calibrated_remaining_pct, calibrated_at, calibrated_note)
                VALUES (?, ?, NULL, ?, ?, ?)
                ON CONFLICT(profile_id, model_group) DO UPDATE SET
                    cooldown_until=NULL,
                    calibrated_remaining_pct=excluded.calibrated_remaining_pct,
                    calibrated_at=excluded.calibrated_at,
                    calibrated_note=excluded.calibrated_note
                """,
                (pid, model_group, float(remaining_pct), now, note or ""),
            )
        pools = {p["model_group"]: p for p in self.quota_pools(profile_id=pid)}
        return pools.get(model_group) or {
            "model_group": model_group,
            "display_name": model_group,
            "status": "normal",
            "cooldown_remaining_seconds": 0,
            "calibrated_remaining_pct": float(remaining_pct),
        }

    def clear_quota_state(self, profile_id: str) -> None:
        if not profile_id:
            return
        with self._connect() as db, db:
            db.execute("DELETE FROM quota_state WHERE profile_id=?", (profile_id,))

    def active_cooldown_by_profile(self) -> dict[str, int]:
        """Return max remaining cooldown seconds keyed by profile_id for active risk-control locks."""
        now = datetime.now(timezone.utc)
        out: dict[str, int] = {}
        with self._connect() as db:
            rows = db.execute(
                "SELECT profile_id, cooldown_until FROM quota_state WHERE cooldown_until IS NOT NULL"
            )
            for row in rows:
                dt = _parse_iso(row["cooldown_until"])
                if dt and dt > now:
                    rem = max(1, int((dt - now).total_seconds()))
                    pid = row["profile_id"] or agy_profile.DEFAULT
                    out[pid] = max(out.get(pid, 0), rem)
        return out

    def delete_profile(self, profile_id: str) -> None:
        if not profile_id:
            return
        with self._connect() as db, db:
            db.execute("DELETE FROM quota_state WHERE profile_id=?", (profile_id,))
            db.execute("DELETE FROM usage_ledger WHERE profile_id=?", (profile_id,))

    def stats(self, window_hours: int = 24, profile_id: str = agy_profile.DEFAULT) -> dict[str, Any]:
        pid = profile_id or agy_profile.DEFAULT
        clauses = ["profile_id = ?"]
        params: list[Any] = [pid]
        if window_hours > 0:
            cutoff = (datetime.now(timezone.utc) - timedelta(hours=window_hours)).isoformat()
            clauses.append("created_at >= ?")
            params.append(cutoff)
        where = "WHERE " + " AND ".join(clauses)
        with self._connect() as db:
            rows = db.execute(
                f"SELECT status, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, thinking_tokens, estimated_cost_usd FROM usage_ledger {where}",
                tuple(params),
            ).fetchall()
        total = len(rows)
        success = sum(1 for r in rows if r["status"] == "success")
        rate_limited = sum(1 for r in rows if r["status"] == "rate_limited")
        failed = sum(1 for r in rows if r["status"] not in ("success", "cancelled"))
        inp = 0
        out = 0
        cached = 0
        cost = 0.0
        for r in rows:
            row_in, _, row_cr, _ = normalize_ledger_input(
                int(r["input_tokens"]),
                int(r["cache_read_tokens"]),
                int(r["cache_write_tokens"]),
            )
            inp += row_in
            out += max(max(0, int(r["output_tokens"])), max(0, int(r["thinking_tokens"])))
            cached += row_cr
            cost += float(r["estimated_cost_usd"])
        ratio = min(1.0, round(cached / inp, 4)) if inp > 0 else 0.0
        return {
            "window_hours": window_hours,
            "total_runs": total,
            "success_runs": success,
            "failed_runs": failed,
            "rate_limited_runs": rate_limited,
            "total_tokens": inp + out,
            "cache_hit_ratio": ratio,
            "estimated_cost_usd": round(cost, 4),
        }
