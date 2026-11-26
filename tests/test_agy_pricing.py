"""Tests for externalized model pricing, date schedules, long-context tiers, and orchestrator split billing."""

from __future__ import annotations

import json
from datetime import date

import pytest

from server.services import agy_models, agy_pricing


def test_pricing_catalog_loads_without_hardcoded_user_file(tmp_path, monkeypatch):
    monkeypatch.setattr(agy_pricing._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_models._paths, "ADMIN_DATA", tmp_path)

    cat = agy_pricing.load_pricing_catalog()
    assert cat["default_fallback_model"] == "gemini-4-carbon"
    assert "gemini-4-neon" in cat["models"]
    assert "gemini-4-carbon" in cat["models"]
    assert "gemini-4-argon" in cat["models"]
    assert "gemini-4-hydrogen" in cat["models"]
    assert "gemini-3.8-flash" in cat["models"]
    assert "gemini-3.1-pro" in cat["models"]
    assert "claude-opus-5-5" in cat["models"]
    assert "claude-sonnet-5-5" in cat["models"]
    assert "gpt-oss-120b" in cat["models"]


def test_date_aware_promo_schedules(tmp_path, monkeypatch):
    monkeypatch.setattr(agy_pricing._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_models._paths, "ADMIN_DATA", tmp_path)

    for model_id in ("gemini-4-carbon-high", "gemini-4-argon"):
        promo = agy_pricing.calculate_run_cost(
            model=model_id,
            usage={"input_tokens": 2_000_000, "cache_read_tokens": 1_000_000, "output_tokens": 1_000_000},
            run_date=date(2026, 11, 30),
        )
        assert promo["estimated_cost_usd"] == pytest.approx(12.1)

        std = agy_pricing.calculate_run_cost(
            model=model_id,
            usage={"input_tokens": 2_000_000, "cache_read_tokens": 1_000_000, "output_tokens": 1_000_000},
            run_date=date(2026, 12, 1),
        )
        assert std["estimated_cost_usd"] == pytest.approx(24.2)

    flash_promo = agy_pricing.resolve_model_rates("gemini-3.8-flash", run_date=date(2026, 12, 31))
    assert flash_promo.standard.input == pytest.approx(0.75)
    assert flash_promo.standard.output == pytest.approx(3.75)

    flash_std = agy_pricing.resolve_model_rates("gemini-3.8-flash", run_date=date(2027, 1, 1))
    assert flash_std.standard.input == pytest.approx(1.5)
    assert flash_std.standard.output == pytest.approx(7.5)


def test_per_step_long_context_tier_and_anthropic_cache_write(tmp_path, monkeypatch):
    monkeypatch.setattr(agy_pricing._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_models._paths, "ADMIN_DATA", tmp_path)

    # Gemini 3.1 Pro via legacy alias `gemini-3-pro-high`: step1 <= 200k, step2 > 200k
    res_lc = agy_pricing.calculate_run_cost(
        model="gemini-3-pro-high",
        usage={"input_tokens": 360_000, "cache_read_tokens": 250_000, "output_tokens": 2_000},
        step_usages=[
            {
                "kind": "PLANNER_RESPONSE",
                "step_index": 1,
                "model": "gemini-3-pro-high",
                "input_tokens": 50_000,
                "cache_read_tokens": 100_000,
                "output_tokens": 1_000,
            },
            {
                "kind": "PLANNER_RESPONSE",
                "step_index": 2,
                "model": "gemini-3-pro-high",
                "input_tokens": 60_000,
                "cache_read_tokens": 150_000,
                "output_tokens": 1_000,
            },
        ],
    )
    assert res_lc["estimated_cost_usd"] == pytest.approx(0.45)
    assert len(res_lc["model_breakdown"]) == 1
    assert res_lc["model_breakdown"][0]["model"] == "gemini-3.1-pro"
    assert res_lc["model_breakdown"][0]["calls"] == 2
    assert res_lc["model_breakdown"][0]["input_tokens"] == 360_000

    # Anthropic cache_write (1.25x) + non-double-counted thinking_tokens subset
    res_claude = agy_pricing.calculate_run_cost(
        model="claude-sonnet-5-5-thinking",
        usage={
            "input_tokens": 1_000_000,
            "cache_read_tokens": 500_000,
            "cache_write_tokens": 200_000,
            "output_tokens": 100_000,
            "thinking_tokens": 50_000,
        },
    )
    assert res_claude["estimated_cost_usd"] == pytest.approx(2.15)

    # Non-orchestrator run must keep role="model" even when saved profile orchestrator roles exist
    non_orch = agy_pricing.calculate_run_cost(
        model="gemini-4-hydrogen-high",
        orchestrator_planner="gemini-4-neon",
        orchestrator_executor="claude-sonnet-5-5",
        usage={"input_tokens": 100_000, "cache_read_tokens": 0, "output_tokens": 1_000},
    )
    assert non_orch["model_breakdown"][0]["role"] == "model"
    assert non_orch["model_breakdown"][0]["model"] == "gemini-4-hydrogen"


def test_orchestrator_per_call_split_and_reconciliation(tmp_path, monkeypatch):
    monkeypatch.setattr(agy_pricing._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_models._paths, "ADMIN_DATA", tmp_path)

    res = agy_pricing.calculate_run_cost(
        model="gemini-pro-orchestrator-neon",
        orchestrator_planner="gemini-4-neon-high",
        orchestrator_executor="claude-sonnet-5-5",
        usage={
            "input_tokens": 600_000,
            "cache_read_tokens": 250_000,
            "cache_write_tokens": 0,
            "output_tokens": 42_000,
            "thinking_tokens": 5_000,
        },
        step_usages=[
            {
                "kind": "PLANNER_RESPONSE",
                "step_index": 1,
                "model": "gemini-pro-orchestrator-neon",
                "input_tokens": 100_000,
                "cache_read_tokens": 0,
                "output_tokens": 10_000,
            },
            {
                "kind": "CHECKPOINT",
                "step_index": 2,
                "model": "",
                "input_tokens": 0,
                "cache_read_tokens": 100_000,
                "output_tokens": 2_000,
            },
            {
                "kind": "PLANNER_RESPONSE",
                "step_index": 3,
                "model": "gemini-flash-worker-agy",
                "input_tokens": 200_000,
                "cache_read_tokens": 0,
                "output_tokens": 20_000,
            },
            {
                "kind": "PLANNER_RESPONSE",
                "step_index": 4,
                "model": "claude-sonnet-5-5",
                "input_tokens": 50_000,
                "cache_read_tokens": 150_000,
                "output_tokens": 10_000,
            },
        ],
    )
    assert res["estimated_cost_usd"] == pytest.approx(1.16)
    by_key = {(item["model"], item["role"]): item for item in res["model_breakdown"]}
    assert by_key[("gemini-4-neon", "planner")]["estimated_cost_usd"] == pytest.approx(0.45)
    assert by_key[("gemini-4-neon", "compaction")]["estimated_cost_usd"] == pytest.approx(0.045)
    assert by_key[("gemini-4-hydrogen", "executor")]["estimated_cost_usd"] == pytest.approx(0.45)
    assert by_key[("claude-sonnet-5-5", "executor")]["estimated_cost_usd"] == pytest.approx(0.215)
    # Invariant: sum(model_breakdown.input_tokens) == ACP inclusive input_tokens
    assert sum(item["input_tokens"] for item in res["model_breakdown"]) == 600_000


def test_pricing_reconciliation_captures_missing_cache_write_only_once(tmp_path, monkeypatch):
    monkeypatch.setattr(agy_pricing._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_models._paths, "ADMIN_DATA", tmp_path)

    res = agy_pricing.calculate_run_cost(
        model="claude-opus-5-5",
        usage={
            "input_tokens": 300_000,
            "cache_read_tokens": 100_000,
            "cache_write_tokens": 100_000,
            "output_tokens": 10_000,
        },
        step_usages=[
            {
                "kind": "PLANNER_RESPONSE",
                "step_index": 1,
                "model": "claude-opus-5-5",
                "input_tokens": 100_000,
                "cache_read_tokens": 100_000,
                "output_tokens": 10_000,
            },
        ],
    )
    # Step 1: 0.1*4.0 + 0.1*0.2 + 0.01*20.0 = 0.62
    # Residual missing cache_write (100k): 0.1*5.0 = 0.50 -> Total = 1.12
    assert res["estimated_cost_usd"] == pytest.approx(1.12)
    assert res["model_breakdown"][0]["cache_write_tokens"] == 100_000
    assert res["model_breakdown"][0]["input_tokens"] == 300_000
    assert res["model_breakdown"][0]["calls"] == 1


def test_external_user_pricing_json_and_config_overrides_hot_reload(tmp_path, monkeypatch):
    monkeypatch.setattr(agy_pricing._paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(agy_models._paths, "ADMIN_DATA", tmp_path)

    # 1. External <ADMIN_DATA>/agy_pricing.json adds a brand-new model & alias without touching source code
    (tmp_path / "agy_pricing.json").write_text(
        json.dumps({
            "internal_aliases": {"future-worker-agy": "gemini-5-alpha"},
            "models": {
                "gemini-5-alpha": {
                    "display_name": "Gemini 5 Alpha",
                    "rates": {"input": 10.0, "cache_read": 1.0, "cache_write": 10.0, "output": 50.0},
                }
            },
        }),
        encoding="utf-8",
    )
    ext = agy_pricing.calculate_run_cost(
        model="future-worker-agy",
        usage={"input_tokens": 1_000_000, "cache_read_tokens": 0, "output_tokens": 100_000},
    )
    assert ext["estimated_cost_usd"] == pytest.approx(15.0)
    assert ext["model_breakdown"][0]["model"] == "gemini-5-alpha"
    assert ext["model_breakdown"][0]["display_name"] == "Gemini 5 Alpha"

    # 2. agy_models pricing_overrides overrides even external/bundled rates immediately on patch
    agy_models.patch_user_config(
        pricing_overrides={
            "gemini-5-alpha": {
                "input": 2.0,
                "cache_read": 0.2,
                "cache_write": 2.0,
                "output": 4.0,
            }
        }
    )
    overridden = agy_pricing.calculate_run_cost(
        model="future-worker-agy",
        usage={"input_tokens": 1_000_000, "cache_read_tokens": 0, "output_tokens": 100_000},
    )
    assert overridden["estimated_cost_usd"] == pytest.approx(2.4)
    assert overridden["model_breakdown"][0]["pricing_source"] == "override"
