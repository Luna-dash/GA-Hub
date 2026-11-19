import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LoaderCircle, ShieldCheck, ShieldMinus, ShieldX } from 'lucide-react'
import clsx from 'clsx'
import type { components } from '@/api/generated/schema'
import { resolveApiUrl } from '@/runtime/runtimeConfig'
import { StatusIconGlyph, statusBadgeToneClass, type StatusBadgeKind } from './ActionIcons'

type Status = components['schemas']['AntiDaemonStatus']
const key = ['anti-daemon-status'] as const

async function request(path: 'status' | 'start', signal?: AbortSignal): Promise<Status> {
  const starting = path === 'start'
  const res = await fetch(resolveApiUrl(`/api/anti/${path}`), {
    signal,
    method: starting ? 'POST' : 'GET',
    headers: { 'X-GA-Hub-Action': starting ? 'start-anti' : 'verify-anti-auth' },
  })
  if (!res.ok) {
    const error = await res.json().catch(() => null)
    throw new Error(typeof error?.detail === 'string' ? error.detail : `Anti 请求失败 (${res.status})`)
  }
  return res.json()
}

export function useAntiDaemonStatus() {
  const cache = useQueryClient()
  const status = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => request('status', signal),
    retry: false,
    refetchInterval: ({ state }) => state.data?.state === 'starting' || state.data?.auth_state === 'checking' ? 1_000 : 10_000,
  })
  const start = useMutation({
    mutationFn: () => request('start'),
    onMutate: () => cache.cancelQueries({ queryKey: key }),
    onSuccess: data => { cache.setQueryData(key, data) },
  })
  const state = status.isError ? 'unavailable' : status.data?.state
  const busy = start.isPending || state === 'starting'
  const running = !busy && state === 'ready'
  return { status, start, state, busy, running, refresh: () => { void cache.invalidateQueries({ queryKey: key }) } }
}

export function AntiDaemonControl({ status, start, state, busy, running }: ReturnType<typeof useAntiDaemonStatus>) {
  const canStart = !busy && state === 'stopped'
  const label = busy ? 'Anti 启动中' : running ? 'Anti 网关运行中' : canStart ? '启动 Anti'
    : state === 'unavailable' ? 'Anti 网关不可用' : '正在检查 Anti'
  const auth = running && status.data?.agy_available ? status.data.auth_state ?? 'unverified' : null
  const authLabel = auth === 'authenticated' ? 'agy 已验证登录' : auth === 'login_required' ? 'agy 需要登录'
    : auth === 'checking' ? '正在验证 agy 登录' : auth === 'unverified' ? '无法验证 agy 登录' : 'agy 登录状态未知'
  const detail = (canStart ? start.error?.message : undefined) ?? status.error?.message ?? status.data?.detail
  const loading = busy || !state
  const gatewayKind: StatusBadgeKind = loading
    ? 'connecting'
    : running
      ? 'connected'
      : state === 'unavailable'
        ? 'error'
        : 'offline'
  const AuthIcon = auth === 'checking' ? LoaderCircle : auth === 'authenticated' ? ShieldCheck
    : auth === 'login_required' ? ShieldX : ShieldMinus
  const gatewayTitle = [label, detail].filter(Boolean).join(' · ')

  return (
    <div className="flex shrink-0 items-center gap-1.5" aria-label="Anti 状态" role="group">
      <span className="inline-flex" title={gatewayTitle}>
        <button
          type="button"
          className={clsx('ga-badge', statusBadgeToneClass(gatewayKind),
            canStart && 'cursor-pointer hover:brightness-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent')}
          aria-label={label}
          disabled={!canStart}
          onClick={() => start.mutate()}
        >
          <StatusIconGlyph kind={gatewayKind} />
        </button>
      </span>
      <span title={authLabel}
        role="img" aria-label={authLabel}
        className={clsx('ga-badge',
          auth === 'authenticated' ? 'ga-badge-connected'
            : auth === 'login_required' ? 'ga-badge-connecting'
              : auth === 'checking' ? 'ga-badge-connecting'
                : 'border-line bg-bg-card text-ink-muted')}>
        <AuthIcon className={clsx('h-3.5 w-3.5', auth === 'checking' && 'animate-spin motion-safe:animate-spin')} strokeWidth={1.85} aria-hidden="true" />
      </span>
      <span role="status" className="sr-only">
        {running ? authLabel : label}{detail && `：${detail}`}
      </span>
    </div>
  )
}
