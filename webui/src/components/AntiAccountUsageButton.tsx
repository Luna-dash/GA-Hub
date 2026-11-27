import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronUp, Gauge, LoaderCircle, RefreshCw } from 'lucide-react'
import clsx from 'clsx'
import { Z_LAYERS } from '@/config/zLayers'
import { useOverlayRegistration } from '@/hooks/useOverlayRegistration'
import { hasHigherLayerOverlay } from '@/utils/overlayStack'
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
  formatEstimatedUsd,
  sortQuotaRows,
} from '@/utils/antiUsage'
import { AntiQuotaProgressList, formatQuotaTime } from './AntiQuotaProgressList'

const HOVER_CLOSE_DELAY_MS = 150

async function checkUsage(profileId?: string): Promise<AntiAccountUsage> {
  try {
    return await antiApi.accountUsage(profileId)
  } catch (error) {
    if (error instanceof HttpTimeoutError) {
      throw new Error('检测官方额度超时，请检查网络或代理设置后重试。')
    }
    if (error instanceof HttpError) {
      if (error.status === 404 || error.status === 405) {
        throw new Error('当前 Gyra 后端版本不支持额度检测，请更新后端后重试。')
      }
      if (error.status === 403) {
        throw new Error('当前页面无权发起额度检测，请从 Gyra 页面重试。')
      }
      const detail = typeof error.body?.detail === 'string' ? error.body.detail : error.message
      throw new Error(detail || '检测失败，请重试。')
    }
    throw error
  }
}

export function AntiAccountUsageButton({
  running,
  profileId,
  profileName,
  cachedUsage,
  onChecked,
}: {
  running: boolean
  profileId?: string
  profileName?: string
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
  const usageMutateRef = useRef(usage.mutate)
  usageMutateRef.current = usage.mutate
  const cachedCheckedAtMs = cachedUsage?.checked_at ? Date.parse(cachedUsage.checked_at) : NaN

  const triggerUsageRefresh = useCallback(() => {
    usageMutateRef.current()
  }, [])
  const [pinned, setPinned] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [showBreakdown, setShowBreakdown] = useState(false)
  const open = pinned || hovered
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
  useOverlayRegistration({
    active: open,
    zIndex: Z_LAYERS.popover,
    getPanel: () => panel.current,
    onEscape: () => {
      const focusInside = Boolean(
        button.current?.contains(document.activeElement)
        || panel.current?.contains(document.activeElement),
      )
      cancelHoverClose()
      setPinned(false)
      setHovered(false)
      if (focusInside) button.current?.focus()
    },
    trapFocus: false,
  })
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
      if (hasHigherLayerOverlay(Z_LAYERS.popover)) return
      if (event.target instanceof Node && !button.current?.contains(event.target) && !panel.current?.contains(event.target)) {
        cancelHoverClose()
        setPinned(false)
        setHovered(false)
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
  const checkedTimeText = formatQuotaTime(displayCheckedAt)
  const statusLine = !checkedTimeText
    ? null
    : !running
      ? `缓存 ${checkedTimeText}`
      : useLiveSnapshot
        ? `更新于 ${checkedTimeText}`
        : `缓存 ${checkedTimeText}`
  const coolingPools = (pools.data ?? []).filter(
    p => p.status === 'cooling_down' || (p.cooldown_remaining_seconds ?? 0) > 0,
  )
  const message = !running ? '请先启用 Agy 运行时。'
    : usage.isPending ? '正在检测额度…'
      : usage.isError ? usage.error.message
        : usage.data?.detail ? usage.data.detail
          : usage.data?.state === 'login_required' ? '请先登录 agy 后再检测。'
            : usage.data ? '未能读取剩余额度，请重试。'
              : '点击刷新查询剩余额度。'
  const Icon = usage.isPending ? LoaderCircle : Gauge
  const byModelItems = stats.data?.by_model ?? []

  return (
    <div className="relative inline-flex">
      <button
        ref={button}
        type="button"
        aria-label="检测反重力额度"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        className={clsx('ga-btn-icon h-[35px] w-[35px] rounded-[9px]',
          rows?.length ? 'text-ink' : 'text-ink-muted')}
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
          className="fixed w-[min(21rem,calc(100vw-16px))] pt-2"
          style={{ top: position.top, left: position.left, zIndex: Z_LAYERS.popover }}
          onMouseEnter={handlePointerEnter}
          onMouseLeave={handlePointerLeave}
        >
          <div id={popoverId} tabIndex={-1} role="dialog" aria-label="反重力剩余额度" className="ga-paper-popover overflow-y-auto overscroll-contain rounded-xl p-3 text-xs text-ink" style={{ maxHeight: position.maxHeight }}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className="shrink-0 font-semibold text-ink">剩余额度</span>
                {statusLine && (
                  <span data-anti-usage-status className="min-w-0 truncate text-[11px] tabular-nums text-ink-muted" title={statusLine}>
                    {statusLine}
                  </span>
                )}
              </div>
              {running && (
                <button
                  type="button"
                  className="ga-btn-link w-[4.25rem] shrink-0 justify-end whitespace-nowrap px-1 py-0 text-[11px]"
                  aria-label="刷新反重力额度"
                  title="刷新剩余额度"
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
            {rows?.length ? (
              <AntiQuotaProgressList
                rows={rows}
                ariaPrefix={profileName || '剩余额度'}
                className="mt-2.5"
              />
            ) : <p className="mt-2 text-ink-muted">{message}</p>}
            {running && usage.isError && rows && rows.length > 0 && (
              <p className="mt-1.5 text-[11px] text-status-danger">{usage.error.message}</p>
            )}
            {running && !usage.isError && usage.data && !usage.data.rows.length && usage.data.detail && rows && rows.length > 0 && (
              <p className="mt-1.5 text-[11px] text-status-danger">{usage.data.detail}</p>
            )}
            {running && (coolingPools.length > 0 || resetBreaker.isError || stats.data) && (
              <div className="mt-2.5 space-y-1.5 border-t border-line/65 pt-2">
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
                  <div className="space-y-1 text-[11px] tabular-nums text-ink-muted">
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate">
                        今日对话 {stats.data.total_runs} (成功 {stats.data.success_runs})
                        {(stats.data.model_calls ?? 0) > 0 ? ` · 调用 ${stats.data.model_calls}` : ''}
                      </span>
                      {byModelItems.length > 0 && (
                        <button
                          type="button"
                          data-anti-usage-breakdown-toggle
                          aria-expanded={showBreakdown}
                          onClick={() => setShowBreakdown(v => !v)}
                          className="ga-btn-link inline-flex shrink-0 items-center gap-0.5 px-1 py-0 text-[11px] text-ink-muted hover:text-ink"
                        >
                          <span>明细</span>
                          {showBreakdown
                            ? <ChevronUp size={12} aria-hidden="true" />
                            : <ChevronDown size={12} aria-hidden="true" />}
                        </button>
                      )}
                    </div>
                    <div title={`${stats.data.total_tokens.toLocaleString('en-US')} tokens`}>
                      {formatCompactTokens(stats.data.total_tokens)} tok
                      {(stats.data.tokens_per_sec ?? 0) > 0
                        ? ` · ${stats.data.tokens_per_sec! >= 100 ? Math.round(stats.data.tokens_per_sec!) : stats.data.tokens_per_sec!.toFixed(1)} tok/s`
                        : ''}
                      {' · '}缓存 {Math.min(100, Math.round(stats.data.cache_hit_ratio * 100))}%
                      {stats.data.estimated_cost_usd > 0 ? ` · ~${formatEstimatedUsd(stats.data.estimated_cost_usd)}` : ''}
                    </div>
                  </div>
                )}
                {showBreakdown && byModelItems.length > 0 && (
                  <div
                    data-anti-usage-by-model
                    className="mt-1.5 space-y-1 border-t border-line/45 pt-1.5 text-[10px]"
                  >
                    {byModelItems.map((item) => {
                      const totalTok = item.input_tokens + Math.max(item.output_tokens, item.thinking_tokens)
                      return (
                        <div
                          key={item.model}
                          className="flex items-center justify-between gap-2 tabular-nums text-ink-secondary"
                        >
                          <span className="truncate">{item.display_name || item.model}</span>
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
