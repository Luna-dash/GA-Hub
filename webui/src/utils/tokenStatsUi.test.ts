import { describe, expect, it } from 'vitest'
import type { TokenThreadStats, TokenWeekStats } from '@/api/types'
import { compactTokens, dailyUsage, filterThreads, pageItems, readableThreadName, visibleWeeks } from './tokenStatsUi'

describe('compactTokens', () => {
  it('uses deterministic k, m, and b token units', () => {
    expect(compactTokens(999)).toBe('999')
    expect(compactTokens(1_000)).toBe('1k')
    expect(compactTokens(12_340)).toBe('12.3k')
    expect(compactTokens(1_250_000)).toBe('1.25m')
    expect(compactTokens(2_000_000_000)).toBe('2b')
  })
})

const thread = (name: string, total: number): TokenThreadStats => ({
  thread: name,
  requests: 1,
  input: Math.floor(total * 0.6),
  output: Math.floor(total * 0.2),
  cache_create: 0,
  cache_read: Math.floor(total * 0.2),
  total: total,
  cache_hit_rate: 20,
  elapsed_seconds: 1,
})

const week = (index: number): TokenWeekStats => ({
  week_start: `2026-0${index + 1}-01`,
  week_end: `2026-0${index + 1}-07`,
  input: index,
  output: index,
  cache_create: 0,
  cache_read: index,
  total: index * 3,
  requests: index,
  cache_hit_rate: 20,
})

describe('token stats presentation', () => {
  it('derives usage from cumulative snapshots and preserves usage after a process reset', () => {
    const rows = dailyUsage([
      { timestamp: 1_800_000_000, requests: 4, input: 100, output: 40, cache_create: 99, cache_read: 60, total: 200, cache_hit_rate: 30 },
      { timestamp: 1_800_000_020, requests: 7, input: 160, output: 55, cache_create: 120, cache_read: 85, total: 300, cache_hit_rate: 30 },
      { timestamp: 1_800_000_040, requests: 0, input: 0, output: 0, cache_create: 0, cache_read: 0, total: 0, cache_hit_rate: 0 },
      { timestamp: 1_800_000_060, requests: 2, input: 20, output: 8, cache_create: 88, cache_read: 12, total: 40, cache_hit_rate: 30 },
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ input: 80, output: 23, cacheRead: 37, total: 140, requests: 5 })
    expect(rows[0]).not.toHaveProperty('cacheCreation')
  })

  it('sorts and filters session usage, then clamps pagination', () => {
    const rows = [thread('research_room', 200), thread('chat-main', 900), thread('quiet', 20)]
    expect(filterThreads(rows, '').map((item) => item.thread)).toEqual(['chat-main', 'research_room', 'quiet'])
    expect(filterThreads(rows, 'research')).toHaveLength(1)
    expect(pageItems(rows, 99, 2)).toMatchObject({ page: 2, pages: 2, items: [rows[2]] })
  })

  it('makes opaque tracker identifiers readable while preserving useful names', () => {
    expect(readableThreadName('session-research_room', 0)).toBe('research room')
    expect(readableThreadName('8c47f7319833a00481dfb6aa', 2)).toBe('会话 3')
  })

  it('shows the six newest weeks first until explicitly expanded', () => {
    const rows = Array.from({ length: 9 }, (_, index) => week(index))
    const preview = visibleWeeks(rows, false)
    expect(preview).toHaveLength(6)
    expect(preview.map((row) => row.week_start)).toEqual([
      '2026-09-01', '2026-08-01', '2026-07-01', '2026-06-01', '2026-05-01', '2026-04-01',
    ])
    expect(visibleWeeks(rows, true).map((row) => row.week_start)).toEqual([
      '2026-09-01', '2026-08-01', '2026-07-01', '2026-06-01', '2026-05-01', '2026-04-01', '2026-03-01', '2026-02-01', '2026-01-01',
    ])
  })
})
