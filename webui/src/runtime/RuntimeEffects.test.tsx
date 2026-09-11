// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeEffects } from './RuntimeEffects'
import { useConductorStore } from '@/stores/conductorStore'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  subscribe: vi.fn(),
  subscribeControl: vi.fn(),
  subscribeState: vi.fn(),
}))

vi.mock('@/runtime/hubEventClient', () => ({
  hubEventClient: {
    subscribe: mocks.subscribe,
    subscribeControl: mocks.subscribeControl,
    subscribeState: mocks.subscribeState,
  },
}))

vi.mock('@/hooks/useDesktopNotifyEffects', () => ({
  useDesktopNotifyEffects: vi.fn(),
}))

vi.mock('@/hooks/useDocumentTitle', () => ({
  useDocumentTitle: vi.fn(),
}))

describe('RuntimeEffects', () => {
  let root: Root | undefined
  let host: HTMLDivElement

  beforeEach(() => {
    mocks.subscribe.mockReset()
    mocks.subscribeControl.mockReset()
    mocks.subscribeState.mockReset()
    mocks.subscribe.mockImplementation(() => () => {})
    mocks.subscribeControl.mockImplementation(() => () => {})
    mocks.subscribeState.mockImplementation(() => () => {})
    useConductorStore.getState().clear()
    host = document.createElement('div')
    document.body.appendChild(host)
  })

  afterEach(() => {
    act(() => root?.unmount())
    host.remove()
    vi.restoreAllMocks()
  })

  it('refreshes active queries once after a reconnect, not on the initial open', () => {
    const queryClient = new QueryClient()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined)
    const mountedRoot = createRoot(host)
    root = mountedRoot
    act(() => mountedRoot.render(
      <QueryClientProvider client={queryClient}>
        <RuntimeEffects />
      </QueryClientProvider>,
    ))

    const onState = mocks.subscribeState.mock.calls[0][0] as (state: string) => void
    onState('connecting')
    onState('open')
    expect(invalidate).not.toHaveBeenCalled()

    onState('closed')
    onState('connecting')
    onState('open')
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(invalidate).toHaveBeenCalledWith({ refetchType: 'active' })
  })

  it('projects Conductor events globally and clears state on hard resync', () => {
    const queryClient = new QueryClient()
    const mountedRoot = createRoot(host)
    root = mountedRoot
    act(() => mountedRoot.render(
      <QueryClientProvider client={queryClient}>
        <RuntimeEffects />
      </QueryClientProvider>,
    ))

    const onEvent = mocks.subscribe.mock.calls[0][1] as (event: unknown) => void
    const onControl = mocks.subscribeControl.mock.calls[0][0] as (control: unknown) => void
    onEvent({ topic: 'conductor:chat', payload: { item: { id: 'chat-1', role: 'user', msg: 'hi', ts: 1 } } })
    expect(useConductorStore.getState().chatMessages).toHaveLength(1)

    onControl({ type: 'resync_required', reason: 'server_restarted' })
    expect(useConductorStore.getState().chatMessages).toEqual([])
  })

  describe('activity timeline projection', () => {
    function mount() {
      const queryClient = new QueryClient()
      const mountedRoot = createRoot(host)
      root = mountedRoot
      act(() => mountedRoot.render(
        <QueryClientProvider client={queryClient}>
          <RuntimeEffects />
        </QueryClientProvider>,
      ))
      return mocks.subscribe.mock.calls[0][1] as (event: unknown) => void
    }

    it('records the row the hub authored, including kinds this build cannot name', () => {
      const onEvent = mount()

      // `milestone`/`force_accept` have never had an entry in the local label
      // table, so the legacy path dropped them. The hub authors the row, so
      // they survive.
      onEvent({
        topic: 'conductor:subagent_milestone',
        event_id: 41,
        ts: 1_700_000_010,
        payload: {
          request_id: 'r1', id: 'w1',
          activity: {
            id: 'ep:41', request_id: 'r1', kind: 'worker_milestone',
            at: 1_700_000_010, atMs: 1_700_000_010_000,
            text: '里程碑 · 扫描目录', worker_id: 'w1',
          },
        },
      })

      expect(useConductorStore.getState().activity).toEqual([{
        id: 'ep:41', request_id: 'r1', kind: 'worker_milestone',
        at: 1_700_000_010, atMs: 1_700_000_010_000,
        text: '里程碑 · 扫描目录', worker_id: 'w1',
      }])
    })

    it('falls back to the local label table for a hub without authored rows', () => {
      const onEvent = mount()

      onEvent({
        topic: 'conductor:subagent_spawned',
        event_id: 7,
        ts: 1_700_000_020,
        payload: { request_id: 'r1', id: 'w1' },
      })

      expect(useConductorStore.getState().activity).toHaveLength(1)
      expect(useConductorStore.getState().activity[0].text).toBe('子代理已派出')
      expect(useConductorStore.getState().activity[0].kind).toBe('worker_spawned')
    })
  })
})
