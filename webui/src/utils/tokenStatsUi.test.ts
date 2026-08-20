import { describe, expect, it } from 'vitest'
import type { TokenDayStats, TokenThreadStats, TokenWeekStats } from '@/api/types'
import { compactTokens, dailyUsage, sessionTitle, topSessions, usageRangeDays, visibleWeeks } from './tokenStatsUi'

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
  title: name,
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

  it('keeps only the six sessions with the highest total usage', () => {
    const rows = Array.from({ length: 8 }, (_, index) => thread(`会话 ${index + 1}`, (index + 1) * 100))
    expect(topSessions(rows).map((item) => item.total)).toEqual([800, 700, 600, 500, 400, 300])
  })

  it('uses the persisted session title and handles an empty title', () => {
    expect(sessionTitle(thread('需求分析', 100))).toBe('需求分析')
    expect(sessionTitle({ ...thread('ignored', 100), title: '   ' })).toBe('未命名会话')
  })

  it('uses the exact natural-week boundaries returned by the server', () => {
    const rows: TokenDayStats[] = [
      { date: '2026-07-13', requests: 1, input: 10, output: 2, cache_create: 0, cache_read: 3, total: 15, cache_hit_rate: 20 },
      { date: '2026-07-15', requests: 2, input: 20, output: 4, cache_create: 0, cache_read: 6, total: 30, cache_hit_rate: 20 },
      { date: '2026-07-20', requests: 3, input: 30, output: 6, cache_create: 0, cache_read: 9, total: 45, cache_hit_rate: 20 },
    ]
    const currentWeek = { week_start: '2026-07-13', week_end: '2026-07-19' }
    const shown = usageRangeDays(rows, 'week', currentWeek, new Date(2026, 6, 15, 12).getTime() / 1000)
    expect(shown).toHaveLength(7)
    expect(shown.map(row => row.date)).toEqual([
      '2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17', '2026-07-18', '2026-07-19',
    ])
    expect(shown.reduce((sum, row) => sum + row.total, 0)).toBe(45)
  })

  it('builds a rolling 30-day range ending at the response timestamp', () => {
    const end = new Date(2026, 6, 15, 12)
    const shown = usageRangeDays([], '30d', { week_start: '2026-07-13', week_end: '2026-07-19' }, end.getTime() / 1000)
    expect(shown).toHaveLength(30)
    expect(shown[0].date).toBe('2026-06-16')
    expect(shown.at(-1)?.date).toBe('2026-07-15')
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
