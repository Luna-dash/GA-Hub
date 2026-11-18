import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleAlert, CircleCheck, LoaderCircle, Power } from 'lucide-react'
import clsx from 'clsx'
import type { components } from '@/api/generated/schema'
import { resolveApiUrl } from '@/runtime/runtimeConfig'

type Status = components['schemas']['AntiDaemonStatus']
const key = ['anti-daemon-status'] as const

async function request(path: 'status' | 'start', signal?: AbortSignal): Promise<Status> {
  const res = await fetch(resolveApiUrl(`/api/anti/${path}`), {
    signal,
    ...(path === 'start' ? { method: 'POST', headers: { 'X-GA-Hub-Action': 'start-anti' } } : {}),
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
    refetchInterval: ({ state }) => state.data?.state === 'starting' ? 800 : 10_000,
  })
  const start = useMutation({
    mutationFn: () => request('start'),
    onMutate: () => cache.cancelQueries({ queryKey: key }),
    onSuccess: data => { cache.setQueryData(key, data) },
  })
  const state = status.isError ? 'unavailable' : status.data?.state
  const busy = start.isPending || state === 'starting'
  const ready = !busy && state === 'ready' && status.data?.agy_available === true
  const canStart = !busy && state === 'stopped'
  const label = busy ? 'Anti 启动中' : ready ? 'Anti 已就绪' : canStart ? '启动 Anti'
    : state === 'ready' ? 'Anti 缺少 agy' : state === 'unavailable' ? 'Anti 不可用' : '正在检查 Anti'
  const detail = (canStart ? start.error?.message : undefined) ?? status.error?.message ?? status.data?.detail
  const Icon = busy || !state ? LoaderCircle : ready ? CircleCheck : canStart ? Power : CircleAlert
  const title = detail ? `${label}：${detail}` : label

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        className={clsx('flex min-h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-line px-2.5 text-xs font-medium',
          canStart ? 'bg-bg-card text-ink hover:bg-bg-soft' : ready ? 'text-status-success' : 'text-ink-muted')}
        title={title}
        aria-label={label}
        disabled={!canStart}
        onClick={() => start.mutate()}
      >
        <Icon size={14} aria-hidden="true" className={clsx((busy || !state) && 'animate-spin')} />
        {label}
      </button>
      <span role="status" className={clsx(detail ? 'max-w-[min(16rem,50vw)] text-right text-xs text-ink-muted [overflow-wrap:anywhere]' : 'sr-only')}>
        {detail ?? label}
      </span>
    </div>
  )
}
