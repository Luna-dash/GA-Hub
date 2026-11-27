import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Building2, Crown, Gem, RefreshCw, Sparkles, UserRound } from 'lucide-react'
import { ChevronDown, ChevronLeft, ChevronRight, Plus, Settings2, Trash2, X } from '@/components/ActionIcons'
import clsx from 'clsx'
import type { components } from '@/api/generated/schema'
import { antiApi, type AgyCodeLoginState } from '@/api/client'
import { Z_LAYERS } from '@/config/zLayers'
import { useDirtyClose } from '@/hooks/useDirtyClose'
import { useOverlayRegistration } from '@/hooks/useOverlayRegistration'
import { dialog } from '@/stores/dialogStore'
import { extractErrorMessage } from '@/utils/errors'
import { hasHigherLayerOverlay } from '@/utils/overlayStack'
import { resolveApiUrl } from '@/runtime/runtimeConfig'
import {
  fiveHourRemainingPct,
  resolveAccountTier,
  sortQuotaRows,
  type AgyAccountTier,
} from '@/utils/antiUsage'
import { AntiQuotaProgressList, formatQuotaTime, quotaTone } from './AntiQuotaProgressList'
import type { useAntiDaemonStatus } from './AntiDaemonControl'

type Profiles = components['schemas']['AgyProfiles']
type Profile = components['schemas']['AgyProfile']
type PanelView =
  | { kind: 'list' }
  | { kind: 'account'; profileId: string }
  | { kind: 'add' }

type Action =
  | { kind: 'create'; name: string }
  | { kind: 'capture'; name: string }
  | { kind: 'switch' | 'login' | 'logout' | 'delete'; profile: Profile }
  | { kind: 'rename'; profile: Profile; name: string }
  | { kind: 'set-tier'; profile: Profile; tier: AgyAccountTier | null }
  | { kind: 'check-usage'; profileId?: string; profileName?: string }

const ACCOUNT_TIER_OPTIONS: readonly { value: AgyAccountTier | ''; label: string }[] = [
  { value: '', label: '不标记' },
  { value: 'free', label: 'Free' },
  { value: 'plus', label: 'Plus' },
  { value: 'pro', label: 'Pro' },
  { value: 'ultra', label: 'Ultra' },
  { value: 'enterprise', label: 'Enterprise' },
]

const key = ['agy-profiles'] as const

async function request<T>(suffix = '', init?: RequestInit): Promise<T> {
  const response = await fetch(resolveApiUrl(`/api/anti/profiles${suffix}`), init)
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(extractErrorMessage({ body }, '无法访问 Agy 账号设置'))
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

function renderTierPillIcon(tier: AgyAccountTier | undefined, fallbackAccent: boolean) {
  switch (tier) {
    case 'ultra':
      return <Crown className="ga-account-tier-icon--ultra h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
    case 'pro':
      return <Gem className="ga-account-tier-icon--pro h-3.5 w-3.5 shrink-0" strokeWidth={1.9} aria-hidden="true" />
    case 'plus':
      return <Sparkles className="ga-account-tier-icon--plus h-3.5 w-3.5 shrink-0" strokeWidth={1.9} aria-hidden="true" />
    case 'enterprise':
      return <Building2 className="ga-account-tier-icon--enterprise h-3.5 w-3.5 shrink-0" strokeWidth={1.9} aria-hidden="true" />
    default:
      return <UserRound className={clsx('h-3.5 w-3.5 shrink-0', fallbackAccent && 'text-accent')} strokeWidth={1.85} aria-hidden="true" />
  }
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
  initialView?: 'list' | 'add'
}) {
  const cache = useQueryClient()
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = controlledOpen ?? uncontrolledOpen
  const setOpen = useCallback((next: boolean) => {
    if (controlledOpen === undefined) setUncontrolledOpen(next)
    onOpenChange?.(next)
  }, [controlledOpen, onOpenChange])

  const [view, setView] = useState<PanelView>({ kind: initialView })
  useLayoutEffect(() => {
    if (open) {
      setView({ kind: initialView })
    }
  }, [open, initialView])

  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({})
  const [name, setName] = useState('')
  const [renameDraft, setRenameDraft] = useState('')
  const [message, setMessage] = useState('')
  const [codeLogin, setCodeLogin] = useState<AgyCodeLoginState | null>(null)
  const [authCode, setAuthCode] = useState('')
  const [refreshingCodeLogin, setRefreshingCodeLogin] = useState(false)
  const [codeLoginRefreshError, setCodeLoginRefreshError] = useState('')
  const refreshCodeLoginBusyRef = useRef(false)
  const codeLoginEpochRef = useRef(0)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  const prevLoginProfile = useRef<string | null | undefined>(undefined)
  const popoverId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number; width: number; maxHeight: number }>()

  const accountViewId = view.kind === 'account' ? view.profileId : null
  const viewedProfile = useMemo(
    () => (accountViewId ? profiles.data?.profiles.find(item => item.id === accountViewId) : undefined),
    [accountViewId, profiles.data?.profiles],
  )
  useEffect(() => {
    if (view.kind === 'account' && profiles.data && !viewedProfile) {
      clearErrorsRef.current()
      resetActionRef.current()
      setView({ kind: 'list' })
    }
  }, [view.kind, profiles.data, viewedProfile])

  useEffect(() => {
    if (viewedProfile) {
      setRenameDraft(viewedProfile.name)
    }
  }, [viewedProfile?.id, viewedProfile?.name])

  useEffect(() => {
    const current = profiles.data?.login_profile ?? null
    if (prevLoginProfile.current && !current) {
      refresh()
      setMessage(old => old || '官方登录窗口已关闭，已刷新账号状态。')
    }
    prevLoginProfile.current = current
  }, [profiles.data?.login_profile, refresh])

  const clearErrorsRef = useRef<() => void>(() => {})
  const resetActionRef = useRef<() => void>(() => {})

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
        cache.setQueryData<Profiles>(key, old => old && ({ ...old, profiles: old.profiles.map(p => p.id === profile.id ? { ...p, ...profile } : p) }))
        setMessage(`已重命名为「${profile.name}」。`)
      } else if (args.kind === 'set-tier') {
        const profile = await request<Profile>(`/${encodeURIComponent(args.profile.id)}`, {
          method: 'PATCH',
          headers: { ...write.headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ account_tier: args.tier ?? '' }),
        })
        cache.setQueryData<Profiles>(key, old => old && ({
          ...old,
          profiles: old.profiles.map(p => (p.id === profile.id
            ? {
              ...p,
              ...profile,
              account_tier: profile.account_tier,
              account_tier_name: profile.account_tier_name,
            }
            : p)),
        }))
        const tierLabel = ACCOUNT_TIER_OPTIONS.find(o => o.value === (args.tier ?? ''))?.label
        setMessage(args.tier ? `已将「${args.profile.name}」档位标记为 ${tierLabel ?? args.tier}。` : `已清除「${args.profile.name}」的档位标记。`)
      } else if (args.kind === 'switch') {
        const data = await antiApi.switchProfile(args.profile.id)
        cache.setQueryData(key, data)
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
        if (args.profileId) {
          setExpandedIds(prev => ({ ...prev, [args.profileId!]: true }))
        }
        const targetLabel = args.profileName ? `「${args.profileName}」` : ''
        setMessage(
          usage.rows.length > 0
            ? `已查询${targetLabel}剩余额度。`
            : (usage.detail || '未读取到额度信息，请确认已登录后重试。'),
        )
      } else {
        await request(`/${encodeURIComponent(args.profile.id)}/login`, write)
        setMessage(`已打开「${args.profile.name}」官方登录窗口，完成后关闭即可。`)
      }
    },
    onMutate: async args => {
      setMessage('')
      clearErrorsRef.current()
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
    mutationFn: ({ profileId }: { profileId: string; epoch: number }) => antiApi.startCodeLogin(profileId),
    onMutate: () => {
      action.reset()
      codeLoginSubmit.reset()
      setCodeLoginRefreshError('')
    },
    onSuccess: (state, vars) => {
      if (!mountedRef.current || vars.epoch !== codeLoginEpochRef.current) return
      setCodeLogin(state)
      setAuthCode('')
      if (state.phase === 'completed') {
        void cache.invalidateQueries({ queryKey: key, exact: true })
        refresh()
      }
    },
  })
  const codeLoginSubmit = useMutation({
    mutationFn: ({ flowId, code }: { flowId: string; code: string; epoch: number }) => antiApi.submitCodeLogin(flowId, code),
    onMutate: () => {
      action.reset()
      codeLoginStart.reset()
      setCodeLoginRefreshError('')
    },
    onSuccess: (state, vars) => {
      if (!mountedRef.current || vars.epoch !== codeLoginEpochRef.current) return
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
    const epoch = codeLoginEpochRef.current
    const timer = window.setInterval(async () => {
      try {
        const next = await antiApi.codeLoginStatus(flow.flow_id)
        if (!active || !mountedRef.current || epoch !== codeLoginEpochRef.current) return
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
  const visibleProfiles = useMemo(
    () => (profiles.data?.profiles ?? []).filter(item => item.id !== 'default'),
    [profiles.data?.profiles],
  )
  const orderedProfiles = useMemo(() => {
    const activeVisible = visibleProfiles.find(item => item.id === profiles.data?.active)
    const rest = visibleProfiles.filter(item => item.id !== profiles.data?.active)
    return activeVisible ? [activeVisible, ...rest] : rest
  }, [profiles.data?.active, visibleProfiles])
  const profileCount = orderedProfiles.length
  const usingHiddenDefault = Boolean(profiles.data?.active === 'default')
  const loginProfile = profiles.data?.login_profile
  const cancelActiveCodeLogin = useCallback((flow: AgyCodeLoginState | null) => {
    codeLoginEpochRef.current += 1
    if (!flow || (flow.phase !== 'starting' && flow.phase !== 'waiting_code')) return
    void antiApi.cancelCodeLogin(flow.flow_id).catch(() => undefined).finally(() => {
      void cache.invalidateQueries({ queryKey: key, exact: true })
    })
  }, [cache])
  clearErrorsRef.current = () => {
    codeLoginStart.reset()
    codeLoginSubmit.reset()
    setCodeLoginRefreshError('')
  }
  resetActionRef.current = action.reset
  const hasActiveCodeLogin = Boolean(codeLogin && (codeLogin.phase === 'starting' || codeLogin.phase === 'waiting_code'))
  const addDirty = view.kind === 'add' && name.trim().length > 0
  const accountDirty = view.kind === 'account' && Boolean(
    (viewedProfile && renameDraft !== viewedProfile.name)
    || authCode.trim()
    || hasActiveCodeLogin,
  )
  const isDirty = open && (addDirty || accountDirty)
  const busy = action.isPending || codeLoginStart.isPending || codeLoginSubmit.isPending
  const navConfirmingRef = useRef(false)
  const restoreFocusOnCloseRef = useRef(false)
  const applyNavigateTo = (next: PanelView) => {
    cancelActiveCodeLogin(codeLogin)
    setCodeLogin(null)
    setAuthCode('')
    setName('')
    if (viewedProfile) setRenameDraft(viewedProfile.name)
    setMessage('')
    action.reset()
    clearErrorsRef.current()
    setView(next)
  }
  const navigateTo = (next: PanelView) => {
    if (busy || navConfirmingRef.current) return
    if (next.kind !== view.kind && (addDirty || accountDirty)) {
      navConfirmingRef.current = true
      void dialog.confirm(
        '放弃未保存的修改？',
        '切换视图将放弃当前未保存的修改或中断授权码登录流程。',
        { confirmText: '放弃修改', cancelText: '继续编辑', tone: 'danger' },
      ).then((discard) => {
        if (discard) applyNavigateTo(next)
      }).finally(() => {
        navConfirmingRef.current = false
      })
      return
    }
    applyNavigateTo(next)
  }
  const closeImmediate = useCallback(() => {
    if (action.isPending || codeLoginStart.isPending || codeLoginSubmit.isPending) return
    const shouldRestoreFocus = restoreFocusOnCloseRef.current
    restoreFocusOnCloseRef.current = false
    cancelActiveCodeLogin(codeLogin)
    setOpen(false)
    setView({ kind: 'list' })
    setName('')
    setCodeLogin(null)
    setAuthCode('')
    setCodeLoginRefreshError('')
    setMessage('')
    action.reset()
    codeLoginStart.reset()
    codeLoginSubmit.reset()
    if (shouldRestoreFocus) triggerRef.current?.focus()
  }, [action, cancelActiveCodeLogin, codeLogin, codeLoginStart, codeLoginSubmit, setOpen])
  const { requestClose } = useDirtyClose({
    dirty: isDirty,
    busy,
    onClose: closeImmediate,
  })
  const requestCloseRef = useRef(requestClose)
  requestCloseRef.current = requestClose

  useOverlayRegistration({
    active: open,
    zIndex: Z_LAYERS.popover,
    getPanel: () => panelRef.current,
    onEscape: () => {
      restoreFocusOnCloseRef.current = true
      requestCloseRef.current()
    },
    trapFocus: false,
  })

  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const anchor = triggerRef.current?.getBoundingClientRect()
      if (!anchor) return
      const width = Math.min(400, window.innerWidth - 16)
      const next = {
        top: anchor.bottom,
        left: Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8)),
        width,
        maxHeight: Math.max(0, Math.min(window.innerHeight - anchor.bottom - 16, 480)),
      }
      setPosition(prev => (
        prev
        && prev.top === next.top
        && prev.left === next.left
        && prev.width === next.width
        && prev.maxHeight === next.maxHeight
          ? prev
          : next
      ))
    }
    const outside = (event: PointerEvent) => {
      if (hasHigherLayerOverlay(Z_LAYERS.popover)) return
      if (event.target instanceof Node && !triggerRef.current?.contains(event.target) && !panelRef.current?.contains(event.target)) {
        restoreFocusOnCloseRef.current = false
        requestCloseRef.current()
      }
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    document.addEventListener('pointerdown', outside, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      document.removeEventListener('pointerdown', outside, true)
    }
  }, [open])

  const disabled = action.isPending || profiles.isError
  const destructiveConfirmRef = useRef(false)
  const confirmLogout = async (profile: Profile) => {
    if (disabled || destructiveConfirmRef.current) return
    destructiveConfirmRef.current = true
    try {
      const ok = await dialog.confirm(
        '清除账号凭据？',
        `将移除「${profile.name}」的本地登录凭据（保留会话记录），之后需要重新登录。`,
        { confirmText: '清除凭据', tone: 'danger' },
      )
      if (ok) action.mutate({ kind: 'logout', profile })
    } finally {
      destructiveConfirmRef.current = false
    }
  }
  const confirmDelete = async (profile: Profile) => {
    if (disabled || destructiveConfirmRef.current) return
    destructiveConfirmRef.current = true
    try {
      const ok = await dialog.confirm(
        '删除账号？',
        `将移除「${profile.name}」的本地凭据与配置记录，且无法恢复。`,
        { confirmText: '删除账号', tone: 'danger' },
      )
      if (ok) action.mutate({ kind: 'delete', profile })
    } finally {
      destructiveConfirmRef.current = false
    }
  }
  const add = (event: FormEvent) => {
    event.preventDefault()
    if (!disabled && profiles.data && name.trim()) action.mutate({ kind: 'create', name: name.trim() })
  }
  const pendingLabel = action.variables?.kind === 'switch' ? '正在切换账号…'
    : action.variables?.kind === 'login' ? '正在打开官方登录窗口…'
    : action.variables?.kind === 'logout' ? '正在清除凭据…'
    : action.variables?.kind === 'rename' ? '正在保存备注…'
    : action.variables?.kind === 'set-tier' ? '正在更新档位…'
    : action.variables?.kind === 'capture' ? '正在另存当前登录…'
    : action.variables?.kind === 'delete' ? '正在删除账号…'
    : action.variables?.kind === 'check-usage' ? '正在查询额度…'
    : '正在添加账号…'

  const nonWindows = typeof navigator !== 'undefined' && /mac|linux|x11/i.test(navigator.platform)

  const toggleExpand = (id: string) => {
    setExpandedIds(prev => ({ ...prev, [id]: !prev[id] }))
  }

  const renderAccountCard = (profile: Profile, isActive: boolean) => {
    const badge = authBadge(profile, loginProfile === profile.id)
    const cooldownSec = profile.cooldown_seconds ?? 0
    const isExpanded = Boolean(expandedIds[profile.id])
    const detailRows = sortQuotaRows(profile.usage?.rows ?? [])
    const checkedLabel = formatQuotaTime(profile.usage?.checked_at)
    const showStatusTag = !badge.healthy || cooldownSec > 0
    const tierInfo = resolveAccountTier(profile.account_tier, profile.account_tier_name)
    const canQueryQuota = Boolean((!daemon || daemon.running) && (isActive || profile.has_credentials))
    const queryingThis = action.isPending && action.variables?.kind === 'check-usage' && action.variables.profileId === profile.id

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
        <div className="flex items-center justify-between gap-2 px-3 py-2.5">
          <button
            type="button"
            aria-expanded={isExpanded}
            aria-label={`${isExpanded ? '收起' : '展开'}「${profile.name}」额度`}
            onClick={() => toggleExpand(profile.id)}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-1 py-0.5 text-left transition-colors hover:bg-bg-soft/45 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            {detailRows.length > 0 && (
              isExpanded
                ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
                : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
            )}
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
          </button>

          <div className="flex shrink-0 items-center gap-1.5">
            {canQueryQuota && (
              <button
                type="button"
                className="ga-btn-sm shrink-0 px-2 text-[11px]"
                disabled={disabled}
                aria-label={`查询额度：${profile.name}`}
                onClick={() => action.mutate({ kind: 'check-usage', profileId: profile.id, profileName: profile.name })}
              >
                <RefreshCw className={clsx('h-3 w-3', queryingThis && 'motion-safe:animate-spin')} aria-hidden="true" />
                <span>{queryingThis ? '查询中' : '查询额度'}</span>
              </button>
            )}
            {!isActive && (
              <button
                type="button"
                className="ga-btn-sm-primary shrink-0 text-[11px]"
                disabled={disabled}
                aria-label={`切换到${profile.name}`}
                onClick={() => action.mutate({ kind: 'switch', profile })}
              >
                切换
              </button>
            )}
            <button
              type="button"
              aria-label={`账号设置：${profile.name}`}
              title={`账号设置：${profile.name}`}
              onClick={() => navigateTo({ kind: 'account', profileId: profile.id })}
              className="flex h-7 w-7 items-center justify-center rounded-lg border border-transparent text-ink-muted transition-colors hover:border-line/70 hover:bg-bg-soft hover:text-ink"
            >
              <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
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
                  <span>剩余额度</span>
                  <div className="flex items-center gap-2">
                    {checkedLabel && <span className="tabular-nums">更新于 {checkedLabel}</span>}
                    <button
                      type="button"
                      className="ga-btn-link-muted px-1 py-0 text-[11px]"
                      onClick={() => toggleExpand(profile.id)}
                    >
                      收起
                    </button>
                  </div>
                </div>
                <AntiQuotaProgressList rows={detailRows} ariaPrefix={profile.name} />
              </>
            ) : (
              <p className="text-[11px] text-ink-muted">
                尚未查询额度，点击「查询额度」按需获取。
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
    const tierInfo = resolveAccountTier(profile.account_tier, profile.account_tier_name)
    const canClearCredentials = (profile.has_credentials || profile.auth_state === 'authenticated')
      && !(isActive && (daemon?.status.data?.active_count ?? 0) > 0)
    const showCodeLoginForm = Boolean(codeLogin && codeLogin.profile_id === profile.id)
    const currentTierValue: AgyAccountTier | '' = (profile.account_tier as AgyAccountTier | undefined) ?? ''

    return (
      <div data-account-settings-view={profile.id} className="space-y-2.5">
        <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-line/65 bg-bg-card/80 px-2.5 py-2">
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
        </div>

        <div className="space-y-2 rounded-xl border border-line/70 bg-bg-card p-2.5">
          <span className="block text-xs font-semibold text-ink">账号档位</span>
          <div role="radiogroup" aria-label="账号档位" className="flex flex-wrap items-center gap-1.5">
            {ACCOUNT_TIER_OPTIONS.map(opt => {
              const activeOpt = currentTierValue === opt.value
              return (
                <button
                  key={opt.value || 'none'}
                  type="button"
                  role="radio"
                  aria-checked={activeOpt}
                  data-account-tier-option={opt.value || 'none'}
                  disabled={disabled}
                  onClick={() => {
                    if (!activeOpt) {
                      action.mutate({ kind: 'set-tier', profile, tier: opt.value || null })
                    }
                  }}
                  className={clsx(
                    'rounded-md px-2 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45',
                    activeOpt
                      ? 'bg-accent text-[var(--c-accent-fg)] shadow-sm'
                      : 'border border-line/70 bg-bg-soft/60 text-ink-muted hover:border-accent/60 hover:text-ink',
                  )}
                >
                  {opt.label}
                </button>
              )
            })}
          </div>
        </div>

        <div className="space-y-2 rounded-xl border border-line/70 bg-bg-card p-2.5">
          <span className="block text-xs font-semibold text-ink">授权与凭据</span>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              className="ga-btn-sm shrink-0 px-2 text-[11px]"
              disabled={disabled || codeLoginStart.isPending}
              aria-label={`授权码登录：${profile.name}`}
              onClick={() => codeLoginStart.mutate({ profileId: profile.id, epoch: ++codeLoginEpochRef.current })}
            >
              {codeLoginStart.isPending && codeLoginStart.variables?.profileId === profile.id ? '生成链接…' : '授权码登录'}
            </button>
            {!nonWindows && (
              <button
                type="button"
                className="ga-btn-sm shrink-0 px-2 text-[11px]"
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
                className="ga-btn-sm-danger shrink-0 px-2 text-[11px]"
                disabled={disabled}
                aria-label={`清除凭据：${profile.name}`}
                onClick={() => { void confirmLogout(profile) }}
              >
                清除凭据
              </button>
            )}
          </div>
          {nonWindows && (
            <p className="text-[11px] text-ink-muted">
              当前系统请使用「授权码登录」，或到「添加账号」中使用「从当前登录另存」。
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
                        codeLoginSubmit.mutate({
                          flowId: codeLogin.flow_id,
                          code: authCode.trim(),
                          epoch: codeLoginEpochRef.current,
                        })
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
                    <button type="submit" className="ga-btn-sm-primary shrink-0 text-[11px]" disabled={!authCode.trim() || codeLoginSubmit.isPending}>
                      {codeLoginSubmit.isPending ? '提交中…' : '提交授权码'}
                    </button>
                    <button
                      type="button"
                      className="ga-btn-sm shrink-0 px-2 text-[11px]"
                      aria-label="刷新授权状态"
                      disabled={refreshingCodeLogin || codeLoginSubmit.isPending}
                      onClick={() => {
                        if (refreshCodeLoginBusyRef.current) return
                        refreshCodeLoginBusyRef.current = true
                        action.reset()
                        codeLoginStart.reset()
                        codeLoginSubmit.reset()
                        setCodeLoginRefreshError('')
                        setRefreshingCodeLogin(true)
                        const epoch = codeLoginEpochRef.current
                        void antiApi.codeLoginStatus(codeLogin.flow_id).then(next => {
                          if (!mountedRef.current || epoch !== codeLoginEpochRef.current) return
                          setCodeLogin(next)
                          if (next.phase === 'completed') {
                            setMessage('Google 授权码登录成功，凭据已保存。')
                            setCodeLogin(null)
                            setAuthCode('')
                            void cache.invalidateQueries({ queryKey: key, exact: true })
                            refresh()
                          }
                        }).catch(err => {
                          if (!mountedRef.current || epoch !== codeLoginEpochRef.current) return
                          setCodeLoginRefreshError(extractErrorMessage(err, '刷新授权状态失败'))
                        }).finally(() => {
                          refreshCodeLoginBusyRef.current = false
                          if (mountedRef.current) setRefreshingCodeLogin(false)
                        })
                      }}
                    >
                      {refreshingCodeLogin ? '刷新中…' : '刷新'}
                    </button>
                    <button
                      type="button"
                      className="ga-btn-sm shrink-0 px-2 text-[11px]"
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
                className="ga-btn-sm-primary h-8 shrink-0 text-xs"
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
            <button
              type="button"
              className="ga-btn-sm-danger shrink-0 px-2 text-[11px]"
              disabled={disabled}
              aria-label={`删除账号：${profile.name}`}
              onClick={() => { void confirmDelete(profile) }}
            >
              <Trash2 className="h-3 w-3" aria-hidden="true" />
              <span>删除账号</span>
            </button>
          </div>
        )}
      </div>
    )
  }

  const renderAddAccount = () => {
    return (
      <form onSubmit={add} data-account-add-view className="space-y-2.5 rounded-xl border border-line/70 bg-bg-card p-3">
        <div className="flex items-baseline justify-between gap-2">
          <label htmlFor="agy-profile-name" className="text-xs font-semibold text-ink">账号备注</label>
          <span id="agy-add-help" className="text-[11px] text-ink-muted">新建空白账号或复制当前登录</span>
        </div>
        <input
          id="agy-profile-name"
          value={name}
          maxLength={64}
          onChange={event => setName(event.target.value)}
          disabled={disabled}
          aria-label="账号备注"
          aria-describedby="agy-add-help"
          placeholder="输入备注，如：工作账号"
          className="h-8 w-full rounded-lg border border-line bg-bg-soft/50 px-2.5 text-xs text-ink outline-none focus:border-accent"
        />
        <div className="flex items-center justify-end gap-1.5">
          <button
            type="button"
            className="ga-btn-sm shrink-0 px-2.5 text-[11px]"
            disabled={disabled || !name.trim()}
            onClick={() => {
              if (!disabled && profiles.data && name.trim()) {
                action.mutate({ kind: 'capture', name: name.trim() })
              }
            }}
          >
            从当前登录另存
          </button>
          <button
            type="submit"
            className="ga-btn-sm-primary shrink-0 px-2.5 text-[11px]"
            disabled={disabled || !name.trim()}
          >
            添加
          </button>
        </div>
      </form>
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

  const headerTitle = view.kind === 'list'
    ? '账号管理'
    : view.kind === 'add'
      ? '添加账号'
      : (viewedProfile?.name ?? '账号设置')
  const activeError = action.error ?? codeLoginStart.error ?? codeLoginSubmit.error
  const activeErrorMessage = activeError
    ? extractErrorMessage(activeError, '操作失败')
    : codeLoginRefreshError
  const statusText = action.isPending ? pendingLabel : message

  return <>
    <button
      ref={triggerRef}
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
      aria-controls={open ? popoverId : undefined}
      onClick={() => {
        if (open) {
          restoreFocusOnCloseRef.current = false
          requestClose()
        } else {
          setOpen(true)
        }
      }}
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
    {open && position && createPortal(
      <div
        ref={panelRef}
        className="fixed pt-2"
        style={{ top: position.top, left: position.left, width: position.width, zIndex: Z_LAYERS.popover }}
      >
        <div
          id={popoverId}
          tabIndex={-1}
          role="dialog"
          aria-labelledby="agy-accounts-title"
          className="ga-paper-popover flex flex-col overflow-hidden rounded-xl text-xs text-ink"
          style={{ maxHeight: position.maxHeight }}
        >
          <div className="shrink-0 border-b border-line/60 px-3.5 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                {view.kind !== 'list' && (
                  <button
                    type="button"
                    aria-label="返回账号列表"
                    title="返回账号列表"
                    onClick={() => navigateTo({ kind: 'list' })}
                    className="ga-btn-icon-sm"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
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

              <div className="flex shrink-0 items-center gap-1">
                {view.kind === 'list' && (
                  <button
                    type="button"
                    className="ga-btn-sm shrink-0 px-2 text-[11px]"
                    aria-label="添加账号"
                    title="添加账号"
                    onClick={() => navigateTo({ kind: 'add' })}
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>添加账号</span>
                  </button>
                )}
                <button
                  type="button"
                  aria-label="关闭"
                  title="关闭"
                  onClick={() => {
                    restoreFocusOnCloseRef.current = false
                    requestClose()
                  }}
                  disabled={busy}
                  className="ga-btn-icon-ghost"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                  <span className="sr-only">关闭</span>
                </button>
              </div>
            </div>
          </div>

          {(statusText || activeErrorMessage) && (
            <div data-anti-profiles-pinned-feedback className="shrink-0 space-y-1.5 border-b border-line/50 bg-bg-soft/35 px-3 py-2">
              {statusText && (
                <div role="status" className="rounded-md bg-bg-card/80 px-2.5 py-1.5 text-xs text-ink-muted">
                  {statusText}
                </div>
              )}
              {activeErrorMessage && (
                <p role="alert" className="rounded-lg border border-status-danger-line bg-status-danger-soft px-2.5 py-1.5 text-xs text-status-danger">
                  {activeErrorMessage}
                </p>
              )}
            </div>
          )}

          <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3">
            {view.kind === 'list' ? (
              <div className="space-y-2">
                {profiles.isError && (
                  <div className="flex items-center justify-between gap-2 rounded-lg border border-line bg-bg-card px-3 py-2 text-xs">
                    <p role="alert" className="text-status-danger">{extractErrorMessage(profiles.error, '读取账号列表失败')}</p>
                    <button type="button" className="ga-btn-sm shrink-0 px-2 text-[11px]" onClick={() => void profiles.refetch()} disabled={profiles.isFetching}>
                      重试
                    </button>
                  </div>
                )}
                {profiles.isPending && <p role="status" className="text-xs text-ink-muted">正在加载账号…</p>}

                {profiles.data && usingHiddenDefault && (
                  <div className="rounded-lg border border-line/60 bg-bg-soft/45 px-2.5 py-1.5 text-[11px] text-ink-muted">
                    当前仍使用系统默认登录态
                    {(selected?.cooldown_seconds ?? 0) > 0 ? `（风控冷却 ${selected!.cooldown_seconds}s）` : ''}
                    {orderedProfiles.length > 0 ? '，点击下方账号即可切换管理。' : '，可点击右上角「添加账号」新建或另存账号。'}
                  </div>
                )}

                {profiles.data && (
                  orderedProfiles.length > 0 ? (
                    <ul className="space-y-1.5" aria-label="账号列表">
                      {orderedProfiles.map(profile => renderAccountCard(profile, profile.id === selected?.id))}
                    </ul>
                  ) : (
                    <div className="rounded-xl border border-dashed border-line/70 px-4 py-5 text-center text-xs text-ink-muted">
                      <p>暂无账号</p>
                      <button
                        type="button"
                        className="ga-btn-sm-primary mt-2 shrink-0 text-[11px]"
                        onClick={() => navigateTo({ kind: 'add' })}
                      >
                        添加账号
                      </button>
                    </div>
                  )
                )}
              </div>
            ) : view.kind === 'account' ? (
              viewedProfile ? renderAccountSettings(viewedProfile) : null
            ) : (
              renderAddAccount()
            )}
          </div>
        </div>
      </div>,
      document.body,
    )}
  </>
}
