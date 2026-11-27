import { describe, expect, it, vi } from 'vitest'
import type { AntiSession } from '@/api/client'
import type { HubSession, SessionRuntime } from '@/api/types'
import {
  antiSessionToRuntime,
  capacityConflictFromError,
  errorMessageFromError,
  groupBestAttentionState,
  isProtectedRailState,
  myKeyParseErrorFromError,
  myKeySyncErrorFromError,
  openAntiSession,
  openSessionChat,
  resolveGroupPreviewLimit,
  resolveSessionRailState,
  sessionActivity,
  sessionAttentionTier,
  sessionChatHref,
  sessionPreview,
  sessionRecencyMs,
  sessionSortTier,
  sessionStatusLabel,
  sortRailGroups,
  sortRailSessions,
  startAbortedFromError,
  structuredErrorDetailFromError,
} from './sessionUi'
import { readPageState, resetPageState } from './pageState'

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

  describe('sessionPreview', () => {
    const rows = [
      session('a', 'A'),
      session('b', 'B'),
      session('c', 'C'),
      session('d', 'D'),
      session('e', 'E'),
    ]

    it('caps the preview at the limit when the current session is already inside it', () => {
      expect(sessionPreview(rows, 'b', 3).map((item) => item.id)).toEqual(['a', 'b', 'c'])
      expect(sessionPreview(rows, null, 3).map((item) => item.id)).toEqual(['a', 'b', 'c'])
      expect(sessionPreview(rows, 'nowhere', 3).map((item) => item.id)).toEqual(['a', 'b', 'c'])
      expect(sessionPreview(rows, 'a', 0)).toEqual([])
    })

    it('pulls a current session that sits past the edge into the last preview slot', () => {
      expect(sessionPreview(rows, 'e', 3).map((item) => item.id)).toEqual(['a', 'b', 'e'])
    })

    it('returns everything at or under the limit untouched', () => {
      expect(sessionPreview(rows.slice(0, 2), 'a', 3).map((item) => item.id)).toEqual(['a', 'b'])
      expect(sessionPreview(rows.slice(0, 3), 'e', 3).map((item) => item.id)).toEqual(['a', 'b', 'c'])
    })

    it('exempts protected sessions using Option A fill-to-limit and never evicts protected rows', () => {
      const protectedIds = new Set(['a', 'b'])
      const isProt = (item: HubSession) => protectedIds.has(item.id)
      // 2 protected + 1 idle fills to limit=3
      expect(sessionPreview(rows, 'a', 3, isProt).map((item) => item.id)).toEqual(['a', 'b', 'c'])
      // currentId outside preview replaces the last idle slot, keeping all protected rows
      expect(sessionPreview(rows, 'e', 3, isProt).map((item) => item.id)).toEqual(['a', 'b', 'e'])
      // When protected count exceeds limit, all protected rows stay visible
      const manyProtected = new Set(['a', 'b', 'c', 'd'])
      expect(sessionPreview(rows, 'a', 3, (item) => manyProtected.has(item.id)).map((item) => item.id))
        .toEqual(['a', 'b', 'c', 'd'])
      // If currentId is idle when slots are full of protected rows, append without evicting protected rows
      expect(sessionPreview(rows, 'e', 3, (item) => manyProtected.has(item.id)).map((item) => item.id))
        .toEqual(['a', 'b', 'c', 'd', 'e'])
      // When protected rows sit later in the list, preview preserves their original relative order
      const lateProtected = new Set(['d'])
      expect(sessionPreview(rows, 'a', 3, (item) => lateProtected.has(item.id)).map((item) => item.id))
        .toEqual(['a', 'b', 'd'])
    })
  })

  describe('unified ranking, dynamic preview limits, and Anti helpers', () => {
    it('resolves rail states with cancelled runs mapped to idle', () => {
      expect(resolveSessionRailState(runtime('a', 'running'), undefined, undefined)).toBe('active')
      expect(resolveSessionRailState({ ...runtime('a', 'idle'), completed_run_id: 'r1', outcome: 'completed' }, undefined, undefined)).toBe('completed')
      expect(resolveSessionRailState({ ...runtime('a', 'idle'), completed_run_id: 'r1', outcome: 'failed' }, undefined, undefined)).toBe('error')
      expect(resolveSessionRailState({ ...runtime('a', 'idle'), completed_run_id: 'r1', outcome: 'cancelled' }, { runId: 'r0', kind: 'completed' }, undefined)).toBe('idle')
      expect(resolveSessionRailState({ ...runtime('a', 'idle'), completed_run_id: 'r1', outcome: 'completed' }, undefined, 'r1')).toBe('idle')
      expect(resolveSessionRailState(undefined, { runId: 'r2', kind: 'error' }, undefined)).toBe('error')
      expect(resolveSessionRailState(undefined, { runId: 'r2', kind: 'error' }, 'r2')).toBe('idle')
    })

    it('pins only active sessions to top and sorts all non-active sessions purely by recency', () => {
      const sCompleted = { ...session('c'), updated_at: '2026-08-04T11:00:00Z' }
      const sError = { ...session('e'), updated_at: '2026-08-04T09:00:00Z' }
      const sActive = { ...session('a'), updated_at: '2026-08-04T08:00:00Z' }
      const sIdle = { ...session('i'), updated_at: '2026-08-04T12:00:00Z' }
      const states = new Map([
        ['c', 'completed' as const],
        ['e', 'error' as const],
        ['a', 'active' as const],
        ['i', 'idle' as const],
      ])
      expect(sessionSortTier('active')).toBe(0)
      expect(sessionSortTier('completed')).toBe(1)
      expect(sessionSortTier('error')).toBe(1)
      expect(sessionSortTier('idle')).toBe(1)
      expect(sessionAttentionTier('completed')).toBeLessThan(sessionAttentionTier('error'))
      expect(sessionAttentionTier('error')).toBeLessThan(sessionAttentionTier('active'))
      expect(sessionAttentionTier('active')).toBeLessThan(sessionAttentionTier('idle'))

      const beforeAck = sortRailSessions([sIdle, sActive, sError, sCompleted], (row) => states.get(row.id)!).map((row) => row.id)
      expect(beforeAck).toEqual(['a', 'i', 'c', 'e'])

      // Marking completed/error as idle must NOT move any session
      states.set('c', 'idle')
      states.set('e', 'idle')
      const afterAck = sortRailSessions([sIdle, sActive, sError, sCompleted], (row) => states.get(row.id)!).map((row) => row.id)
      expect(afterAck).toEqual(beforeAck)
    })

    it('switches group preview limit from 5 (<3 projects) to 3 (>=3 projects)', () => {
      expect(resolveGroupPreviewLimit(0)).toBe(5)
      expect(resolveGroupPreviewLimit(1)).toBe(5)
      expect(resolveGroupPreviewLimit(2)).toBe(5)
      expect(resolveGroupPreviewLimit(3)).toBe(3)
      expect(resolveGroupPreviewLimit(5)).toBe(3)
    })

    it('sorts groups by pin order, then active running presence, then recency (unread never shifts groups)', () => {
      const groups = [
        { key: 'project:idle', sessions: [{ ...session('1'), updated_at: '2026-08-04T12:00:00Z' }] },
        { key: 'project:active', sessions: [{ ...session('2'), updated_at: '2026-08-04T08:00:00Z' }] },
        { key: 'project:completed', sessions: [{ ...session('3'), updated_at: '2026-08-04T07:00:00Z' }] },
        { key: 'project:pinned', sessions: [{ ...session('4'), updated_at: '2026-08-04T06:00:00Z' }] },
      ]
      const states = new Map([
        ['1', 'idle' as const],
        ['2', 'active' as const],
        ['3', 'completed' as const],
        ['4', 'idle' as const],
      ])
      expect(sortRailGroups(groups, ['project:pinned'], (row) => states.get(row.id)!).map((g) => g.key))
        .toEqual(['project:pinned', 'project:active', 'project:idle', 'project:completed'])
      expect(groupBestAttentionState(groups[2].sessions, (row) => states.get(row.id)!)).toBe('completed')
      expect(groupBestAttentionState(groups[0].sessions, (row) => states.get(row.id)!)).toBeNull()
      expect(isProtectedRailState('error')).toBe(true)
      expect(isProtectedRailState('idle')).toBe(false)
    })

    it('maps Anti sessions to runtime state and opens Anti deep links', () => {
      resetPageState()
      const navigate = vi.fn()
      openAntiSession(navigate, 'anti-123')
      expect(readPageState('antiChat.currentSession', '')).toBe('anti-123')
      expect(navigate).toHaveBeenCalledWith('/anti?session=anti-123')

      const base: AntiSession = {
        id: 'a1',
        project: 'p',
        title: 't',
        workspace: 'D:/p',
        engine: 'anti',
        active_run_id: null,
        completed_run_id: 'r1',
        last_outcome: 'completed',
        last_error: null,
      }
      expect(antiSessionToRuntime(base)).toMatchObject({
        session_id: 'a1',
        status: 'idle',
        completed_run_id: 'r1',
        outcome: 'completed',
      })
      expect(antiSessionToRuntime({ ...base, active_run_id: 'r2' })).toMatchObject({
        session_id: 'a1',
        status: 'running',
        run_id: 'r2',
      })
    })
  })

  describe('startAbortedFromError', () => {
    const conflict = (code: string, status = 409) => ({
      status,
      body: { detail: { code, detail: '本次运行在启动完成前已被停止，消息未发出。' } },
    })

    it('recognizes the cold-start stop refusal', () => {
      expect(startAbortedFromError(conflict('run_start_aborted'))).toBe(true)
    })

    it('does not claim other 409s or non-409 responses', () => {
      expect(startAbortedFromError(conflict('session_active'))).toBe(false)
      expect(startAbortedFromError(conflict('agent_busy'))).toBe(false)
      expect(startAbortedFromError(conflict('run_start_aborted', 500))).toBe(false)
      expect(startAbortedFromError(new Error('network'))).toBe(false)
      expect(startAbortedFromError(null)).toBe(false)
    })
  })
})
