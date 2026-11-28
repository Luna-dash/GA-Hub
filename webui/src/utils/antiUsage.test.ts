import { describe, expect, it } from 'vitest'
import {
  currentHourStartMs,
  formatCompactTokens,
  formatEstimatedUsd,
  formatQuotaModelName,
  formatQuotaPct,
  formatRunUsage,
  geminiQuotaSummary,
  isUsageStaleForHour,
  modelRoleLabel,
  nextTopOfHourMs,
  quotaLimitDisplayLabel,
  resolveAccountTier,
  sortQuotaRows,
} from './antiUsage'

describe('formatCompactTokens', () => {
  it('formats integers, k, M, and B boundaries cleanly', () => {
    expect(formatCompactTokens(-5)).toBe('0')
    expect(formatCompactTokens(Number.NaN)).toBe('0')
    expect(formatCompactTokens(0)).toBe('0')
    expect(formatCompactTokens(120)).toBe('120')
    expect(formatCompactTokens(999)).toBe('999')
    expect(formatCompactTokens(1_000)).toBe('1k')
    expect(formatCompactTokens(1_500)).toBe('1.5k')
    expect(formatCompactTokens(29_726)).toBe('29.7k')
    expect(formatCompactTokens(90_537)).toBe('90.5k')
    expect(formatCompactTokens(778_033)).toBe('778k')
    expect(formatCompactTokens(999_499)).toBe('999k')
    expect(formatCompactTokens(999_500)).toBe('1M')
    expect(formatCompactTokens(5_461_792)).toBe('5.46M')
    expect(formatCompactTokens(10_500_000)).toBe('10.5M')
    expect(formatCompactTokens(100_000_000)).toBe('100M')
    expect(formatCompactTokens(1_250_000_000)).toBe('1.25B')
  })
})

describe('formatRunUsage', () => {
  it('keeps small inclusive counts concise while supporting legacy exclusive repair', () => {
    const small = formatRunUsage({
      input_tokens: 120,
      output_tokens: 30,
      cache_read_tokens: 60,
      cache_write_tokens: 0,
      thinking_tokens: 0,
    })
    expect(small?.text).toBe('120 in · 30 out · 缓存 50%')
    expect(small?.title).toContain('总输入 120（新输入 60 + 缓存命中 60）')

    // Reproduces the 778,033 exclusive input + 4,683,759 cached read case -> 5.46M total input, 86% cache hit
    const highCache = formatRunUsage({
      input_tokens: 778_033,
      output_tokens: 90_537,
      cache_read_tokens: 4_683_759,
      cache_write_tokens: 0,
      thinking_tokens: 29_726,
    })
    expect(highCache?.text).toBe('5.46M in · 90.5k out · 29.7k think · 缓存 86%')
    expect(highCache?.title).toBe(
      '总输入 5,461,792（新输入 778,033 + 缓存命中 4,683,759） · 输出 90,537 · 思考 29,726 · 缓存命中率 85.8%',
    )

    // Includes cache_write_tokens when reported
    const withWrite = formatRunUsage({
      input_tokens: 100_000,
      output_tokens: 2_500,
      cache_read_tokens: 60_000,
      cache_write_tokens: 10_000,
      thinking_tokens: 0,
    })
    expect(withWrite?.text).toBe('100k in · 2.5k out · 缓存 60%')
    expect(withWrite?.title).toContain('新输入 30,000 + 缓存命中 60,000 + 缓存写入 10,000')

    // Displays model_calls and tok/s when generation_ms >= 150ms without double-counting thinking tokens
    const withSpeed = formatRunUsage({
      input_tokens: 1_000,
      output_tokens: 400,
      cache_read_tokens: 500,
      cache_write_tokens: 0,
      thinking_tokens: 150,
      model_calls: 4,
      generation_ms: 5_000,
    })
    expect(withSpeed?.text).toBe('1k in · 400 out · 150 think · 缓存 50% · 4 次调用 · 80.0 tok/s')
    expect(withSpeed?.title).toContain('模型调用 4 次 · 生成速度 80.0 tok/s（有效输出耗时 5.0s）')
  })
})

describe('geminiQuotaSummary and hourly slot helpers', () => {
  it('picks lowest Gemini 5h and weekly windows and ignores shared 3p rows when Gemini rows exist', () => {
    const summary = geminiQuotaSummary({
      rows: [
        { model: 'Gemini Argon', limit: 'Five Hour Limit Remaining', remaining_pct: 95, resets_at: '2026-11-26T05:00:00Z' },
        { model: 'Gemini', limit: 'Five Hour Limit Remaining', remaining_pct: 72.5, resets_at: '2026-11-26T04:00:00Z' },
        { model: 'Gemini', limit: 'Weekly Limit Remaining', remaining_pct: 20.9, resets_at: '2026-12-01T04:00:00Z' },
        { model: 'Claude & GPT (shared)', limit: 'Five Hour Limit Remaining', remaining_pct: 10 },
        { model: 'Claude & GPT (shared)', limit: 'Weekly Limit Remaining', remaining_pct: 5 },
      ],
    })
    expect(summary.fiveHour?.remaining_pct).toBe(72.5)
    expect(summary.weekly?.remaining_pct).toBe(20.9)
    expect(formatQuotaPct(72.5)).toBe('72.5%')
    expect(formatQuotaPct(100)).toBe('100%')

    // Falls back to non-weekly Reported Quota when no explicit 5h row exists
    const singleRow = geminiQuotaSummary({
      rows: [
        { model: 'Gemini', limit: 'Reported Quota', remaining_pct: 42 },
        { model: 'Gemini', limit: 'Weekly Limit Remaining', remaining_pct: 60 },
      ],
    })
    expect(singleRow.fiveHour?.remaining_pct).toBe(42)
    expect(singleRow.weekly?.remaining_pct).toBe(60)
    expect(geminiQuotaSummary(null)).toEqual({ fiveHour: null, weekly: null })
  })

  it('detects hour boundaries and usage staleness', () => {
    const now = new Date(2026, 10, 26, 10, 23, 45, 500).getTime()
    const hourStart = currentHourStartMs(now)
    expect(hourStart).toBe(new Date(2026, 10, 26, 10, 0, 0, 0).getTime())
    expect(nextTopOfHourMs(now)).toBe(new Date(2026, 10, 26, 11, 0, 0, 0).getTime())

    expect(isUsageStaleForHour(null, now)).toBe(true)
    expect(isUsageStaleForHour('not-a-date', now)).toBe(true)
    expect(isUsageStaleForHour(new Date(hourStart - 1_000).toISOString(), now)).toBe(true)
    expect(isUsageStaleForHour(new Date(hourStart + 60_000).toISOString(), now)).toBe(false)
  })
})

describe('resolveAccountTier', () => {
  it('maps ultra, pro, plus, enterprise, and free tiers to warm-luxury presentations and rejects unknown values', () => {
    const ultra = resolveAccountTier('ultra', 'Google AI Ultra')
    expect(ultra).toMatchObject({ tier: 'ultra', shortLabel: 'Ultra', fullLabel: 'Google AI Ultra', pillClass: 'ga-account-pill--ultra', cardBadgeClass: 'ga-tier-badge--ultra', cardFrameAccentClass: 'ga-tier-frame--ultra' })

    expect(resolveAccountTier('pro')).toMatchObject({ tier: 'pro', shortLabel: 'Pro', fullLabel: 'Google AI Pro', pillClass: 'ga-account-pill--pro' })
    expect(resolveAccountTier('plus')).toMatchObject({ tier: 'plus', shortLabel: 'Plus', fullLabel: 'Google AI Plus', pillClass: 'ga-account-pill--plus' })
    expect(resolveAccountTier('enterprise')).toMatchObject({ tier: 'enterprise', shortLabel: 'Enterprise', fullLabel: 'Enterprise', pillClass: 'ga-account-pill--enterprise' })
    expect(resolveAccountTier('free')).toMatchObject({ tier: 'free', shortLabel: 'Free', fullLabel: 'Free', pillClass: '' })
    expect(resolveAccountTier(null)).toBeNull()
    expect(resolveAccountTier('unknown')).toBeNull()
  })
})

describe('quotaLimitDisplayLabel and sortQuotaRows', () => {
  it('translates Reported Quota and standard window labels consistently', () => {
    expect(quotaLimitDisplayLabel('Five Hour Limit Remaining')).toBe('5 小时额度')
    expect(quotaLimitDisplayLabel('Weekly Limit Remaining')).toBe('每周额度')
    expect(quotaLimitDisplayLabel('Pro Weekly Limit')).toBe('每周额度')
    expect(quotaLimitDisplayLabel('Reported Quota')).toBe('当前额度')
    expect(quotaLimitDisplayLabel('Custom Limit')).toBe('Custom Limit')
    expect(formatQuotaModelName('Claude & GPT (shared)')).toBe('Claude & GPT')
    expect(formatQuotaModelName('Claude & GPT (SHARED) ')).toBe('Claude & GPT')
    expect(formatQuotaModelName('Gemini')).toBe('Gemini')
  })

  it('deduplicates display rows and orders families & windows deterministically', () => {
    const sorted = sortQuotaRows([
      { model: 'Claude & GPT (shared)', limit: 'Weekly Limit Remaining', remaining_pct: 70, resets_at: '2026-12-01T00:00:00Z' },
      { model: 'Gemini Argon', limit: 'Weekly Limit Remaining', remaining_pct: 90, resets_at: null },
      { model: 'Gemini', limit: 'Weekly Limit Remaining', remaining_pct: 60, resets_at: '2026-12-01T00:00:00Z' },
      { model: 'Gemini', limit: 'Five Hour Limit Remaining', remaining_pct: 80, resets_at: '2026-11-26T12:00:00Z' },
      { model: 'Gemini', limit: 'Five Hour Limit Remaining', remaining_pct: 10, resets_at: null },
      { model: 'Claude & GPT (shared)', limit: 'Five Hour Limit Remaining', remaining_pct: 40, resets_at: '2026-11-26T12:00:00Z' },
    ])
    expect(sorted.map(r => `${r.model}|${r.limit}|${r.remaining_pct}`)).toEqual([
      'Gemini|Five Hour Limit Remaining|80',
      'Gemini|Weekly Limit Remaining|60',
      'Gemini Argon|Weekly Limit Remaining|90',
      'Claude & GPT (shared)|Five Hour Limit Remaining|40',
      'Claude & GPT (shared)|Weekly Limit Remaining|70',
    ])
  })
})


describe('estimated USD formatting & per-model breakdown', () => {
  it('formats sub-penny and standard USD amounts accurately', () => {
    expect(formatEstimatedUsd(0)).toBe('$0.00')
    expect(formatEstimatedUsd(0.00004)).toBe('<$0.0001')
    expect(formatEstimatedUsd(0.0024)).toBe('$0.0024')
    expect(formatEstimatedUsd(0.12)).toBe('$0.12')
    expect(formatEstimatedUsd(1.5)).toBe('$1.50')
  })

  it('includes cost estimate and per-model breakdown in formatRunUsage tooltip', () => {
    const res = formatRunUsage({
      input_tokens: 150_000,
      output_tokens: 5_000,
      cache_read_tokens: 100_000,
      cache_write_tokens: 0,
      thinking_tokens: 0,
      model_calls: 3,
      estimated_cost_usd: 0.0042,
      model_breakdown: [
        {
          model: 'gemini-4-neon',
          display_name: 'Gemini 4 Neon',
          role: 'planner',
          calls: 1,
          input_tokens: 50_000,
          output_tokens: 2_000,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          thinking_tokens: 0,
          estimated_cost_usd: 0.003,
          pricing_source: 'catalog',
        },
        {
          model: 'gemini-4-hydrogen',
          display_name: 'Gemini 4 Hydrogen',
          role: 'executor',
          calls: 2,
          input_tokens: 100_000,
          output_tokens: 3_000,
          cache_read_tokens: 100_000,
          cache_write_tokens: 0,
          thinking_tokens: 0,
          estimated_cost_usd: 0.0012,
          pricing_source: 'catalog',
        },
      ],
    })
    expect(res?.text).toContain('~$0.0042')
    expect(res?.title).toContain('按官方公开 API 价估算 ~$0.0042')
    expect(res?.title).toContain('Gemini 4 Neon(规划) ×1 ~$0.003')
    expect(res?.title).toContain('Gemini 4 Hydrogen(执行) ×2 ~$0.0012')
  })

  it('formats subagent role breakdown with 子代理 label', () => {
    expect(modelRoleLabel('subagent')).toBe('子代理')
    const res = formatRunUsage({
      input_tokens: 200_000,
      output_tokens: 10_000,
      cache_read_tokens: 100_000,
      cache_write_tokens: 0,
      thinking_tokens: 0,
      model_calls: 6,
      estimated_cost_usd: 0.015,
      model_breakdown: [
        {
          model: 'gemini-3.8-flash',
          display_name: 'Gemini 3.8 Flash',
          role: 'subagent',
          calls: 5,
          input_tokens: 150_000,
          output_tokens: 8_000,
          cache_read_tokens: 100_000,
          cache_write_tokens: 0,
          thinking_tokens: 0,
          estimated_cost_usd: 0.012,
          pricing_source: 'catalog',
        },
      ],
    })
    expect(res?.title).toContain('Gemini 3.8 Flash(子代理) ×5 ~$0.01')
  })
})
