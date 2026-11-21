import { useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation } from '@tanstack/react-query'
import { Gauge, LoaderCircle } from 'lucide-react'
import clsx from 'clsx'
import type { components } from '@/api/generated/schema'
import { antiApi, type AgyProfileUsageSnapshot, type AntiQuotaPool } from '@/api/client'
import { resolveApiUrl } from '@/runtime/runtimeConfig'

type Usage = components['schemas']['AntiAccountUsage']

async function checkUsage(): Promise<Usage> {
  const response = await fetch(resolveApiUrl('/api/anti/account-usage'), {
    method: 'POST',
    headers: { 'X-GA-Hub-Action': 'check-anti-usage' },
  })
  if (!response.ok) {
    if (response.status === 404 || response.status === 405) {
      throw new Error('当前 GA-Hub 后端版本不支持额度检测，请更新后端后重试。')
    }
    if (response.status === 403) throw new Error('当前页面无权发起额度检测，请从 GA-Hub 页面重试。')
    const report = await response.json().catch(() => null)
    throw new Error(typeof report?.detail === 'string' ? report.detail : '检测失败，请重试。')
  }
  return response.json()
}

const resetFormat = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

function limitLabel(limit: string) {
  if (limit === 'Weekly Limit Remaining') return '每周额度'
  if (limit === 'Five Hour Limit Remaining') return '5 小时额度'
  if (limit.endsWith(' Weekly Limit')) return '每周额度'
  return limit
}

function poolStatusView(pool: AntiQuotaPool) {
  if (pool.status === 'cooling_down' || (pool.cooldown_remaining_seconds ?? 0) > 0) {
    return {
      cooling: true,
      label: `冷却 ${pool.cooldown_remaining_seconds ?? 0}s`,
      tone: 'text-status-danger',
    }
  }
  if (pool.status === 'HARD_LIMIT') {
    return { cooling: true, label: '已达上限', tone: 'text-status-danger' }
  }
  if (pool.status === 'WARN') {
    return { cooling: false, label: '接近上限', tone: 'text-status-warning' }
  }
  return { cooling: false, label: '正常', tone: 'text-ink' }
}

export function AntiAccountUsageButton({
  running,
  cachedUsage,
  onChecked,
}: {
  running: boolean
  cachedUsage?: AgyProfileUsageSnapshot | null
  onChecked: () => void
}) {
  const usage = useMutation({ mutationFn: checkUsage, onSettled: onChecked })
  const pools = useMutation({ mutationFn: () => antiApi.quota() })
  const stats = useMutation({ mutationFn: () => antiApi.stats(24) })
  const resetBreaker = useMutation({
    mutationFn: (modelGroup?: string) => antiApi.resetBreaker(modelGroup),
    onSuccess: () => { pools.mutate() },
  })
  const calibrate = useMutation({
    mutationFn: ({ modelGroup, remainingPct, note }: { modelGroup: string; remainingPct: number; note?: string }) =>
      antiApi.calibrateQuota(modelGroup, remainingPct, note),
    onSuccess: updated => {
      pools.reset()
      pools.mutate()
      setCalibrating(null)
      if (updated) {
        setCalibratePct(String(updated.calibrated_remaining_pct ?? ''))
      }
    },
  })
  const [calibrating, setCalibrating] = useState<string | null>(null)
  const [calibratePct, setCalibratePct] = useState('100')
  const [calibrateNote, setCalibrateNote] = useState('')
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const tooltipId = useId()
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [tapped, setTapped] = useState(false)
  const [position, setPosition] = useState<{ top: number; left: number; maxHeight: number }>()
  const open = (hovered || focused || tapped) && !dismissed
  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const anchor = button.current?.getBoundingClientRect()
      if (!anchor) return
      const width = Math.min(312, window.innerWidth - 16)
      setPosition({ top: anchor.bottom, left: Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8)),
        maxHeight: Math.max(0, window.innerHeight - anchor.bottom - 16) })
    }
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !button.current?.contains(event.target) && !panel.current?.contains(event.target)) {
        setTapped(false)
      }
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    document.addEventListener('pointerdown', outside)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      document.removeEventListener('pointerdown', outside)
    }
  }, [open])
  const liveRows = usage.data?.rows
  const fallbackRows = !usage.data && !usage.isError ? cachedUsage?.rows : undefined
  const rows = running ? (liveRows ?? fallbackRows) : fallbackRows
  const poolRows = pools.data
  const coolingPools = poolRows?.filter(p => poolStatusView(p).cooling) ?? []
  const message = !running ? '请先启用 Agy 运行时。'
    : usage.isPending ? '正在检测官方额度…'
    : usage.isError ? usage.error.message
    : usage.data?.state === 'login_required' ? '请先登录 agy，再重新检测。'
    : usage.data ? '未能读取官方额度，请重试。'
    : '点击检测官方剩余额度。'
  const Icon = usage.isPending ? LoaderCircle : Gauge

  return (
    <div
      className="relative inline-flex"
      onMouseEnter={() => { setHovered(true); setDismissed(false) }}
      onMouseLeave={() => { setHovered(false); setTapped(false) }}
    >
      <button
        ref={button}
        type="button"
        aria-label="检测反重力额度"
        aria-describedby={open ? tooltipId : undefined}
        aria-disabled={!running || usage.isPending}
        className={clsx('inline-flex size-8 items-center justify-center rounded-lg border focus-visible:outline focus-visible:outline-2',
          rows?.length ? 'border-line bg-bg-card text-ink' : 'border-line bg-bg-card text-ink-muted',
          running && !usage.isPending ? 'hover:bg-bg-soft' : 'cursor-default opacity-65')}
        onFocus={event => { setFocused(event.currentTarget.matches(':focus-visible')); setDismissed(false) }}
        onBlur={() => setFocused(false)}
        onKeyDown={event => { if (event.key === 'Escape') { setTapped(false); setDismissed(true) } }}
        onClick={() => {
          if (!hovered && !focused) setTapped(true)
          setDismissed(false)
          if (running && !usage.isPending) usage.mutate()
        }}
      >
        <Icon size={16} aria-hidden="true" className={clsx(usage.isPending && 'motion-safe:animate-spin')} />
      </button>
      {open && position && createPortal(
        <div ref={panel} className="fixed z-[60] w-[min(19.5rem,calc(100vw-16px))] pt-2" style={{ top: position.top, left: position.left }}>
          <div id={tooltipId} role="tooltip" className="overflow-y-auto overscroll-contain rounded-xl border border-line bg-bg-card p-3 text-xs text-ink shadow-lg" style={{ maxHeight: position.maxHeight }}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold">反重力剩余额度</span>
              {!liveRows && fallbackRows?.length && cachedUsage?.checked_at ? (
                <span className="text-[11px] text-ink-muted tabular-nums">
                  {running ? '缓存' : '离线缓存'} · {resetFormat.format(new Date(cachedUsage.checked_at))}
                </span>
              ) : null}
            </div>
            {rows?.length ? (
              <ul className="mt-1 divide-y divide-line">
                {rows.map(row => (
                  <li key={`${row.model}-${row.limit}`} className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 py-1.5">
                    <span className="min-w-0 break-words font-medium">{row.model}</span>
                    <span className="text-right font-semibold tabular-nums">{row.remaining_pct}%</span>
                    <span className="text-ink-muted">{limitLabel(row.limit)}</span>
                    <time dateTime={row.resets_at} className="text-right text-ink-muted tabular-nums">{resetFormat.format(new Date(row.resets_at))} 重置</time>
                  </li>
                ))}
              </ul>
            ) : <p className="mt-1 text-ink-muted">{message}</p>}
            {!running && rows?.length && (
              <p className="mt-1 text-[11px] text-ink-muted">Agy 运行时已停止；启用后点击图标即可刷新实时额度。</p>
            )}
            {running && (
              <div className="mt-2 border-t border-line/70 pt-2 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    className="text-accent hover:underline"
                    disabled={pools.isPending}
                    onClick={() => {
                      pools.mutate()
                      stats.mutate()
                    }}
                  >
                    {pools.isPending ? '正在查询本地配额池…' : '查看本地配额池 / 熔断'}
                  </button>
                  {coolingPools.length > 0 && (
                    <button
                      type="button"
                      className="text-status-danger hover:underline"
                      disabled={resetBreaker.isPending}
                      onClick={() => resetBreaker.mutate(undefined)}
                    >
                      {resetBreaker.isPending ? '重置中…' : '重置熔断'}
                    </button>
                  )}
                </div>
                {pools.isError && <p className="text-status-danger">{pools.error.message}</p>}
                {resetBreaker.isError && <p className="text-status-danger">{resetBreaker.error.message}</p>}
                {calibrate.isError && <p className="text-status-danger">{calibrate.error.message}</p>}
                {poolRows && poolRows.length > 0 && (
                  <ul className="space-y-1.5 text-[11px] text-ink-muted">
                    {poolRows.map(pool => {
                      const view = poolStatusView(pool)
                      const isCalibrating = calibrating === pool.model_group
                      return (
                        <li key={pool.model_group} className="space-y-1 rounded-md bg-bg-soft/70 px-2 py-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate font-medium text-ink">{pool.display_name}</span>
                            <div className="flex shrink-0 items-center gap-1.5">
                              <span className={clsx('tabular-nums font-medium', view.tone)}>
                                {view.label}
                              </span>
                              <button
                                type="button"
                                className="text-[10px] text-accent hover:underline"
                                aria-label={`校准 ${pool.display_name}`}
                                onClick={() => {
                                  if (isCalibrating) {
                                    setCalibrating(null)
                                  } else {
                                    setCalibrating(pool.model_group)
                                    setCalibratePct(String(pool.calibrated_remaining_pct ?? 100))
                                    setCalibrateNote('')
                                  }
                                }}
                              >
                                {isCalibrating ? '取消' : '校准'}
                              </button>
                              {view.cooling && (
                                <button
                                  type="button"
                                  className="text-[10px] text-accent hover:underline disabled:opacity-40"
                                  disabled={resetBreaker.isPending}
                                  aria-label={`重置 ${pool.display_name} 熔断`}
                                  onClick={() => resetBreaker.mutate(pool.model_group)}
                                >
                                  重置
                                </button>
                              )}
                            </div>
                          </div>
                          {(pool.window_5h_pct != null || pool.window_7d_pct != null) && (
                            <div className="flex items-center justify-between gap-2 text-[10px] tabular-nums">
                              <span>5h 窗口 {pool.window_5h_pct != null ? `${pool.window_5h_pct.toFixed(0)}%` : '—'}</span>
                              <span>7d 窗口 {pool.window_7d_pct != null ? `${pool.window_7d_pct.toFixed(0)}%` : '—'}</span>
                            </div>
                          )}
                          {(pool.calibrated_remaining_pct != null || (pool.estimated_cost_7d_usd ?? 0) > 0) && (
                            <div className="flex items-center justify-between gap-2 text-[10px] tabular-nums">
                              <span>{pool.calibrated_remaining_pct != null ? `已校准剩余 ${pool.calibrated_remaining_pct}%` : ''}</span>
                              {(pool.estimated_cost_7d_usd ?? 0) > 0 && <span>7d ~${pool.estimated_cost_7d_usd!.toFixed(2)}</span>}
                            </div>
                          )}
                          {isCalibrating && (
                            <form
                              className="flex flex-wrap items-center gap-1 pt-1"
                              onSubmit={e => {
                                e.preventDefault()
                                const pct = Number(calibratePct)
                                if (!Number.isFinite(pct) || pct < 0 || pct > 100) return
                                calibrate.mutate({ modelGroup: pool.model_group, remainingPct: pct, note: calibrateNote.trim() || undefined })
                              }}
                            >
                              <input
                                type="number"
                                min={0}
                                max={100}
                                step="1"
                                value={calibratePct}
                                onChange={e => setCalibratePct(e.target.value)}
                                aria-label={`${pool.display_name} 剩余百分比`}
                                className="w-14 rounded border border-line bg-bg-card px-1.5 py-0.5 text-[11px] text-ink"
                              />
                              <span className="text-[10px]">%</span>
                              <input
                                type="text"
                                value={calibrateNote}
                                onChange={e => setCalibrateNote(e.target.value)}
                                placeholder="备注"
                                aria-label="校准备注"
                                className="min-w-0 flex-1 rounded border border-line bg-bg-card px-1.5 py-0.5 text-[11px] text-ink"
                              />
                              <button
                                type="submit"
                                className="rounded bg-accent px-1.5 py-0.5 text-[10px] font-medium text-white disabled:opacity-50"
                                disabled={calibrate.isPending}
                              >
                                {calibrate.isPending ? '保存中' : '保存'}
                              </button>
                            </form>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                )}
                {stats.data && (
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 border-t border-line/50 pt-1.5 text-[10px] text-ink-muted tabular-nums">
                    <span>24h {stats.data.total_runs} 次（成功 {stats.data.success_runs}）</span>
                    <span>
                      {stats.data.total_tokens.toLocaleString('en-US')} tok · 缓存 {(stats.data.cache_hit_ratio * 100).toFixed(0)}%
                      {stats.data.estimated_cost_usd > 0 ? ` · ~$${stats.data.estimated_cost_usd.toFixed(2)}` : ''}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>, document.body,
      )}
      <span role="status" className="sr-only">{rows?.length ? `已检测到 ${rows.length} 项额度` : message}</span>
    </div>
  )
}
