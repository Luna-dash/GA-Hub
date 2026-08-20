import type { TokenDayStats, TokenHistoryPoint, TokenThreadStats, TokenWeekStats } from '@/api/types'

export const TOP_SESSION_COUNT = 6
export const WEEK_PREVIEW_SIZE = 6

export type DailyUsageRange = 'week' | '30d'

export function compactTokens(value: number) {
  const number = Number.isFinite(value) ? value : 0
  const absolute = Math.abs(number)
  const units = [
    { threshold: 1_000_000_000, suffix: 'b' },
    { threshold: 1_000_000, suffix: 'm' },
    { threshold: 1_000, suffix: 'k' },
  ]
  const unit = units.find(({ threshold }) => absolute >= threshold)
  if (!unit) return Math.round(number).toLocaleString('en-US')
  const scaled = number / unit.threshold
  const digits = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2
  return `${Number(scaled.toFixed(digits))}${unit.suffix}`
}

export function dailyUsage(points: TokenHistoryPoint[]) {
  const ordered = [...points].sort((a, b) => a.timestamp - b.timestamp)
  const grouped = new Map<string, { input: number; output: number; cacheRead: number; total: number; requests: number }>()
  const increase = (current: number, previous: number) => current >= previous ? current - previous : current
  for (let index = 1; index < ordered.length; index += 1) {
    const current = ordered[index]
    const previous = ordered[index - 1]
    const date = new Date(current.timestamp * 1000).toLocaleDateString('sv-SE')
    const row = grouped.get(date) ?? { input: 0, output: 0, cacheRead: 0, total: 0, requests: 0 }
    row.input += increase(current.input, previous.input)
    row.output += increase(current.output, previous.output)
    row.cacheRead += increase(current.cache_read, previous.cache_read)
    row.total += increase(current.total, previous.total)
    row.requests += increase(current.requests, previous.requests)
    grouped.set(date, row)
  }
  return [...grouped.entries()].map(([date, value]) => ({ date, ...value })).sort((a, b) => a.date.localeCompare(b.date))
}

function parseDate(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day, 12)
}

function dateKey(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
}

const emptyDay = (date: string): TokenDayStats => ({
  date,
  requests: 0,
  input: 0,
  output: 0,
  cache_create: 0,
  cache_read: 0,
  total: 0,
  cache_hit_rate: 0,
})

export function usageRangeDays(
  rows: TokenDayStats[],
  range: DailyUsageRange,
  currentWeek: Pick<TokenWeekStats, 'week_start' | 'week_end'>,
  timestamp: number,
) {
  const byDate = new Map(rows.map(row => [row.date, row]))
  const end = range === 'week' ? parseDate(currentWeek.week_end) : new Date(timestamp * 1000)
  const start = range === 'week' ? parseDate(currentWeek.week_start) : new Date(end)
  if (range === '30d') start.setDate(end.getDate() - 29)

  const result: TokenDayStats[] = []
  const date = new Date(start)
  while (date <= end) {
    const key = dateKey(date)
    result.push(byDate.get(key) ?? emptyDay(key))
    date.setDate(date.getDate() + 1)
  }
  return result
}

export function topSessions(rows: TokenThreadStats[], count = TOP_SESSION_COUNT) {
  return [...rows].sort((a, b) => b.total - a.total).slice(0, count)
}

export function sessionTitle(row: TokenThreadStats) {
  return row.title.trim() || '未命名会话'
}

export function visibleWeeks(rows: TokenWeekStats[], expanded: boolean) {
  const newestFirst = [...rows].sort((a, b) => b.week_start.localeCompare(a.week_start))
  return expanded ? newestFirst : newestFirst.slice(0, WEEK_PREVIEW_SIZE)
}
