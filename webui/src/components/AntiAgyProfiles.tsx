import { useEffect, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { UserRound } from 'lucide-react'
import clsx from 'clsx'
import type { components } from '@/api/generated/schema'
import { antiApi } from '@/api/client'
import { ModalOverlay } from '@/components/ModalOverlay'
import { resolveApiUrl } from '@/runtime/runtimeConfig'
import type { useAntiDaemonStatus } from './AntiDaemonControl'

type Profiles = components['schemas']['AgyProfiles']
type Profile = components['schemas']['AgyProfile']
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
}: {
  profiles: ReturnType<typeof useAgyProfiles>
  refresh: () => void
  daemon?: ReturnType<typeof useAntiDaemonStatus>
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const cache = useQueryClient()
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = controlledOpen ?? uncontrolledOpen
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setUncontrolledOpen(next)
    onOpenChange?.(next)
  }
  const [name, setName] = useState('')
  const [editing, setEditing] = useState<{ profile: Profile; name: string } | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [showLogs, setShowLogs] = useState(false)
  const [message, setMessage] = useState('')
  const prevLoginProfile = useRef<string | null | undefined>(undefined)

  useEffect(() => {
    const current = profiles.data?.login_profile ?? null
    if (prevLoginProfile.current && !current) {
      refresh()
      setMessage(old => old || '官方登录窗口已关闭，已刷新账号凭据状态。')
    }
    prevLoginProfile.current = current
  }, [profiles.data?.login_profile, refresh])

  const logs = useQuery({
    queryKey: ['anti-daemon-logs'],
    enabled: open && showLogs,
    queryFn: ({ signal }) => antiApi.daemonLogs(80, signal),
    retry: false,
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
        setMessage(`已添加「${profile.name}」。请在该账号旁点「官方登录」，完成登录并关闭 CLI 窗口后再切换。`)
      } else if (args.kind === 'capture') {
        const profile = await antiApi.captureProfile(args.name)
        setName('')
        setMessage(`已将当前系统登录另存为独立账号「${profile.name}」。`)
      } else if (args.kind === 'rename') {
        const profile = await request<Profile>(`/${encodeURIComponent(args.profile.id)}`, {
          method: 'PATCH',
          headers: { ...write.headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: args.name }),
        })
        cache.setQueryData<Profiles>(key, old => old && ({ ...old, profiles: old.profiles.map(p => p.id === profile.id ? profile : p) }))
        setEditing(null)
        setMessage(`账号备注已改为「${profile.name}」。`)
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
        setMessage(`已删除账号「${args.profile.name}」。`)
      } else if (args.kind === 'logout') {
        const updated = await antiApi.clearProfileCredentials(args.profile.id)
        cache.setQueryData<Profiles>(key, old => old && ({
          ...old,
          profiles: old.profiles.map(p => p.id === updated.id ? updated : p),
        }))
        setMessage(`已清除「${args.profile.name}」的登录凭据与缓存额度，保留了多轮会话记录。`)
      } else if (args.kind === 'check-usage') {
        const usage = await antiApi.accountUsage()
        setMessage(usage.rows.length > 0 ? `已刷新额度（${usage.rows.length} 项模型）。` : '未读取到额度信息，请确认已登录并重试。')
      } else {
        await request(`/${encodeURIComponent(args.profile.id)}/login`, write)
        setMessage(`已为「${args.profile.name}」打开官方 CLI。请完成登录并关闭该窗口，再回这里切换。`)
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

  const selected = profiles.data?.profiles.find(item => item.id === profiles.data?.active)
  const others = profiles.data?.profiles.filter(item => item.id !== profiles.data?.active) ?? []
  const loginProfile = profiles.data?.login_profile
  const close = () => {
    if (action.isPending) return
    setOpen(false)
    setEditing(null)
    setConfirmDeleteId(null)
    setShowLogs(false)
    setMessage('')
    action.reset()
  }
  const disabled = action.isPending || profiles.isError
  const add = (event: FormEvent) => {
    event.preventDefault()
    if (!disabled && profiles.data && name.trim()) action.mutate({ kind: 'create', name: name.trim() })
  }
  const pendingLabel = action.variables?.kind === 'switch' ? '正在切换账号…'
    : action.variables?.kind === 'login' ? '正在打开官方 CLI…'
    : action.variables?.kind === 'logout' ? '正在清除账号凭据…'
    : action.variables?.kind === 'rename' ? '正在保存备注…'
    : action.variables?.kind === 'capture' ? '正在从当前系统登录另存…'
    : action.variables?.kind === 'delete' ? '正在删除账号…'
    : action.variables?.kind === 'check-usage' ? '正在刷新当前账号额度…'
    : '正在添加账号…'
  const secondary = 'ga-btn shrink-0'
  const daemonError = daemon?.start.error ?? daemon?.stop.error ?? daemon?.restart.error
  const nonWindows = typeof navigator !== 'undefined' && /mac|linux|x11/i.test(navigator.platform)
  const editButton = (profile: Profile) => profile.id !== 'default' && (
    <button type="button" className={secondary} disabled={disabled} aria-label={`修改备注：${profile.name}`}
      onClick={() => { action.reset(); setMessage(''); setConfirmDeleteId(null); setEditing({ profile, name: profile.name }) }}>修改备注</button>
  )

  const renderProfileMeta = (profile: Profile) => {
    const badge = authBadge(profile, loginProfile === profile.id)
    const usage = profile.usage
    const pct = usage?.min_remaining_pct
    return (
      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
        <span className={clsx('inline-flex items-center rounded-md border px-1.5 py-0.5 font-medium', badge.tone)}>
          {badge.label}
        </span>
        {typeof pct === 'number' && (
          <span className={clsx('font-semibold tabular-nums', quotaTone(pct))} title={usage?.checked_at ? `上次检测：${resetTimeFormat.format(new Date(usage.checked_at))}` : undefined}>
            最低剩余 {pct}%
          </span>
        )}
        {usage?.checked_at && (
          <span className="tabular-nums">
            检测于 {resetTimeFormat.format(new Date(usage.checked_at))}
          </span>
        )}
      </div>
    )
  }

  const triggerLabel = selected ? `Agy 账号：${selected.name}` : 'Agy 账号'
  const customActive = Boolean(selected && selected.id !== 'default')

  return <>
    <button
      type="button"
      className={clsx(
        'relative inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-bg-card transition hover:bg-bg-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
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
      panelClassName="max-h-[90vh] w-full max-w-lg space-y-4 overflow-auto p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="agy-accounts-title" className="text-base font-semibold">Agy CLI 账号</h2>
          <p className="mt-1 text-sm text-ink-muted">「系统默认」沿用当前系统的 agy 登录。其他账号各自隔离凭据与历史，切换只影响 GA-Hub。</p>
        </div>
        <button type="button" className={secondary} onClick={close} disabled={action.isPending}>关闭</button>
      </div>
      {daemon && (
        <div className="space-y-1.5 rounded-lg border border-line/70 bg-bg-soft px-3 py-2 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0 space-y-0.5 text-ink-muted">
              <div>
                网关状态：<strong className="font-semibold text-ink">
                  {daemon.external ? '外部网关运行中' : daemon.running ? '运行中' : daemon.busy ? '处理中' : daemon.state === 'stopped' ? '已停止' : '不可用'}
                </strong>
                {daemon.running && daemon.status.data?.port && (
                  <span className="ml-1.5 tabular-nums">:{daemon.status.data.port}</span>
                )}
                {daemon.running && daemon.status.data?.version && (
                  <span className="ml-1.5">v{daemon.status.data.version}</span>
                )}
              </div>
              {daemon.external && (
                <p className="text-[11px] text-ink-muted">当前网关由外部启动，GA-Hub 不会接管启停；如需切换隔离账号请先在外部停止网关。</p>
              )}
              {daemon.state === 'unavailable' && daemon.status.data?.detail && (
                <p className="text-[11px] text-status-danger">{daemon.status.data.detail}</p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {!daemon.running && daemon.state === 'stopped' && (
                <button type="button" className={secondary} disabled={daemon.busy} onClick={() => daemon.start.mutate()}>启动网关</button>
              )}
              {(daemon.running || daemon.state === 'unavailable') && daemon.managed && (
                <button type="button" className={secondary} disabled={daemon.busy} onClick={() => daemon.restart.mutate()}>重启网关</button>
              )}
              {daemon.running && daemon.managed && (
                <button type="button" className={secondary} disabled={daemon.busy} onClick={() => daemon.stop.mutate()}>停止网关</button>
              )}
              <button type="button" className={secondary} onClick={() => setShowLogs(v => !v)}>
                {showLogs ? '隐藏日志' : '网关日志'}
              </button>
            </div>
          </div>
          {showLogs && (
            <div className="border-t border-line/60 pt-2">
              <div className="mb-1 flex items-center justify-between text-[11px] text-ink-muted">
                <span className="truncate" title={logs.data?.log_path}>最近 AntiCLI 网关日志</span>
                <button type="button" className="text-accent hover:underline" disabled={logs.isFetching} onClick={() => void logs.refetch()}>
                  {logs.isFetching ? '刷新中…' : '刷新'}
                </button>
              </div>
              {logs.error ? (
                <p className="text-[11px] text-status-danger">{logs.error.message}</p>
              ) : logs.data?.lines.length ? (
                <pre className="max-h-36 overflow-auto rounded bg-bg-card p-2 font-mono text-[11px] leading-4 text-ink whitespace-pre-wrap break-all">
                  {logs.data.lines.join('\n')}
                </pre>
              ) : (
                <p className="text-[11px] text-ink-muted">{logs.isPending ? '正在读取日志…' : '暂无托管网关启动日志。'}</p>
              )}
            </div>
          )}
        </div>
      )}
      <div role="status" className="text-sm text-ink-muted empty:hidden">{action.isPending ? pendingLabel : message}</div>
      {(action.error || daemonError) && (
        <p role="alert" className="rounded-lg border border-status-danger-line bg-status-danger-soft p-2 text-sm text-status-danger">
          {(action.error ?? daemonError)!.message}
        </p>
      )}
      {profiles.isError && <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-2 text-sm">
        <p role="alert">{profiles.error.message}</p>
        <button type="button" className={secondary} onClick={() => void profiles.refetch()} disabled={profiles.isFetching}>重试加载账号</button>
      </div>}
      {profiles.isPending && <p role="status" className="text-sm text-ink-muted">正在加载账号…</p>}
      {profiles.data && <>
        {selected && <section className="rounded-lg border border-line/70 p-3" aria-labelledby="agy-active-account">
          <h3 id="agy-active-account" className="text-sm font-semibold">当前账号</h3>
          <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="break-all text-sm font-medium">{selected.name}</div>
              {renderProfileMeta(selected)}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {daemon?.running && (
                <button type="button" className={secondary} disabled={disabled}
                  onClick={() => action.mutate({ kind: 'check-usage' })}>刷新额度</button>
              )}
              {editButton(selected)}
              {selected.id !== 'default' && (selected.has_credentials || selected.auth_state === 'authenticated') && (!daemon || daemon.state === 'stopped') && (
                <button type="button" className={secondary} disabled={disabled}
                  aria-label={`清除凭据：${selected.name}`}
                  onClick={() => action.mutate({ kind: 'logout', profile: selected })}>清除凭据</button>
              )}
              <button type="button" className={secondary} disabled={disabled || nonWindows}
                title={nonWindows ? '从 GA-Hub 直接唤起官方登录窗口仅支持 Windows，请在终端设置隔离 HOME 后运行 agy 登录' : undefined}
                aria-label={`官方登录：${selected.name}`} onClick={() => action.mutate({ kind: 'login', profile: selected })}>官方登录</button>
            </div>
          </div>
          {nonWindows && (
            <p className="mt-2 text-[11px] text-ink-muted">当前非 Windows 系统：可在终端将隔离账号目录设为 `HOME` 后运行 `agy` 登录，或通过下方「从当前登录另存」导入凭据。</p>
          )}
          {selected.usage?.rows?.length ? (
            <div className="mt-2 grid grid-cols-2 gap-1.5 border-t border-line/60 pt-2 text-xs sm:grid-cols-3">
              {selected.usage.rows.map(row => (
                <div key={`${row.model}-${row.limit}`} className="rounded-md bg-bg-soft px-2 py-1">
                  <div className="truncate font-medium text-ink" title={row.model}>{row.model}</div>
                  <div className={clsx('tabular-nums font-semibold', quotaTone(row.remaining_pct))}>{row.remaining_pct}%</div>
                </div>
              ))}
            </div>
          ) : null}
        </section>}
        <section aria-labelledby="agy-other-accounts">
          <h3 id="agy-other-accounts" className="mb-1 text-sm font-semibold">其他账号</h3>
          {others.length === 0 ? <p className="text-sm text-ink-muted">暂无可切换账号，请先添加。</p> :
            <ul className="divide-y divide-line/60 rounded-lg border border-line/70">
              {others.map(profile => <li key={profile.id} className="flex flex-wrap items-center gap-2 p-2">
                <div className="min-w-0 flex-1 px-1">
                  <div className="break-all text-sm">{profile.name}</div>
                  {renderProfileMeta(profile)}
                </div>
                {editButton(profile)}
                {profile.id !== 'default' && (profile.has_credentials || profile.auth_state === 'authenticated') && (
                  <button type="button" className={secondary} disabled={disabled}
                    aria-label={`清除凭据：${profile.name}`}
                    onClick={() => action.mutate({ kind: 'logout', profile })}>清除凭据</button>
                )}
                {profile.id !== 'default' && (
                  confirmDeleteId === profile.id ? (
                    <div className="flex items-center gap-1">
                      <button type="button" className="ga-btn-danger shrink-0" disabled={disabled}
                        aria-label={`确认删除：${profile.name}`} onClick={() => action.mutate({ kind: 'delete', profile })}>确认删除</button>
                      <button type="button" className={secondary} disabled={disabled}
                        onClick={() => setConfirmDeleteId(null)}>取消</button>
                    </div>
                  ) : (
                    <button type="button" className={secondary} disabled={disabled}
                      aria-label={`删除账号：${profile.name}`} onClick={() => setConfirmDeleteId(profile.id)}>删除</button>
                  )
                )}
                <button type="button" className={secondary} disabled={disabled || nonWindows}
                  title={nonWindows ? '仅支持在 Windows 上直接唤起官方登录窗口' : undefined}
                  aria-label={`官方登录：${profile.name}`}
                  onClick={() => action.mutate({ kind: 'login', profile })}>官方登录</button>
                <button type="button" className="ga-btn-primary shrink-0" disabled={disabled} aria-label={`切换到${profile.name}`}
                  onClick={() => action.mutate({ kind: 'switch', profile })}>切换</button>
              </li>)}
            </ul>}
        </section>
        {editing && <form onSubmit={event => {
          event.preventDefault()
          const value = editing.name.trim()
          if (!disabled && value && value !== editing.profile.name) action.mutate({ kind: 'rename', profile: editing.profile, name: value })
        }} className="space-y-2 border-t border-line/70 pt-3">
          <label htmlFor="agy-edit-name" className="text-sm font-semibold">修改「{editing.profile.name}」的备注</label>
          <div className="flex flex-wrap gap-2">
            <input id="agy-edit-name" value={editing.name} maxLength={64} disabled={disabled}
              onChange={event => setEditing({ ...editing, name: event.target.value })}
              className="min-w-0 flex-1 rounded-lg border border-line bg-transparent px-2 text-sm" />
            <button type="submit" className={secondary} disabled={disabled || !editing.name.trim() || editing.name.trim() === editing.profile.name}>保存备注</button>
            <button type="button" className={secondary} disabled={action.isPending} onClick={() => { action.reset(); setEditing(null) }}>取消</button>
          </div>
        </form>}
        <form onSubmit={add} className="space-y-2 border-t border-line/70 pt-3">
          <label htmlFor="agy-profile-name" className="text-sm font-semibold">添加账号</label>
          <p id="agy-add-help" className="text-sm text-ink-muted">新建空白账号需通过官方 CLI 登录一次；也可直接把本机当前登录另存为独立账号。</p>
          <div className="flex flex-wrap gap-2">
            <input id="agy-profile-name" value={name} maxLength={64} onChange={event => setName(event.target.value)} disabled={disabled}
              aria-label="账号备注" aria-describedby="agy-add-help" placeholder="例如：工作账号"
              className="min-w-0 flex-1 rounded-lg border border-line bg-transparent px-2 text-sm" />
            <button type="submit" className={secondary} disabled={disabled || !name.trim()}>添加账号</button>
            <button type="button" className={secondary} disabled={disabled || !name.trim()}
              onClick={() => { if (!disabled && profiles.data && name.trim()) action.mutate({ kind: 'capture', name: name.trim() }) }}>
              从当前登录另存
            </button>
          </div>
        </form>
      </>}
    </ModalOverlay>, document.body)}
  </>
}
