import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Gauge, LoaderCircle, RefreshCw } from 'lucide-react'
import clsx from 'clsx'
import { Z_LAYERS } from '@/config/zLayers'
import {
  antiApi,
  HttpError,
  HttpTimeoutError,
  type AgyProfiles,
  type AgyProfileUsageSnapshot,
  type AntiAccountUsage,
} from '@/api/client'
import {
  formatCompactTokens,
  formatQuotaPct,
  formatEstimatedUsd,
  modelRoleLabel,
  quotaLimitDisplayLabel,
  sortQuotaRows,
} from '@/utils/antiUsage'

export const AUTO_USAGE_REFRESH_INTERVAL_MS = 10 * 60 * 1000
const DWELL_TICK_MAX_MS = 60 * 1000
const DWELL_CLAMP_SLACK_MS = 5 * 1000
const HOVER_CLOSE_DELAY_MS = 150

interface UsageDwellState {
  elapsedMs: number
  lastTriggeredMs: number
}

const usageDwellByKey = new Map<string, UsageDwellState>()

export function resetAntiUsageAutoRefreshForTests() {
  usageDwellByKey.clear()
}

function getDwellState(key: string): UsageDwellState {
  let entry = usageDwellByKey.get(key)
  if (!entry) {
    entry = { elapsedMs: 0, lastTriggeredMs: 0 }
    usageDwellByKey.set(key, entry)
  }
  return entry
}

async function checkUsage(profileId?: string): Promise<AntiAccountUsage> {
  try {
    return await antiApi.accountUsage(profileId)
  } catch (error) {
    if (error instanceof HttpTimeoutError) {
      throw new Error('检测官方额度超时，请检查网络或代理设置后重试。')
    }
    if (error instanceof HttpError) {
      if (error.status === 404 || error.status === 405) {
        throw new Error('当前 GA-Hub 后端版本不支持额度检测，请更新后端后重试。')
      }
      if (error.status === 403) {
        throw new Error('当前页面无权发起额度检测，请从 GA-Hub 页面重试。')
      }
      const detail = typeof error.body?.detail === 'string' ? error.body.detail : error.message
      throw new Error(detail || '检测失败，请重试。')
    }
    throw error
  }
}

const resetFormat = new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric', day: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})

function formatReset(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '时间未知' : resetFormat.format(date)
}

export function AntiAccountUsageButton({
  running,
  profileId,
  profileName,
  autoRefreshKey,
  cachedUsage,
  onChecked,
}: {
  running: boolean
  profileId?: string
  profileName?: string
  autoRefreshKey?: string
  cachedUsage?: AgyProfileUsageSnapshot | null
  onChecked: () => void
}) {
  const qc = useQueryClient()
  const [liveSnapshot, setLiveSnapshot] = useState<{
    rows: AntiAccountUsage['rows']
    checkedAt: string
    checkedAtMs: number
  } | null>(null)
  const usage = useMutation({
    mutationFn: () => checkUsage(profileId),
    onSuccess: data => {
      if (!data.rows.length) return
      const sortedRows = sortQuotaRows(data.rows)
      const nowMs = Date.now()
      const nowIso = new Date(nowMs).toISOString()
      setLiveSnapshot({ rows: sortedRows, checkedAt: nowIso, checkedAtMs: nowMs })
      const pcts = sortedRows
        .map(row => row.remaining_pct)
        .filter((pct): pct is number => typeof pct === 'number' && Number.isFinite(pct))
      qc.setQueryData<AgyProfiles>(['agy-profiles'], old => {
        if (!old) return old
        const targetId = profileId ?? old.active
        return {
          ...old,
          profiles: old.profiles.map(p => (p.id !== targetId ? p : {
            ...p,
            auth_state: 'authenticated',
            ...(data.account_tier ? { account_tier: data.account_tier } : {}),
            ...(data.account_tier_name ? { account_tier_name: data.account_tier_name } : {}),
            usage: {
              checked_at: nowIso,
              min_remaining_pct: pcts.length ? Math.min(...pcts) : null,
              rows: sortedRows,
            },
          })),
        }
      })
    },
    onSettled: onChecked,
  })
  const dwellKey = autoRefreshKey ?? profileId ?? '__active__'
  const usageMutateRef = useRef(usage.mutate)
  usageMutateRef.current = usage.mutate
  const usagePendingRef = useRef(usage.isPending)
  usagePendingRef.current = usage.isPending
  const cachedCheckedAtMs = cachedUsage?.checked_at ? Date.parse(cachedUsage.checked_at) : NaN
  const cachedCheckedAtRef = useRef(Number.isFinite(cachedCheckedAtMs) ? cachedCheckedAtMs : 0)
  cachedCheckedAtRef.current = Number.isFinite(cachedCheckedAtMs) ? cachedCheckedAtMs : 0
  const [autoTimerEpoch, setAutoTimerEpoch] = useState(0)

  const triggerUsageRefresh = useCallback(() => {
    const state = getDwellState(dwellKey)
    state.elapsedMs = 0
    state.lastTriggeredMs = Date.now()
    setAutoTimerEpoch(n => n + 1)
    usageMutateRef.current()
  }, [dwellKey])

  useEffect(() => {
    if (!running || typeof document === 'undefined') return
    const state = getDwellState(dwellKey)
    let timer: number | undefined
    let segmentStart: number | null = document.visibilityState === 'visible' ? Date.now() : null

    const commitSegment = () => {
      if (segmentStart === null) return
      const rawDelta = Math.max(0, Date.now() - segmentStart)
      // Cap per-segment delta so OS sleep or background throttling never counts as active dwell.
      state.elapsedMs = Math.min(
        AUTO_USAGE_REFRESH_INTERVAL_MS,
        state.elapsedMs + Math.min(rawDelta, DWELL_TICK_MAX_MS + DWELL_CLAMP_SLACK_MS),
      )
      segmentStart = Date.now()
    }

    const scheduleNext = () => {
      if (timer !== undefined) {
        window.clearTimeout(timer)
        timer = undefined
      }
      if (document.visibilityState !== 'visible') {
        segmentStart = null
        return
      }
      if (segmentStart === null) segmentStart = Date.now()
      const remainingDwell = Math.max(1_000, AUTO_USAGE_REFRESH_INTERVAL_MS - state.elapsedMs)
      const waitMs = Math.min(DWELL_TICK_MAX_MS, remainingDwell)
      timer = window.setTimeout(() => {
        commitSegment()
        if (document.visibilityState !== 'visible') {
          segmentStart = null
          return
        }
        const now = Date.now()
        const latestCheck = Math.max(state.lastTriggeredMs, cachedCheckedAtRef.current)
        const sinceLastCheck = latestCheck > 0 ? now - latestCheck : AUTO_USAGE_REFRESH_INTERVAL_MS
        if (state.elapsedMs >= AUTO_USAGE_REFRESH_INTERVAL_MS && sinceLastCheck >= AUTO_USAGE_REFRESH_INTERVAL_MS) {
          if (!usagePendingRef.current) {
            state.elapsedMs = 0
            state.lastTriggeredMs = now
            usageMutateRef.current()
          } else {
            state.elapsedMs = AUTO_USAGE_REFRESH_INTERVAL_MS - 10_000
          }
        } else if (state.elapsedMs >= AUTO_USAGE_REFRESH_INTERVAL_MS && sinceLastCheck < AUTO_USAGE_REFRESH_INTERVAL_MS) {
          state.elapsedMs = Math.max(0, sinceLastCheck)
        }
        scheduleNext()
      }, waitMs)
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        commitSegment()
        segmentStart = null
        if (timer !== undefined) {
          window.clearTimeout(timer)
          timer = undefined
        }
      } else {
        segmentStart = Date.now()
        scheduleNext()
      }
    }

    scheduleNext()
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      commitSegment()
      if (timer !== undefined) window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [running, dwellKey, autoTimerEpoch])
  const [pinned, setPinned] = useState(false)
  const [hovered, setHovered] = useState(false)
  const open = pinned || hovered
  const hoveredRef = useRef(hovered)
  hoveredRef.current = hovered
  const hoverCloseTimerRef = useRef<number | null>(null)
  const cancelHoverClose = useCallback(() => {
    if (hoverCloseTimerRef.current !== null) {
      window.clearTimeout(hoverCloseTimerRef.current)
      hoverCloseTimerRef.current = null
    }
  }, [])
  const handlePointerEnter = useCallback(() => {
    cancelHoverClose()
    setHovered(true)
  }, [cancelHoverClose])
  const handlePointerLeave = useCallback(() => {
    cancelHoverClose()
    hoverCloseTimerRef.current = window.setTimeout(() => {
      hoverCloseTimerRef.current = null
      setHovered(false)
    }, HOVER_CLOSE_DELAY_MS)
  }, [cancelHoverClose])
  useEffect(() => cancelHoverClose, [cancelHoverClose])
  const pools = useQuery({
    queryKey: ['anti-quota', profileId ?? '__active__'],
    queryFn: ({ signal }) => antiApi.quota(signal, profileId),
    enabled: open && running,
    retry: false,
  })
  const stats = useQuery({
    queryKey: ['anti-stats', 'today', profileId ?? '__active__'],
    queryFn: ({ signal }) => antiApi.stats(24, signal, profileId, true),
    enabled: open && running,
    retry: false,
  })
  const resetBreaker = useMutation({
    mutationFn: (modelGroup?: string) => antiApi.resetBreaker(modelGroup, profileId),
    onSuccess: () => {
      void pools.refetch()
      onChecked()
    },
  })
  const popoverId = useId()
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number; maxHeight: number }>()
  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const anchor = button.current?.getBoundingClientRect()
      if (!anchor) return
      const width = Math.min(320, window.innerWidth - 16)
      setPosition({
        top: anchor.bottom,
        left: Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8)),
        maxHeight: Math.max(0, window.innerHeight - anchor.bottom - 16),
      })
    }
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !button.current?.contains(event.target) && !panel.current?.contains(event.target)) {
        cancelHoverClose()
        setPinned(false)
        setHovered(false)
      }
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const focusInside = Boolean(
        button.current?.contains(document.activeElement)
        || panel.current?.contains(document.activeElement),
      )
      if (!hoveredRef.current && !focusInside) return
      event.preventDefault()
      cancelHoverClose()
      setPinned(false)
      setHovered(false)
      if (focusInside) button.current?.focus()
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [open, cancelHoverClose])
  useLayoutEffect(() => {
    if (pinned && position && !panel.current?.contains(document.activeElement) && document.activeElement === button.current) {
      panel.current?.querySelector<HTMLElement>('[role=dialog]')?.focus()
    }
  }, [pinned, !!position])
  const cachedMs = Number.isFinite(cachedCheckedAtMs) ? cachedCheckedAtMs : 0
  const cachedRows = useMemo(
    () => (cachedUsage?.rows?.length ? sortQuotaRows(cachedUsage.rows) : undefined),
    [cachedUsage?.rows],
  )
  const useLiveSnapshot = Boolean(
    running
    && liveSnapshot
    && !(cachedMs > liveSnapshot.checkedAtMs + 5_000 && cachedRows?.length),
  )
  const rows = useLiveSnapshot ? liveSnapshot!.rows : cachedRows
  const displayCheckedAt = useLiveSnapshot ? liveSnapshot!.checkedAt : cachedUsage?.checked_at
  const statusLine = !running
    ? (cachedUsage?.checked_at ? `离线缓存 · ${formatReset(cachedUsage.checked_at)}` : null)
    : useLiveSnapshot && displayCheckedAt
      ? `更新于 ${formatReset(displayCheckedAt)}`
      : cachedRows?.length && cachedUsage?.checked_at
        ? `缓存 · ${formatReset(cachedUsage.checked_at)}`
        : null
  const coolingPools = (pools.data ?? []).filter(
    p => p.status === 'cooling_down' || (p.cooldown_remaining_seconds ?? 0) > 0,
  )
  const message = !running ? '请先启用 Agy 运行时。'
    : usage.isPending ? '正在检测官方额度…'
      : usage.isError ? usage.error.message
        : usage.data?.detail ? usage.data.detail
          : usage.data?.state === 'login_required' ? '请先登录 agy，再重新检测。'
            : usage.data ? '未能读取官方额度，请重试。'
              : '点击检测官方剩余额度。'
  const Icon = usage.isPending ? LoaderCircle : Gauge

  return (
    <div className="relative inline-flex">
      <button
        ref={button}
        type="button"
        aria-label="检测反重力额度"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        className={clsx('ga-btn-icon',
          rows?.length ? 'text-ink' : 'text-ink-muted',
          running && !usage.isPending ? '' : 'cursor-default opacity-65')}
        onMouseEnter={handlePointerEnter}
        onMouseLeave={handlePointerLeave}
        onClick={() => {
          cancelHoverClose()
          if (pinned) {
            setPinned(false)
            setHovered(false)
          } else {
            setPinned(true)
            if (running && !usage.isPending) triggerUsageRefresh()
            if (running && hovered) {
              void pools.refetch()
              void stats.refetch()
            }
          }
        }}
      >
        <Icon size={16} aria-hidden="true" className={clsx(usage.isPending && 'motion-safe:animate-spin')} />
      </button>
      {open && position && createPortal(
        <div
          ref={panel}
          className="fixed w-[min(20rem,calc(100vw-16px))] pt-2"
          style={{ top: position.top, left: position.left, zIndex: Z_LAYERS.tooltip }}
          onMouseEnter={handlePointerEnter}
          onMouseLeave={handlePointerLeave}
        >
          <div id={popoverId} tabIndex={-1} role="dialog" aria-label="反重力剩余额度" className="ga-paper-popover overflow-y-auto overscroll-contain rounded-xl p-3 text-xs text-ink" style={{ maxHeight: position.maxHeight }}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className="shrink-0 font-semibold">反重力剩余额度</span>
                {profileName && (
                  <span className="truncate rounded bg-bg-soft px-1.5 py-0.5 text-[10px] font-medium text-ink-muted" title={profileName}>
                    {profileName}
                  </span>
                )}
              </div>
              {running && (
                <button
                  type="button"
                  className="ga-btn-link w-[4.25rem] shrink-0 justify-end whitespace-nowrap px-1 py-0 text-[11px]"
                  aria-label="刷新反重力额度"
                  title="重新检测官方额度"
                  disabled={usage.isPending}
                  onClick={() => {
                    cancelHoverClose()
                    setPinned(true)
                    if (!usage.isPending) triggerUsageRefresh()
                    void pools.refetch()
                    void stats.refetch()
                  }}
                >
                  <RefreshCw size={12} aria-hidden="true" className={clsx(usage.isPending && 'motion-safe:animate-spin')} />
                  <span>{usage.isPending ? '检测中' : '刷新'}</span>
                </button>
              )}
            </div>
            {statusLine && (
              <div data-anti-usage-status className="mt-0.5 text-[11px] tabular-nums text-ink-muted">
                {statusLine}
              </div>
            )}
            {rows?.length ? (
              <ul className="mt-1 divide-y divide-line/45">
                {rows.map(row => (
                  <li key={`${row.model}-${row.limit}`} className="space-y-0.5 py-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 flex-1 truncate font-medium" title={row.model}>{row.model}</span>
                      <span className="w-12 shrink-0 text-right font-semibold tabular-nums">{formatQuotaPct(row.remaining_pct)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2 text-ink-muted">
                      <span className="min-w-0 truncate">{quotaLimitDisplayLabel(row.limit)}</span>
                      {row.resets_at ? (
                        <time dateTime={row.resets_at} className="shrink-0 whitespace-nowrap text-right tabular-nums">{formatReset(row.resets_at)} 重置</time>
                      ) : (
                        <span className="shrink-0 whitespace-nowrap text-right">满额未消耗</span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            ) : <p className="mt-1 text-ink-muted">{message}</p>}
            {running && usage.isError && rows && rows.length > 0 && (
              <p className="mt-1 text-[11px] text-status-danger">{usage.error.message}</p>
            )}
            {running && !usage.isError && usage.data && !usage.data.rows.length && usage.data.detail && rows && rows.length > 0 && (
              <p className="mt-1 text-[11px] text-status-danger">{usage.data.detail}</p>
            )}
            {!running && rows?.length && (
              <p className="mt-1 text-[11px] text-ink-muted">Agy 运行时已停止；启用后点击图标即可刷新实时额度。</p>
            )}
            {running && (coolingPools.length > 0 || resetBreaker.isError || stats.data) && (
              <div className="mt-2 space-y-1.5 border-t border-line/70 pt-2">
                {coolingPools.length > 0 && (
                  <div
                    data-anti-cooldown-alert
                    role="status"
                    className="flex items-center justify-between gap-2 rounded-lg border border-status-danger-line bg-status-danger-soft px-2.5 py-1.5 text-[11px] text-status-danger"
                  >
                    <span className="min-w-0">
                      触发 429 冷却（{coolingPools.map(p => `${p.display_name} ${p.cooldown_remaining_seconds ?? 0}s`).join('、')}）
                    </span>
                    <button
                      type="button"
                      className="ga-btn-link shrink-0 px-1 py-0 text-[11px] font-semibold text-status-danger hover:underline"
                      disabled={resetBreaker.isPending}
                      onClick={() => resetBreaker.mutate(undefined)}
                    >
                      {resetBreaker.isPending ? '解锁中…' : '提前解锁'}
                    </button>
                  </div>
                )}
                {resetBreaker.isError && <p className="text-[11px] text-status-danger">{resetBreaker.error.message}</p>}
                {stats.data && (
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-[11px] tabular-nums text-ink-muted">
                    <span>
                      今日 {stats.data.total_runs} 轮
                      {(stats.data.model_calls ?? 0) > 0 ? ` · ${stats.data.model_calls} 次调用` : ''}
                      （成功 {stats.data.success_runs}）
                    </span>
                    <span title={`${stats.data.total_tokens.toLocaleString('en-US')} tokens`}>
                      {formatCompactTokens(stats.data.total_tokens)} tok
                      {(stats.data.tokens_per_sec ?? 0) > 0
                        ? ` · ${stats.data.tokens_per_sec! >= 100 ? Math.round(stats.data.tokens_per_sec!) : stats.data.tokens_per_sec!.toFixed(1)} tok/s`
                        : ''}
                      {' · '}缓存 {Math.min(100, Math.round(stats.data.cache_hit_ratio * 100))}%
                      {stats.data.estimated_cost_usd > 0 ? ` · ~${formatEstimatedUsd(stats.data.estimated_cost_usd)}` : ''}
                    </span>
                  </div>
                )}
                {stats.data && (stats.data.by_model?.length ?? 0) > 0 && (
                  <div
                    data-anti-usage-by-model
                    className="mt-1.5 border-t border-border/50 pt-1.5 space-y-1 text-[10px]"
                  >
                    <div className="flex items-center justify-between text-ink-muted/80">
                      <span>分模型明细</span>
                      <span title="按官方公开 API 定价估算，实际计费以账号订阅额度为准">
                        按官方 API 价估算
                      </span>
                    </div>
                    {stats.data.by_model!.map((item) => {
                      const roles = (item.roles ?? []).filter((r) => r && r !== 'model' && r !== 'legacy')
                      const totalTok = item.input_tokens + Math.max(item.output_tokens, item.thinking_tokens)
                      return (
                        <div
                          key={item.model}
                          className="flex items-center justify-between gap-2 tabular-nums text-ink-secondary"
                        >
                          <span className="truncate">
                            {item.display_name || item.model}
                            {roles.length > 0 ? (
                              <span className="ml-1 text-ink-muted">
                                ({roles.map((r) => modelRoleLabel(r)).join('/')})
                              </span>
                            ) : null}
                          </span>
                          <span className="shrink-0 text-ink-muted">
                            {item.calls > 0 ? `${item.calls}次 · ` : ''}
                            {formatCompactTokens(totalTok)} tok
                            {item.estimated_cost_usd > 0 ? ` · ~${formatEstimatedUsd(item.estimated_cost_usd)}` : ''}
                          </span>
                        </div>
                      )
                    })}
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
