import { describe, expect, it } from 'vitest'
import { formatClock, formatDurationSeconds, formatRelativeTime } from './timeFormat'

// A fixed "now" so relative formatting is deterministic: 2026-09-15 12:00 UTC.
const NOW = Date.UTC(2026, 8, 15, 12, 0, 0) / 1000

describe('formatClock', () => {
  it('renders local HH:MM for same-day stamps', () => {
    const stamp = NOW - 3600
    expect(formatClock(stamp, NOW)).toMatch(/^\d{2}:\d{2}$/)
  })

  it('prefixes the month-day for cross-day stamps', () => {
    const stamp = Date.UTC(2026, 7, 1, 3, 5, 0) / 1000
    expect(formatClock(stamp, NOW)).toMatch(/^\d{1,2}-\d{1,2} \d{2}:\d{2}$/)
  })

  it('returns an empty string for missing timestamps', () => {
    expect(formatClock(0, NOW)).toBe('')
    expect(formatClock(Number.NaN, NOW)).toBe('')
  })
})

describe('formatRelativeTime', () => {
  it('says 刚刚 within 90 seconds', () => {
    expect(formatRelativeTime(NOW - 30, NOW)).toBe('刚刚')
    expect(formatRelativeTime(NOW - 89, NOW)).toBe('刚刚')
  })

  it('counts minutes up to an hour', () => {
    expect(formatRelativeTime(NOW - 300, NOW)).toBe('5分钟前')
    expect(formatRelativeTime(NOW - 3599, NOW)).toBe('59分钟前')
  })

  it('counts hours within a day', () => {
    expect(formatRelativeTime(NOW - 2 * 3600, NOW)).toBe('2小时前')
    expect(formatRelativeTime(NOW - 23 * 3600, NOW)).toBe('23小时前')
  })

  it('falls back to a dated clock beyond a day', () => {
    expect(formatRelativeTime(NOW - 26 * 3600, NOW)).toMatch(/^\d{1,2}-\d{1,2} \d{2}:\d{2}$/)
  })

  it('returns an empty string for missing timestamps', () => {
    expect(formatRelativeTime(0, NOW)).toBe('')
  })
})

describe('formatDurationSeconds', () => {
  it('formats short durations as M:SS', () => {
    expect(formatDurationSeconds(0)).toBe('0:00')
    expect(formatDurationSeconds(65)).toBe('1:05')
    expect(formatDurationSeconds(604.5)).toBe('10:04')
  })

  it('formats long durations as H:MM:SS', () => {
    expect(formatDurationSeconds(3600)).toBe('1:00:00')
    expect(formatDurationSeconds(3671)).toBe('1:01:11')
  })

  it('returns an empty string for invalid input', () => {
    expect(formatDurationSeconds(-1)).toBe('')
    expect(formatDurationSeconds(Number.NaN)).toBe('')
  })
})
