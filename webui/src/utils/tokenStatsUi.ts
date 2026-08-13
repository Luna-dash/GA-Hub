import type { TokenHistoryPoint, TokenThreadStats, TokenWeekStats } from '@/api/types'

export const SESSION_PAGE_SIZE = 8
export const WEEK_PREVIEW_SIZE = 6

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

export function readableThreadName(thread: string, index: number) {
  const cleaned = thread
    .replace(/^thread[-_: ]*/i, '')
    .replace(/^session[-_: ]*/i, '')
    .replace(/[_-]+/g, ' ')
    .trim()
  if (!cleaned || /^[0-9a-f]{16,}$/i.test(cleaned)) return `会话 ${index + 1}`
  return cleaned.length > 42 ? `${cleaned.slice(0, 39)}…` : cleaned
}

export function filterThreads(rows: TokenThreadStats[], query: string) {
  const needle = query.trim().toLocaleLowerCase()
  const sorted = [...rows].sort((a, b) => b.total - a.total)
  return needle ? sorted.filter((row, index) => `${readableThreadName(row.thread, index)} ${row.thread}`.toLocaleLowerCase().includes(needle)) : sorted
}

export function pageItems<T>(rows: T[], page: number, pageSize = SESSION_PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(rows.length / pageSize))
  const safePage = Math.min(Math.max(1, page), pages)
  return { items: rows.slice((safePage - 1) * pageSize, safePage * pageSize), page: safePage, pages }
}

export function visibleWeeks(rows: TokenWeekStats[], expanded: boolean) {
  const newestFirst = [...rows].sort((a, b) => b.week_start.localeCompare(a.week_start))
  return expanded ? newestFirst : newestFirst.slice(0, WEEK_PREVIEW_SIZE)
}
