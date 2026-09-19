import { describe, expect, it, vi } from 'vitest'
import type { HubSession, SessionRuntime } from '@/api/types'
import {
  capacityConflictFromError,
  errorMessageFromError,
  myKeyParseErrorFromError,
  myKeySyncErrorFromError,
  openSessionChat,
  sessionActivity,
  sessionChatHref,
  sessionRecencyMs,
  sessionStatusLabel,
  structuredErrorDetailFromError,
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
    expect(sessionActivity(runtime('a', 'aborting'))).toBe('active')
    expect(sessionActivity(runtime('a', 'error'))).toBe('error')
    expect(sessionActivity(runtime('a', 'idle'))).toBe('idle')
    expect(sessionActivity(undefined)).toBe('unknown')
    expect(sessionStatusLabel(runtime('a', 'running'))).toBe('运行中')
    expect(sessionStatusLabel(runtime('a', 'aborting'))).toBe('停止中')
  })

  it('builds a stable URL used to switch the selected live-chat session', () => {
    expect(sessionChatHref('session/a b')).toBe('/chat?session=session%2Fa+b')
  })

  it('switches sessions like the rail does: persist the id, then route to it', () => {
    const navigate = vi.fn()

    openSessionChat(navigate, 'session/a b')

    // LiveChat re-reads this on a plain /chat boot; the URL selects it now.
    expect(localStorage.getItem('gahub.currentSessionId')).toBe('session/a b')
    expect(navigate).toHaveBeenCalledWith('/chat?session=session%2Fa+b')
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

  it('prefers the nested detail payload in backend error envelopes', () => {
    expect(errorMessageFromError({ body: { detail: { detail: '具体错误', code: 'fallback_code' } } })).toBe('具体错误')
    expect(errorMessageFromError({ body: { detail: { error: '上游失败', code: 'x' } } })).toBe('上游失败')
    expect(errorMessageFromError({ body: { detail: '纯文本 detail' } })).toBe('纯文本 detail')
    // Message wins over code inside a structured detail (canonical precedence).
    expect(errorMessageFromError({ body: { detail: { message: '人话', code: 'E123' } } })).toBe('人话')
    expect(errorMessageFromError({ body: {}, message: 'transport broken' })).toBe('transport broken')
  })

  it('renders mykey parse diagnostics with line/column and guards missing offsets', () => {
    expect(myKeyParseErrorFromError({
      body: { detail: { error: 'YamlError', message: 'bad indent', line: 3, col: 5 } },
    })).toBe('第 3:5 行 — YamlError: bad indent')
    expect(myKeyParseErrorFromError({
      body: { detail: { message: 'bad indent', line: 3 } },
    })).toBe('第 3 行 — bad indent')
    // Backend omitted offsets entirely: no more "第 undefined:undefined 行".
    expect(myKeyParseErrorFromError({ body: { detail: { message: 'bad indent' } } })).toBe('bad indent')
    expect(myKeyParseErrorFromError({ body: { detail: 'plain detail' } })).toBe('plain detail')
    expect(myKeyParseErrorFromError(new Error('network down'))).toBe('network down')
  })

  it('merges mykey sync message with subprocess stderr instead of dropping it', () => {
    expect(myKeySyncErrorFromError({
      body: { detail: { message: '同步失败', stderr: 'rsync: exit 23' } },
    })).toBe('同步失败\n\nrsync: exit 23')
    // Identical halves collapse to one copy.
    expect(myKeySyncErrorFromError({
      body: { detail: { message: 'same', stderr: 'same' } },
    })).toBe('same')
    expect(myKeySyncErrorFromError({ body: { detail: 'plain detail' } })).toBe('plain detail')
    expect(myKeySyncErrorFromError({ body: { detail: {} }, message: 'transport down' })).toBe('transport down')
    expect(myKeySyncErrorFromError(new Error('network down'))).toBe('network down')
  })

  it('unwraps the structured detail payload for evidence-style consumers', () => {
    interface Evidence { error?: string }
    // FastAPI wraps dict details in {detail}…
    expect(structuredErrorDetailFromError<Evidence>({ body: { detail: { error: 'completion_unverified' } } }))
      .toEqual({ error: 'completion_unverified' })
    // …plain dicts pass through as the body itself.
    expect(structuredErrorDetailFromError<Evidence>({ body: { error: 'completion_unverified' } }))
      .toEqual({ error: 'completion_unverified' })
    expect(structuredErrorDetailFromError<Evidence>(new Error('network down'))).toBeNull()
  })

  it('provides a useful fallback title for untitled sessions', () => {
    expect(sessionStatusLabel(runtime('a', 'error'))).toBe('异常')
    expect(session('a').title).toBe('')
  })

  describe('sessionRecencyMs', () => {
    it('reads the sidecar stamp and the optimistic stamp as the same instant', () => {
      // `datetime.now(timezone.utc).isoformat()` vs `new Date().toISOString()`.
      expect(sessionRecencyMs({ updated_at: '2026-09-18T06:00:00.123000+00:00', created_at: '' }))
        .toBe(Date.parse('2026-09-18T06:00:00.123Z'))
      // A whole second carries no fraction at all — isoformat drops it.
      expect(sessionRecencyMs({ updated_at: '2026-09-18T06:00:00+00:00', created_at: '' }))
        .toBe(Date.parse('2026-09-18T06:00:00Z'))
    })

    it('orders stamps by time, not by which flavour wrote them', () => {
      const sidecar = { updated_at: '2026-09-18T06:00:00.123456+00:00', created_at: '' }
      const optimistic = { updated_at: '2026-09-18T06:00:01.000Z', created_at: '' }
      expect(sessionRecencyMs(optimistic)).toBeGreaterThan(sessionRecencyMs(sidecar))
    })

    it('falls back to created_at and bottoms out at 0 for unusable rows', () => {
      expect(sessionRecencyMs({ updated_at: '', created_at: '2026-09-18T06:00:00Z' }))
        .toBe(Date.parse('2026-09-18T06:00:00Z'))
      expect(sessionRecencyMs({ updated_at: 'not-a-date', created_at: 'also-bad' })).toBe(0)
    })
  })
})
