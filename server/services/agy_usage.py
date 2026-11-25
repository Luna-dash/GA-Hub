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
import sqlite3
import subprocess
import threading
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import requests

from .. import _paths
from ..process_utils import hidden_process_kwargs
from . import agy_profile

log = logging.getLogger(__name__)

DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com"
PROD_ENDPOINT = "https://cloudcode-pa.googleapis.com"
USER_AGENT = "antigravity/hub/2.24.0 (aidev_client; os_type=win32; arch=x64; cl=963137146)"
PROBE_TIMEOUT = 10.0

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
        text = raw.decode("utf-8", errors="replace")
        if text.startswith("go-keyring-base64:"):
            import base64
            return base64.b64decode(text[len("go-keyring-base64:") :])
        if text.startswith("go-keyring-encoded:"):
            return bytes.fromhex(text[len("go-keyring-encoded:") :])
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


def _iso_utc(raw: str | None) -> str:
    parsed = _parse_iso(raw)
    if parsed is not None:
        return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return (datetime.now(timezone.utc) + timedelta(days=7)).isoformat().replace("+00:00", "Z")


def _extract_access_token(profile_id: str) -> tuple[str | None, str | None]:
    """Return `(access_token, project_id)` for a profile, refreshing if needed."""
    session = requests.Session()
    session.trust_env = True

    acp_tok_path = agy_profile.find_credential_file(profile_id, "acp_token.json")
    if acp_tok_path is not None:
        try:
            tok = json.loads(acp_tok_path.read_text(encoding="utf-8"))
            res = session.post(
                "https://oauth2.googleapis.com/token",
                data={
                    "client_id": tok["client_id"],
                    "client_secret": tok["client_secret"],
                    "refresh_token": tok["refresh_token"],
                    "grant_type": "refresh_token",
                },
                timeout=PROBE_TIMEOUT,
            )
            if res.status_code == 200:
                payload = res.json()
                access = payload.get("access_token")
                if isinstance(access, str) and access:
                    return access, tok.get("project_id")
        except Exception:
            log.debug("Failed to refresh acp_token.json", exc_info=True)

    cli_tok_path = agy_profile.find_credential_file(profile_id, "antigravity-oauth-token")
    raw_cli: bytes | None = None
    if cli_tok_path is not None:
        try:
            raw_cli = cli_tok_path.read_bytes()
        except OSError:
            raw_cli = None
    elif profile_id == agy_profile.DEFAULT and os.name == "nt":
        raw_cli = read_windows_cli_credential()

    if raw_cli:
        try:
            parsed = json.loads(raw_cli.decode("utf-8", errors="replace"))
            token_obj = parsed.get("token") if isinstance(parsed, dict) else None
            if isinstance(token_obj, dict):
                expiry = _parse_iso(token_obj.get("expiry"))
                access = token_obj.get("access_token")
                if isinstance(access, str) and access:
                    if expiry is None or expiry > datetime.now(timezone.utc) + timedelta(seconds=30):
                        return access, None
        except Exception:
            log.debug("Failed to parse CLI oauth token", exc_info=True)

    return None, None


def _parse_summary_rows(data: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
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
            bid = str(bucket.get("bucketId") or "")
            frac = bucket.get("remainingFraction")
            if not isinstance(frac, (int, float)):
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
                family = display_group or bid or "Antigravity"
            win = str(bucket.get("window") or "")
            limit = "Weekly Limit Remaining" if win == "weekly" else "Five Hour Limit Remaining" if win == "5h" else str(bucket.get("displayName") or "Quota")
            key = (family, limit)
            if key in seen:
                continue
            seen.add(key)
            rows.append({
                "model": family,
                "limit": limit,
                "remaining_pct": pct,
                "resets_at": _iso_utc(bucket.get("resetTime")),
            })
    return rows


def _parse_model_rows(data: dict[str, Any]) -> list[dict[str, Any]]:
    models = data.get("models")
    if not isinstance(models, dict):
        return []
    merged: dict[tuple[str, str], dict[str, Any]] = {}
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
        for label, quota in (("Reported Quota", info.get("quotaInfo")), ("Weekly Limit Remaining", info.get("weeklyQuotaInfo"))):
            if not isinstance(quota, dict):
                continue
            frac = quota.get("remainingFraction")
            if not isinstance(frac, (int, float)):
                continue
            pct = round(max(0.0, min(1.0, float(frac))) * 100.0, 1)
            key = (family, label)
            prev = merged.get(key)
            if prev is None or pct < prev["remaining_pct"]:
                merged[key] = {
                    "model": family,
                    "limit": label,
                    "remaining_pct": pct,
                    "resets_at": _iso_utc(quota.get("resetTime")),
                }
    return list(merged.values())


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
    access_token, project_id = _extract_access_token(profile_id)
    if not access_token:
        return {"state": "login_required", "items": []}
    session = requests.Session()
    session.trust_env = True
    headers = {
        "Authorization": f"Bearer {access_token}",
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
    }
    body = {"project": project_id} if project_id else {}
    for endpoint in (DAILY_ENDPOINT, PROD_ENDPOINT):
        try:
            res = session.post(f"{endpoint}/v1internal:fetchAvailableModels", headers=headers, json=body, timeout=PROBE_TIMEOUT)
            if res.status_code != 200:
                continue
            items = _parse_available_model_catalog(res.json())
            if items:
                return {"state": "authenticated", "items": items}
        except Exception:
            continue
    return {"state": "authenticated", "items": []}


def _probe_via_cli_fallback(profile_id: str) -> dict[str, Any] | None:
    """Last-resort fallback when no readable local OAuth token is present (e.g. expired CLI token)."""
    import re

    executable = agy_profile.agy_executable_or_none()
    if not executable:
        return None
    temp_dir = agy_profile.make_runtime_temp_dir(profile_id)
    try:
        env = agy_profile.clean_agy_env(profile_id, temp_dir=temp_dir)
        res = subprocess.run(
            [executable, "-p", "/usage"],
            cwd=str(agy_profile.profile_gemini_dir(profile_id)),
            env=env,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            timeout=20,
            **hidden_process_kwargs(),
        )
    except (OSError, subprocess.SubprocessError):
        return None
    finally:
        import shutil
        shutil.rmtree(temp_dir, ignore_errors=True)

    text = f"{res.stdout}\n{res.stderr}"
    if re.search(r"authentication required|not logged in|not signed in|login required|please (?:log|sign) in", text, re.I):
        return {"state": "login_required", "rows": []}
    if res.returncode != 0:
        return None
    pat = re.compile(r"^(?P<model>[^\t]{1,128})\t(?P<limit>[^\t]*\blimit\b[^\t]*)\t(?P<pct>\d{1,3}(?:\.\d+)?)%\t(?P<reset>\d{4}-\d{2}-\d{2}T\S+)$", re.I)
    rows = []
    for line in res.stdout.splitlines():
        m = pat.fullmatch(line.strip())
        if not m:
            continue
        rows.append({
            "model": m.group("model").strip(),
            "limit": m.group("limit").strip(),
            "remaining_pct": float(m.group("pct")),
            "resets_at": _iso_utc(m.group("reset")),
        })
    return {"state": "authenticated", "rows": rows} if rows else None


def probe_account_usage(profile_id: str, *, allow_cli_fallback: bool = True) -> dict[str, Any]:
    """Query live official quota windows directly from CloudCode APIs (T3 Code method)."""
    access_token, project_id = _extract_access_token(profile_id)
    if not access_token:
        if allow_cli_fallback:
            fallback = _probe_via_cli_fallback(profile_id)
            if fallback is not None:
                return fallback
        state = "unverified" if agy_profile.has_local_credentials(profile_id) else "login_required"
        return {"state": state, "rows": []}

    session = requests.Session()
    session.trust_env = True
    headers = {
        "Authorization": f"Bearer {access_token}",
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
    }
    body = {"project": project_id} if project_id else {}
    unauthorized = False
    for op, parser in (
        ("retrieveUserQuotaSummary", _parse_summary_rows),
        ("fetchAvailableModels", _parse_model_rows),
    ):
        collected: list[dict[str, Any]] = []
        seen: set[tuple[str, str]] = set()
        for endpoint in (DAILY_ENDPOINT, PROD_ENDPOINT):
            try:
                res = session.post(f"{endpoint}/v1internal:{op}", headers=headers, json=body, timeout=PROBE_TIMEOUT)
                if res.status_code in (401, 403):
                    unauthorized = True
                    continue
                if res.status_code != 200:
                    continue
                for row in parser(res.json()):
                    key = (row["model"], row["limit"])
                    if key not in seen:
                        seen.add(key)
                        collected.append(row)
            except Exception:
                continue
        if collected:
            return {"state": "authenticated", "rows": collected}

    if unauthorized:
        return {"state": "login_required", "rows": []}
    if allow_cli_fallback:
        fallback = _probe_via_cli_fallback(profile_id)
        if fallback is not None:
            return fallback
    return {"state": "authenticated" if access_token else "unverified", "rows": []}


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
        thinking_tokens: int = 0,
        cooldown_seconds: int = 0,
    ) -> None:
        pid = profile_id or agy_profile.DEFAULT
        group = _model_group(model)
        cfg = _QUOTA_GROUPS.get(group, _QUOTA_GROUPS["gemini-4"])
        cached = min(max(0, cache_read_tokens), max(0, input_tokens))
        non_cached = max(0, input_tokens - cached)
        out_think = max(0, output_tokens) + max(0, thinking_tokens)
        cost = round(
            (non_cached / 1_000_000) * cfg["input_rate"]
            + (cached / 1_000_000) * cfg["cached_rate"]
            + (out_think / 1_000_000) * cfg["output_rate"],
            6,
        )
        now = datetime.now(timezone.utc)
        with self._connect() as db, db:
            db.execute(
                """
                INSERT INTO usage_ledger
                (run_id, profile_id, model, model_group, status, input_tokens, output_tokens, cache_read_tokens, thinking_tokens, estimated_cost_usd, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(run_id) DO UPDATE SET
                    profile_id=excluded.profile_id,
                    status=excluded.status,
                    input_tokens=excluded.input_tokens,
                    output_tokens=excluded.output_tokens,
                    cache_read_tokens=excluded.cache_read_tokens,
                    thinking_tokens=excluded.thinking_tokens,
                    estimated_cost_usd=excluded.estimated_cost_usd
                """,
                (
                    run_id,
                    pid,
                    model,
                    group,
                    status,
                    max(0, input_tokens),
                    max(0, output_tokens),
                    max(0, cache_read_tokens),
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
                    "SELECT model_group, SUM(input_tokens + output_tokens + thinking_tokens) AS tok "
                    "FROM usage_ledger WHERE profile_id=? AND created_at>=? GROUP BY model_group",
                    (pid, cutoff_5h),
                )
            }
            totals_7d = {
                row["model_group"]: (row["tok"] or 0, float(row["cost"] or 0.0))
                for row in db.execute(
                    "SELECT model_group, SUM(input_tokens + output_tokens + thinking_tokens) AS tok, SUM(estimated_cost_usd) AS cost "
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
                f"SELECT status, input_tokens, output_tokens, cache_read_tokens, thinking_tokens, estimated_cost_usd FROM usage_ledger {where}",
                tuple(params),
            ).fetchall()
        total = len(rows)
        success = sum(1 for r in rows if r["status"] == "success")
        rate_limited = sum(1 for r in rows if r["status"] == "rate_limited")
        failed = sum(1 for r in rows if r["status"] not in ("success", "cancelled"))
        inp = sum(int(r["input_tokens"]) for r in rows)
        out = sum(int(r["output_tokens"]) for r in rows)
        think = sum(int(r["thinking_tokens"]) for r in rows)
        cached = sum(int(r["cache_read_tokens"]) for r in rows)
        cost = sum(float(r["estimated_cost_usd"]) for r in rows)
        return {
            "window_hours": window_hours,
            "total_runs": total,
            "success_runs": success,
            "failed_runs": failed,
            "rate_limited_runs": rate_limited,
            "total_tokens": inp + out + think,
            "cache_hit_ratio": round(cached / inp, 4) if inp > 0 else 0.0,
            "estimated_cost_usd": round(cost, 4),
        }
