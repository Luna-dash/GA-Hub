import type { SessionRuntime } from '@/api/types'

export type SessionActivity = 'active' | 'idle' | 'error' | 'unknown'

export interface CapacityConflict {
  message: string
  activeSessionId: string | null
  activeRunId: string | null
  capacity: number | null
  activeCount: number | null
  /** Distinguish same-session busy from genuine capacity overflow. */
  reason: 'session_active' | 'capacity_full' | null
}

export function sessionActivity(runtime?: SessionRuntime): SessionActivity {
  if (!runtime) return 'unknown'
  if (runtime.status === 'starting' || runtime.status === 'running') return 'active'
  // 停止中仍是"运行"：aborting 归为 active，否则会话在停止期间会从
  // 置顶运行组掉进 idle 组（回归：cf签到 按停止后会话栏位置跳到第 5-6）。
  if (runtime.status === 'aborting') return 'active'
  if (runtime.status === 'error') return 'error'
  return 'idle'
}

export function sessionStatusLabel(runtime?: SessionRuntime): string {
  const activity = sessionActivity(runtime)
  if (activity === 'active') {
    if (runtime?.status === 'starting') return '启动中'
    if (runtime?.status === 'aborting') return '停止中'
    return '运行中'
  }
  if (activity === 'error') return '异常'
  if (activity === 'idle') return '空闲'
  return '未知'
}

export function sessionChatHref(sessionId: string): string {
  const params = new URLSearchParams({ session: sessionId })
  return `/chat?${params.toString()}`
}

export function errorMessageFromError(error: unknown, fallback = '请求失败'): string {
  if (typeof error === 'string' && error.trim()) return error
  const value = error as { body?: { detail?: unknown }; message?: unknown } | null
  const detail = value?.body?.detail
  if (typeof detail === 'string' && detail.trim()) return detail
  if (detail && typeof detail === 'object') {
    const payload = detail as Record<string, unknown>
    for (const key of ['message', 'detail', 'error', 'code']) {
      const candidate = payload[key]
      if (typeof candidate === 'string' && candidate.trim()) return candidate
    }
    try {
      return JSON.stringify(detail)
    } catch {
      // Fall through to the ordinary Error message or the stable fallback.
    }
  }
  if (typeof value?.message === 'string' && value.message.trim()) return value.message
  return fallback
}

/** Structured failure text for mykey sync (upload/fetch) dialogs: the sync
 * scripts answer with {message, stderr} and the two halves are both useful —
 * merge them instead of dropping the subprocess output. Kept byte-compatible
 * with the MyKey-local original (empty detail objects must not stringify). */
export function myKeySyncErrorFromError(error: unknown, fallback = '同步失败'): string {
  const detail = (error as { body?: { detail?: unknown } } | null)?.body?.detail
  if (typeof detail === 'string') return detail
  const payload = (detail ?? {}) as { message?: unknown; stderr?: unknown }
  const message = typeof payload.message === 'string' ? payload.message.trim() : ''
  const stderr = typeof payload.stderr === 'string' ? payload.stderr.trim() : ''
  if (message && stderr && message !== stderr) return `${message}\n\n${stderr}`
  const raw = (error as { message?: unknown } | null)?.message
  return message || stderr || (typeof raw === 'string' && raw ? raw : String(error ?? fallback))
}

/** Controlled exception to the *FromError string family: returns the
 * structured payload behind FastAPI's {detail} wrapping (or the raw body when
 * the route returned a plain dict) for callers that need evidence objects,
 * not display text. */
export function structuredErrorDetailFromError<T>(error: unknown): T | null {
  const body = (error as { body?: unknown } | null)?.body
  if (!body || typeof body !== 'object') return null
  const detail = (body as { detail?: unknown }).detail
  return (detail ?? body) as T
}

/** Parse-error display for mykey session/raw edits: the backend puts the
 * line/column diagnostics on the structured detail object. Both callers used
 * to hand-roll this and had already drifted (one guarded, one printing
 * "第 undefined:undefined 行" when the backend omits the offsets). */
export function myKeyParseErrorFromError(error: unknown, fallback = '保存失败'): string {
  const value = error as { body?: { detail?: unknown } } | null
  const detail = value?.body?.detail
  if (detail && typeof detail === 'object' && 'line' in (detail as Record<string, unknown>)) {
    const payload = detail as Record<string, unknown>
    const line = typeof payload.line === 'number' ? payload.line : null
    const col = typeof payload.col === 'number' ? payload.col : null
    const message = typeof payload.message === 'string' ? payload.message : null
    const errorName = typeof payload.error === 'string' ? payload.error : null
    const location = line !== null ? `第 ${line}${col !== null ? `:${col}` : ''} 行 — ` : ''
    const parts = [errorName && message ? `${errorName}: ${message}` : (message ?? errorName)]
      .filter((part): part is string => Boolean(part))
    if (parts.length) return `${location}${parts[0]}`
  }
  return errorMessageFromError(error, fallback)
}

export function capacityConflictFromError(error: unknown): CapacityConflict | null {
  const value = error as { status?: unknown; body?: { detail?: unknown } } | null
  const detail = value?.body?.detail
  if (value?.status !== 409 || !detail || typeof detail !== 'object') return null
  const payload = detail as Record<string, unknown>
  // `agent_busy` => global capacity overflow (other sessions occupy all slots).
  // `session_active` => *this* session still owns a run (running/aborting),
  //   a serial guard that must NOT be reported as "capacity full".
  const reason: CapacityConflict['reason'] =
    payload.code === 'session_active'
      ? 'session_active'
      : payload.code === 'agent_busy'
        ? 'capacity_full'
        : null
  if (reason === null) return null
  return {
    message: typeof payload.detail === 'string' ? payload.detail : '会话运行容量已满。',
    activeSessionId: typeof payload.active_session_id === 'string' ? payload.active_session_id : null,
    activeRunId: typeof payload.active_run_id === 'string' ? payload.active_run_id : null,
    capacity: typeof payload.capacity === 'number' ? payload.capacity : null,
    activeCount: typeof payload.active_count === 'number' ? payload.active_count : null,
    reason,
  }
}
