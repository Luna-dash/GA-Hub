import { describe, expect, it } from 'vitest'
import {
  currentHourStartMs,
  formatCompactTokens,
  formatQuotaPct,
  formatRunUsage,
  geminiQuotaSummary,
  isUsageStaleForHour,
  nextTopOfHourMs,
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
