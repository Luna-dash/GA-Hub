import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LoaderCircle, Power, RotateCw, ShieldCheck, ShieldMinus, ShieldX } from 'lucide-react'
import clsx from 'clsx'
import { antiApi, HttpError } from '@/api/client'
import { toast } from '@/stores/toastStore'
import { errorMessageFromError } from '@/utils/sessionUi'
import { StatusIconGlyph, statusBadgeToneClass, type StatusBadgeKind } from './ActionIcons'

const key = ['anti-daemon-status'] as const

export function useAntiDaemonStatus() {
  const cache = useQueryClient()
  const [forceConflict, setForceConflict] = useState<'stop' | 'restart' | null>(null)
  const status = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => antiApi.daemonStatus(signal),
    retry: false,
    refetchInterval: ({ state }) => state.data?.state === 'starting' || state.data?.auth_state === 'checking' ? 1_000 : 10_000,
  })
  useEffect(() => {
    if (status.data?.active_count === 0 || status.data?.state === 'stopped') {
      setForceConflict(null)
    }
  }, [status.data?.active_count, status.data?.state])
  const start = useMutation({
    mutationFn: () => antiApi.daemonStart(),
    onMutate: () => cache.cancelQueries({ queryKey: key }),
    onSuccess: data => {
      setForceConflict(null)
      cache.setQueryData(key, data)
    },
    onError: error => { toast.error(errorMessageFromError(error, '启动 Anti 网关失败')) },
  })
  const stop = useMutation({
    mutationFn: (force?: boolean | void) => antiApi.daemonStop(Boolean(force)),
    onMutate: () => cache.cancelQueries({ queryKey: key }),
    onSuccess: data => {
      setForceConflict(null)
      cache.setQueryData(key, data)
      void cache.invalidateQueries({ queryKey: ['anti-sessions'] })
      void cache.invalidateQueries({ queryKey: ['anti-workers'] })
      void cache.invalidateQueries({ queryKey: ['anti-runs'] })
    },
    onError: (error, force) => {
      if (!force && error instanceof HttpError && error.status === 409) {
        setForceConflict('stop')
      }
      toast.error(errorMessageFromError(error, '停止 Anti 网关失败'))
    },
  })
  const restart = useMutation({
    mutationFn: (force?: boolean | void) => antiApi.daemonRestart(Boolean(force)),
    onMutate: () => cache.cancelQueries({ queryKey: key }),
    onSuccess: data => {
      setForceConflict(null)
      cache.setQueryData(key, data)
      void cache.invalidateQueries({ queryKey: ['anti-sessions'] })
      void cache.invalidateQueries({ queryKey: ['anti-workers'] })
      void cache.invalidateQueries({ queryKey: ['anti-runs'] })
    },
    onError: (error, force) => {
      if (!force && error instanceof HttpError && error.status === 409) {
        setForceConflict('restart')
      }
      toast.error(errorMessageFromError(error, '重启 Anti 网关失败'))
    },
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
    forceConflict,
    clearForceConflict: () => setForceConflict(null),
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
  forceConflict,
  clearForceConflict,
}: ReturnType<typeof useAntiDaemonStatus>) {
  const canStart = !busy && state === 'stopped'
  const canControl = !busy && (running || state === 'unavailable')
  const label = busy ? 'Agy 启动中' : external ? '外部 Agy 运行中' : running ? 'Agy ACP 运行中'
    : canStart ? '启用 Agy' : state === 'unavailable' ? 'Agy 不可用' : '正在检查 Agy'
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
  const externalDisabledReason = '当前运行时由外部管理'

  return (
    <div className="flex shrink-0 items-center gap-1.5" aria-label="Anti 状态" role="group">
      <span className="inline-flex" title={gatewayTitle}>
        <button
          type="button"
          className={clsx('ga-badge', canStart
            ? 'border-[var(--c-solid-danger-bg)] bg-[var(--c-solid-danger-bg)] text-[var(--c-solid-danger-fg)] cursor-pointer hover:border-[var(--c-solid-danger-hover)] hover:bg-[var(--c-solid-danger-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
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
        <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-line/65" />
        <div data-anti-runtime-controls className="inline-flex items-center gap-1.5">
          <button
            type="button"
            disabled={!managed}
            className={clsx(
              'inline-flex h-7 w-7 items-center justify-center rounded-lg border border-line/80 bg-bg-card/90 text-ink-muted shadow-[inset_0_1px_0_var(--c-inset-highlight),0_1px_2px_rgba(45,34,22,0.06)] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
              managed ? 'cursor-pointer hover:border-accent/60 hover:bg-bg-soft/90 hover:text-ink active:scale-[0.96]' : 'cursor-not-allowed opacity-45',
            )}
            aria-label="重置 Agy 运行时"
            title={managed ? '重置 Agy 运行时' : externalDisabledReason}
            onClick={() => { if (managed) restart.mutate(false) }}
          >
            <RotateCw className="h-[14px] w-[14px]" strokeWidth={1.9} aria-hidden="true" />
          </button>
          {running && <button
            type="button"
            disabled={!managed}
            className={clsx(
              'inline-flex h-7 w-7 items-center justify-center rounded-lg border shadow-[inset_0_1px_0_var(--c-inset-highlight),0_1px_2px_rgba(158,51,40,0.08)] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-status-danger/45',
              managed
                ? 'cursor-pointer border-status-danger/35 bg-status-danger-soft text-status-danger hover:border-[var(--c-solid-danger-bg)] hover:bg-[var(--c-solid-danger-bg)] hover:text-[var(--c-solid-danger-fg)] active:scale-[0.96] active:bg-[var(--c-solid-danger-hover)]'
                : 'cursor-not-allowed border-status-danger-line/70 bg-status-danger-soft/50 text-status-danger/55 opacity-45',
            )}
            aria-label="停止 Agy 运行时"
            title={managed ? '停止 Agy 运行时' : externalDisabledReason}
            onClick={() => { if (managed) stop.mutate(false) }}
          >
            <Power className="h-[15px] w-[15px]" strokeWidth={2.1} aria-hidden="true" />
          </button>}
        </div>
      </>}
      {forceConflict && managed && !busy && (
        <div
          data-anti-daemon-force-confirm
          className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-status-danger-line bg-status-danger-soft px-2 text-[11px]"
        >
          <button
            type="button"
            className="font-medium text-status-danger hover:underline"
            onClick={() => {
              if (forceConflict === 'restart') restart.mutate(true)
              else stop.mutate(true)
            }}
          >
            {forceConflict === 'restart' ? '强制重置' : '强制停止'}
          </button>
          <button
            type="button"
            className="text-ink-muted hover:text-ink"
            aria-label="取消强制操作"
            onClick={clearForceConflict}
          >
            取消
          </button>
        </div>
      )}
      <span role="status" className="sr-only">
        {running ? authLabel : label}{detail && `：${detail}`}
      </span>
    </div>
  )
}
