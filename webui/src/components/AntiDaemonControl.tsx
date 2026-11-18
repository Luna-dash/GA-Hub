import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleAlert, CircleCheck, LoaderCircle, Power } from 'lucide-react'
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
    : auth === 'checking' ? '正在验证 agy 登录' : auth === 'unverified' ? '无法验证 agy 登录' : null
  const detail = (canStart ? start.error?.message : undefined) ?? status.error?.message ?? status.data?.detail
  const Icon = busy || !state ? LoaderCircle : running ? CircleCheck : canStart ? Power : CircleAlert
  const title = detail ? `${label}：${detail}` : label

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        className={clsx('flex min-h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-line px-2.5 text-xs font-medium',
          canStart ? 'bg-bg-card text-ink hover:bg-bg-soft' : 'text-ink-muted')}
        title={title}
        aria-label={label}
        disabled={!canStart}
        onClick={() => start.mutate()}
      >
        <Icon size={14} aria-hidden="true" className={clsx((busy || !state) && 'animate-spin')} />
        {label}
      </button>
      <div role="status" className={clsx(detail || authLabel ? 'max-w-[min(16rem,50vw)] text-right text-xs text-ink-muted [overflow-wrap:anywhere]' : 'sr-only')}>
        {authLabel && <div className={clsx(auth === 'authenticated' && 'text-status-success')} title="登录验证不代表模型推理可用">
          {authLabel}
        </div>}
        {detail ?? (!authLabel && label)}
      </div>
    </div>
  )
}
