import { describe, expect, it } from 'vitest'
import type { HubSession, SessionRuntime } from '@/api/types'
import {
  capacityConflictFromError,
  errorMessageFromError,
  sessionActivity,
  sessionChatHref,
  sessionStatusLabel,
} from './sessionUi'

const session = (id: string, title = ''): HubSession => ({
  id,
  title,
  llm_index: null,
  llm_key: null,
  archive_path: null,
  created_at: '2026-08-04T10:00:00Z',
  updated_at: '2026-08-04T10:00:00Z',
})

const runtime = (sessionId: string, status: string): SessionRuntime => ({
  session_id: sessionId,
  status,
  run_id: status === 'running' ? `run-${sessionId}` : null,
  stream_id: status === 'running' ? `stream-${sessionId}` : null,
})

describe('session UI contracts', () => {
  it('maps backend runtime states without treating terminal states as active', () => {
    expect(sessionActivity(runtime('a', 'starting'))).toBe('active')
    expect(sessionActivity(runtime('a', 'running'))).toBe('active')
    expect(sessionActivity(runtime('a', 'error'))).toBe('error')
    expect(sessionActivity(runtime('a', 'idle'))).toBe('idle')
    expect(sessionActivity(undefined)).toBe('unknown')
    expect(sessionStatusLabel(runtime('a', 'running'))).toBe('运行中')
  })

  it('builds a stable URL used to switch the selected live-chat session', () => {
    expect(sessionChatHref('session/a b')).toBe('/chat?session=session%2Fa+b')
  })

  it('extracts the bounded-capacity 409 contract and ignores unrelated errors', () => {
    const conflict = capacityConflictFromError({
      status: 409,
      body: {
        detail: {
          code: 'agent_busy',
          detail: '另一个会话正在运行，请等待当前任务结束后重试。',
          active_session_id: 'active-1',
          active_run_id: 'run-1',
          capacity: 2,
          active_count: 2,
        },
      },
    })
    expect(conflict).toEqual({
      reason: 'capacity_full',
      message: '另一个会话正在运行，请等待当前任务结束后重试。',
      activeSessionId: 'active-1',
      activeRunId: 'run-1',
      capacity: 2,
      activeCount: 2,
    })
    expect(capacityConflictFromError({ status: 500, body: { detail: 'boom' } })).toBeNull()
  })

  it('renders structured HTTP details without object coercion', () => {
    expect(errorMessageFromError({ body: { detail: { message: '项目绑定失败' } } })).toBe('项目绑定失败')
    expect(errorMessageFromError({ body: { detail: { code: 'project_error', path: 'D:/repo' } } })).toBe('project_error')
    expect(errorMessageFromError({ body: { detail: { path: 'D:/repo' } } })).toBe('{"path":"D:/repo"}')
    expect(errorMessageFromError(new Error('network down'))).toBe('network down')
    expect(errorMessageFromError(null, '未知错误')).toBe('未知错误')
  })

  it('provides a useful fallback title for untitled sessions', () => {
    expect(sessionStatusLabel(runtime('a', 'error'))).toBe('异常')
    expect(session('a').title).toBe('')
  })
})
