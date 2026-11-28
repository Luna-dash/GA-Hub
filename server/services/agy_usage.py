"""Official Antigravity CLI quota probing & local SQLite usage ledger.

Queries official quota via the Antigravity CLI (`agy -p /usage --output-format json`,
manual single-account invocation only — zero direct calls to internal CloudCode or
OAuth HTTP endpoints) and maintains GA-Hub's local SQLite 5h/7d quota pool,
circuit-breaker, calibration, and token/cost bookkeeping.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import sqlite3
import subprocess
import threading
import time
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .. import _paths
from ..process_utils import hidden_process_kwargs
from . import agy_pricing, agy_profile, child_job

log = logging.getLogger(__name__)

CLI_REFRESH_TIMEOUT = 8.0
CLI_USAGE_TIMEOUT = 18.0
CLI_USAGE_PRINT_TIMEOUT = "15s"
_SUMMARY_WINDOW_MINS = {"5h": 5 * 60, "weekly": 7 * 24 * 60}
_AUTH_ERR_TOKENS = (
    "authentication required",
    "please visit the url to log in",
    "waiting for authentication",
    "invalid_grant",
    "login required",
    "please sign in",
    "unauthenticated",
    "token expired",
)

_QUOTA_GROUPS: dict[str, dict[str, Any]] = {
    "gemini-4": {
        "display_name": "Gemini 4",
        "window_5h_soft_tokens": 1_500_000,
        "window_5h_hard_tokens": 2_500_000,
        "window_7d_soft_tokens": 12_000_000,
        "window_7d_hard_tokens": 20_000_000,
    },
    "gemini-3": {
        "display_name": "Gemini 3",
        "window_5h_soft_tokens": 2_000_000,
        "window_5h_hard_tokens": 3_500_000,
        "window_7d_soft_tokens": 15_000_000,
        "window_7d_hard_tokens": 25_000_000,
    },
    "claude-3p": {
        "display_name": "Claude & GPT (shared)",
        "window_5h_soft_tokens": 800_000,
        "window_5h_hard_tokens": 1_500_000,
        "window_7d_soft_tokens": 6_000_000,
        "window_7d_hard_tokens": 10_000_000,
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


def _profile_auth_type(profile_id: str) -> str:
    """Return `oauth-business` or `oauth-personal` from profile/workspace `settings.json`."""
    candidates = [agy_profile.profile_vault_app_data_dir(profile_id) / "settings.json"]
    if agy_profile.active_workspace_profile() == profile_id:
        candidates.append(agy_profile.workspace_app_data_dir() / "settings.json")
    for settings_path in candidates:
        try:
            if settings_path.is_file() and not settings_path.is_symlink():
                raw = json.loads(settings_path.read_text(encoding="utf-8"))
                auth_obj = raw.get("auth") if isinstance(raw, dict) else None
                if isinstance(auth_obj, dict) and auth_obj.get("type") == "oauth-business":
                    return "oauth-business"
        except Exception:
            continue
    return "oauth-personal"


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
    """Refresh an expired CLI OAuth token via bounded official `agy models` inside profile's vault.

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


def refresh_profile_token(profile_id: str) -> str:
    """Attempt silent vault token renewal strictly via official `agy models` (`ok` | `login_required` | `transient_error`)."""
    try:
        agy_profile.sync_workspace_credentials_to_vault(profile_id)
    except Exception:
        pass
    if profile_id == agy_profile.DEFAULT:
        agy_profile._seed_default_vault_if_empty()
    if not agy_profile.has_local_credentials(profile_id):
        return "login_required"
    status = _refresh_cli_token_status(profile_id)
    if status == "ok":
        agy_profile.record_auth_state(profile_id, "authenticated")
        return "ok"
    if status == "exited_nonzero" and not _has_cli_refresh_token(profile_id):
        return "login_required"
    return "transient_error"


def _is_auth_error_text(text: str | None) -> bool:
    if not text:
        return False
    lower = text.lower()
    return any(tok in lower for tok in _AUTH_ERR_TOKENS)


def _summary_reset_time(bucket: dict[str, Any], window: str, requested_at: datetime) -> str | None:
    """Suppress rolling full-window reset timestamps for untouched 100% buckets."""
    raw_reset = bucket.get("reset_time") if "reset_time" in bucket else bucket.get("resetTime")
    mins = _SUMMARY_WINDOW_MINS.get(window)
    frac = bucket.get("remaining_fraction") if "remaining_fraction" in bucket else bucket.get("remainingFraction")
    if (
        frac == 1
        and bucket.get("description") is None
        and mins is not None
        and isinstance(raw_reset, str)
    ):
        parsed = _parse_iso(raw_reset)
        if parsed is not None and abs((parsed - requested_at).total_seconds() - mins * 60) <= 300.0:
            return None
    return _iso_utc_optional(raw_reset if isinstance(raw_reset, str) else None)


def _normalize_group_family(bid: str, group_name: str) -> str:
    cleaned_group = re.sub(r"(?:^|\s+)models$", "", group_name.strip(), flags=re.IGNORECASE).strip()
    low_bid = bid.lower()
    low_group = cleaned_group.lower()
    if low_bid.startswith("gemini-argon-") or "argon" in low_group:
        return cleaned_group if "argon" in low_group else "Gemini Argon"
    if low_bid.startswith("gemini-carbon-") or "carbon" in low_group:
        return cleaned_group if "carbon" in low_group else "Gemini Carbon"
    if low_bid.startswith("gemini-") or low_group == "gemini":
        return "Gemini"
    if low_bid.startswith("3p-") or ("claude" in low_group and "gpt" in low_group):
        return "Claude & GPT (shared)"
    return cleaned_group or bid


def _parse_cli_usage_buckets(
    data: dict[str, Any],
    *,
    requested_at: datetime | None = None,
) -> list[dict[str, Any]]:
    req_at = requested_at or datetime.now(timezone.utc)
    raw_rows: list[tuple[str, dict[str, Any]]] = []
    seen_ids: set[str] = set()
    groups = data.get("groups")
    if not isinstance(groups, list) or not any(isinstance(g, dict) and g.get("buckets") for g in groups):
        groups = [{"buckets": data.get("buckets")}]
    for group in groups:
        if not isinstance(group, dict):
            continue
        display_group = str(group.get("name") or group.get("displayName") or "").strip()
        for bucket in group.get("buckets") or []:
            if not isinstance(bucket, dict) or bucket.get("disabled"):
                continue
            bid = str(bucket.get("id") or bucket.get("bucketId") or "").strip()
            frac = (
                bucket.get("remaining_fraction")
                if "remaining_fraction" in bucket
                else bucket.get("remainingFraction")
            )
            if not bid or not isinstance(frac, (int, float)):
                continue
            pct = round(max(0.0, min(1.0, float(frac))) * 100.0, 1)
            family = _normalize_group_family(bid, display_group)
            win = str(bucket.get("window") or "").strip().lower()
            bucket_label = str(bucket.get("name") or bucket.get("displayName") or "").strip()
            if win == "weekly":
                limit = "Weekly Limit Remaining"
            elif win == "5h":
                limit = "Five Hour Limit Remaining"
            else:
                limit = bucket_label or "Quota"
            if bid in seen_ids:
                continue
            seen_ids.add(bid)
            raw_rows.append((
                bid,
                {
                    "model": family,
                    "limit": limit,
                    "remaining_pct": pct,
                    "resets_at": _summary_reset_time(bucket, win, req_at),
                },
            ))

    collapsed: dict[tuple[str, str], dict[str, Any]] = {}
    for _, row in raw_rows:
        disp_key = (str(row.get("model") or ""), str(row.get("limit") or ""))
        prev = collapsed.get(disp_key)
        if prev is None or _should_replace_display_row(prev, row):
            collapsed[disp_key] = row
    return sorted(collapsed.values(), key=_quota_row_sort_key)


_MODEL_FAMILY_RANK = {
    "gemini": 0,
    "gemini argon": 1,
    "gemini carbon": 2,
    "claude & gpt (shared)": 3,
    "claude": 4,
    "gpt": 5,
}


def _quota_row_sort_key(row: dict[str, Any]) -> tuple[int, int, str, str]:
    model_low = str(row.get("model") or "").strip().lower()
    limit_low = str(row.get("limit") or "").strip().lower()
    family_rank = _MODEL_FAMILY_RANK.get(model_low, 6)
    if "5h" in limit_low or "five hour" in limit_low:
        win_rank = 0
    elif "weekly" in limit_low:
        win_rank = 2
    else:
        win_rank = 1
    return (family_rank, win_rank, model_low, limit_low)


def _should_replace_display_row(prev: dict[str, Any], candidate: dict[str, Any]) -> bool:
    prev_pct = float(prev.get("remaining_pct", 100.0))
    cand_pct = float(candidate.get("remaining_pct", 100.0))
    if cand_pct != prev_pct:
        return cand_pct < prev_pct
    prev_reset = prev.get("resets_at")
    cand_reset = candidate.get("resets_at")
    if cand_reset and not prev_reset:
        return True
    if cand_reset and prev_reset and str(cand_reset) < str(prev_reset):
        return True
    return False


_TIER_GENERIC_NAMES = frozenset({
    "antigravity",
    "free-tier",
    "legacy-tier",
    "standard-tier",
    "g1-pro-tier",
    "g1-ultra-tier",
    "g1-plus-tier",
})


def _classify_tier_entry(obj: Any) -> tuple[str | None, str | None]:
    if isinstance(obj, str):
        obj = {"id": obj, "name": obj}
    if not isinstance(obj, dict):
        return None, None
    tid = str(obj.get("id") or "").strip()
    tname = str(obj.get("name") or "").strip()
    if not tid and not tname:
        return None, None
    combined = f"{tid} {tname}".lower()
    friendly = "" if (not tname or tname.lower() == tid.lower() or tname.lower() in _TIER_GENERIC_NAMES) else tname[:64]
    if "ultra" in combined:
        return "ultra", friendly or "Google AI Ultra"
    if re.search(r"\bpro\b|pro-tier|ai\s+pro", combined):
        return "pro", friendly or "Google AI Pro"
    if re.search(r"\bplus\b|plus-tier|ai\s+plus", combined):
        return "plus", friendly or "Google AI Plus"
    if any(tok in combined for tok in ("enterprise", "standard-tier", "business")):
        return "enterprise", friendly or "Enterprise"
    if "free" in combined or "legacy-tier" in combined:
        return "free", friendly or "Free"
    return None, None


def _normalize_account_tier(
    data: dict[str, Any] | None,
    *,
    auth_type: str = "oauth-personal",
) -> tuple[str | None, str | None]:
    if isinstance(data, dict):
        paid_tier, paid_name = _classify_tier_entry(data.get("paidTier") or data.get("paid_tier"))
        cur_tier, cur_name = _classify_tier_entry(
            data.get("currentTier") or data.get("current_tier") or data.get("plan_tier") or data.get("tier")
        )
        if paid_tier is not None and (paid_tier != "free" or cur_tier is None):
            return paid_tier, paid_name
        if cur_tier is not None:
            return cur_tier, cur_name
        if paid_tier is not None:
            return paid_tier, paid_name
    if auth_type == "oauth-business":
        return "enterprise", "Enterprise"
    return None, None


def _extract_json_envelope(raw_stdout: str) -> dict[str, Any] | None:
    text = (raw_stdout or "").strip()
    if not text:
        return None
    try:
        parsed = json.loads(text)
        return parsed if isinstance(parsed, dict) else None
    except ValueError:
        pass
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        try:
            parsed = json.loads(text[start : end + 1])
            return parsed if isinstance(parsed, dict) else None
        except ValueError:
            return None
    return None


def _run_cli_usage_command(
    profile_id: str,
    *,
    timeout: float = CLI_USAGE_TIMEOUT,
) -> tuple[str, int | None, str, str]:
    """Execute official `agy -p /usage --output-format json` inside the profile vault.

    Returns `(outcome, returncode, stdout, stderr)` where `outcome` is one of
    `"ok"`, `"auth_required"`, `"timeout"`, or `"unavailable"`.
    """
    executable = agy_profile.agy_executable_or_none()
    if not executable:
        return "unavailable", None, "", ""
    temp_dir = agy_profile.make_runtime_temp_dir(profile_id)
    gemini_dir = agy_profile.profile_vault_gemini_dir(profile_id)
    proc: subprocess.Popen | None = None
    group: child_job.ProcessGroupHandle | None = None
    stdout_chunks: list[str] = []
    stderr_chunks: list[str] = []
    auth_triggered = threading.Event()
    try:
        gemini_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        env = agy_profile.clean_agy_env(profile_id, temp_dir=temp_dir, vault_only=True)
        cmd = [
            executable,
            "-p",
            "/usage",
            "--output-format",
            "json",
            "--print-timeout",
            CLI_USAGE_PRINT_TIMEOUT,
        ]
        proc = child_job.spawn(
            cmd,
            kind="agy-usage-probe",
            marker=executable,
            cwd=str(gemini_dir),
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            encoding="utf-8",
            errors="replace",
            **hidden_process_kwargs(),
        )
        group = child_job.create_process_group(proc)

        def _terminate_now() -> None:
            if group is not None and proc is not None:
                group.terminate(proc.pid)
            elif proc is not None:
                child_job.terminate_tree(proc.pid)

        def _drain_stdout() -> None:
            if proc is None or proc.stdout is None:
                return
            try:
                stdout_chunks.append(proc.stdout.read())
            except OSError:
                pass

        def _drain_stderr() -> None:
            if proc is None or proc.stderr is None:
                return
            try:
                for line in proc.stderr:
                    stderr_chunks.append(line)
                    if not auth_triggered.is_set() and _is_auth_error_text(line):
                        auth_triggered.set()
                        _terminate_now()
            except OSError:
                pass

        t_out = threading.Thread(target=_drain_stdout, daemon=True)
        t_err = threading.Thread(target=_drain_stderr, daemon=True)
        t_out.start()
        t_err.start()
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            _terminate_now()
            t_out.join(timeout=1.0)
            t_err.join(timeout=1.0)
            if auth_triggered.is_set():
                return "auth_required", proc.returncode, "".join(stdout_chunks), "".join(stderr_chunks)
            return "timeout", None, "".join(stdout_chunks), "".join(stderr_chunks)

        t_out.join(timeout=1.5)
        t_err.join(timeout=1.5)
        stdout_text = "".join(stdout_chunks)
        stderr_text = "".join(stderr_chunks)
        if auth_triggered.is_set():
            return "auth_required", proc.returncode, stdout_text, stderr_text
        if proc.returncode == 0:
            agy_profile.sync_vault_token_to_workspace_if_newer(profile_id)
        return "ok", proc.returncode, stdout_text, stderr_text
    except (OSError, subprocess.SubprocessError):
        return "unavailable", None, "", ""
    finally:
        if group is not None:
            group.close()
        if proc is not None:
            child_job.forget(proc.pid)
        shutil.rmtree(temp_dir, ignore_errors=True)


def probe_account_usage(profile_id: str) -> dict[str, Any]:
    """Query official quota windows strictly via local `agy -p /usage --output-format json`."""
    try:
        agy_profile.sync_workspace_credentials_to_vault(profile_id)
    except Exception:
        pass
    if profile_id == agy_profile.DEFAULT:
        agy_profile._seed_default_vault_if_empty()

    if not agy_profile.has_local_credentials(profile_id):
        agy_profile.record_auth_state(profile_id, "login_required")
        return {
            "state": "login_required",
            "rows": [],
            "detail": "当前账号尚未登录或未找到可用凭据，请先完成登录后再检测额度。",
        }

    requested_at = datetime.now(timezone.utc)
    outcome, returncode, stdout_text, stderr_text = _run_cli_usage_command(profile_id)
    if outcome == "unavailable":
        return {
            "state": "unverified",
            "rows": [],
            "detail": "未找到可用的官方 agy CLI，请先安装或检查 agy 路径后重试。",
        }
    if outcome == "timeout":
        return {
            "state": "unverified",
            "rows": [],
            "detail": "调用官方 agy /usage 超时，请检查网络与代理设置后重试。",
        }
    if outcome == "auth_required":
        agy_profile.record_auth_state(profile_id, "login_required")
        return {
            "state": "login_required",
            "rows": [],
            "detail": "当前账号登录态已失效，请重新登录 Agy 账号。",
        }

    envelope = _extract_json_envelope(stdout_text)
    if envelope is None:
        combined_err = f"{stderr_text}\n{stdout_text}"
        if _is_auth_error_text(combined_err):
            agy_profile.record_auth_state(profile_id, "login_required")
            return {
                "state": "login_required",
                "rows": [],
                "detail": "当前账号登录态已失效，请重新登录 Agy 账号。",
            }
        return {
            "state": "unverified",
            "rows": [],
            "detail": "官方 agy /usage 未返回有效额度数据，请检查网络或升级 agy CLI 后重试。",
        }

    status_str = str(envelope.get("status") or "").strip().upper()
    err_text = str(envelope.get("error") or "").strip()
    resp_text = str(envelope.get("response") or "").strip()
    if returncode != 0 or (status_str and status_str != "SUCCESS"):
        combined_err = f"{err_text}\n{resp_text}\n{stderr_text}"
        if _is_auth_error_text(combined_err):
            agy_profile.record_auth_state(profile_id, "login_required")
            return {
                "state": "login_required",
                "rows": [],
                "detail": "当前账号登录态已失效，请重新登录 Agy 账号。",
            }
        return {
            "state": "unverified",
            "rows": [],
            "detail": err_text or "调用官方 agy /usage 失败，请检查网络与代理设置后重试。",
        }

    cmd_obj = envelope.get("command")
    cmd_data = cmd_obj.get("data") if isinstance(cmd_obj, dict) and isinstance(cmd_obj.get("data"), dict) else None
    rows = _parse_cli_usage_buckets(cmd_data, requested_at=requested_at) if cmd_data is not None else []
    auth_type = _profile_auth_type(profile_id)
    tier, tier_name = _normalize_account_tier(
        cmd_data if isinstance(cmd_data, dict) else envelope,
        auth_type=auth_type,
    )
    if tier is None:
        tier, tier_name = _normalize_account_tier(envelope, auth_type=auth_type)

    result: dict[str, Any] = {"state": "authenticated", "rows": rows}
    if tier:
        result["account_tier"] = tier
        if tier_name:
            result["account_tier_name"] = tier_name
    agy_profile.record_auth_state(profile_id, "authenticated")
    if not rows:
        result["detail"] = "官方 agy /usage 未返回该账号的可用额度窗口。"
    return result


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
                model_calls INTEGER NOT NULL DEFAULT 0,
                generation_ms INTEGER NOT NULL DEFAULT 0,
                estimated_cost_usd REAL NOT NULL DEFAULT 0,
                model_breakdown_json TEXT,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS usage_ledger_models (
                run_id TEXT NOT NULL,
                profile_id TEXT NOT NULL DEFAULT 'default',
                model TEXT NOT NULL,
                display_name TEXT NOT NULL DEFAULT '',
                model_group TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'model',
                calls INTEGER NOT NULL DEFAULT 0,
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                cache_read_tokens INTEGER NOT NULL DEFAULT 0,
                cache_write_tokens INTEGER NOT NULL DEFAULT 0,
                thinking_tokens INTEGER NOT NULL DEFAULT 0,
                estimated_cost_usd REAL NOT NULL DEFAULT 0,
                pricing_source TEXT NOT NULL DEFAULT 'catalog',
                created_at TEXT NOT NULL,
                PRIMARY KEY (run_id, model, role)
            );
            CREATE INDEX IF NOT EXISTS idx_usage_ledger_models_profile_created
                ON usage_ledger_models(profile_id, created_at);
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
        if "model_calls" not in ledger_cols:
            with conn:
                conn.execute("ALTER TABLE usage_ledger ADD COLUMN model_calls INTEGER NOT NULL DEFAULT 0")
        if "generation_ms" not in ledger_cols:
            with conn:
                conn.execute("ALTER TABLE usage_ledger ADD COLUMN generation_ms INTEGER NOT NULL DEFAULT 0")
        if "model_breakdown_json" not in ledger_cols:
            with conn:
                conn.execute("ALTER TABLE usage_ledger ADD COLUMN model_breakdown_json TEXT")
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
        model_calls: int = 0,
        generation_ms: int = 0,
        cooldown_seconds: int = 0,
        estimated_cost_usd: float | None = None,
        model_breakdown: list[dict[str, Any]] | None = None,
        orchestrator_planner: str | None = None,
        orchestrator_executor: str | None = None,
    ) -> None:
        pid = profile_id or agy_profile.DEFAULT
        group = _model_group(model)
        total_in, fresh_in, cached, cache_write = normalize_ledger_input(
            input_tokens, cache_read_tokens, cache_write_tokens
        )
        # Antigravity 1.5+ output_tokens already includes thinking_tokens (T3 Code reasoningTokens subset).
        out_raw = max(0, int(output_tokens or 0))
        think_raw = max(0, int(thinking_tokens or 0))
        calls_norm = max(0, int(model_calls or 0))
        now = datetime.now(timezone.utc)
        now_iso = now.isoformat()

        breakdown_items: list[dict[str, Any]] = []
        if isinstance(model_breakdown, list) and model_breakdown:
            merged_buckets: dict[tuple[str, str], dict[str, Any]] = {}
            for raw_item in model_breakdown:
                if not isinstance(raw_item, dict):
                    continue
                item_model = agy_pricing.canonicalize_model_id(str(raw_item.get("model") or model)) or str(model)
                item_role = str(raw_item.get("role") or "model").strip().lower() or "model"
                item_display = str(raw_item.get("display_name") or "").strip() or agy_pricing.model_display_name(item_model)
                key = (item_model, item_role)
                bucket = merged_buckets.get(key)
                if bucket is None:
                    bucket = {
                        "model": item_model,
                        "display_name": item_display,
                        "role": item_role,
                        "calls": 0,
                        "input_tokens": 0,
                        "output_tokens": 0,
                        "cache_read_tokens": 0,
                        "cache_write_tokens": 0,
                        "thinking_tokens": 0,
                        "estimated_cost_usd": 0.0,
                        "pricing_source": str(raw_item.get("pricing_source") or "catalog"),
                    }
                    merged_buckets[key] = bucket
                bucket["calls"] += max(0, int(raw_item.get("calls") or 0))
                bucket["input_tokens"] += max(0, int(raw_item.get("input_tokens") or 0))
                bucket["output_tokens"] += max(0, int(raw_item.get("output_tokens") or 0))
                bucket["cache_read_tokens"] += max(0, int(raw_item.get("cache_read_tokens") or 0))
                bucket["cache_write_tokens"] += max(0, int(raw_item.get("cache_write_tokens") or 0))
                bucket["thinking_tokens"] += max(0, int(raw_item.get("thinking_tokens") or 0))
                bucket["estimated_cost_usd"] += max(0.0, float(raw_item.get("estimated_cost_usd") or 0.0))
            for bucket in merged_buckets.values():
                bucket["estimated_cost_usd"] = round(float(bucket["estimated_cost_usd"]), 6)
                breakdown_items.append(bucket)
            breakdown_items.sort(key=lambda b: (-float(b["estimated_cost_usd"]), b["model"], b["role"]))

        if breakdown_items:
            cost = (
                round(max(0.0, float(estimated_cost_usd)), 6)
                if estimated_cost_usd is not None
                else round(sum(float(item["estimated_cost_usd"]) for item in breakdown_items), 6)
            )
        else:
            calc = agy_pricing.calculate_run_cost(
                model=model,
                usage={
                    "input_tokens": total_in,
                    "output_tokens": out_raw,
                    "cache_read_tokens": cached,
                    "cache_write_tokens": cache_write,
                    "thinking_tokens": think_raw,
                    "model_calls": calls_norm,
                },
                orchestrator_planner=orchestrator_planner,
                orchestrator_executor=orchestrator_executor,
                run_date=now,
            )
            breakdown_items = list(calc["model_breakdown"])
            if estimated_cost_usd is not None:
                cost = round(max(0.0, float(estimated_cost_usd)), 6)
                if len(breakdown_items) == 1:
                    breakdown_items[0]["estimated_cost_usd"] = cost
            else:
                cost = float(calc["estimated_cost_usd"])

        breakdown_json = json.dumps(breakdown_items, ensure_ascii=False) if breakdown_items else None
        with self._connect() as db, db:
            db.execute(
                """
                INSERT INTO usage_ledger
                (run_id, profile_id, model, model_group, status, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, thinking_tokens, model_calls, generation_ms, estimated_cost_usd, model_breakdown_json, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(run_id) DO UPDATE SET
                    profile_id=excluded.profile_id,
                    model=excluded.model,
                    model_group=excluded.model_group,
                    status=excluded.status,
                    input_tokens=excluded.input_tokens,
                    output_tokens=excluded.output_tokens,
                    cache_read_tokens=excluded.cache_read_tokens,
                    cache_write_tokens=excluded.cache_write_tokens,
                    thinking_tokens=excluded.thinking_tokens,
                    model_calls=excluded.model_calls,
                    generation_ms=excluded.generation_ms,
                    estimated_cost_usd=excluded.estimated_cost_usd,
                    model_breakdown_json=excluded.model_breakdown_json
                """,
                (
                    run_id,
                    pid,
                    model,
                    group,
                    status,
                    total_in,
                    out_raw,
                    cached,
                    cache_write,
                    think_raw,
                    calls_norm,
                    max(0, int(generation_ms)),
                    cost,
                    breakdown_json,
                    now_iso,
                ),
            )
            db.execute("DELETE FROM usage_ledger_models WHERE run_id=?", (run_id,))
            for item in breakdown_items:
                db.execute(
                    """
                    INSERT INTO usage_ledger_models
                    (run_id, profile_id, model, display_name, model_group, role, calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, thinking_tokens, estimated_cost_usd, pricing_source, created_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                    """,
                    (
                        run_id,
                        pid,
                        item["model"],
                        item["display_name"],
                        _model_group(item["model"]),
                        item["role"],
                        item["calls"],
                        item["input_tokens"],
                        item["output_tokens"],
                        item["cache_read_tokens"],
                        item["cache_write_tokens"],
                        item["thinking_tokens"],
                        item["estimated_cost_usd"],
                        item["pricing_source"],
                        now_iso,
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
            totals_5h: dict[str, int] = {}
            for query in (
                "SELECT model_group, SUM(input_tokens + MAX(output_tokens, thinking_tokens)) AS tok "
                "FROM usage_ledger_models WHERE profile_id=? AND created_at>=? GROUP BY model_group",
                "SELECT model_group, SUM(input_tokens + MAX(output_tokens, thinking_tokens)) AS tok "
                "FROM usage_ledger u WHERE profile_id=? AND created_at>=? "
                "AND NOT EXISTS (SELECT 1 FROM usage_ledger_models m WHERE m.run_id = u.run_id) "
                "GROUP BY model_group",
            ):
                for row in db.execute(query, (pid, cutoff_5h)):
                    mg = str(row["model_group"])
                    totals_5h[mg] = totals_5h.get(mg, 0) + int(row["tok"] or 0)

            totals_7d: dict[str, tuple[int, float]] = {}
            for query in (
                "SELECT model_group, SUM(input_tokens + MAX(output_tokens, thinking_tokens)) AS tok, SUM(estimated_cost_usd) AS cost "
                "FROM usage_ledger_models WHERE profile_id=? AND created_at>=? GROUP BY model_group",
                "SELECT model_group, SUM(input_tokens + MAX(output_tokens, thinking_tokens)) AS tok, SUM(estimated_cost_usd) AS cost "
                "FROM usage_ledger u WHERE profile_id=? AND created_at>=? "
                "AND NOT EXISTS (SELECT 1 FROM usage_ledger_models m WHERE m.run_id = u.run_id) "
                "GROUP BY model_group",
            ):
                for row in db.execute(query, (pid, cutoff_7d)):
                    mg = str(row["model_group"])
                    prev_tok, prev_cost = totals_7d.get(mg, (0, 0.0))
                    totals_7d[mg] = (prev_tok + int(row["tok"] or 0), prev_cost + float(row["cost"] or 0.0))
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
                "estimated_cost_7d_usd": round(cost_7d, 6),
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
            db.execute("DELETE FROM usage_ledger_models WHERE profile_id=?", (profile_id,))

    def stats(
        self,
        window_hours: int = 24,
        profile_id: str = agy_profile.DEFAULT,
        *,
        today: bool = False,
    ) -> dict[str, Any]:
        pid = profile_id or agy_profile.DEFAULT
        clauses = ["profile_id = ?"]
        params: list[Any] = [pid]
        if today:
            local_midnight = datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
            cutoff = local_midnight.astimezone(timezone.utc).isoformat()
            clauses.append("created_at >= ?")
            params.append(cutoff)
        elif window_hours > 0:
            cutoff = (datetime.now(timezone.utc) - timedelta(hours=window_hours)).isoformat()
            clauses.append("created_at >= ?")
            params.append(cutoff)
        where = "WHERE " + " AND ".join(clauses)
        with self._connect() as db:
            rows = db.execute(
                f"SELECT status, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, thinking_tokens, model_calls, generation_ms, estimated_cost_usd FROM usage_ledger {where}",
                tuple(params),
            ).fetchall()
            m_rows = db.execute(
                f"SELECT run_id, model, display_name, role, calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, thinking_tokens, estimated_cost_usd FROM usage_ledger_models {where}",
                tuple(params),
            ).fetchall()
            legacy_rows = db.execute(
                f"SELECT run_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, thinking_tokens, model_calls, estimated_cost_usd "
                f"FROM usage_ledger {where} AND NOT EXISTS (SELECT 1 FROM usage_ledger_models m WHERE m.run_id = usage_ledger.run_id)",
                tuple(params),
            ).fetchall()
        total = len(rows)
        success = sum(1 for r in rows if r["status"] == "success")
        rate_limited = sum(1 for r in rows if r["status"] == "rate_limited")
        failed = sum(1 for r in rows if r["status"] not in ("success", "cancelled"))
        inp = 0
        out = 0
        cached = 0
        calls = 0
        gen_ms_total = 0
        gen_out_tokens = 0
        cost = 0.0
        for r in rows:
            row_in, _, row_cr, _ = normalize_ledger_input(
                int(r["input_tokens"]),
                int(r["cache_read_tokens"]),
                int(r["cache_write_tokens"]),
            )
            row_out = max(max(0, int(r["output_tokens"])), max(0, int(r["thinking_tokens"])))
            row_gen_ms = max(0, int(r["generation_ms"] or 0))
            inp += row_in
            out += row_out
            cached += row_cr
            calls += max(0, int(r["model_calls"] or 0))
            if row_gen_ms >= 150 and row_out > 0:
                gen_ms_total += row_gen_ms
                gen_out_tokens += row_out
            cost += float(r["estimated_cost_usd"])
        ratio = min(1.0, round(cached / inp, 4)) if inp > 0 else 0.0
        tok_per_sec = (
            round(gen_out_tokens / (gen_ms_total / 1000.0), 1)
            if gen_ms_total >= 150 and gen_out_tokens > 0
            else 0.0
        )

        role_order = {"planner": 0, "executor": 1, "subagent": 2, "compaction": 3, "model": 4}
        model_acc: dict[str, dict[str, Any]] = {}

        def _acc_entry(
            *,
            m_key: str,
            disp: str,
            run_id: str,
            role: str,
            c: int,
            in_t: int,
            out_t: int,
            cr_t: int,
            cw_t: int,
            th_t: int,
            usd: float,
        ) -> None:
            bucket = model_acc.get(m_key)
            if bucket is None:
                bucket = {
                    "model": m_key,
                    "display_name": disp or agy_pricing.model_display_name(m_key),
                    "_run_ids": set(),
                    "_roles": set(),
                    "calls": 0,
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "cache_read_tokens": 0,
                    "cache_write_tokens": 0,
                    "thinking_tokens": 0,
                    "estimated_cost_usd": 0.0,
                }
                model_acc[m_key] = bucket
            if run_id:
                bucket["_run_ids"].add(run_id)
            if role:
                bucket["_roles"].add(role)
            bucket["calls"] += max(0, c)
            bucket["input_tokens"] += max(0, in_t)
            bucket["output_tokens"] += max(0, out_t)
            bucket["cache_read_tokens"] += max(0, cr_t)
            bucket["cache_write_tokens"] += max(0, cw_t)
            bucket["thinking_tokens"] += max(0, th_t)
            bucket["estimated_cost_usd"] += max(0.0, usd)

        for mr in m_rows:
            m_key = str(mr["model"] or "").strip() or "unknown"
            _acc_entry(
                m_key=m_key,
                disp=str(mr["display_name"] or "").strip(),
                run_id=str(mr["run_id"] or ""),
                role=str(mr["role"] or "model").strip().lower() or "model",
                c=int(mr["calls"] or 0),
                in_t=int(mr["input_tokens"] or 0),
                out_t=int(mr["output_tokens"] or 0),
                cr_t=int(mr["cache_read_tokens"] or 0),
                cw_t=int(mr["cache_write_tokens"] or 0),
                th_t=int(mr["thinking_tokens"] or 0),
                usd=float(mr["estimated_cost_usd"] or 0.0),
            )

        for lr in legacy_rows:
            raw_m = str(lr["model"] or "").strip()
            m_key = agy_pricing.canonicalize_model_id(raw_m) or raw_m or "unknown"
            row_in, _, row_cr, row_cw = normalize_ledger_input(
                int(lr["input_tokens"]),
                int(lr["cache_read_tokens"]),
                int(lr["cache_write_tokens"]),
            )
            _acc_entry(
                m_key=m_key,
                disp=agy_pricing.model_display_name(m_key),
                run_id=str(lr["run_id"] or ""),
                role="model",
                c=int(lr["model_calls"] or 0),
                in_t=row_in,
                out_t=int(lr["output_tokens"] or 0),
                cr_t=row_cr,
                cw_t=row_cw,
                th_t=int(lr["thinking_tokens"] or 0),
                usd=float(lr["estimated_cost_usd"] or 0.0),
            )

        by_model: list[dict[str, Any]] = []
        for b in model_acc.values():
            by_model.append({
                "model": b["model"],
                "display_name": b["display_name"],
                "runs": len(b["_run_ids"]),
                "calls": b["calls"],
                "roles": sorted(b["_roles"], key=lambda r: (role_order.get(r, 99), r)),
                "input_tokens": b["input_tokens"],
                "output_tokens": b["output_tokens"],
                "cache_read_tokens": b["cache_read_tokens"],
                "cache_write_tokens": b["cache_write_tokens"],
                "thinking_tokens": b["thinking_tokens"],
                "estimated_cost_usd": round(b["estimated_cost_usd"], 6),
            })
        by_model.sort(
            key=lambda x: (
                -float(x["estimated_cost_usd"]),
                -(int(x["input_tokens"]) + max(int(x["output_tokens"]), int(x["thinking_tokens"]))),
                str(x["model"]),
            )
        )

        return {
            "window_hours": 0 if today else window_hours,
            "total_runs": total,
            "success_runs": success,
            "failed_runs": failed,
            "rate_limited_runs": rate_limited,
            "total_tokens": inp + out,
            "model_calls": calls,
            "tokens_per_sec": tok_per_sec,
            "cache_hit_ratio": ratio,
            "estimated_cost_usd": round(cost, 6),
            "by_model": by_model,
        }
