import type { SessionRuntime } from '@/api/types'

export type SessionActivity = 'active' | 'idle' | 'error' | 'unknown'

export interface CapacityConflict {
  message: string
  activeSessionId: string | null
  activeRunId: string | null
  capacity: number | null
  activeCount: number | null
}

export function sessionActivity(runtime?: SessionRuntime): SessionActivity {
  if (!runtime) return 'unknown'
  if (runtime.status === 'starting' || runtime.status === 'running') return 'active'
  if (runtime.status === 'error') return 'error'
  return 'idle'
}

export function sessionStatusLabel(runtime?: SessionRuntime): string {
  const activity = sessionActivity(runtime)
  if (activity === 'active') return runtime?.status === 'starting' ? '启动中' : '运行中'
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

export function capacityConflictFromError(error: unknown): CapacityConflict | null {
  const value = error as { status?: unknown; body?: { detail?: unknown } } | null
  const detail = value?.body?.detail
  if (value?.status !== 409 || !detail || typeof detail !== 'object') return null
  const payload = detail as Record<string, unknown>
  if (payload.code !== 'agent_busy') return null
  return {
    message: typeof payload.detail === 'string' ? payload.detail : '会话运行容量已满。',
    activeSessionId: typeof payload.active_session_id === 'string' ? payload.active_session_id : null,
    activeRunId: typeof payload.active_run_id === 'string' ? payload.active_run_id : null,
    capacity: typeof payload.capacity === 'number' ? payload.capacity : null,
    activeCount: typeof payload.active_count === 'number' ? payload.active_count : null,
  }
}
