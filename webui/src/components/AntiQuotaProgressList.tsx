import clsx from 'clsx'
import { formatQuotaModelName, formatQuotaPct, quotaLimitDisplayLabel, quotaWindowShortLabel } from '@/utils/antiUsage'

export interface QuotaProgressRowData {
  model: string
  limit: string
  remaining_pct: number
  resets_at?: string | null
}

const quotaResetFormat = new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

export function formatQuotaTime(raw?: string | null): string | null {
  if (!raw) return null
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? quotaResetFormat.format(ms) : null
}

export function quotaTone(pct: number): string {
  if (pct >= 50) return 'text-status-success'
  if (pct >= 20) return 'text-status-warning'
  return 'text-status-danger'
}

export function quotaBarTone(pct: number): string {
  if (pct >= 50) return 'bg-status-success'
  if (pct >= 20) return 'bg-status-warning'
  return 'bg-status-danger'
}

export function AntiQuotaProgressList({
  rows,
  ariaPrefix,
  className,
}: {
  rows: ReadonlyArray<QuotaProgressRowData>
  ariaPrefix?: string
  className?: string
}) {
  return (
    <ul className={clsx('space-y-2', className)} data-anti-quota-bars>
      {rows.map((row) => {
        const pct = Math.max(0, Math.min(100, row.remaining_pct))
        const displayModel = formatQuotaModelName(row.model)
        const winTag = quotaWindowShortLabel(row.limit) ?? quotaLimitDisplayLabel(row.limit)
        const resetLabel = formatQuotaTime(row.resets_at)
        const ariaLabel = ariaPrefix
          ? `${ariaPrefix} ${displayModel} ${winTag} 额度`
          : `${displayModel} ${winTag} 额度`
        return (
          <li key={`${row.model}-${row.limit}`} className="space-y-1">
            <div className="flex items-center justify-between gap-2 text-[11px]">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="truncate font-medium text-ink" title={displayModel}>
                  {displayModel}
                </span>
                <span className="shrink-0 rounded bg-bg-soft px-1.5 py-0.5 text-[10px] leading-none text-ink-muted ring-1 ring-line/45">
                  {winTag}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-2 tabular-nums">
                {resetLabel ? (
                  <time dateTime={row.resets_at ?? undefined} className="whitespace-nowrap text-[10px] text-ink-muted">
                    {resetLabel} 重置
                  </time>
                ) : (
                  <span className="whitespace-nowrap text-[10px] text-ink-muted">满额未消耗</span>
                )}
                <span className={clsx('w-10 text-right font-semibold', quotaTone(pct))}>
                  {formatQuotaPct(pct)}
                </span>
              </div>
            </div>
            <div
              role="progressbar"
              aria-label={ariaLabel}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              className="h-1.5 w-full overflow-hidden rounded-full bg-bg-soft/90 ring-1 ring-line/45"
            >
              <div
                className={clsx('h-full rounded-full transition-[width] duration-300', quotaBarTone(pct))}
                style={{ width: `${pct}%` }}
              />
            </div>
          </li>
        )
      })}
    </ul>
  )
}
