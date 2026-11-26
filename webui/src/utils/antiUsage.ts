import type { AntiRunUsage } from '@/api/client'

export interface FormattedRunUsage {
  text: string
  title: string
}

function trimDecimal(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.?0+$/, '')
}

export function formatCompactTokens(rawValue: number): string {
  if (!Number.isFinite(rawValue) || rawValue <= 0) return '0'
  const value = Math.round(rawValue)
  if (value < 1_000) return String(value)
  if (value < 999_500) {
    if (value >= 100_000) return `${Math.round(value / 1_000)}k`
    return `${trimDecimal(value / 1_000, 1)}k`
  }
  if (value < 999_500_000) {
    if (value >= 100_000_000) return `${Math.round(value / 1_000_000)}M`
    if (value >= 10_000_000) return `${trimDecimal(value / 1_000_000, 1)}M`
    return `${trimDecimal(value / 1_000_000, 2)}M`
  }
  return `${trimDecimal(value / 1_000_000_000, value >= 10_000_000_000 ? 1 : 2)}B`
}

export function quotaWindowShortLabel(limit?: string | null): string | null {
  if (!limit) return null
  if (limit === 'Five Hour Limit Remaining' || /five\s*hour|\b5h\b/i.test(limit)) return '5h'
  if (limit === 'Weekly Limit Remaining' || /weekly/i.test(limit)) return '周'
  return null
}

export function quotaLimitDisplayLabel(limit: string): string {
  if (limit === 'Five Hour Limit Remaining') return '5 小时额度'
  if (limit === 'Weekly Limit Remaining' || limit.endsWith(' Weekly Limit')) return '每周额度'
  if (limit === 'Reported Quota') return '当前额度'
  return limit
}

const QUOTA_MODEL_RANK: Record<string, number> = {
  gemini: 0,
  'gemini argon': 1,
  'gemini carbon': 2,
  'claude & gpt (shared)': 3,
  claude: 4,
  gpt: 5,
}

export function sortQuotaRows<
  T extends { model: string; limit: string; remaining_pct: number; resets_at?: string | null },
>(rows: ReadonlyArray<T>): T[] {
  const deduped = new Map<string, T>()
  for (const row of rows) {
    const key = `${row.model}\0${row.limit}`
    if (!deduped.has(key)) deduped.set(key, row)
  }
  return [...deduped.values()].sort((a, b) => {
    const aModel = a.model.trim().toLowerCase()
    const bModel = b.model.trim().toLowerCase()
    const aRank = QUOTA_MODEL_RANK[aModel] ?? 6
    const bRank = QUOTA_MODEL_RANK[bModel] ?? 6
    if (aRank !== bRank) return aRank - bRank

    const aLimit = a.limit.trim().toLowerCase()
    const bLimit = b.limit.trim().toLowerCase()
    const winRank = (low: string) => (low.includes('5h') || low.includes('five hour') ? 0 : low.includes('weekly') ? 2 : 1)
    const aWin = winRank(aLimit)
    const bWin = winRank(bLimit)
    if (aWin !== bWin) return aWin - bWin

    const modelCmp = aModel.localeCompare(bModel)
    return modelCmp !== 0 ? modelCmp : aLimit.localeCompare(bLimit)
  })
}

/**
 * Pick the minimum remaining percentage for the 5-hour quota window from a profile usage snapshot.
 * Falls back to non-weekly rows (e.g. `Reported Quota`) when upstream only reports a single quota row,
 * and returns `null` when only weekly rows are present so weekly limits are never shown as 5h.
 */
export function fiveHourRemainingPct(
  usage?: { rows?: ReadonlyArray<{ limit?: string | null; remaining_pct?: number | null }> } | null,
): number | null {
  const rows = usage?.rows
  if (!rows?.length) return null
  const valid = rows.filter(
    (row): row is { limit?: string | null; remaining_pct: number } =>
      typeof row.remaining_pct === 'number' && Number.isFinite(row.remaining_pct),
  )
  if (!valid.length) return null
  const fiveHour = valid.filter(row => quotaWindowShortLabel(row.limit) === '5h')
  if (fiveHour.length) return Math.min(...fiveHour.map(row => row.remaining_pct))
  const nonWeekly = valid.filter(row => quotaWindowShortLabel(row.limit) !== '周')
  if (nonWeekly.length) return Math.min(...nonWeekly.map(row => row.remaining_pct))
  return null
}

export interface QuotaWindowReading {
  remaining_pct: number
  resets_at?: string | null
  model: string
  limit: string
}

export interface GeminiQuotaSummary {
  fiveHour: QuotaWindowReading | null
  weekly: QuotaWindowReading | null
}

export function formatQuotaPct(pct: number): string {
  const clamped = Math.max(0, Math.min(100, pct))
  return `${Number.isInteger(clamped) ? String(clamped) : clamped.toFixed(1).replace(/\.0$/, '')}%`
}

function pickLowestQuotaRow<
  T extends { model?: string | null; limit?: string | null; remaining_pct: number; resets_at?: string | null },
>(rows: ReadonlyArray<T>): QuotaWindowReading | null {
  if (!rows.length) return null
  const best = rows.reduce((min, row) => (row.remaining_pct < min.remaining_pct ? row : min), rows[0])
  return {
    remaining_pct: Math.max(0, Math.min(100, best.remaining_pct)),
    resets_at: best.resets_at ?? null,
    model: best.model ?? '',
    limit: best.limit ?? '',
  }
}

export function geminiQuotaSummary(
  usage?: {
    rows?: ReadonlyArray<{ model?: string | null; limit?: string | null; remaining_pct?: number | null; resets_at?: string | null }>
  } | null,
): GeminiQuotaSummary {
  const rows = usage?.rows
  if (!rows?.length) return { fiveHour: null, weekly: null }
  const valid = rows.filter(
    (row): row is { model?: string | null; limit?: string | null; remaining_pct: number; resets_at?: string | null } =>
      typeof row.remaining_pct === 'number' && Number.isFinite(row.remaining_pct),
  )
  if (!valid.length) return { fiveHour: null, weekly: null }
  const geminiRows = valid.filter(row => /gemini/i.test(row.model ?? ''))
  const pool = geminiRows.length ? geminiRows : valid
  const fiveHourRows = pool.filter(row => quotaWindowShortLabel(row.limit) === '5h')
  const nonWeeklyRows = pool.filter(row => quotaWindowShortLabel(row.limit) !== '周')
  const weeklyRows = pool.filter(row => quotaWindowShortLabel(row.limit) === '周')
  return {
    fiveHour: pickLowestQuotaRow(fiveHourRows.length ? fiveHourRows : nonWeeklyRows),
    weekly: pickLowestQuotaRow(weeklyRows),
  }
}

export function currentHourStartMs(nowMs = Date.now()): number {
  const d = new Date(nowMs)
  d.setMinutes(0, 0, 0)
  return d.getTime()
}

export function nextTopOfHourMs(nowMs = Date.now()): number {
  return currentHourStartMs(nowMs) + 3_600_000
}

export function isUsageStaleForHour(checkedAt?: string | null, nowMs = Date.now()): boolean {
  if (!checkedAt) return true
  const parsed = Date.parse(checkedAt)
  if (!Number.isFinite(parsed)) return true
  return parsed < currentHourStartMs(nowMs)
}

export function formatRunUsage(usage?: AntiRunUsage | null): FormattedRunUsage | null {
  if (!usage) return null
  const rawIn = Math.max(0, Math.round(usage.input_tokens ?? 0))
  const totalOut = Math.max(0, Math.round(usage.output_tokens ?? 0))
  const cached = Math.max(0, Math.round(usage.cache_read_tokens ?? 0))
  const cacheWrite = Math.max(0, Math.round(usage.cache_write_tokens ?? 0))
  const thinking = Math.max(0, Math.round(usage.thinking_tokens ?? 0))
  const modelCalls = Math.max(0, Math.round(usage.model_calls ?? 0))
  const generationMs = Math.max(0, Math.round(usage.generation_ms ?? 0))
  if (!rawIn && !totalOut && !thinking && !cached && !cacheWrite) return null

  const totalIn = (cached + cacheWrite) > rawIn ? rawIn + cached + cacheWrite : rawIn
  const freshIn = Math.max(0, totalIn - cached - cacheWrite)
  const hitPct = totalIn > 0 && cached > 0 ? Math.min(100, Math.round((cached / totalIn) * 100)) : 0
  const effectiveOut = Math.max(totalOut, thinking)
  const tokPerSec = generationMs >= 150 && effectiveOut > 0 ? effectiveOut / (generationMs / 1000) : null

  const parts = [
    `${formatCompactTokens(totalIn)} in`,
    `${formatCompactTokens(totalOut)} out`,
  ]
  if (thinking > 0) parts.push(`${formatCompactTokens(thinking)} think`)
  if (totalIn > 0 && cached > 0) parts.push(`缓存 ${hitPct}%`)
  if (modelCalls > 0) parts.push(`${modelCalls} 次调用`)
  if (tokPerSec !== null) parts.push(`${tokPerSec >= 100 ? Math.round(tokPerSec) : tokPerSec.toFixed(1)} tok/s`)

  const inBreakdown = [
    `新输入 ${freshIn.toLocaleString('en-US')}`,
    cached > 0 ? `缓存命中 ${cached.toLocaleString('en-US')}` : null,
    cacheWrite > 0 ? `缓存写入 ${cacheWrite.toLocaleString('en-US')}` : null,
  ].filter(Boolean).join(' + ')

  const titleParts = [
    `总输入 ${totalIn.toLocaleString('en-US')}${cached > 0 || cacheWrite > 0 ? `（${inBreakdown}）` : ''}`,
    `输出 ${totalOut.toLocaleString('en-US')}`,
    thinking > 0 ? `思考 ${thinking.toLocaleString('en-US')}` : null,
    totalIn > 0 && cached > 0 ? `缓存命中率 ${((cached / totalIn) * 100).toFixed(1)}%` : null,
    modelCalls > 0 ? `模型调用 ${modelCalls} 次` : null,
    tokPerSec !== null ? `生成速度 ${tokPerSec.toFixed(1)} tok/s（有效输出耗时 ${(generationMs / 1000).toFixed(1)}s）` : null,
  ].filter(Boolean)

  return {
    text: parts.join(' · '),
    title: titleParts.join(' · '),
  }
}

export type AgyAccountTier = 'ultra' | 'pro' | 'plus' | 'enterprise' | 'free'

export interface AccountTierPresentation {
  tier: AgyAccountTier
  shortLabel: string
  fullLabel: string
  glyph: string
  cardBadgeClass: string
  cardFrameAccentClass: string
  pillClass: string
}

const TIER_PRESENTATIONS: Record<AgyAccountTier, Omit<AccountTierPresentation, 'tier' | 'fullLabel'> & { defaultFullLabel: string }> = {
  ultra: {
    shortLabel: 'Ultra',
    defaultFullLabel: 'Google AI Ultra',
    glyph: '✦',
    cardBadgeClass:
      'border-[#B8892D]/65 bg-gradient-to-r from-[#2D2417] via-[#41321D] to-[#2B2216] text-[#F5D68A] shadow-[inset_0_1px_0_rgba(255,232,163,0.28)]',
    cardFrameAccentClass: 'border-[#B68934]/65 shadow-[0_2px_10px_rgba(168,121,36,0.12)]',
    pillClass: 'ga-account-pill--ultra',
  },
  pro: {
    shortLabel: 'Pro',
    defaultFullLabel: 'Google AI Pro',
    glyph: '◆',
    cardBadgeClass:
      'border-[#8C5B2B]/55 bg-gradient-to-r from-[#EFE3CE] to-[#E6D2B2] text-[#6B421A] shadow-[inset_0_1px_0_rgba(255,248,230,0.75)]',
    cardFrameAccentClass: 'border-[#966533]/55 shadow-[0_2px_8px_rgba(122,80,34,0.09)]',
    pillClass: 'ga-account-pill--pro',
  },
  plus: {
    shortLabel: 'Plus',
    defaultFullLabel: 'Google AI Plus',
    glyph: '◈',
    cardBadgeClass: 'border-[#4E7A65]/45 bg-[#DDE9E1] text-[#26523E]',
    cardFrameAccentClass: '',
    pillClass: 'ga-account-pill--plus',
  },
  enterprise: {
    shortLabel: 'Enterprise',
    defaultFullLabel: 'Enterprise',
    glyph: '',
    cardBadgeClass: 'border-[#4F6685]/45 bg-[#DFE6EE] text-[#283E59]',
    cardFrameAccentClass: '',
    pillClass: 'ga-account-pill--enterprise',
  },
  free: {
    shortLabel: 'Free',
    defaultFullLabel: 'Free',
    glyph: '',
    cardBadgeClass: 'border-line/70 bg-bg-soft/75 text-ink-muted',
    cardFrameAccentClass: '',
    pillClass: '',
  },
}

export function resolveAccountTier(
  tier?: string | null,
  tierName?: string | null,
): AccountTierPresentation | null {
  const key = (tier ?? '').trim().toLowerCase() as AgyAccountTier
  if (!key || !(key in TIER_PRESENTATIONS)) return null
  const spec = TIER_PRESENTATIONS[key]
  const cleanFull = (tierName ?? '').trim()
  return {
    tier: key,
    shortLabel: spec.shortLabel,
    fullLabel: cleanFull || spec.defaultFullLabel,
    glyph: spec.glyph,
    cardBadgeClass: spec.cardBadgeClass,
    cardFrameAccentClass: spec.cardFrameAccentClass,
    pillClass: spec.pillClass,
  }
}
