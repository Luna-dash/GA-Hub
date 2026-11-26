// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (e: any) => void>(),
  stateHandlers: new Set<(s: string) => void>(),
  controlHandlers: new Set<(c: any) => void>(),
  chatSessions: vi.fn(),
  chatRuntimes: vi.fn(),
  antiSessions: vi.fn(),
}))

vi.mock('@/runtime/hubEventClient', () => ({
  hubEventClient: {
    subscribe: (topic: string, fn: (e: any) => void) => {
      mocks.handlers.set(topic, fn)
      return () => mocks.handlers.delete(topic)
    },
    subscribeState: (fn: (s: string) => void) => {
      mocks.stateHandlers.add(fn)
      return () => mocks.stateHandlers.delete(fn)
    },
    subscribeControl: (fn: (c: any) => void) => {
      mocks.controlHandlers.add(fn)
      return () => mocks.controlHandlers.delete(fn)
    },
  },
}))

vi.mock('@/api/client', () => ({
  api: {
    sessions: mocks.chatSessions,
    sessionRuntimes: mocks.chatRuntimes,
  },
  antiApi: {
    sessions: mocks.antiSessions,
  },
}))

import { useSessionUnreadEffects } from './useSessionUnreadEffects'
import { hasUnreadSessions, markSessionRead } from '@/stores/sessionUnreadStore'
import { queryKeys } from '@/queries/queryKeys'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Probe() {
  useSessionUnreadEffects()
  return null
}

describe('useSessionUnreadEffects', () => {
  let host: HTMLDivElement
  let root: Root
  let qc: QueryClient

  beforeEach(() => {
    localStorage.clear()
    mocks.handlers.clear()
    mocks.stateHandlers.clear()
    mocks.controlHandlers.clear()
    mocks.chatSessions.mockResolvedValue({ total: 1, items: [{ id: 'c1', title: 'Chat', updated_at: '2026-08-05T09:00:00Z' }] })
    mocks.chatRuntimes.mockResolvedValue({})
    mocks.antiSessions.mockResolvedValue([{ id: 'a1', project: 'p', title: 'Agy', workspace: 'D:/p', updated_at: '2026-08-05T09:00:00Z' }])
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    qc.clear()
    host.remove()
  })

  it('tracks unread completions for Chat (excluding theme_task) and Agy, and prunes deleted sessions', async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <Probe />
        </QueryClientProvider>,
      )
    })

    // Theme task completion on session:runtime must NOT mark chat unread.
    mocks.chatSessions.mockResolvedValueOnce({
      total: 2,
      items: [
        { id: 'c1', title: 'Chat', updated_at: '2026-08-05T09:00:00Z' },
        { id: 't1', title: 'Theme', theme_task: { instruction: 'x' }, updated_at: '2026-08-05T09:00:00Z' },
      ],
    })
    qc.setQueryData(queryKeys.sessions, {
      total: 2,
      items: [
        { id: 'c1', title: 'Chat', updated_at: '2026-08-05T09:00:00Z' },
        { id: 't1', title: 'Theme', theme_task: { instruction: 'x' }, updated_at: '2026-08-05T09:00:00Z' },
      ],
    })

    await act(async () => {
      mocks.handlers.get('session:runtime')?.({
        topic: 'session:runtime',
        payload: { session_id: 't1', status: 'idle', run_id: null, stream_id: null, completed_run_id: 'rt1', outcome: 'completed' },
      })
    })
    expect(hasUnreadSessions('chat')).toBe(false)

    // Normal chat completion lights up chat unread and bumps updated_at.
    await act(async () => {
      mocks.handlers.get('session:runtime')?.({
        topic: 'session:runtime',
        payload: { session_id: 'c1', status: 'idle', run_id: null, stream_id: null, completed_run_id: 'rc1', outcome: 'completed' },
      })
    })
    expect(hasUnreadSessions('chat')).toBe(true)

    // Anti completion updates anti cache and lights up anti unread; cancelled clears it.
    await act(async () => {
      mocks.handlers.get('anti:runtime')?.({
        topic: 'anti:runtime',
        payload: {
          session_id: 'a1',
          title: 'Agy',
          status: 'idle',
          run_id: null,
          completed_run_id: 'ra1',
          outcome: 'failed',
          updated_at: '2026-08-05T10:00:00Z',
        },
      })
    })
    expect(hasUnreadSessions('anti')).toBe(true)
    const antiCached = qc.getQueryData<any[]>(queryKeys.antiSessions)
    expect(antiCached?.[0].completed_run_id).toBe('ra1')
    expect(antiCached?.[0].last_outcome).toBe('failed')

    // Deleting a session in the cache prunes its unread badge.
    await act(async () => {
      qc.setQueryData(queryKeys.antiSessions, [])
    })
    expect(hasUnreadSessions('anti')).toBe(false)

    act(() => markSessionRead('chat', 'c1', 'rc1'))
    expect(hasUnreadSessions('chat')).toBe(false)
  })
})
