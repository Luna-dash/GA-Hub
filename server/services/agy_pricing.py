"""Externalized, date-aware API pricing engine for Antigravity / Agy runs."""

from __future__ import annotations

import json
import logging
import math
import threading
from copy import deepcopy
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any

from .. import _paths
from . import agy_models

logger = logging.getLogger(__name__)

_BUNDLED_CATALOG_PATH = Path(__file__).with_name("agy_pricing_catalog.json")
_USER_PRICING_FILENAME = "agy_pricing.json"

_CACHE_LOCK = threading.Lock()
_CACHED_SIGNATURE: tuple[Any, ...] | None = None
_CACHED_CATALOG: dict[str, Any] | None = None


@dataclass(frozen=True)
class RateTier:
    input: float
    cache_read: float
    cache_write: float
    output: float


@dataclass(frozen=True)
class ResolvedModelRates:
    model: str
    display_name: str
    standard: RateTier
    long_context_threshold: int = 0
    long_context: RateTier | None = None
    pricing_source: str = "catalog"

    def tier_for_context(self, context_tokens: int) -> RateTier:
        if (
            self.long_context is not None
            and self.long_context_threshold > 0
            and context_tokens > self.long_context_threshold
        ):
            return self.long_context
        return self.standard


def _user_pricing_path() -> Path:
    return Path(_paths.ADMIN_DATA) / _USER_PRICING_FILENAME


def _file_sig(path: Path) -> tuple[str, bool, int, int]:
    try:
        st = path.stat()
        return (str(path), True, int(st.st_mtime_ns), int(st.st_size))
    except OSError:
        return (str(path), False, 0, 0)


def _read_json_dict(path: Path) -> dict[str, Any]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except Exception as exc:
        logger.warning("Failed to load pricing file %s: %s", path, exc)
        return {}
    return raw if isinstance(raw, dict) else {}


def _merge_catalogs(base: dict[str, Any], extra: dict[str, Any]) -> dict[str, Any]:
    merged = deepcopy(base)
    if not extra:
        return merged

    for list_key in ("strip_suffixes", "orchestrator_prefixes"):
        val = extra.get(list_key)
        if isinstance(val, list) and val:
            merged[list_key] = [str(item).strip().lower() for item in val if str(item).strip()]

    for dict_key in ("orchestrator_inferences", "internal_aliases", "role_aliases", "group_fallbacks"):
        val = extra.get(dict_key)
        if isinstance(val, dict):
            target = dict(merged.get(dict_key) or {})
            for k, v in val.items():
                ks = str(k).strip().lower()
                vs = str(v).strip().lower()
                if ks and vs:
                    target[ks] = vs
            merged[dict_key] = target

    if isinstance(extra.get("prefix_aliases"), list):
        rules: list[list[str]] = []
        for pair in extra["prefix_aliases"]:
            if isinstance(pair, (list, tuple)) and len(pair) == 2:
                pref = str(pair[0]).strip().lower()
                target = str(pair[1]).strip().lower()
                if pref and target:
                    rules.append([pref, target])
        if rules:
            merged["prefix_aliases"] = rules

    fallback = str(extra.get("default_fallback_model") or "").strip().lower()
    if fallback:
        merged["default_fallback_model"] = fallback

    extra_models = extra.get("models")
    if isinstance(extra_models, dict):
        models = dict(merged.get("models") or {})
        for raw_key, raw_entry in extra_models.items():
            key = str(raw_key).strip().lower()
            if not key or not isinstance(raw_entry, dict):
                continue
            prev = deepcopy(models.get(key) or {})
            for ek, ev in raw_entry.items():
                if ek in ("rates", "long_context") and isinstance(ev, dict):
                    merged_rates = dict(prev.get(ek) or {})
                    merged_rates.update(ev)
                    prev[ek] = merged_rates
                else:
                    prev[ek] = deepcopy(ev)
            models[key] = prev
        merged["models"] = models

    return merged


def _normalize_catalog(raw: dict[str, Any]) -> dict[str, Any]:
    strip_suffixes = sorted(
        {str(s).strip().lower() for s in (raw.get("strip_suffixes") or []) if str(s).strip()},
        key=len,
        reverse=True,
    )
    orch_prefixes = [str(p).strip().lower() for p in (raw.get("orchestrator_prefixes") or []) if str(p).strip()]
    orch_inferences = {
        str(k).strip().lower(): str(v).strip().lower()
        for k, v in (raw.get("orchestrator_inferences") or {}).items()
        if str(k).strip() and str(v).strip()
    }
    internal_aliases = {
        str(k).strip().lower(): str(v).strip().lower()
        for k, v in (raw.get("internal_aliases") or {}).items()
        if str(k).strip() and str(v).strip()
    }
    role_aliases = {
        str(k).strip().lower(): str(v).strip().lower()
        for k, v in (raw.get("role_aliases") or {}).items()
        if str(k).strip() and str(v).strip()
    }
    prefix_aliases: list[tuple[str, str]] = []
    for item in raw.get("prefix_aliases") or []:
        if isinstance(item, (list, tuple)) and len(item) == 2:
            pref = str(item[0]).strip().lower()
            target = str(item[1]).strip().lower()
            if pref and target:
                prefix_aliases.append((pref, target))
    prefix_aliases.sort(key=lambda pair: len(pair[0]), reverse=True)
    group_fallbacks = {
        str(k).strip().lower(): str(v).strip().lower()
        for k, v in (raw.get("group_fallbacks") or {}).items()
        if str(k).strip() and str(v).strip()
    }
    models = {
        str(k).strip().lower(): dict(v)
        for k, v in (raw.get("models") or {}).items()
        if str(k).strip() and isinstance(v, dict)
    }
    return {
        "schema_version": int(raw.get("schema_version") or 1),
        "default_fallback_model": str(raw.get("default_fallback_model") or "").strip().lower(),
        "strip_suffixes": strip_suffixes,
        "orchestrator_prefixes": orch_prefixes,
        "orchestrator_inferences": orch_inferences,
        "internal_aliases": internal_aliases,
        "role_aliases": role_aliases,
        "prefix_aliases": prefix_aliases,
        "group_fallbacks": group_fallbacks,
        "models": models,
    }


def load_pricing_catalog() -> dict[str, Any]:
    """Load bundled pricing catalog overlaid with optional `<ADMIN_DATA>/agy_pricing.json`."""
    user_path = _user_pricing_path()
    sig = (_file_sig(_BUNDLED_CATALOG_PATH), _file_sig(user_path))
    with _CACHE_LOCK:
        global _CACHED_SIGNATURE, _CACHED_CATALOG
        if _CACHED_SIGNATURE == sig and _CACHED_CATALOG is not None:
            return _CACHED_CATALOG
        base = _read_json_dict(_BUNDLED_CATALOG_PATH)
        extra = _read_json_dict(user_path) if sig[1][1] else {}
        normalized = _normalize_catalog(_merge_catalogs(base, extra))
        _CACHED_SIGNATURE = sig
        _CACHED_CATALOG = normalized
        return normalized


def _parse_date(value: date | datetime | str | None) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str) and value.strip():
        text = value.strip()
        try:
            return date.fromisoformat(text[:10])
        except ValueError:
            pass
    return datetime.now().date()


def _safe_rate(val: Any, fallback: float = 0.0) -> float:
    try:
        num = float(val)
    except (TypeError, ValueError):
        return fallback
    return num if math.isfinite(num) and num >= 0.0 else fallback


def _to_tier(raw: dict[str, Any], base: RateTier | None = None) -> RateTier:
    b = base or RateTier(0.0, 0.0, 0.0, 0.0)
    return RateTier(
        input=_safe_rate(raw.get("input"), b.input),
        cache_read=_safe_rate(raw.get("cache_read"), b.cache_read),
        cache_write=_safe_rate(raw.get("cache_write"), b.cache_write),
        output=_safe_rate(raw.get("output"), b.output),
    )


def _strip_suffixes(model_id: str, catalog: dict[str, Any]) -> str:
    cur = model_id.strip().lower()
    if not cur:
        return ""
    suffixes: list[str] = catalog["strip_suffixes"]
    changed = True
    while changed and cur:
        changed = False
        if cur in catalog["models"] or cur in catalog["internal_aliases"] or cur in catalog["orchestrator_inferences"]:
            break
        for suffix in suffixes:
            if cur.endswith(suffix) and len(cur) > len(suffix):
                cur = cur[: -len(suffix)]
                changed = True
                break
    return cur


def _is_orchestrator_id(model_id: str, catalog: dict[str, Any]) -> bool:
    norm = model_id.strip().lower()
    if not norm:
        return False
    stripped = _strip_suffixes(norm, catalog)
    if norm in catalog["orchestrator_inferences"] or stripped in catalog["orchestrator_inferences"]:
        return True
    return any(norm.startswith(pref) for pref in catalog["orchestrator_prefixes"])


def canonicalize_model_id(raw_model: str, catalog: dict[str, Any] | None = None) -> str:
    """Resolve a raw ACP/transcript model string to its canonical catalog model ID."""
    cat = catalog or load_pricing_catalog()
    raw = str(raw_model or "").strip().lower()
    if not raw:
        return ""

    # 1. Direct lookup on raw ID (preserve explicit catalog/alias hits before stripping)
    if raw in cat["internal_aliases"]:
        return cat["internal_aliases"][raw]
    if raw in cat["orchestrator_inferences"]:
        return cat["orchestrator_inferences"][raw]
    if raw in cat["models"]:
        return raw

    # 2. Strip effort/preview suffixes and retry exact tables
    stripped = _strip_suffixes(raw, cat)
    if stripped in cat["internal_aliases"]:
        return cat["internal_aliases"][stripped]
    if stripped in cat["orchestrator_inferences"]:
        return cat["orchestrator_inferences"][stripped]
    if stripped in cat["models"]:
        return stripped

    # 3. Prefix alias table (handles dated/variant names cleanly)
    for pref, target in cat["prefix_aliases"]:
        if stripped.startswith(pref) or raw.startswith(pref):
            return target

    # 4. Orchestrator prefix fallback if unknown orchestrator variant appears
    if _is_orchestrator_id(raw, cat):
        inferences = cat["orchestrator_inferences"]
        for orch_prefix in cat["orchestrator_prefixes"]:
            if orch_prefix in inferences:
                return inferences[orch_prefix]

    return stripped or raw


def model_display_name(model_id: str, catalog: dict[str, Any] | None = None) -> str:
    cat = catalog or load_pricing_catalog()
    canon = canonicalize_model_id(model_id, cat)
    entry = cat["models"].get(canon) or cat["models"].get(model_id.strip().lower())
    if isinstance(entry, dict) and str(entry.get("display_name") or "").strip():
        return str(entry["display_name"]).strip()
    raw = canon or str(model_id or "").strip()
    return raw or "Unknown"


def _select_scheduled_block(entry: dict[str, Any], on_date: date) -> tuple[dict[str, Any], str]:
    schedules = entry.get("schedules")
    if isinstance(schedules, list):
        for sched in schedules:
            if not isinstance(sched, dict) or not isinstance(sched.get("rates"), dict):
                continue
            start_s = str(sched.get("effective_from") or "").strip()
            end_s = str(sched.get("effective_until") or "").strip()
            start_d = date.fromisoformat(start_s[:10]) if start_s else date.min
            end_d = date.fromisoformat(end_s[:10]) if end_s else date.max
            if start_d <= on_date <= end_d:
                merged = dict(entry)
                merged["rates"] = sched["rates"]
                if "long_context" in sched and isinstance(sched["long_context"], dict):
                    merged["long_context"] = sched["long_context"]
                if "long_context_threshold" in sched:
                    merged["long_context_threshold"] = sched["long_context_threshold"]
                return merged, "schedule"
    return entry, "catalog"


def _normalize_overrides(raw_overrides: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    if raw_overrides is None:
        raw_overrides = (agy_models.load_models_config() or {}).get("pricing_overrides")
    if not isinstance(raw_overrides, dict):
        return {}
    out: dict[str, dict[str, Any]] = {}
    for k, v in raw_overrides.items():
        ks = str(k).strip().lower()
        if ks and isinstance(v, dict):
            out[ks] = dict(v)
    return out


def _apply_override(resolved: ResolvedModelRates, ov: dict[str, Any]) -> ResolvedModelRates:
    new_std = RateTier(
        input=_safe_rate(ov.get("input"), resolved.standard.input),
        cache_read=_safe_rate(ov.get("cache_read"), resolved.standard.cache_read),
        cache_write=_safe_rate(ov.get("cache_write"), resolved.standard.cache_write),
        output=_safe_rate(ov.get("output"), resolved.standard.output),
    )
    threshold = resolved.long_context_threshold
    if "long_context_threshold" in ov and ov.get("long_context_threshold") is not None:
        try:
            threshold = max(0, int(ov["long_context_threshold"]))
        except (TypeError, ValueError):
            pass

    lc_raw = ov.get("long_context") if isinstance(ov.get("long_context"), dict) else {}
    has_lc_override = any(
        k in ov and ov.get(k) is not None
        for k in (
            "long_context",
            "long_context_input",
            "long_context_cache_read",
            "long_context_cache_write",
            "long_context_output",
        )
    )
    new_lc = resolved.long_context
    if has_lc_override:
        lc_base = resolved.long_context or new_std
        new_lc = RateTier(
            input=_safe_rate(ov.get("long_context_input", lc_raw.get("input")), lc_base.input),
            cache_read=_safe_rate(ov.get("long_context_cache_read", lc_raw.get("cache_read")), lc_base.cache_read),
            cache_write=_safe_rate(ov.get("long_context_cache_write", lc_raw.get("cache_write")), lc_base.cache_write),
            output=_safe_rate(ov.get("long_context_output", lc_raw.get("output")), lc_base.output),
        )

    disp = str(ov.get("display_name") or "").strip() or resolved.display_name
    return ResolvedModelRates(
        model=resolved.model,
        display_name=disp,
        standard=new_std,
        long_context_threshold=threshold,
        long_context=new_lc,
        pricing_source="override",
    )


def resolve_model_rates(
    model_id: str,
    *,
    run_date: date | datetime | str | None = None,
    catalog: dict[str, Any] | None = None,
    overrides: dict[str, Any] | None = None,
) -> ResolvedModelRates:
    """Resolve effective token rates (USD / 1M tokens) for a model on a given date."""
    cat = catalog or load_pricing_catalog()
    on_date = _parse_date(run_date)
    raw = str(model_id or "").strip().lower()
    stripped = _strip_suffixes(raw, cat)
    canon = canonicalize_model_id(raw, cat)
    ov_map = _normalize_overrides(overrides)

    entry = cat["models"].get(canon)
    source = "catalog"
    resolved_id = canon

    if not isinstance(entry, dict):
        group = agy_models.match_quota_group(raw) or agy_models.match_quota_group(canon) or ""
        fallback_key = cat["group_fallbacks"].get(group) or cat["default_fallback_model"]
        entry = cat["models"].get(fallback_key) if fallback_key else None
        source = "fallback"
        if isinstance(entry, dict):
            resolved_id = fallback_key

    if not isinstance(entry, dict):
        # Last resort if user deleted all models from custom catalog
        resolved = ResolvedModelRates(
            model=canon or raw or "unknown",
            display_name=model_display_name(raw, cat),
            standard=RateTier(0.0, 0.0, 0.0, 0.0),
            pricing_source="fallback",
        )
    else:
        selected, sched_src = _select_scheduled_block(entry, on_date)
        effective_src = sched_src if source != "fallback" else "fallback"
        std_tier = _to_tier(selected.get("rates") if isinstance(selected.get("rates"), dict) else {})
        threshold = max(0, int(selected.get("long_context_threshold") or 0))
        lc_tier = (
            _to_tier(selected["long_context"], std_tier)
            if isinstance(selected.get("long_context"), dict) and threshold > 0
            else None
        )
        resolved = ResolvedModelRates(
            model=resolved_id,
            display_name=str(selected.get("display_name") or "").strip() or resolved_id,
            standard=std_tier,
            long_context_threshold=threshold,
            long_context=lc_tier,
            pricing_source=effective_src,
        )

    for candidate in (raw, stripped, canon, resolved.model):
        if candidate and candidate in ov_map:
            resolved = _apply_override(resolved, ov_map[candidate])
            break
    return resolved


def resolve_step_model_and_role(
    step_model: str | None,
    *,
    run_model: str,
    kind: str = "PLANNER_RESPONSE",
    planner_model: str | None = None,
    executor_model: str | None = None,
    last_model: str | None = None,
    catalog: dict[str, Any] | None = None,
) -> tuple[str, str, str]:
    """Resolve `(canonical_model, role, pricing_lookup_key)` for a single LLM step."""
    cat = catalog or load_pricing_catalog()
    raw_step = str(step_model or "").strip().lower()
    raw_run = str(run_model or "").strip().lower()
    raw_planner = str(planner_model or "").strip().lower()
    raw_executor = str(executor_model or "").strip().lower()

    is_orch = _is_orchestrator_id(raw_run, cat) or _is_orchestrator_id(raw_step, cat)

    canon_planner = ""
    if raw_planner:
        canon_planner = canonicalize_model_id(raw_planner, cat)
    elif _is_orchestrator_id(raw_run, cat):
        canon_planner = canonicalize_model_id(raw_run, cat)

    canon_executor = canonicalize_model_id(raw_executor, cat) if raw_executor else ""

    if str(kind or "").strip().upper() == "CHECKPOINT" and not raw_step:
        chosen = str(last_model or "").strip().lower() or canon_planner or canonicalize_model_id(raw_run, cat)
        return (chosen, "compaction", chosen)

    if not raw_step:
        chosen = canonicalize_model_id(raw_run, cat)
        role = "planner" if _is_orchestrator_id(raw_run, cat) else "model"
        return (chosen, role, raw_run or chosen)

    # Role alias (e.g., gemini-flash-worker-agy -> executor)
    stripped_step = _strip_suffixes(raw_step, cat)
    alias_role = cat["role_aliases"].get(raw_step) or cat["role_aliases"].get(stripped_step)
    if alias_role:
        chosen = canonicalize_model_id(raw_step, cat)
        return (chosen, alias_role, raw_step)

    if _is_orchestrator_id(raw_step, cat):
        # If caller explicitly configured a concrete non-orchestrator planner model, prefer it
        if raw_planner and not _is_orchestrator_id(raw_planner, cat):
            return (canon_planner, "planner", raw_planner)
        chosen = canonicalize_model_id(raw_step, cat)
        return (chosen, "planner", raw_step)

    chosen = canonicalize_model_id(raw_step, cat)
    if is_orch:
        if canon_executor and chosen == canon_executor and chosen != canon_planner:
            return (chosen, "executor", raw_step)
        if canon_planner and chosen == canon_planner:
            return (chosen, "planner", raw_step)
        if canon_executor and chosen == canon_executor:
            return (chosen, "executor", raw_step)
        return (chosen, "executor" if canon_planner and chosen != canon_planner else "model", raw_step)

    return (chosen, "model", raw_step)


def _step_cost(
    *,
    uncached_input_tokens: int,
    cache_read_tokens: int,
    cache_write_tokens: int,
    output_tokens: int,
    thinking_tokens: int,
    rates: ResolvedModelRates,
) -> float:
    context_tokens = uncached_input_tokens + cache_read_tokens + cache_write_tokens
    tier = rates.tier_for_context(context_tokens)
    # Antigravity 1.5+ output_tokens already includes thinking_tokens when both are reported.
    billable_out = max(output_tokens, thinking_tokens)
    usd = (
        uncached_input_tokens * tier.input
        + cache_read_tokens * tier.cache_read
        + cache_write_tokens * tier.cache_write
        + billable_out * tier.output
    ) / 1_000_000.0
    return usd


def _split_inclusive_input(input_tokens: int, cache_read_tokens: int, cache_write_tokens: int) -> tuple[int, int, int, int]:
    """Normalize inclusive vs exclusive ACP `input_tokens` into `(total_input, uncached_input, cache_read, cache_write)`."""
    raw_in = max(0, int(input_tokens))
    cr = max(0, int(cache_read_tokens))
    cw = max(0, int(cache_write_tokens))
    cached = cr + cw
    if cached > raw_in:
        return (raw_in + cached, raw_in, cr, cw)
    return (raw_in, raw_in - cached, cr, cw)


def calculate_run_cost(
    *,
    model: str,
    usage: dict[str, Any] | None,
    step_usages: list[dict[str, Any]] | None = None,
    orchestrator_planner: str | None = None,
    orchestrator_executor: str | None = None,
    run_date: date | datetime | str | None = None,
    catalog: dict[str, Any] | None = None,
    overrides: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Compute exact estimated API cost (USD) and per-model breakdown for a turn.

    - `step_usages` (from `transcript.jsonl`) use exclusive `input_tokens` (uncached fresh tokens).
    - `usage` (from ACP `usage_update`) uses inclusive `input_tokens` (`uncached + cache_read + cache_write`).
    - Returned `model_breakdown[*].input_tokens` preserves GA-Hub's inclusive `input_tokens` invariant.
    """
    cat = catalog or load_pricing_catalog()
    ov_map = _normalize_overrides(overrides)
    u = usage if isinstance(usage, dict) else {}

    u_total_in, u_uncached_in, u_cr, u_cw = _split_inclusive_input(
        max(0, int(u.get("input_tokens") or 0)),
        max(0, int(u.get("cache_read_tokens") or 0)),
        max(0, int(u.get("cache_write_tokens") or 0)),
    )
    u_out = max(0, int(u.get("output_tokens") or 0))
    u_think = max(0, int(u.get("thinking_tokens") or 0))
    u_calls = max(0, int(u.get("model_calls") or 0))

    buckets: dict[tuple[str, str], dict[str, Any]] = {}

    def _add_to_bucket(
        *,
        canon_model: str,
        role: str,
        calls: int,
        inclusive_in_tok: int,
        out_tok: int,
        cr_tok: int,
        cw_tok: int,
        think_tok: int,
        cost_usd: float,
        pricing_source: str,
        display_name: str,
    ) -> None:
        key = (canon_model, role)
        bucket = buckets.get(key)
        if bucket is None:
            bucket = {
                "model": canon_model,
                "display_name": display_name,
                "role": role,
                "calls": 0,
                "input_tokens": 0,
                "output_tokens": 0,
                "cache_read_tokens": 0,
                "cache_write_tokens": 0,
                "thinking_tokens": 0,
                "estimated_cost_usd": 0.0,
                "pricing_source": pricing_source,
            }
            buckets[key] = bucket
        bucket["calls"] += calls
        bucket["input_tokens"] += inclusive_in_tok
        bucket["output_tokens"] += out_tok
        bucket["cache_read_tokens"] += cr_tok
        bucket["cache_write_tokens"] += cw_tok
        bucket["thinking_tokens"] += think_tok
        bucket["estimated_cost_usd"] += cost_usd

    if step_usages:
        last_model: str | None = None
        last_key: str | None = None
        last_role: str | None = None
        sum_uncached_in = 0
        sum_cr = 0
        sum_cw = 0
        sum_out_total = 0

        for step in step_usages:
            if not isinstance(step, dict):
                continue
            raw_step_model = str(step.get("model") or "").strip()
            kind = str(step.get("kind") or "PLANNER_RESPONSE").strip().upper()
            canon_model, role, lookup_key = resolve_step_model_and_role(
                raw_step_model,
                run_model=model,
                kind=kind,
                planner_model=orchestrator_planner,
                executor_model=orchestrator_executor,
                last_model=last_model,
                catalog=cat,
            )
            if raw_step_model:
                last_model = canon_model
                last_key = lookup_key
                last_role = role

            # transcript.jsonl reports exclusive `input_tokens` (uncached fresh tokens) per request
            s_uncached_in = max(0, int(step.get("input_tokens") or 0))
            s_cr = max(0, int(step.get("cache_read_tokens") or 0))
            s_cw = max(0, int(step.get("cache_write_tokens") or 0))
            s_out = max(0, int(step.get("output_tokens") or 0))
            s_think = max(0, int(step.get("thinking_tokens") or 0))
            s_inclusive_in = s_uncached_in + s_cr + s_cw

            rates = resolve_model_rates(lookup_key or canon_model, run_date=run_date, catalog=cat, overrides=ov_map)
            cost = _step_cost(
                uncached_input_tokens=s_uncached_in,
                cache_read_tokens=s_cr,
                cache_write_tokens=s_cw,
                output_tokens=s_out,
                thinking_tokens=s_think,
                rates=rates,
            )
            _add_to_bucket(
                canon_model=canon_model or rates.model,
                role=role,
                calls=1,
                inclusive_in_tok=s_inclusive_in,
                out_tok=s_out,
                cr_tok=s_cr,
                cw_tok=s_cw,
                think_tok=s_think,
                cost_usd=cost,
                pricing_source=rates.pricing_source,
                display_name=rates.display_name,
            )
            sum_uncached_in += s_uncached_in
            sum_cr += s_cr
            sum_cw += s_cw
            sum_out_total += max(s_out, s_think)

        # Reconcile any positive ACP usage delta (e.g., Anthropic cache_write or trailing tokens not flushed to steps)
        # while capping input residuals at total ACP input budget (`u_total_in - sum_all_in`).
        sum_all_in = sum_uncached_in + sum_cr + sum_cw
        input_budget = max(0, u_total_in - sum_all_in)
        rem_cw = min(input_budget, max(0, u_cw - sum_cw))
        input_budget -= rem_cw
        rem_uncached_in = min(input_budget, max(0, u_uncached_in - sum_uncached_in))
        input_budget -= rem_uncached_in
        rem_cr = min(input_budget, max(0, u_cr - sum_cr))
        rem_out_total = max(0, max(u_out, u_think) - sum_out_total)

        if rem_uncached_in or rem_cr or rem_cw or rem_out_total:
            rem_out = rem_out_total if u_out >= u_think else 0
            rem_think = rem_out_total if u_think > u_out else 0
            fallback_model = (orchestrator_executor or orchestrator_planner or model) if _is_orchestrator_id(model, cat) else model
            res_model = last_model or canonicalize_model_id(fallback_model, cat)
            res_key = last_key or res_model
            res_role = last_role or "model"
            rates = resolve_model_rates(res_key, run_date=run_date, catalog=cat, overrides=ov_map)
            rem_cost = _step_cost(
                uncached_input_tokens=rem_uncached_in,
                cache_read_tokens=rem_cr,
                cache_write_tokens=rem_cw,
                output_tokens=rem_out,
                thinking_tokens=rem_think,
                rates=rates,
            )
            _add_to_bucket(
                canon_model=res_model or rates.model,
                role=res_role,
                calls=0,
                inclusive_in_tok=rem_uncached_in + rem_cr + rem_cw,
                out_tok=rem_out,
                cr_tok=rem_cr,
                cw_tok=rem_cw,
                think_tok=rem_think,
                cost_usd=rem_cost,
                pricing_source=rates.pricing_source,
                display_name=rates.display_name,
            )
    else:
        if u_total_in or u_out or u_cr or u_cw or u_think:
            canon_model, role, lookup_key = resolve_step_model_and_role(
                model,
                run_model=model,
                kind="PLANNER_RESPONSE",
                planner_model=orchestrator_planner,
                executor_model=orchestrator_executor,
                catalog=cat,
            )
            rates = resolve_model_rates(lookup_key or canon_model, run_date=run_date, catalog=cat, overrides=ov_map)
            calls = u_calls if u_calls > 0 else 1
            per_call_ctx = int(u_total_in / calls)
            tier = rates.tier_for_context(per_call_ctx)
            cost = (
                u_uncached_in * tier.input
                + u_cr * tier.cache_read
                + u_cw * tier.cache_write
                + max(u_out, u_think) * tier.output
            ) / 1_000_000.0
            _add_to_bucket(
                canon_model=canon_model or rates.model,
                role=role,
                calls=calls,
                inclusive_in_tok=u_total_in,
                out_tok=u_out,
                cr_tok=u_cr,
                cw_tok=u_cw,
                think_tok=u_think,
                cost_usd=cost,
                pricing_source=rates.pricing_source,
                display_name=rates.display_name,
            )

    breakdown: list[dict[str, Any]] = []
    total_cost = 0.0
    for item in buckets.values():
        rounded = round(float(item["estimated_cost_usd"]), 6)
        item["estimated_cost_usd"] = rounded
        total_cost += rounded
        breakdown.append(item)
    breakdown.sort(key=lambda b: (-float(b["estimated_cost_usd"]), str(b["model"]), str(b["role"])))

    return {
        "estimated_cost_usd": round(total_cost, 6),
        "model_breakdown": breakdown,
    }
