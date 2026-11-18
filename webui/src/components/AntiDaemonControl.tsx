import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleAlert, LoaderCircle, Power, Radio, ShieldCheck, ShieldMinus, ShieldX } from 'lucide-react'
import clsx from 'clsx'
import type { components } from '@/api/generated/schema'
import { resolveApiUrl } from '@/runtime/runtimeConfig'

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

export function AntiDaemonControl() {
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
  const canStart = !busy && state === 'stopped'
  const label = busy ? 'Anti 启动中' : running ? 'Anti 网关运行中' : canStart ? '启动 Anti'
    : state === 'unavailable' ? 'Anti 网关不可用' : '正在检查 Anti'
  const auth = running && status.data?.agy_available ? status.data.auth_state ?? 'unverified' : null
  const authLabel = auth === 'authenticated' ? 'agy 已验证登录' : auth === 'login_required' ? 'agy 需要登录'
    : auth === 'checking' ? '正在验证 agy 登录' : auth === 'unverified' ? '无法验证 agy 登录' : 'agy 登录状态未知'
  const detail = (canStart ? start.error?.message : undefined) ?? status.error?.message ?? status.data?.detail
  const loading = busy || !state
  const GatewayIcon = loading ? LoaderCircle : running ? Radio : canStart ? Power : CircleAlert
  const AuthIcon = auth === 'checking' ? LoaderCircle : auth === 'authenticated' ? ShieldCheck
    : auth === 'login_required' ? ShieldX : ShieldMinus
  const gatewayTitle = [label, detail].filter(Boolean).join(' · ')

  return (
    <div className="flex shrink-0 items-center gap-1" aria-label="Anti 状态" role="group">
      <span className="inline-flex" title={gatewayTitle}>
        <button
          type="button"
          className={clsx('inline-flex size-8 items-center justify-center rounded-lg border',
            running ? 'border-status-success-line bg-status-success-soft text-status-success'
              : 'border-line bg-bg-card text-ink-muted',
            canStart && 'hover:border-accent/40 hover:bg-bg-soft hover:text-accent focus-visible:outline focus-visible:outline-accent')}
          aria-label={label}
          disabled={!canStart}
          onClick={() => start.mutate()}
        >
          <GatewayIcon size={16} aria-hidden="true" className={clsx(loading && 'motion-safe:animate-spin')} />
        </button>
      </span>
      <span title={auth === 'authenticated' ? `${authLabel}（登录验证不代表模型推理可用）` : authLabel}
        role="img" aria-label={authLabel}
        className={clsx('inline-flex size-8 items-center justify-center rounded-lg border',
          auth === 'authenticated' ? 'border-status-success-line bg-status-success-soft text-status-success'
            : auth === 'login_required' ? 'border-status-warning-line bg-status-warning-soft text-status-warning'
              : 'border-line bg-bg-card text-ink-muted')}>
        <AuthIcon size={16} aria-hidden="true" className={clsx(auth === 'checking' && 'motion-safe:animate-spin')} />
      </span>
      <span role="status" className="sr-only">
        {running ? authLabel : label}{detail && `：${detail}`}
      </span>
    </div>
  )
}
