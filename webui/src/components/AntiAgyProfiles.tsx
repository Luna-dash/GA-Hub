import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Building2, Crown, Gem, RefreshCw, Sparkles, UserRound } from 'lucide-react'
import { ChevronDown, ChevronLeft, ChevronRight, RefreshIcon, Settings2, Trash2, X } from '@/components/ActionIcons'
import clsx from 'clsx'
import type { components } from '@/api/generated/schema'
import { antiApi, type AgyCodeLoginState } from '@/api/client'
import { ModalOverlay } from '@/components/ModalOverlay'
import { resolveApiUrl } from '@/runtime/runtimeConfig'
import {
  fiveHourRemainingPct,
  formatQuotaPct,
  geminiQuotaSummary,
  quotaWindowShortLabel,
  resolveAccountTier,
  sortQuotaRows,
  type AgyAccountTier,
  type QuotaWindowReading,
} from '@/utils/antiUsage'
import type { useAntiDaemonStatus } from './AntiDaemonControl'

type Profiles = components['schemas']['AgyProfiles']
type Profile = components['schemas']['AgyProfile']
type ModalView =
  | { kind: 'list' }
  | { kind: 'account'; profileId: string }
  | { kind: 'settings' }

type Action =
  | { kind: 'create'; name: string }
  | { kind: 'capture'; name: string }
  | { kind: 'switch' | 'login' | 'logout' | 'delete'; profile: Profile }
  | { kind: 'rename'; profile: Profile; name: string }
  | { kind: 'check-usage'; profileId?: string; profileName?: string }

const key = ['agy-profiles'] as const

const resetTimeFormat = new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

async function request<T>(suffix = '', init?: RequestInit): Promise<T> {
  const response = await fetch(resolveApiUrl(`/api/anti/profiles${suffix}`), init)
  if (!response.ok) {
    const error = await response.json().catch(() => null)
    throw new Error(typeof error?.detail === 'string' ? error.detail : '无法访问 Agy 账号设置')
  }
  return response.status === 204 ? undefined as T : response.json()
}

const write = { method: 'POST', headers: { 'X-GA-Hub-Action': 'manage-agy-profiles' } }

function authBadge(profile?: Profile, loggingIn?: boolean) {
  if (loggingIn) {
    return { label: '登录中', tone: 'border-accent/50 bg-accent/10 text-accent', healthy: false }
  }
  if (profile?.auth_state === 'authenticated') {
    return { label: '已验证登录', tone: 'border-status-success-line bg-status-success-soft text-status-success', healthy: true }
  }
  if (profile?.auth_state === 'login_required') {
    return { label: '需要登录', tone: 'border-status-danger-line bg-status-danger-soft text-status-danger', healthy: false }
  }
  if (profile?.has_credentials) {
    return { label: '已有凭据', tone: 'border-line bg-bg-soft text-ink', healthy: true }
  }
  return { label: '未登录', tone: 'border-line bg-bg-soft text-ink-muted', healthy: false }
}

function quotaTone(pct: number) {
  if (pct >= 50) return 'text-status-success'
  if (pct >= 20) return 'text-status-warning'
  return 'text-status-danger'
}

function quotaBarTone(pct: number) {
  if (pct >= 50) return 'bg-status-success'
  if (pct >= 20) return 'bg-status-warning'
  return 'bg-status-danger'
}

function renderTierPillIcon(tier: AgyAccountTier | undefined, fallbackAccent: boolean) {
  switch (tier) {
    case 'ultra':
      return <Crown className="h-3.5 w-3.5 shrink-0 text-[#9A6B16]" strokeWidth={2} aria-hidden="true" />
    case 'pro':
      return <Gem className="h-3.5 w-3.5 shrink-0 text-[#8A5622]" strokeWidth={1.9} aria-hidden="true" />
    case 'plus':
      return <Sparkles className="h-3.5 w-3.5 shrink-0 text-[#2E6B50]" strokeWidth={1.9} aria-hidden="true" />
    case 'enterprise':
      return <Building2 className="h-3.5 w-3.5 shrink-0 text-[#335073]" strokeWidth={1.9} aria-hidden="true" />
    default:
      return <UserRound className={clsx('h-3.5 w-3.5 shrink-0', fallbackAccent && 'text-accent')} strokeWidth={1.85} aria-hidden="true" />
  }
}

function formatIdleSeconds(seconds: number) {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  return `${Math.floor(seconds / 3600)}h`
}

function formatTimeLabel(raw?: string | null) {
  if (!raw) return null
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? resetTimeFormat.format(ms) : null
}

function QuotaMiniBar({
  profileName,
  label,
  reading,
}: {
  profileName: string
  label: '5h' | '周'
  reading: QuotaWindowReading | null
}) {
  const pct = reading?.remaining_pct ?? null
  const resetLabel = formatTimeLabel(reading?.resets_at)
  return (
    <div
      className="flex min-w-0 items-center gap-1.5"
      title={pct !== null
        ? `Gemini ${label}：剩余 ${formatQuotaPct(pct)}${resetLabel ? ` · ${resetLabel} 重置` : ''}`
        : `Gemini ${label}：暂无数据`}
    >
      <span className="w-5 shrink-0 text-[11px] font-medium text-ink-muted">{label}</span>
      <div
        role="progressbar"
        aria-label={`${profileName} Gemini ${label} 额度`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
        className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-bg-soft ring-1 ring-line/45"
      >
        <div
          className={clsx('h-full rounded-full transition-[width] duration-300', pct !== null ? quotaBarTone(pct) : 'bg-transparent')}
          style={{ width: `${pct !== null ? Math.max(0, Math.min(100, pct)) : 0}%` }}
        />
      </div>
      <span
        className={clsx(
          'w-9 shrink-0 text-right text-[11px] font-semibold tabular-nums',
          pct !== null ? quotaTone(pct) : 'text-ink-faint',
        )}
      >
        {pct !== null ? formatQuotaPct(pct) : '—'}
      </span>
    </div>
  )
}

function QuotaProgressRow({
  profileName,
  row,
}: {
  profileName: string
  row: NonNullable<NonNullable<Profile['usage']>['rows']>[number]
}) {
  const pct = Math.max(0, Math.min(100, row.remaining_pct))
  const winTag = quotaWindowShortLabel(row.limit)
  const resetLabel = formatTimeLabel(row.resets_at)
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-medium text-ink">{row.model}</span>
          <span className="shrink-0 rounded bg-bg-card px-1.5 py-0.5 text-[10px] leading-none text-ink-muted ring-1 ring-line/45">
            {winTag ?? row.limit}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2 tabular-nums">
          <span className="text-[10px] text-ink-muted">
            {resetLabel ? `${resetLabel} 重置` : '满额未消耗'}
          </span>
          <span className={clsx('w-10 text-right font-semibold', quotaTone(pct))}>
            {formatQuotaPct(pct)}
          </span>
        </div>
      </div>
      <div
        role="progressbar"
        aria-label={`${profileName} ${row.model} ${winTag ?? row.limit} 额度`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="h-1.5 w-full overflow-hidden rounded-full bg-bg-card ring-1 ring-line/45"
      >
        <div
          className={clsx('h-full rounded-full transition-[width] duration-300', quotaBarTone(pct))}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

export function useAgyProfiles() {
  return useQuery({
    queryKey: key,
    queryFn: ({ signal }) => request<Profiles>('', { signal }),
    retry: false,
    refetchInterval: ({ state }) => (state.data?.login_profile ? 2_000 : false),
  })
}

export function AntiAgyProfiles({
  profiles,
  refresh,
  daemon,
  open: controlledOpen,
  onOpenChange,
  initialView = 'list',
}: {
  profiles: ReturnType<typeof useAgyProfiles>
  refresh: () => void
  daemon?: ReturnType<typeof useAntiDaemonStatus>
  open?: boolean
  onOpenChange?: (open: boolean) => void
  initialView?: 'list' | 'settings'
}) {
  const cache = useQueryClient()
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = controlledOpen ?? uncontrolledOpen
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setUncontrolledOpen(next)
    onOpenChange?.(next)
  }

  const [view, setView] = useState<ModalView>({ kind: initialView })
  const prevSyncKeyRef = useRef('')
  const syncKey = `${open}:${initialView}`
  if (prevSyncKeyRef.current !== syncKey) {
    prevSyncKeyRef.current = syncKey
    if (open) {
      setView({ kind: initialView })
    }
  }

  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({})
  const [name, setName] = useState('')
  const [renameDraft, setRenameDraft] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [showLogs, setShowLogs] = useState(false)
  const [showWorkers, setShowWorkers] = useState(false)
  const [resettingSid, setResettingSid] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [codeLogin, setCodeLogin] = useState<AgyCodeLoginState | null>(null)
  const [authCode, setAuthCode] = useState('')
  const prevLoginProfile = useRef<string | null | undefined>(undefined)

  const accountViewId = view.kind === 'account' ? view.profileId : null
  const viewedProfile = useMemo(
    () => (accountViewId ? profiles.data?.profiles.find(item => item.id === accountViewId) : undefined),
    [accountViewId, profiles.data?.profiles],
  )
  useEffect(() => {
    if (view.kind === 'account' && profiles.data && !viewedProfile) {
      setView({ kind: 'list' })
    }
  }, [view.kind, profiles.data, viewedProfile])

  useEffect(() => {
    if (viewedProfile) {
      setRenameDraft(viewedProfile.name)
    }
    setConfirmDeleteId(null)
  }, [viewedProfile?.id, viewedProfile?.name])

  useEffect(() => {
    const current = profiles.data?.login_profile ?? null
    if (prevLoginProfile.current && !current) {
      refresh()
      setMessage(old => old || '官方登录窗口已关闭，已刷新账号状态。')
    }
    prevLoginProfile.current = current
  }, [profiles.data?.login_profile, refresh])

  const logs = useQuery({
    queryKey: ['anti-daemon-logs'],
    enabled: open && view.kind === 'settings' && showLogs,
    queryFn: ({ signal }) => antiApi.daemonLogs(80, signal),
    retry: false,
  })
  const workers = useQuery({
    queryKey: ['anti-workers'],
    enabled: open && view.kind === 'settings',
    queryFn: ({ signal }) => antiApi.workers(signal),
    refetchInterval: open && view.kind === 'settings' ? 3_000 : false,
    retry: false,
  })
  const workerItems = Array.isArray(workers.data?.items) ? workers.data.items : []
  const resetWorker = useMutation({
    mutationFn: ({ sid, force }: { sid: string; force: boolean }) => antiApi.resetSession(sid, force),
    onMutate: ({ sid }) => {
      setMessage('')
      setResettingSid(sid)
    },
    onSuccess: (_, { sid, force }) => {
      setMessage(force ? '已强制重连会话进程（保留上下文）。' : '已释放空闲会话进程。')
      void cache.invalidateQueries({ queryKey: ['anti-workers'] })
      void cache.invalidateQueries({ queryKey: ['anti-sessions'] })
      void cache.invalidateQueries({ queryKey: ['anti-runs', sid] })
      daemon?.refresh()
    },
    onSettled: () => {
      setResettingSid(null)
    },
  })

  const action = useMutation({
    mutationFn: async (args: Action) => {
      if (args.kind === 'create') {
        const profile = await request<Profile>('', {
          ...write,
          headers: { ...write.headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: args.name }),
        })
        cache.setQueryData<Profiles>(key, old => old && ({ ...old, profiles: [...old.profiles.filter(p => p.id !== profile.id), profile] }))
        setName('')
        setView({ kind: 'list' })
        setMessage(`已添加「${profile.name}」，请点击账号右侧设置完成登录授权。`)
      } else if (args.kind === 'capture') {
        const profile = await antiApi.captureProfile(args.name)
        setName('')
        setView({ kind: 'list' })
        setMessage(`已另存为独立账号「${profile.name}」。`)
      } else if (args.kind === 'rename') {
        const profile = await request<Profile>(`/${encodeURIComponent(args.profile.id)}`, {
          method: 'PATCH',
          headers: { ...write.headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: args.name }),
        })
        cache.setQueryData<Profiles>(key, old => old && ({ ...old, profiles: old.profiles.map(p => p.id === profile.id ? profile : p) }))
        setMessage(`已重命名为「${profile.name}」。`)
      } else if (args.kind === 'switch') {
        const data = await antiApi.switchProfile(args.profile.id)
        cache.setQueryData(key, data)
        setConfirmDeleteId(null)
        void cache.invalidateQueries({ queryKey: ['anti-models'] })
        void cache.invalidateQueries({ queryKey: ['anti-commands'] })
        void cache.invalidateQueries({ queryKey: ['anti-workers'] })
        void cache.invalidateQueries({ queryKey: ['anti-sessions'] })
        void cache.invalidateQueries({ queryKey: ['anti-daemon-status'] })
        setMessage(`已切换到「${args.profile.name}」。`)
      } else if (args.kind === 'delete') {
        await antiApi.deleteProfile(args.profile.id)
        cache.setQueryData<Profiles>(key, old => old && ({
          ...old,
          profiles: old.profiles.filter(p => p.id !== args.profile.id),
        }))
        setConfirmDeleteId(null)
        setView({ kind: 'list' })
        setMessage(`已删除「${args.profile.name}」。`)
      } else if (args.kind === 'logout') {
        const updated = await antiApi.clearProfileCredentials(args.profile.id)
        cache.setQueryData<Profiles>(key, old => old && ({
          ...old,
          profiles: old.profiles.map(p => p.id === updated.id ? updated : p),
        }))
        void cache.invalidateQueries({ queryKey: ['anti-daemon-status'] })
        setMessage(`已清除「${args.profile.name}」凭据（保留会话记录）。`)
      } else if (args.kind === 'check-usage') {
        const usage = await antiApi.accountUsage(args.profileId)
        const targetLabel = args.profileName ? `「${args.profileName}」` : ''
        setMessage(
          usage.rows.length > 0
            ? `已刷新${targetLabel}额度（${usage.rows.length} 项模型）。`
            : (usage.detail || '未读取到额度信息，请确认已登录后重试。'),
        )
      } else {
        await request(`/${encodeURIComponent(args.profile.id)}/login`, write)
        setMessage(`已打开「${args.profile.name}」官方登录窗口，完成后关闭即可。`)
      }
    },
    onMutate: async args => {
      setMessage('')
      if (args.kind !== 'login' && args.kind !== 'check-usage') {
        await cache.cancelQueries({ queryKey: key, exact: true })
      }
    },
    onSettled: (_, __, args) => {
      void cache.invalidateQueries({ queryKey: key, exact: true })
      if (args.kind === 'switch' || args.kind === 'check-usage') refresh()
    },
  })

  const codeLoginStart = useMutation({
    mutationFn: (profileId: string) => antiApi.startCodeLogin(profileId),
    onSuccess: state => {
      setCodeLogin(state)
      setAuthCode('')
      if (state.phase === 'completed') {
        void cache.invalidateQueries({ queryKey: key, exact: true })
        refresh()
      }
    },
  })
  const codeLoginSubmit = useMutation({
    mutationFn: ({ flowId, code }: { flowId: string; code: string }) => antiApi.submitCodeLogin(flowId, code),
    onSuccess: state => {
      setCodeLogin(state)
      if (state.phase === 'completed') {
        setMessage('Google 授权码登录成功，凭据已保存。')
        setCodeLogin(null)
        setAuthCode('')
        void cache.invalidateQueries({ queryKey: key, exact: true })
        refresh()
      }
    },
  })
  useEffect(() => {
    const flow = codeLogin
    if (!flow || (flow.phase !== 'starting' && flow.phase !== 'waiting_code')) return
    let active = true
    const timer = window.setInterval(async () => {
      try {
        const next = await antiApi.codeLoginStatus(flow.flow_id)
        if (!active) return
        setCodeLogin(next)
        if (next.phase === 'completed') {
          setMessage('Google 授权码登录成功，凭据已保存。')
          setCodeLogin(null)
          setAuthCode('')
          void cache.invalidateQueries({ queryKey: key, exact: true })
          refresh()
        } else if (next.phase === 'cancelled' || next.phase === 'failed') {
          void cache.invalidateQueries({ queryKey: key, exact: true })
        }
      } catch {
        // Ignore transient poll errors while waiting for user input.
      }
    }, 2000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [codeLogin, cache, refresh])

  const selected = profiles.data?.profiles.find(item => item.id === profiles.data?.active)
  const others = profiles.data?.profiles.filter(item => item.id !== profiles.data?.active) ?? []
  const orderedProfiles = useMemo(
    () => [selected, ...others].filter((item): item is Profile => Boolean(item)),
    [selected, others],
  )
  const profileCount = profiles.data?.profiles.length ?? 0
  const loginProfile = profiles.data?.login_profile
  const cancelActiveCodeLogin = (flow: AgyCodeLoginState | null) => {
    if (!flow || (flow.phase !== 'starting' && flow.phase !== 'waiting_code')) return
    void antiApi.cancelCodeLogin(flow.flow_id).catch(() => undefined).finally(() => {
      void cache.invalidateQueries({ queryKey: key, exact: true })
    })
  }
  const navigateTo = (next: ModalView) => {
    cancelActiveCodeLogin(codeLogin)
    setCodeLogin(null)
    setAuthCode('')
    setConfirmDeleteId(null)
    setMessage('')
    action.reset()
    setView(next)
  }
  const close = () => {
    if (action.isPending || codeLoginStart.isPending || codeLoginSubmit.isPending) return
    cancelActiveCodeLogin(codeLogin)
    setOpen(false)
    setView({ kind: 'list' })
    setConfirmDeleteId(null)
    setShowLogs(false)
    setShowWorkers(false)
    setResettingSid(null)
    setCodeLogin(null)
    setAuthCode('')
    setMessage('')
    action.reset()
    resetWorker.reset()
    codeLoginStart.reset()
    codeLoginSubmit.reset()
  }
  const disabled = action.isPending || profiles.isError
  const add = (event: FormEvent) => {
    event.preventDefault()
    if (!disabled && profiles.data && name.trim()) action.mutate({ kind: 'create', name: name.trim() })
  }
  const pendingLabel = action.variables?.kind === 'switch' ? '正在切换账号…'
    : action.variables?.kind === 'login' ? '正在打开官方登录窗口…'
    : action.variables?.kind === 'logout' ? '正在清除凭据…'
    : action.variables?.kind === 'rename' ? '正在保存备注…'
    : action.variables?.kind === 'capture' ? '正在另存当前登录…'
    : action.variables?.kind === 'delete' ? '正在删除账号…'
    : action.variables?.kind === 'check-usage' ? '正在刷新额度…'
    : '正在添加账号…'

  const compactBtn = 'ga-btn-sm h-7 shrink-0 px-2 py-0 text-[11px]'
  const compactPrimaryBtn = 'ga-btn-sm-primary h-7 shrink-0 px-2.5 py-0 text-[11px]'
  const compactDangerBtn = 'ga-btn-sm-danger h-7 shrink-0 px-2 py-0 text-[11px]'
  const daemonError = daemon?.start.error ?? daemon?.stop.error ?? daemon?.restart.error
  const nonWindows = typeof navigator !== 'undefined' && /mac|linux|x11/i.test(navigator.platform)
  const hasDaemonLifecycleBtns = Boolean(
    daemon && (
      (!daemon.running && daemon.state === 'stopped')
      || ((daemon.running || daemon.state === 'unavailable') && daemon.managed)
    ),
  )

  const toggleExpand = (id: string) => {
    setExpandedIds(prev => ({ ...prev, [id]: !prev[id] }))
  }

  const renderAccountCard = (profile: Profile, isActive: boolean) => {
    const badge = authBadge(profile, loginProfile === profile.id)
    const cooldownSec = profile.cooldown_seconds ?? 0
    const isExpanded = Boolean(expandedIds[profile.id])
    const gemini = geminiQuotaSummary(profile.usage)
    const detailRows = sortQuotaRows(profile.usage?.rows ?? [])
    const checkedLabel = formatTimeLabel(profile.usage?.checked_at)
    const showStatusTag = !badge.healthy || cooldownSec > 0
    const tierInfo = resolveAccountTier(profile.account_tier, profile.account_tier_name)

    return (
      <li
        key={profile.id}
        data-account-card={profile.id}
        className={clsx(
          'overflow-hidden rounded-xl border transition-colors',
          isActive
            ? clsx('border-accent/55 bg-bg-card shadow-sm', tierInfo?.cardFrameAccentClass)
            : 'border-line/70 bg-bg-card/75 hover:border-line',
        )}
      >
        <div className="flex items-stretch gap-2 p-2.5">
          <button
            type="button"
            aria-expanded={isExpanded}
            aria-label={`${isExpanded ? '收起' : '展开'}「${profile.name}」详细额度`}
            onClick={() => toggleExpand(profile.id)}
            className="flex min-w-0 flex-1 flex-col gap-2 rounded-lg px-1 py-0.5 text-left transition-colors hover:bg-bg-soft/45 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            <div className="flex min-w-0 items-center gap-1.5">
              {isExpanded
                ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
                : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-ink-muted" aria-hidden="true" />}
              <span
                className={clsx(
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  cooldownSec > 0
                    ? 'bg-status-warning'
                    : badge.healthy
                      ? 'bg-status-success'
                      : 'bg-status-danger',
                )}
                title={badge.label}
                aria-hidden="true"
              />
              <span className="min-w-0 truncate text-sm font-medium text-ink" title={profile.name}>
                {profile.name}
              </span>
              {tierInfo && (
                <span
                  data-account-tier-badge={tierInfo.tier}
                  title={tierInfo.fullLabel}
                  className={clsx(
                    'inline-flex shrink-0 items-center gap-0.5 rounded border px-1.5 py-0.5 text-[10px] font-semibold leading-none tracking-wide',
                    tierInfo.cardBadgeClass,
                  )}
                >
                  {tierInfo.glyph && <span aria-hidden="true">{tierInfo.glyph}</span>}
                  <span>{tierInfo.shortLabel}</span>
                </span>
              )}
              {isActive && (
                <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-accent">
                  当前
                </span>
              )}
              {showStatusTag && (
                cooldownSec > 0 ? (
                  <span className="shrink-0 rounded border border-status-warning-line bg-status-warning-soft px-1.5 py-0.5 text-[10px] font-medium leading-none tabular-nums text-status-warning">
                    风控冷却 {cooldownSec}s
                  </span>
                ) : (
                  <span className={clsx('shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none', badge.tone)}>
                    {badge.label}
                  </span>
                )
              )}
            </div>

            <div className="grid grid-cols-1 gap-x-4 gap-y-1.5 pl-5 sm:grid-cols-2">
              <QuotaMiniBar profileName={profile.name} label="5h" reading={gemini.fiveHour} />
              <QuotaMiniBar profileName={profile.name} label="周" reading={gemini.weekly} />
            </div>
          </button>

          <div className="flex shrink-0 items-center border-l border-line/40 pl-2">
            <button
              type="button"
              aria-label={`账号设置：${profile.name}`}
              title={`账号设置：${profile.name}`}
              onClick={() => navigateTo({ kind: 'account', profileId: profile.id })}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-transparent text-ink-muted transition-colors hover:border-line/70 hover:bg-bg-soft hover:text-ink"
            >
              <Settings2 className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>

        {isExpanded && (
          <div
            data-account-quota-details={profile.id}
            className="space-y-2 border-t border-line/50 bg-bg-soft/35 px-3.5 py-2.5"
          >
            {detailRows.length > 0 ? (
              <>
                <div className="flex items-center justify-between text-[11px] text-ink-muted">
                  <span>详细额度</span>
                  {checkedLabel && <span className="tabular-nums">检测于 {checkedLabel}</span>}
                </div>
                <div className="space-y-2">
                  {detailRows.map(row => (
                    <QuotaProgressRow key={`${row.model}-${row.limit}`} profileName={profile.name} row={row} />
                  ))}
                </div>
              </>
            ) : (
              <p className="text-[11px] text-ink-muted">
                暂无额度数据，请点击右侧设置图标进入账号详情后手动刷新额度。
              </p>
            )}
          </div>
        )}
      </li>
    )
  }

  const renderAccountSettings = (profile: Profile) => {
    const isActive = profile.id === selected?.id
    const badge = authBadge(profile, loginProfile === profile.id)
    const cooldownSec = profile.cooldown_seconds ?? 0
    const checkedLabel = formatTimeLabel(profile.usage?.checked_at)
    const tierInfo = resolveAccountTier(profile.account_tier, profile.account_tier_name)
    const canClearCredentials = (profile.has_credentials || profile.auth_state === 'authenticated')
      && !(isActive && (daemon?.status.data?.active_count ?? 0) > 0)
    const showCodeLoginForm = Boolean(codeLogin && codeLogin.profile_id === profile.id)

    return (
      <div data-account-settings-view={profile.id} className="space-y-3">
        <div className="rounded-xl border border-line/70 bg-bg-card p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className={clsx('shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none', badge.tone)}>
                {badge.label}
              </span>
              {tierInfo && (
                <span
                  data-account-settings-tier={tierInfo.tier}
                  className={clsx(
                    'inline-flex shrink-0 items-center gap-0.5 rounded border px-1.5 py-0.5 text-[10px] font-semibold leading-none tracking-wide',
                    tierInfo.cardBadgeClass,
                  )}
                >
                  {tierInfo.glyph && <span aria-hidden="true">{tierInfo.glyph}</span>}
                  <span>{tierInfo.fullLabel}</span>
                </span>
              )}
              {cooldownSec > 0 && (
                <span className="shrink-0 rounded border border-status-warning-line bg-status-warning-soft px-1.5 py-0.5 text-[10px] font-medium leading-none tabular-nums text-status-warning">
                  风控冷却 {cooldownSec}s
                </span>
              )}
              {checkedLabel && (
                <span className="text-[11px] text-ink-muted tabular-nums">
                  额度检测于 {checkedLabel}
                </span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {daemon?.running && (isActive || profile.has_credentials) && (
                <button
                  type="button"
                  className={compactBtn}
                  disabled={disabled}
                  aria-label={`刷新额度：${profile.name}`}
                  onClick={() => action.mutate({ kind: 'check-usage', profileId: profile.id, profileName: profile.name })}
                >
                  <RefreshCw className="h-3 w-3" aria-hidden="true" />
                  <span>刷新额度</span>
                </button>
              )}
              {!isActive && (
                <button
                  type="button"
                  className={compactPrimaryBtn}
                  disabled={disabled}
                  aria-label={`切换到${profile.name}`}
                  onClick={() => action.mutate({ kind: 'switch', profile })}
                >
                  设为当前账号
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="space-y-2 rounded-xl border border-line/70 bg-bg-card p-3">
          <span className="block text-xs font-semibold text-ink">授权与凭据</span>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              className={compactBtn}
              disabled={disabled || codeLoginStart.isPending}
              aria-label={`授权码登录：${profile.name}`}
              onClick={() => codeLoginStart.mutate(profile.id)}
            >
              {codeLoginStart.isPending && codeLoginStart.variables === profile.id ? '生成链接…' : '授权码登录'}
            </button>
            {!nonWindows && (
              <button
                type="button"
                className={compactBtn}
                disabled={disabled}
                aria-label={`官方登录：${profile.name}`}
                onClick={() => action.mutate({ kind: 'login', profile })}
              >
                官方登录
              </button>
            )}
            {canClearCredentials && (
              <button
                type="button"
                className={compactBtn}
                disabled={disabled}
                aria-label={`清除凭据：${profile.name}`}
                onClick={() => action.mutate({ kind: 'logout', profile })}
              >
                清除凭据
              </button>
            )}
          </div>
          {nonWindows && (
            <p className="text-[11px] text-ink-muted">
              当前系统请使用「授权码登录」，或到右上角「设置」中使用「从当前登录另存」。
            </p>
          )}
          {showCodeLoginForm && codeLogin && (
            <div className="space-y-1.5 rounded-lg border border-accent/45 bg-bg-soft/45 p-2.5 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-ink">Google 授权码登录</span>
                <span className="text-[11px] text-ink-muted">打开链接登录后粘贴授权码或回调链接</span>
              </div>
              {codeLogin.authorization_url ? (
                <>
                  <a
                    href={codeLogin.authorization_url}
                    target="_blank"
                    rel="noreferrer"
                    title={codeLogin.authorization_url}
                    className="block truncate rounded bg-bg-card px-2 py-1 font-mono text-[11px] text-accent underline"
                  >
                    {codeLogin.authorization_url}
                  </a>
                  <form
                    className="flex items-center gap-1.5"
                    onSubmit={e => {
                      e.preventDefault()
                      if (authCode.trim() && !codeLoginSubmit.isPending) {
                        codeLoginSubmit.mutate({ flowId: codeLogin.flow_id, code: authCode.trim() })
                      }
                    }}
                  >
                    <input
                      value={authCode}
                      onChange={e => setAuthCode(e.target.value)}
                      placeholder="粘贴授权码或回调链接…"
                      aria-label="Google 授权码"
                      className="h-7 min-w-0 flex-1 rounded-md border border-line bg-bg-card px-2 text-xs text-ink outline-none focus:border-accent"
                    />
                    <button type="submit" className={compactPrimaryBtn} disabled={!authCode.trim() || codeLoginSubmit.isPending}>
                      {codeLoginSubmit.isPending ? '提交中…' : '提交授权码'}
                    </button>
                    <button
                      type="button"
                      className={compactBtn}
                      aria-label="刷新授权状态"
                      onClick={() => {
                        void antiApi.codeLoginStatus(codeLogin.flow_id).then(next => {
                          setCodeLogin(next)
                          if (next.phase === 'completed') {
                            setMessage('Google 授权码登录成功，凭据已保存。')
                            setCodeLogin(null)
                            setAuthCode('')
                            void cache.invalidateQueries({ queryKey: key, exact: true })
                            refresh()
                          }
                        }).catch(() => undefined)
                      }}
                    >
                      刷新
                    </button>
                    <button
                      type="button"
                      className={compactBtn}
                      onClick={() => {
                        cancelActiveCodeLogin(codeLogin)
                        setCodeLogin(null)
                        setAuthCode('')
                      }}
                    >
                      取消
                    </button>
                  </form>
                </>
              ) : (
                <p className="text-[11px] text-ink-muted">正在生成 Google 授权链接…{codeLogin.error ? `（${codeLogin.error}）` : ''}</p>
              )}
              {codeLogin.error && <p className="text-[11px] text-status-danger">{codeLogin.error}</p>}
            </div>
          )}
        </div>

        {profile.id !== 'default' && (
          <form
            className="space-y-2 rounded-xl border border-line/70 bg-bg-card p-3"
            onSubmit={event => {
              event.preventDefault()
              const value = renameDraft.trim()
              if (!disabled && value && value !== profile.name) {
                action.mutate({ kind: 'rename', profile, name: value })
              }
            }}
          >
            <label htmlFor="agy-edit-name" className="block text-xs font-semibold text-ink">
              账号备注
            </label>
            <div className="flex items-center gap-1.5">
              <input
                id="agy-edit-name"
                value={renameDraft}
                maxLength={64}
                disabled={disabled}
                aria-label={`修改「${profile.name}」的备注`}
                onChange={event => setRenameDraft(event.target.value)}
                className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-bg-soft/60 px-2.5 text-xs text-ink outline-none focus:border-accent"
              />
              <button
                type="submit"
                className={compactPrimaryBtn}
                disabled={disabled || !renameDraft.trim() || renameDraft.trim() === profile.name}
              >
                保存备注
              </button>
            </div>
          </form>
        )}

        {!isActive && profile.id !== 'default' && (
          <div className="flex items-center justify-between gap-2 rounded-xl border border-line/70 bg-bg-card px-3 py-2.5">
            <span className="text-xs text-ink-muted">删除后将移除此账号的本地凭据与记录。</span>
            {confirmDeleteId === profile.id ? (
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  className="ga-btn-danger h-7 shrink-0 rounded-md px-2.5 py-0 text-[11px]"
                  disabled={disabled}
                  aria-label={`确认删除：${profile.name}`}
                  onClick={() => action.mutate({ kind: 'delete', profile })}
                >
                  确认删除
                </button>
                <button
                  type="button"
                  className={compactBtn}
                  disabled={disabled}
                  onClick={() => setConfirmDeleteId(null)}
                >
                  取消
                </button>
              </div>
            ) : (
              <button
                type="button"
                className={compactDangerBtn}
                disabled={disabled}
                aria-label={`删除账号：${profile.name}`}
                onClick={() => setConfirmDeleteId(profile.id)}
              >
                <Trash2 className="h-3 w-3" aria-hidden="true" />
                <span>删除账号</span>
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  const renderSharedSettings = () => {
    return (
      <div data-account-management-settings className="space-y-3">
        <form onSubmit={add} className="rounded-xl border border-line/70 bg-bg-card p-3">
          <div className="flex items-baseline justify-between gap-2">
            <label htmlFor="agy-profile-name" className="text-xs font-semibold text-ink">添加账号</label>
            <span id="agy-add-help" className="text-[11px] text-ink-muted">新建空白账号或复制当前登录</span>
          </div>
          <div className="mt-2 flex items-center gap-1.5">
            <input
              id="agy-profile-name"
              value={name}
              maxLength={64}
              onChange={event => setName(event.target.value)}
              disabled={disabled}
              aria-label="账号备注"
              aria-describedby="agy-add-help"
              placeholder="输入备注，如：工作账号"
              className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-bg-soft/50 px-2.5 text-xs text-ink outline-none focus:border-accent"
            />
            <button
              type="submit"
              className="ga-btn-sm h-8 shrink-0 px-2.5 py-0 text-xs"
              disabled={disabled || !name.trim()}
            >
              添加
            </button>
            <button
              type="button"
              className="ga-btn-sm h-8 shrink-0 px-2.5 py-0 text-xs"
              disabled={disabled || !name.trim()}
              onClick={() => {
                if (!disabled && profiles.data && name.trim()) {
                  action.mutate({ kind: 'capture', name: name.trim() })
                }
              }}
            >
              从当前登录另存
            </button>
          </div>
        </form>

        <div className="rounded-xl border border-line/70 bg-bg-card p-3 text-xs">
          <div className="font-semibold text-ink">额度查询方式</div>
          <p className="mt-0.5 text-[11px] text-ink-muted">
            为避免后台高频探测触发账号风控，已关闭整点自动与批量刷新；可在顶部额度按钮或单个账号详情页手动按需查询。
          </p>
        </div>

        {daemon && (
          <div className="rounded-xl border border-line/70 bg-bg-card p-3 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className={clsx('h-2 w-2 shrink-0 rounded-full', daemonDotClass)} aria-hidden="true" />
                <span className="font-semibold text-ink">{daemonStateLabel}</span>
                {daemon.running && daemon.status.data?.version && (
                  <span className="font-mono text-[11px] text-ink-muted">v{daemon.status.data.version}</span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  className={clsx(compactBtn, showWorkers && 'border-accent/60 bg-accent-soft/45 text-ink')}
                  onClick={() => {
                    setShowWorkers(v => !v)
                    setShowLogs(false)
                  }}
                >
                  {showWorkers ? '隐藏进程' : `活跃进程${workerItems.length > 0 ? ` (${workerItems.length})` : ''}`}
                </button>
                <button
                  type="button"
                  className={clsx(compactBtn, showLogs && 'border-accent/60 bg-accent-soft/45 text-ink')}
                  onClick={() => {
                    setShowLogs(v => !v)
                    setShowWorkers(false)
                  }}
                >
                  {showLogs ? '隐藏日志' : 'ACP 日志'}
                </button>
                {hasDaemonLifecycleBtns && <span aria-hidden="true" className="mx-0.5 h-3.5 w-px bg-line/70" />}
                {!daemon.running && daemon.state === 'stopped' && (
                  <button type="button" className={compactBtn} disabled={daemon.busy} onClick={() => daemon.start.mutate()}>启用 Agy</button>
                )}
                {(daemon.running || daemon.state === 'unavailable') && daemon.managed && (
                  <button type="button" className={compactBtn} disabled={daemon.busy} onClick={() => daemon.restart.mutate(false)}>重置运行时</button>
                )}
                {daemon.running && daemon.managed && (
                  <button type="button" className={compactBtn} disabled={daemon.busy} onClick={() => daemon.stop.mutate(false)}>停止运行时</button>
                )}
              </div>
            </div>
            {daemon.state === 'unavailable' && daemon.status.data?.detail && (
              <p className="mt-1.5 text-[11px] text-status-danger">{daemon.status.data.detail}</p>
            )}
            {renderForceConflictBar('mt-2')}
            {showWorkers && (
              <div data-anti-workers-panel className="mt-2 space-y-1.5 border-t border-line/60 pt-2">
                <div className="flex items-center justify-between text-[11px] text-ink-muted">
                  <span>活跃会话进程（{workerItems.length}）</span>
                  <button type="button" className="ga-btn-link" disabled={workers.isFetching} onClick={() => void workers.refetch()}>
                    <RefreshIcon spinning={workers.isFetching} size={11} />
                    <span>{workers.isFetching ? '刷新中…' : '刷新'}</span>
                  </button>
                </div>
                {workers.error ? (
                  <p className="text-[11px] text-status-danger">{workers.error.message}</p>
                ) : workerItems.length > 0 ? (
                  <ul className="space-y-1">
                    {workerItems.map(worker => {
                      const forceReset = worker.busy || worker.exit_pending || worker.dirty
                      const stateLabel = worker.state === 'running' ? '运行中'
                        : worker.state === 'retiring' ? '退出中'
                        : worker.state === 'idle' ? `空闲 ${formatIdleSeconds(worker.idle_seconds)}`
                        : '已停止'
                      const stateTone = worker.state === 'running' ? 'text-accent font-medium'
                        : worker.state === 'retiring' ? 'text-status-warning font-medium'
                        : 'text-ink-muted'
                      const isResetting = resetWorker.isPending && resettingSid === worker.session_id
                      return (
                        <li key={`${worker.profile_id}:${worker.session_id}`} className="flex items-center justify-between gap-2 rounded bg-bg-soft px-2.5 py-1.5">
                          <div className="min-w-0 flex-1 space-y-0.5">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate font-medium text-ink" title={worker.workspace}>
                                {worker.session_title || worker.project || worker.session_id.slice(0, 8)}
                              </span>
                              {worker.project && worker.session_title && (
                                <span className="shrink-0 rounded bg-bg-card px-1 py-0.5 text-[10px] text-ink-muted">{worker.project}</span>
                              )}
                              <span className="shrink-0 rounded bg-bg-card px-1 py-0.5 text-[10px] text-ink-muted">{worker.profile_name || worker.profile_id}</span>
                            </div>
                            <div className="flex items-center gap-2 text-[11px] text-ink-muted tabular-nums">
                              <span>PID {worker.pid ?? '—'}</span>
                              <span className={stateTone}>{stateLabel}</span>
                            </div>
                          </div>
                          <button
                            type="button"
                            className={forceReset ? compactDangerBtn : compactBtn}
                            disabled={resetWorker.isPending}
                            onClick={() => resetWorker.mutate({ sid: worker.session_id, force: forceReset })}
                          >
                            {isResetting ? '处理中…' : (forceReset ? '强制重连' : '释放进程')}
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                ) : (
                  <p className="text-[11px] text-ink-muted">{workers.isPending ? '正在查询进程池…' : '当前没有常驻 Agy ACP 进程。'}</p>
                )}
              </div>
            )}
            {showLogs && (
              <div className="mt-2 border-t border-line/60 pt-2">
                <div className="mb-1 flex items-center justify-between text-[11px] text-ink-muted">
                  <span className="truncate" title={logs.data?.log_path}>最近 Agy ACP 运行日志</span>
                  <button type="button" className="ga-btn-link" disabled={logs.isFetching} onClick={() => void logs.refetch()}>
                    <RefreshIcon spinning={logs.isFetching} size={11} />
                    <span>{logs.isFetching ? '刷新中…' : '刷新'}</span>
                  </button>
                </div>
                {logs.error ? (
                  <p className="text-[11px] text-status-danger">{logs.error.message}</p>
                ) : logs.data?.lines?.length ? (
                  <pre className="max-h-36 overflow-auto rounded bg-bg-soft p-2 font-mono text-[11px] leading-4 text-ink whitespace-pre-wrap break-all">
                    {logs.data.lines.join('\n')}
                  </pre>
                ) : (
                  <p className="text-[11px] text-ink-muted">{logs.isPending ? '正在读取日志…' : '暂无 Agy ACP 运行日志。'}</p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  const triggerLabel = selected ? `Agy 账号：${selected.name}` : 'Agy 账号'
  const customActive = Boolean(selected && selected.id !== 'default')
  const activeCooldown = selected?.cooldown_seconds ?? 0
  const activeNeedLogin = Boolean(selected && (selected.auth_state === 'login_required' || selected.has_credentials === false))
  const activeFiveHourPct = fiveHourRemainingPct(selected?.usage)
  const activeTierInfo = resolveAccountTier(selected?.account_tier, selected?.account_tier_name)
  const showTierEffect = Boolean(activeTierInfo && !activeNeedLogin && activeCooldown === 0)
  const triggerParts = [triggerLabel]
  if (activeTierInfo) triggerParts.push(activeTierInfo.fullLabel)
  if (activeCooldown > 0) {
    triggerParts.push(`风控冷却 ${activeCooldown}s`)
  } else if (activeNeedLogin) {
    triggerParts.push('需要登录')
  } else if (typeof activeFiveHourPct === 'number') {
    triggerParts.push(`5h 剩余 ${activeFiveHourPct}%`)
  }
  const triggerTitle = triggerParts.join(' · ')

  const daemonDotClass = daemon?.running
    ? 'bg-status-success'
    : daemon?.state === 'unavailable'
      ? 'bg-status-danger'
      : daemon?.busy
        ? 'bg-accent animate-pulse'
        : 'bg-ink-faint'
  const daemonStateLabel = !daemon ? ''
    : daemon.external ? '外部运行中'
    : daemon.running ? 'ACP 就绪'
    : daemon.busy ? '处理中'
    : daemon.state === 'stopped' ? '已停止'
    : '不可用'

  const renderForceConflictBar = (className?: string) => (
    daemon?.forceConflict && daemon.managed ? (
      <div
        data-anti-modal-force-bar
        role="status"
        className={clsx(
          'flex flex-wrap items-center justify-between gap-2 rounded-lg border border-status-danger-line bg-status-danger-soft px-2.5 py-1.5 text-[11px] text-status-danger',
          className,
        )}
      >
        <span>仍有活跃任务，常规{daemon.forceConflict === 'restart' ? '重置' : '停止'}已拦截；可强制中断。</span>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            className={compactDangerBtn}
            disabled={daemon.busy}
            onClick={() => (daemon.forceConflict === 'restart' ? daemon.restart.mutate(true) : daemon.stop.mutate(true))}
          >
            {daemon.forceConflict === 'restart' ? '强制重置运行时' : '强制停止运行时'}
          </button>
          <button type="button" className={compactBtn} onClick={() => daemon.clearForceConflict()}>
            取消
          </button>
        </div>
      </div>
    ) : null
  )

  const headerTitle = view.kind === 'list'
    ? '账号管理'
    : view.kind === 'settings'
      ? '账号管理设置'
      : (viewedProfile?.name ?? '账号设置')
  const activeError = action.error ?? daemonError ?? codeLoginStart.error ?? codeLoginSubmit.error ?? resetWorker.error
  const statusText = action.isPending ? pendingLabel : message

  return <>
    <button
      type="button"
      data-anti-account-pill
      data-account-tier={activeTierInfo?.tier}
      className={clsx(
        'ga-btn ga-account-pill inline-flex h-[35px] max-w-full shrink-0 items-center gap-1.5 rounded-[9px] px-2.5 text-xs leading-none transition-colors',
        activeNeedLogin
          ? 'border-status-danger-line/80 text-status-danger hover:text-status-danger'
          : activeCooldown > 0
            ? 'border-status-warning-line text-status-warning hover:text-status-warning'
            : showTierEffect && activeTierInfo?.pillClass
              ? clsx(activeTierInfo.pillClass, 'text-ink hover:text-ink')
              : customActive
                ? 'border-accent/45 text-ink hover:border-accent/70'
                : 'text-ink-muted hover:text-ink',
      )}
      aria-label={triggerLabel}
      title={triggerTitle}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => setOpen(true)}
    >
      {renderTierPillIcon(showTierEffect ? activeTierInfo?.tier : undefined, customActive && !activeNeedLogin)}
      <span className="max-w-[7.5rem] truncate font-medium text-ink">{selected?.name ?? 'Agy 账号'}</span>
      {activeCooldown > 0 ? (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-status-warning" aria-hidden="true" />
      ) : activeNeedLogin ? (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-status-danger" aria-hidden="true" />
      ) : typeof activeFiveHourPct === 'number' ? (
        <span className={clsx('shrink-0 text-[11px] font-semibold tabular-nums', quotaTone(activeFiveHourPct))}>
          {activeFiveHourPct}%
        </span>
      ) : null}
    </button>
    {open && createPortal(
      <ModalOverlay
        onClose={close}
        labelledBy="agy-accounts-title"
        panelClassName="flex max-h-[86vh] w-[38rem] max-w-[94vw] flex-col overflow-hidden p-0"
      >
        <div className="shrink-0 border-b border-line/60 px-4 py-3 sm:px-5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              {view.kind !== 'list' && (
                <button
                  type="button"
                  aria-label="返回账号列表"
                  title="返回账号列表"
                  onClick={() => navigateTo({ kind: 'list' })}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-line/70 bg-bg-card text-ink-muted transition-colors hover:border-accent/50 hover:text-ink"
                >
                  <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                </button>
              )}
              <h2 id="agy-accounts-title" className="truncate text-sm font-semibold text-ink">
                {headerTitle}
              </h2>
              {view.kind === 'list' && profileCount > 0 && (
                <span className="shrink-0 rounded bg-line/35 px-1.5 py-0.5 text-[10px] font-medium leading-none tabular-nums text-ink-muted">
                  {profileCount}
                </span>
              )}
              {view.kind === 'account' && viewedProfile?.id === selected?.id && (
                <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-accent">
                  当前
                </span>
              )}
            </div>

            <div className="flex shrink-0 items-center gap-1.5">
              {view.kind === 'list' && (
                <button
                  type="button"
                  className={compactBtn}
                  aria-label="账号管理设置"
                  title="账号管理设置"
                  onClick={() => navigateTo({ kind: 'settings' })}
                >
                  <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>设置</span>
                </button>
              )}
              <button type="button" className={compactBtn} onClick={close} disabled={action.isPending}>
                <X className="h-3.5 w-3.5" aria-hidden="true" />
                <span>关闭</span>
              </button>
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 sm:px-5">
          <div role="status" className="rounded-md bg-bg-card/80 px-2.5 py-1.5 text-xs text-ink-muted empty:hidden">
            {statusText}
          </div>
          {activeError && (
            <p role="alert" className="rounded-lg border border-status-danger-line bg-status-danger-soft px-2.5 py-1.5 text-xs text-status-danger">
              {activeError.message}
            </p>
          )}

          {view.kind === 'list' ? (
            <div className="space-y-3">
              {renderForceConflictBar('px-3 py-2')}

              {daemon && (daemon.state === 'stopped' || daemon.state === 'unavailable') && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line/70 bg-bg-card px-3 py-2 text-xs">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className={clsx('h-2 w-2 shrink-0 rounded-full', daemonDotClass)} aria-hidden="true" />
                    <span className="font-medium text-ink">{daemonStateLabel}</span>
                    {daemon.status.data?.detail && (
                      <span className="truncate text-[11px] text-status-danger">{daemon.status.data.detail}</span>
                    )}
                  </div>
                  {!daemon.running && daemon.state === 'stopped' ? (
                    <button type="button" className={compactPrimaryBtn} disabled={daemon.busy} onClick={() => daemon.start.mutate()}>
                      启用 Agy
                    </button>
                  ) : daemon.managed ? (
                    <button type="button" className={compactBtn} disabled={daemon.busy} onClick={() => daemon.restart.mutate(false)}>
                      重置运行时
                    </button>
                  ) : null}
                </div>
              )}

              {profiles.isError && (
                <div className="flex items-center justify-between gap-2 rounded-lg border border-line bg-bg-card px-3 py-2 text-xs">
                  <p role="alert" className="text-status-danger">{profiles.error.message}</p>
                  <button type="button" className={compactBtn} onClick={() => void profiles.refetch()} disabled={profiles.isFetching}>
                    重试
                  </button>
                </div>
              )}
              {profiles.isPending && <p role="status" className="text-xs text-ink-muted">正在加载账号…</p>}

              {profiles.data && (
                orderedProfiles.length > 0 ? (
                  <ul className="space-y-2" aria-label="账号列表">
                    {orderedProfiles.map(profile => renderAccountCard(profile, profile.id === selected?.id))}
                  </ul>
                ) : (
                  <div className="rounded-xl border border-dashed border-line/70 px-4 py-6 text-center text-xs text-ink-muted">
                    <p>暂无账号</p>
                    <button
                      type="button"
                      className={clsx(compactPrimaryBtn, 'mt-2')}
                      onClick={() => navigateTo({ kind: 'settings' })}
                    >
                      去添加账号
                    </button>
                  </div>
                )
              )}
            </div>
          ) : view.kind === 'account' ? (
            viewedProfile ? renderAccountSettings(viewedProfile) : null
          ) : (
            renderSharedSettings()
          )}
        </div>
      </ModalOverlay>,
      document.body,
    )}
  </>
}
