import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LoaderCircle, RotateCw, ShieldCheck, ShieldMinus, ShieldX, Square } from 'lucide-react'
import clsx from 'clsx'
import { antiApi } from '@/api/client'
import { toast } from '@/stores/toastStore'
import { errorMessageFromError } from '@/utils/sessionUi'
import { StatusIconGlyph, statusBadgeToneClass, type StatusBadgeKind } from './ActionIcons'

const key = ['anti-daemon-status'] as const

export function useAntiDaemonStatus() {
  const cache = useQueryClient()
  const status = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => antiApi.daemonStatus(signal),
    retry: false,
    refetchInterval: ({ state }) => state.data?.state === 'starting' || state.data?.auth_state === 'checking' ? 1_000 : 10_000,
  })
  const start = useMutation({
    mutationFn: () => antiApi.daemonStart(),
    onMutate: () => cache.cancelQueries({ queryKey: key }),
    onSuccess: data => { cache.setQueryData(key, data) },
    onError: error => { toast.error(errorMessageFromError(error, '启动 Anti 网关失败')) },
  })
  const stop = useMutation({
    mutationFn: () => antiApi.daemonStop(),
    onMutate: () => cache.cancelQueries({ queryKey: key }),
    onSuccess: data => { cache.setQueryData(key, data) },
    onError: error => { toast.error(errorMessageFromError(error, '停止 Anti 网关失败')) },
  })
  const restart = useMutation({
    mutationFn: () => antiApi.daemonRestart(),
    onMutate: () => cache.cancelQueries({ queryKey: key }),
    onSuccess: data => { cache.setQueryData(key, data) },
    onError: error => { toast.error(errorMessageFromError(error, '重启 Anti 网关失败')) },
  })
  const state = status.isError ? 'unavailable' : status.data?.state
  const busy = start.isPending || stop.isPending || restart.isPending || state === 'starting'
  const running = !busy && state === 'ready'
  // Only an explicit `false` from backend identifies an externally started daemon.
  const external = running && status.data?.managed === false
  return {
    status,
    start,
    stop,
    restart,
    state,
    busy,
    running,
    managed: !external,
    external,
    refresh: () => { void cache.invalidateQueries({ queryKey: key }) },
  }
}

export function AntiDaemonControl({
  status,
  start,
  stop,
  restart,
  state,
  busy,
  running,
  managed,
  external,
}: ReturnType<typeof useAntiDaemonStatus>) {
  const canStart = !busy && state === 'stopped'
  const canControl = !busy && (running || state === 'unavailable')
  const label = busy ? 'Anti 启动中' : external ? '外部 Anti 网关运行中' : running ? 'Anti 网关运行中'
    : canStart ? '启动 Anti' : state === 'unavailable' ? 'Anti 网关不可用' : '正在检查 Anti'
  const auth = running && status.data?.agy_available ? status.data.auth_state ?? 'unverified' : null
  const authLabel = auth === 'authenticated' ? 'agy 已验证登录' : auth === 'login_required' ? 'agy 需要登录'
    : auth === 'checking' ? '正在验证 agy 登录' : auth === 'unverified' ? '无法验证 agy 登录' : 'agy 登录状态未知'
  const detail = (canStart ? start.error?.message : undefined)
    ?? stop.error?.message
    ?? restart.error?.message
    ?? status.error?.message
    ?? status.data?.detail
  const runtimeMeta = running
    ? [
        status.data?.port ? `:${status.data.port}` : undefined,
        status.data?.version ? `v${status.data.version}` : undefined,
        typeof status.data?.active_count === 'number' && status.data.active_count > 0
          ? `${status.data.active_count} 个运行中任务`
          : undefined,
      ].filter(Boolean).join(' · ')
    : undefined
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
  const gatewayTitle = [label, runtimeMeta, detail].filter(Boolean).join(' · ')
  const externalDisabledReason = '当前为外部启动的 AntiCLI 网关，请在外部终端停止或重启'

  return (
    <div className="flex shrink-0 items-center gap-1.5" aria-label="Anti 状态" role="group">
      <span className="inline-flex" title={gatewayTitle}>
        <button
          type="button"
          className={clsx('ga-badge', canStart
            ? 'border-status-danger bg-status-danger text-white cursor-pointer hover:border-status-danger-strong hover:bg-status-danger-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
            : statusBadgeToneClass(gatewayKind))}
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
      {canControl && <>
        <button
          type="button"
          disabled={!managed}
          className={clsx(
            'ga-badge border-line bg-bg-card text-ink-muted transition-colors',
            managed ? 'cursor-pointer hover:border-accent/50 hover:text-ink' : 'cursor-not-allowed opacity-45',
          )}
          aria-label="重启 Anti 网关"
          title={managed ? '重启 Anti 网关' : externalDisabledReason}
          onClick={() => { if (managed) restart.mutate() }}
        >
          <RotateCw className="h-3.5 w-3.5" strokeWidth={1.85} aria-hidden="true" />
        </button>
        {running && <button
          type="button"
          disabled={!managed}
          className={clsx(
            'ga-badge border-line bg-bg-card text-ink-muted transition-colors',
            managed ? 'cursor-pointer hover:border-status-danger hover:text-status-danger' : 'cursor-not-allowed opacity-45',
          )}
          aria-label="停止 Anti 网关"
          title={managed ? '停止 Anti 网关' : externalDisabledReason}
          onClick={() => { if (managed) stop.mutate() }}
        >
          <Square className="h-3.5 w-3.5" strokeWidth={1.85} aria-hidden="true" />
        </button>}
      </>}
      <span role="status" className="sr-only">
        {running ? authLabel : label}{detail && `：${detail}`}
      </span>
    </div>
  )
}
