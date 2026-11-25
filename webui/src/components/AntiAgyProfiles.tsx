import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Brain, UserRound } from 'lucide-react'
import { RefreshIcon, RotateCw, Trash2, X } from '@/components/ActionIcons'
import clsx from 'clsx'
import type { components } from '@/api/generated/schema'
import { antiApi, type AgyCodeLoginState } from '@/api/client'
import { buildOrchestratorRoleChoices, DEFAULT_MODEL } from '@/components/AntiModelSelector'
import { ModalOverlay } from '@/components/ModalOverlay'
import { resolveApiUrl } from '@/runtime/runtimeConfig'
import type { useAntiDaemonStatus } from './AntiDaemonControl'

type Profiles = components['schemas']['AgyProfiles']
type Profile = components['schemas']['AgyProfile']
type ModalTab = 'accounts' | 'models'
type Action =
  | { kind: 'create'; name: string }
  | { kind: 'capture'; name: string }
  | { kind: 'switch' | 'login' | 'logout' | 'delete'; profile: Profile }
  | { kind: 'rename'; profile: Profile; name: string }
  | { kind: 'check-usage' }
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
    return { label: '登录窗口已打开', tone: 'border-accent/50 bg-accent/10 text-accent' }
  }
  if (profile?.auth_state === 'authenticated') {
    return { label: '已验证登录', tone: 'border-status-success-line bg-status-success-soft text-status-success' }
  }
  if (profile?.auth_state === 'login_required') {
    return { label: '需要登录', tone: 'border-status-danger-line bg-status-danger-soft text-status-danger' }
  }
  if (profile?.has_credentials) {
    return { label: '已有凭据', tone: 'border-line bg-bg-soft text-ink' }
  }
  return { label: '未登录', tone: 'border-line bg-bg-soft text-ink-muted' }
}

function quotaTone(pct: number) {
  if (pct >= 50) return 'text-status-success'
  if (pct >= 20) return 'text-status-warning'
  return 'text-status-danger'
}

function formatIdleSeconds(seconds: number) {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  return `${Math.floor(seconds / 3600)}h`
}

function formatSyncTime(raw?: string | null) {
  if (!raw) return null
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? resetTimeFormat.format(ms) : null
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
  targetProfileId,
  focusSection = 'default',
}: {
  profiles: ReturnType<typeof useAgyProfiles>
  refresh: () => void
  daemon?: ReturnType<typeof useAntiDaemonStatus>
  open?: boolean
  onOpenChange?: (open: boolean) => void
  targetProfileId?: string
  focusSection?: 'default' | 'orchestrator'
}) {
  const cache = useQueryClient()
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = controlledOpen ?? uncontrolledOpen
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setUncontrolledOpen(next)
    onOpenChange?.(next)
  }
  const [activeTab, setActiveTab] = useState<ModalTab>(
    focusSection === 'orchestrator' ? 'models' : 'accounts',
  )
  const prevSyncKeyRef = useRef('')
  const syncKey = `${open}:${focusSection}`
  if (prevSyncKeyRef.current !== syncKey) {
    prevSyncKeyRef.current = syncKey
    if (open) {
      const targetTab: ModalTab = focusSection === 'orchestrator' ? 'models' : 'accounts'
      if (activeTab !== targetTab) setActiveTab(targetTab)
    }
  }

  const [name, setName] = useState('')
  const [editing, setEditing] = useState<{ profile: Profile; name: string } | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [showLogs, setShowLogs] = useState(false)
  const [showWorkers, setShowWorkers] = useState(false)
  const [resettingSid, setResettingSid] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [codeLogin, setCodeLogin] = useState<AgyCodeLoginState | null>(null)
  const [authCode, setAuthCode] = useState('')
  const [orchPlannerDraft, setOrchPlannerDraft] = useState('')
  const [orchExecutorDraft, setOrchExecutorDraft] = useState('')
  const prevLoginProfile = useRef<string | null | undefined>(undefined)

  useEffect(() => {
    const current = profiles.data?.login_profile ?? null
    if (prevLoginProfile.current && !current) {
      refresh()
      setMessage(old => old || '官方登录窗口已关闭，已刷新账号状态。')
    }
    prevLoginProfile.current = current
  }, [profiles.data?.login_profile, refresh])

  const effectivePid = targetProfileId || profiles.data?.active || 'default'
  const overridePid = targetProfileId && targetProfileId !== profiles.data?.active ? targetProfileId : undefined
  const effectiveProfileName = profiles.data?.profiles.find(p => p.id === effectivePid)?.name ?? effectivePid

  const modelsQuery = useQuery({
    queryKey: ['anti-models', effectivePid],
    enabled: open && activeTab === 'models' && Boolean(effectivePid),
    queryFn: ({ signal }) => antiApi.models(signal, overridePid),
    staleTime: 60_000,
    retry: false,
  })
  const syncModels = useMutation({
    mutationFn: () => antiApi.syncModels(overridePid),
    onMutate: () => {
      setMessage('')
    },
    onSuccess: synced => {
      cache.setQueryData(['anti-models', effectivePid], synced)
      void cache.invalidateQueries({ queryKey: ['anti-models'] })
      setMessage(`已同步上游模型（${synced.items.length} 个）。`)
    },
  })
  const orchestratorSettings = useQuery({
    queryKey: ['anti-orchestrator', effectivePid],
    enabled: open && activeTab === 'models' && Boolean(effectivePid),
    queryFn: ({ signal }) => antiApi.profileOrchestrator(effectivePid, signal),
    retry: false,
  })
  useEffect(() => {
    setOrchPlannerDraft(orchestratorSettings.data?.planner ?? '')
    setOrchExecutorDraft(orchestratorSettings.data?.executor ?? '')
  }, [orchestratorSettings.data?.planner, orchestratorSettings.data?.executor, effectivePid])

  const orchestratorRoleChoices = useMemo(
    () => buildOrchestratorRoleChoices(modelsQuery.data?.items ?? [DEFAULT_MODEL]),
    [modelsQuery.data?.items],
  )
  const updateOrchestrator = useMutation({
    mutationFn: ({ planner, executor }: { planner: string | null; executor: string | null }) =>
      antiApi.updateProfileOrchestrator(effectivePid, { planner, executor }),
    onMutate: () => {
      setMessage('')
    },
    onSuccess: updated => {
      cache.setQueryData(['anti-orchestrator', effectivePid], updated)
      void cache.invalidateQueries({ queryKey: ['anti-sessions'], exact: true })
      void cache.invalidateQueries({ queryKey: ['anti-workers'] })
      setMessage('已保存，空闲进程已刷新。')
    },
  })

  const logs = useQuery({
    queryKey: ['anti-daemon-logs'],
    enabled: open && activeTab === 'accounts' && showLogs,
    queryFn: ({ signal }) => antiApi.daemonLogs(80, signal),
    retry: false,
  })
  const workers = useQuery({
    queryKey: ['anti-workers'],
    enabled: open && activeTab === 'accounts',
    queryFn: ({ signal }) => antiApi.workers(signal),
    refetchInterval: open && activeTab === 'accounts' ? 3_000 : false,
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
        setMessage(`已添加「${profile.name}」，请点击登录完成授权。`)
      } else if (args.kind === 'capture') {
        const profile = await antiApi.captureProfile(args.name)
        setName('')
        setMessage(`已另存为独立账号「${profile.name}」。`)
      } else if (args.kind === 'rename') {
        const profile = await request<Profile>(`/${encodeURIComponent(args.profile.id)}`, {
          method: 'PATCH',
          headers: { ...write.headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: args.name }),
        })
        cache.setQueryData<Profiles>(key, old => old && ({ ...old, profiles: old.profiles.map(p => p.id === profile.id ? profile : p) }))
        setEditing(null)
        setMessage(`已重命名为「${profile.name}」。`)
      } else if (args.kind === 'switch') {
        const data = await request<Profiles>(`/${encodeURIComponent(args.profile.id)}/switch`, write)
        cache.setQueryData(key, data)
        setConfirmDeleteId(null)
        setMessage(`已切换到「${args.profile.name}」。`)
      } else if (args.kind === 'delete') {
        await antiApi.deleteProfile(args.profile.id)
        cache.setQueryData<Profiles>(key, old => old && ({
          ...old,
          profiles: old.profiles.filter(p => p.id !== args.profile.id),
        }))
        setConfirmDeleteId(null)
        setMessage(`已删除「${args.profile.name}」。`)
      } else if (args.kind === 'logout') {
        const updated = await antiApi.clearProfileCredentials(args.profile.id)
        cache.setQueryData<Profiles>(key, old => old && ({
          ...old,
          profiles: old.profiles.map(p => p.id === updated.id ? updated : p),
        }))
        setMessage(`已清除「${args.profile.name}」凭据（保留会话记录）。`)
      } else if (args.kind === 'check-usage') {
        const usage = await antiApi.accountUsage()
        setMessage(
          usage.rows.length > 0
            ? `已刷新额度（${usage.rows.length} 项模型）。`
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
  const close = () => {
    if (action.isPending || codeLoginStart.isPending || codeLoginSubmit.isPending || syncModels.isPending || updateOrchestrator.isPending) return
    cancelActiveCodeLogin(codeLogin)
    setOpen(false)
    setEditing(null)
    setConfirmDeleteId(null)
    setShowLogs(false)
    setShowWorkers(false)
    setResettingSid(null)
    setCodeLogin(null)
    setAuthCode('')
    setMessage('')
    action.reset()
    resetWorker.reset()
    syncModels.reset()
    updateOrchestrator.reset()
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

  const renderAccountRow = (profile: Profile, isActive: boolean) => {
    const badge = authBadge(profile, loginProfile === profile.id)
    const usage = profile.usage
    const pct = usage?.min_remaining_pct
    const checkedAt = usage?.checked_at ? new Date(usage.checked_at).getTime() : NaN
    const checkedLabel = Number.isFinite(checkedAt) ? resetTimeFormat.format(checkedAt) : null
    const cooldownSec = profile.cooldown_seconds ?? 0
    const isEditing = editing?.profile.id === profile.id
    const canClearCredentials = profile.id !== 'default'
      && (profile.has_credentials || profile.auth_state === 'authenticated')
      && (!isActive || !daemon || daemon.state === 'stopped')
    const showRightDivider = !isActive && profile.id !== 'default'

    return (
      <li
        key={profile.id}
        className={clsx(
          'rounded-lg border px-3 py-2 transition-colors',
          isActive ? 'border-accent/45 bg-bg-card' : 'border-line/70 bg-bg-card/75',
        )}
      >
        <div className="flex min-h-[28px] items-center justify-between gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            {isActive && (
              <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-accent">
                当前
              </span>
            )}
            <span className="min-w-0 truncate text-sm font-medium text-ink" title={profile.name}>
              {profile.name}
            </span>
            <span className={clsx('shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none', badge.tone)}>
              {badge.label}
            </span>
            {cooldownSec > 0 && (
              <span className="shrink-0 rounded border border-status-warning-line bg-status-warning-soft px-1.5 py-0.5 text-[10px] font-medium leading-none tabular-nums text-status-warning">
                风控冷却 {cooldownSec}s
              </span>
            )}
            {typeof pct === 'number' && (
              <span
                className={clsx('shrink-0 text-xs font-semibold tabular-nums', quotaTone(pct))}
                title={checkedLabel ? `检测于 ${checkedLabel}` : undefined}
              >
                最低剩余 {pct}%
              </span>
            )}
          </div>
          <div className="shrink-0">
            {isActive ? (
              daemon?.running && (
                <button
                  type="button"
                  className={compactBtn}
                  disabled={disabled}
                  onClick={() => action.mutate({ kind: 'check-usage' })}
                >
                  刷新额度
                </button>
              )
            ) : (
              <button
                type="button"
                className={compactPrimaryBtn}
                disabled={disabled}
                aria-label={`切换到${profile.name}`}
                onClick={() => action.mutate({ kind: 'switch', profile })}
              >
                切换
              </button>
            )}
          </div>
        </div>

        {isActive && profile.usage?.rows?.length ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
            {profile.usage.rows.map(row => (
              <span
                key={`${row.model}-${row.limit}`}
                className="inline-flex items-center gap-1.5 rounded bg-bg-soft px-2 py-0.5"
                title={`${row.model} · ${row.limit}`}
              >
                <span className="max-w-[11rem] truncate text-ink-muted">{row.model}</span>
                <span className={clsx('font-semibold tabular-nums', quotaTone(row.remaining_pct))}>
                  {row.remaining_pct}%
                </span>
              </span>
            ))}
          </div>
        ) : null}

        <div className="mt-1.5 flex items-center justify-between gap-2 border-t border-line/40 pt-1.5">
          {isEditing ? (
            <form
              className="flex w-full items-center gap-1.5"
              onSubmit={event => {
                event.preventDefault()
                const value = editing.name.trim()
                if (!disabled && value && value !== editing.profile.name) {
                  action.mutate({ kind: 'rename', profile: editing.profile, name: value })
                }
              }}
            >
              <input
                id="agy-edit-name"
                value={editing.name}
                maxLength={64}
                disabled={disabled}
                aria-label={`修改「${editing.profile.name}」的备注`}
                onChange={event => setEditing({ ...editing, name: event.target.value })}
                className="h-7 min-w-0 flex-1 rounded-md border border-accent/60 bg-bg-soft/60 px-2 text-xs text-ink outline-none focus:border-accent"
              />
              <button
                type="submit"
                className={compactPrimaryBtn}
                disabled={disabled || !editing.name.trim() || editing.name.trim() === editing.profile.name}
              >
                保存备注
              </button>
              <button
                type="button"
                className={compactBtn}
                disabled={action.isPending}
                onClick={() => {
                  action.reset()
                  setEditing(null)
                }}
              >
                取消
              </button>
            </form>
          ) : (
            <>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  className={compactBtn}
                  disabled={disabled || codeLoginStart.isPending}
                  aria-label={`授权码登录：${profile.name}`}
                  onClick={() => codeLoginStart.mutate(profile.id)}
                >
                  {codeLoginStart.isPending && codeLoginStart.variables === profile.id ? '生成链接…' : '授权码登录'}
                </button>
                <button
                  type="button"
                  className={compactBtn}
                  disabled={disabled || nonWindows}
                  title={nonWindows ? '仅支持在 Windows 上直接唤起官方登录窗口，请使用「授权码登录」' : undefined}
                  aria-label={`官方登录：${profile.name}`}
                  onClick={() => action.mutate({ kind: 'login', profile })}
                >
                  官方登录
                </button>
              </div>
              <div className="flex items-center gap-1.5">
                {profile.id !== 'default' && (
                  <button
                    type="button"
                    className={compactBtn}
                    disabled={disabled}
                    aria-label={`修改备注：${profile.name}`}
                    onClick={() => {
                      action.reset()
                      setMessage('')
                      setConfirmDeleteId(null)
                      setEditing({ profile, name: profile.name })
                    }}
                  >
                    修改备注
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
                {showRightDivider && (
                  confirmDeleteId === profile.id ? (
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        className="ga-btn-danger h-7 shrink-0 rounded-md px-2 py-0 text-[11px]"
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
                      <span>删除</span>
                    </button>
                  )
                )}
              </div>
            </>
          )}
        </div>
      </li>
    )
  }

  const triggerLabel = selected ? `Agy 账号：${selected.name}` : 'Agy 账号'
  const customActive = Boolean(selected && selected.id !== 'default')

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

  return <>
    <button
      type="button"
      className={clsx(
        'ga-btn-icon relative',
        customActive ? 'text-accent' : 'text-ink-muted hover:text-ink',
      )}
      aria-label={triggerLabel}
      title={triggerLabel}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => setOpen(true)}
    >
      <UserRound className="h-4 w-4" strokeWidth={1.85} aria-hidden="true" />
      {customActive && (
        <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-accent" aria-hidden="true" />
      )}
    </button>
    {open && createPortal(<ModalOverlay onClose={close} labelledBy="agy-accounts-title"
      panelClassName="flex max-h-[86vh] w-[40rem] max-w-[94vw] flex-col overflow-hidden p-0">
      <div className="shrink-0 border-b border-line/60 px-4 py-3 sm:px-5">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 id="agy-accounts-title" className="text-sm font-semibold text-ink">Agy CLI 账号</h2>
            <p className="mt-0.5 truncate text-[11px] text-ink-muted">
              账号隔离凭据与上下文，切换默认不影响运行中会话
            </p>
          </div>
          <button type="button" className={compactBtn} onClick={close} disabled={action.isPending}>
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            <span>关闭</span>
          </button>
        </div>
        <div
          role="tablist"
          aria-label="Agy 账号设置分区"
          className="mt-2.5 inline-flex rounded-lg border border-line/70 bg-bg-card/80 p-0.5 text-xs"
        >
          <button
            type="button"
            role="tab"
            id="agy-tab-accounts"
            aria-selected={activeTab === 'accounts'}
            aria-controls="agy-panel-accounts"
            onClick={() => setActiveTab('accounts')}
            className={clsx(
              'inline-flex items-center gap-1.5 rounded-md px-3 py-1 font-medium transition-colors',
              activeTab === 'accounts'
                ? 'bg-bg-soft text-ink shadow-sm ring-1 ring-line/60'
                : 'text-ink-muted hover:text-ink',
            )}
          >
            <span>账号管理</span>
            {profileCount > 0 && (
              <span className="rounded bg-line/40 px-1 py-0.5 text-[10px] leading-none tabular-nums text-ink-muted">
                {profileCount}
              </span>
            )}
          </button>
          <button
            type="button"
            role="tab"
            id="agy-tab-models"
            aria-selected={activeTab === 'models'}
            aria-controls="agy-panel-models"
            onClick={() => setActiveTab('models')}
            className={clsx(
              'inline-flex items-center gap-1.5 rounded-md px-3 py-1 font-medium transition-colors',
              activeTab === 'models'
                ? 'bg-bg-soft text-ink shadow-sm ring-1 ring-line/60'
                : 'text-ink-muted hover:text-ink',
            )}
          >
            <Brain size={12} className="shrink-0 text-accent" aria-hidden="true" />
            <span>模型与 Orchestrator</span>
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 sm:px-5">
        <div role="status" className="rounded-md bg-bg-card/80 px-2.5 py-1.5 text-xs text-ink-muted empty:hidden">
          {action.isPending ? pendingLabel : message}
        </div>
        {(action.error || daemonError || codeLoginStart.error || codeLoginSubmit.error || resetWorker.error) && (
          <p role="alert" className="rounded-lg border border-status-danger-line bg-status-danger-soft px-2.5 py-1.5 text-xs text-status-danger">
            {(action.error ?? daemonError ?? codeLoginStart.error ?? codeLoginSubmit.error ?? resetWorker.error)!.message}
          </p>
        )}

        {activeTab === 'accounts' ? (
          <div role="tabpanel" id="agy-panel-accounts" aria-labelledby="agy-tab-accounts" className="space-y-3">
            {daemon && (
              <div className="rounded-lg border border-line/70 bg-bg-card px-3 py-2 text-xs">
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
                  <p className="mt-1 text-[11px] text-status-danger">{daemon.status.data.detail}</p>
                )}
                {daemon.forceConflict && daemon.managed && (
                  <div
                    data-anti-modal-force-bar
                    role="status"
                    className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded border border-status-danger-line bg-status-danger-soft px-2.5 py-1.5 text-[11px] text-status-danger"
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
                )}
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

            {codeLogin && (
              <div className="space-y-1.5 rounded-lg border border-accent/45 bg-bg-card p-3 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-ink">Google 授权码登录</span>
                  <span className="text-[11px] text-ink-muted">打开链接登录后，将授权码或回调链接粘贴到下方：</span>
                </div>
                {codeLogin.authorization_url ? (
                  <>
                    <a
                      href={codeLogin.authorization_url}
                      target="_blank"
                      rel="noreferrer"
                      title={codeLogin.authorization_url}
                      className="block truncate rounded bg-bg-soft px-2 py-1 font-mono text-[11px] text-accent underline"
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
                        className="h-7 min-w-0 flex-1 rounded-md border border-line bg-bg-soft/60 px-2 text-xs text-ink outline-none focus:border-accent"
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
              <>
                {orderedProfiles.length > 0 ? (
                  <ul className="space-y-2" aria-label="账号列表">
                    {orderedProfiles.map(profile => renderAccountRow(profile, profile.id === selected?.id))}
                  </ul>
                ) : (
                  <p className="text-xs text-ink-muted">暂无账号，请在下方添加。</p>
                )}
                {nonWindows && (
                  <p className="text-[11px] text-ink-muted">
                    非 Windows 系统请使用「授权码登录」或下方「从当前登录另存」。
                  </p>
                )}
                <form onSubmit={add} className="rounded-lg border border-line/70 bg-bg-card px-3 py-2.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <label htmlFor="agy-profile-name" className="text-xs font-semibold text-ink">添加账号</label>
                    <span id="agy-add-help" className="text-[11px] text-ink-muted">空白新建或复制本机当前登录</span>
                  </div>
                  <div className="mt-1.5 flex items-center gap-1.5">
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
              </>
            )}
          </div>
        ) : (
          <div role="tabpanel" id="agy-panel-models" aria-labelledby="agy-tab-models">
            <section
              data-anti-models-orch-section
              aria-labelledby="agy-models-orch-title"
              className="space-y-3 rounded-lg border border-line/70 bg-bg-card p-3 text-xs"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <h3 id="agy-models-orch-title" className="truncate text-sm font-semibold text-ink">
                    模型目录（{effectiveProfileName}）
                  </h3>
                  <p className="mt-0.5 text-[11px] text-ink-muted">
                    {modelsQuery.data?.items
                      ? `共 ${modelsQuery.data.items.length} 个模型${formatSyncTime(modelsQuery.data.synced_at) ? ` · 同步于 ${formatSyncTime(modelsQuery.data.synced_at)}` : ''}`
                      : '默认每日 00/06/12/18 点自动同步上游目录'}
                  </p>
                </div>
                <button
                  type="button"
                  className={compactBtn}
                  disabled={syncModels.isPending}
                  aria-label="同步上游模型"
                  onClick={() => syncModels.mutate()}
                >
                  <RotateCw size={12} className={syncModels.isPending ? 'animate-spin motion-reduce:animate-none' : undefined} aria-hidden="true" />
                  <span>{syncModels.isPending ? '同步中…' : '同步上游模型'}</span>
                </button>
              </div>
              {syncModels.error && (
                <p className="text-[11px] text-status-danger">
                  {syncModels.error instanceof Error ? syncModels.error.message : '同步上游模型失败'}
                </p>
              )}

              <div data-anti-orchestrator-section className="space-y-2.5 border-t border-line/60 pt-2.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs font-semibold text-ink">Orchestrator 角色模型</span>
                  <span className="text-[11px] text-ink-muted">写入账号 settings.json，新会话生效</span>
                </div>
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  <label className="block space-y-1">
                    <span className="block text-[11px] font-medium text-ink-muted">Planner（规划）</span>
                    <select
                      aria-label="Orchestrator Planner 模型"
                      value={orchPlannerDraft}
                      disabled={orchestratorSettings.isPending || updateOrchestrator.isPending}
                      onChange={e => setOrchPlannerDraft(e.target.value)}
                      className="h-8 w-full rounded-lg border border-line bg-bg-soft/50 px-2 text-xs text-ink outline-none focus:border-accent"
                    >
                      <option value="">默认（跟随上游 / High）</option>
                      {orchPlannerDraft && !orchestratorRoleChoices.some(c => c.id === orchPlannerDraft) && (
                        <option value={orchPlannerDraft}>{orchPlannerDraft}（当前配置）</option>
                      )}
                      {orchestratorRoleChoices.map(choice => (
                        <option key={choice.id} value={choice.id}>{choice.label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block space-y-1">
                    <span className="block text-[11px] font-medium text-ink-muted">Executor（执行）</span>
                    <select
                      aria-label="Orchestrator Executor 模型"
                      value={orchExecutorDraft}
                      disabled={orchestratorSettings.isPending || updateOrchestrator.isPending}
                      onChange={e => setOrchExecutorDraft(e.target.value)}
                      className="h-8 w-full rounded-lg border border-line bg-bg-soft/50 px-2 text-xs text-ink outline-none focus:border-accent"
                    >
                      <option value="">默认（跟随上游 / High）</option>
                      {orchExecutorDraft && !orchestratorRoleChoices.some(c => c.id === orchExecutorDraft) && (
                        <option value={orchExecutorDraft}>{orchExecutorDraft}（当前配置）</option>
                      )}
                      {orchestratorRoleChoices.map(choice => (
                        <option key={choice.id} value={choice.id}>{choice.label}</option>
                      ))}
                    </select>
                  </label>
                </div>
                {updateOrchestrator.error && (
                  <p className="text-[11px] text-status-danger">
                    {updateOrchestrator.error instanceof Error ? updateOrchestrator.error.message : '保存 Orchestrator 设置失败'}
                  </p>
                )}
                <div className="flex items-center justify-end gap-1.5">
                  <button
                    type="button"
                    className={compactBtn}
                    disabled={updateOrchestrator.isPending}
                    onClick={() => updateOrchestrator.mutate({ planner: null, executor: null })}
                  >
                    恢复默认
                  </button>
                  <button
                    type="button"
                    className={compactPrimaryBtn}
                    disabled={updateOrchestrator.isPending}
                    onClick={() => updateOrchestrator.mutate({
                      planner: orchPlannerDraft || null,
                      executor: orchExecutorDraft || null,
                    })}
                  >
                    {updateOrchestrator.isPending ? '保存中…' : '保存设置'}
                  </button>
                </div>
              </div>
            </section>
          </div>
        )}
      </div>
    </ModalOverlay>, document.body)}
  </>
}
