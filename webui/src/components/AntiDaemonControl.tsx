import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { LoaderCircle, Power, RotateCw, ShieldCheck, ShieldMinus, ShieldX } from 'lucide-react'
import clsx from 'clsx'
import { antiApi, HttpError } from '@/api/client'
import { Z_LAYERS } from '@/config/zLayers'
import { toast } from '@/stores/toastStore'
import { errorMessageFromError } from '@/utils/sessionUi'
import { RefreshIcon, StatusIconGlyph, statusBadgeToneClass, X, type StatusBadgeKind } from './ActionIcons'

const key = ['anti-daemon-status'] as const

function formatIdleSeconds(seconds: number) {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  return `${Math.floor(seconds / 3600)}h`
}

export function useAntiDaemonStatus() {
  const cache = useQueryClient()
  const [forceConflict, setForceConflict] = useState<'stop' | 'restart' | null>(null)
  const status = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => antiApi.daemonStatus(signal),
    retry: false,
    refetchInterval: ({ state }) => state.data?.state === 'starting' || state.data?.auth_state === 'checking' ? 1_000 : 10_000,
    refetchIntervalInBackground: false,
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
  refresh,
  diagnosticsOpen,
  onDiagnosticsOpenChange,
}: ReturnType<typeof useAntiDaemonStatus> & {
  diagnosticsOpen?: boolean
  onDiagnosticsOpenChange?: (open: boolean) => void
}) {
  const cache = useQueryClient()
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const diagOpen = diagnosticsOpen ?? uncontrolledOpen
  const setDiagOpen = useCallback((next: boolean) => {
    if (diagnosticsOpen === undefined) setUncontrolledOpen(next)
    onDiagnosticsOpenChange?.(next)
  }, [diagnosticsOpen, onDiagnosticsOpenChange])
  const [showLogs, setShowLogs] = useState(false)
  const [showWorkers, setShowWorkers] = useState(false)
  const [resettingSid, setResettingSid] = useState<string | null>(null)
  const [diagMessage, setDiagMessage] = useState('')
  const popoverId = useId()
  const badgeRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ top: number; left: number; width: number; maxHeight: number }>()

  const canStart = !busy && state === 'stopped'
  const canControl = !busy && (running || state === 'unavailable')
  const canInspectDiagnostics = !busy && !canStart && Boolean(state)
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

  const logs = useQuery({
    queryKey: ['anti-daemon-logs'],
    enabled: diagOpen && showLogs,
    queryFn: ({ signal }) => antiApi.daemonLogs(80, signal),
    retry: false,
  })
  const workers = useQuery({
    queryKey: ['anti-workers'],
    enabled: diagOpen,
    queryFn: ({ signal }) => antiApi.workers(signal),
    refetchInterval: diagOpen ? 3_000 : false,
    retry: false,
  })
  const workerItems = Array.isArray(workers.data?.items) ? workers.data.items : []
  const resetWorker = useMutation({
    mutationFn: ({ sid, force }: { sid: string; force: boolean }) => antiApi.resetSession(sid, force),
    onMutate: ({ sid }) => {
      setDiagMessage('')
      setResettingSid(sid)
    },
    onSuccess: (_, { sid, force }) => {
      setDiagMessage(force ? '已强制重连会话进程（保留上下文）。' : '已释放空闲会话进程。')
      void cache.invalidateQueries({ queryKey: ['anti-workers'] })
      void cache.invalidateQueries({ queryKey: ['anti-sessions'] })
      void cache.invalidateQueries({ queryKey: ['anti-runs', sid] })
      refresh()
    },
    onSettled: () => {
      setResettingSid(null)
    },
  })

  const closeDiag = useCallback(() => {
    setDiagOpen(false)
    setShowLogs(false)
    setShowWorkers(false)
    setResettingSid(null)
    setDiagMessage('')
    resetWorker.reset()
  }, [resetWorker, setDiagOpen])
  const closeDiagRef = useRef(closeDiag)
  closeDiagRef.current = closeDiag

  useLayoutEffect(() => {
    if (!diagOpen) return
    const update = () => {
      const anchor = badgeRef.current?.getBoundingClientRect()
      if (!anchor) return
      const width = Math.min(384, window.innerWidth - 16)
      const next = {
        top: anchor.bottom,
        left: Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8)),
        width,
        maxHeight: Math.max(0, Math.min(window.innerHeight - anchor.bottom - 16, 460)),
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
      if (event.target instanceof Node && !badgeRef.current?.contains(event.target) && !panelRef.current?.contains(event.target)) {
        closeDiagRef.current()
      }
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      closeDiagRef.current()
      badgeRef.current?.focus()
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('keydown', escape)
    }
  }, [diagOpen])

  const daemonError = start.error ?? stop.error ?? restart.error
  const diagDotClass = running
    ? 'bg-status-success'
    : state === 'unavailable'
      ? 'bg-status-danger'
      : busy
        ? 'bg-accent animate-pulse'
        : 'bg-ink-faint'
  const diagStateLabel = external ? '外部运行中'
    : running ? 'ACP 就绪'
    : busy ? '处理中'
    : state === 'stopped' ? '已停止'
    : '不可用'
  const compactBtn = 'ga-btn-sm shrink-0 px-2 text-[11px]'
  const compactDangerBtn = 'ga-btn-sm-danger shrink-0 px-2 text-[11px]'
  const hasDaemonLifecycleBtns = (!running && state === 'stopped') || ((running || state === 'unavailable') && managed)
  const diagError = daemonError ?? resetWorker.error

  return (
    <div className="flex shrink-0 items-center gap-1.5" aria-label="Anti 状态" role="group">
      <span className="inline-flex" title={gatewayTitle}>
        <button
          ref={badgeRef}
          type="button"
          className={clsx(
            'ga-badge',
            canStart
              ? 'border-[var(--c-solid-danger-bg)] bg-[var(--c-solid-danger-bg)] text-[var(--c-solid-danger-fg)] cursor-pointer hover:border-[var(--c-solid-danger-hover)] hover:bg-[var(--c-solid-danger-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
              : statusBadgeToneClass(gatewayKind),
            canInspectDiagnostics && 'cursor-pointer',
          )}
          aria-label={label}
          aria-haspopup={canInspectDiagnostics ? 'dialog' : undefined}
          aria-expanded={canInspectDiagnostics ? diagOpen : undefined}
          aria-controls={diagOpen && canInspectDiagnostics ? popoverId : undefined}
          disabled={!canStart && !canInspectDiagnostics}
          onClick={() => {
            if (canStart) start.mutate()
            else if (canInspectDiagnostics) {
              if (diagOpen) closeDiag()
              else setDiagOpen(true)
            }
          }}
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
            className="ga-btn-icon h-7 w-7"
            aria-label="重置 Agy 运行时"
            title={managed ? '重置 Agy 运行时' : externalDisabledReason}
            onClick={() => { if (managed) restart.mutate(false) }}
          >
            <RotateCw className="h-[14px] w-[14px]" strokeWidth={1.9} aria-hidden="true" />
          </button>
          {running && <button
            type="button"
            disabled={!managed}
            className="ga-btn-icon-danger"
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
          className="inline-flex h-7 items-center gap-1 rounded-lg border border-status-danger-line bg-status-danger-soft px-2 text-[11px]"
        >
          <button
            type="button"
            className="ga-btn-link px-1 py-0 text-[11px] font-medium text-status-danger hover:bg-status-danger/10 hover:text-status-danger"
            onClick={() => {
              if (forceConflict === 'restart') restart.mutate(true)
              else stop.mutate(true)
            }}
          >
            {forceConflict === 'restart' ? '强制重置' : '强制停止'}
          </button>
          <button
            type="button"
            className="ga-btn-link-muted px-1 py-0 text-[11px]"
            aria-label="取消强制操作"
            onClick={clearForceConflict}
          >
            取消
          </button>
        </div>
      )}
      {diagOpen && position && createPortal(
        <div
          ref={panelRef}
          className="fixed pt-2"
          style={{ top: position.top, left: position.left, width: position.width, zIndex: Z_LAYERS.tooltip }}
        >
          <div
            id={popoverId}
            tabIndex={-1}
            role="dialog"
            aria-label="Agy 运行时诊断"
            className="ga-paper-popover flex flex-col overflow-hidden rounded-xl text-xs text-ink"
            style={{ maxHeight: position.maxHeight }}
          >
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line/60 px-3.5 py-2.5">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className={clsx('h-2 w-2 shrink-0 rounded-full', diagDotClass)} aria-hidden="true" />
                <span className="font-semibold text-ink">{diagStateLabel}</span>
                {running && status.data?.version && (
                  <span className="font-mono text-[11px] text-ink-muted">v{status.data.version}</span>
                )}
              </div>
              <button
                type="button"
                aria-label="关闭"
                title="关闭"
                onClick={closeDiag}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-bg-soft hover:text-ink"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="sr-only">关闭</span>
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3">
              {diagMessage && (
                <div role="status" className="rounded-md bg-bg-soft/75 px-2.5 py-1.5 text-[11px] text-ink-muted">
                  {diagMessage}
                </div>
              )}
              {diagError && (
                <p role="alert" className="rounded-lg border border-status-danger-line bg-status-danger-soft px-2.5 py-1.5 text-[11px] text-status-danger">
                  {diagError.message}
                </p>
              )}
              {state === 'unavailable' && status.data?.detail && (
                <p className="text-[11px] text-status-danger">{status.data.detail}</p>
              )}

              {forceConflict && managed && (
                <div
                  data-anti-modal-force-bar
                  role="status"
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-status-danger-line bg-status-danger-soft px-2.5 py-1.5 text-[11px] text-status-danger"
                >
                  <span>仍有活跃任务，常规{forceConflict === 'restart' ? '重置' : '停止'}已拦截；可强制中断。</span>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      className={compactDangerBtn}
                      disabled={busy}
                      onClick={() => (forceConflict === 'restart' ? restart.mutate(true) : stop.mutate(true))}
                    >
                      {forceConflict === 'restart' ? '强制重置运行时' : '强制停止运行时'}
                    </button>
                    <button type="button" className={compactBtn} onClick={clearForceConflict}>
                      取消
                    </button>
                  </div>
                </div>
              )}

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
                {!running && state === 'stopped' && (
                  <button type="button" className={compactBtn} disabled={busy} onClick={() => start.mutate()}>启用 Agy</button>
                )}
                {(running || state === 'unavailable') && managed && (
                  <button type="button" className={compactBtn} disabled={busy} onClick={() => restart.mutate(false)}>重置运行时</button>
                )}
                {running && managed && (
                  <button type="button" className={compactBtn} disabled={busy} onClick={() => stop.mutate(false)}>停止运行时</button>
                )}
              </div>

              {showWorkers && (
                <div data-anti-workers-panel className="space-y-1.5 border-t border-line/60 pt-2">
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
                <div className="border-t border-line/60 pt-2">
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
          </div>
        </div>,
        document.body,
      )}
      <span role="status" className="sr-only">
        {running ? authLabel : label}{detail && `：${detail}`}
      </span>
    </div>
  )
}
