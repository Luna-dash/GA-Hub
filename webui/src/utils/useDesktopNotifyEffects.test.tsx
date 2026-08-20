// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: any) => void>(),
  notify: vi.fn(),
  subscribe: vi.fn((prefix: string, handler: (event: any) => void) => {
    mocks.handlers.set(prefix, handler)
    return () => mocks.handlers.delete(prefix)
  }),
}))

vi.mock('@/runtime/hubEventClient', () => ({
  hubEventClient: { subscribe: mocks.subscribe },
}))

vi.mock('./notify', () => ({ notify: mocks.notify }))

import { useChatStore } from '@/stores/chatStore'
import { useDesktopNotifyEffects } from './useDesktopNotifyEffects'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Probe() {
  useDesktopNotifyEffects()
  return null
}

describe('useDesktopNotifyEffects', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    mocks.handlers.clear()
    mocks.notify.mockClear()
    mocks.subscribe.mockClear()
    useChatStore.setState({ msgs: [], streaming: false })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => root.render(<Probe />))
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('notifies exactly when a chat stream transitions to idle', () => {
    act(() => useChatStore.setState({
      streaming: true,
      msgs: [{ role: 'assistant', content: 'finished answer', streaming: true }],
    }))
    expect(mocks.notify).not.toHaveBeenCalled()

    act(() => useChatStore.setState({
      streaming: false,
      msgs: [{ role: 'assistant', content: 'finished answer', streaming: false }],
    }))

    expect(mocks.notify).toHaveBeenCalledWith('Agent 已回复', {
      body: 'finished answer',
      tag: 'agent-stream-done',
    })
  })

  it('notifies from a global Conductor event without page store state', () => {
    act(() => mocks.handlers.get('conductor:workflow_completed')?.({
      topic: 'conductor:workflow_completed',
      ts: Date.now() / 1000,
      payload: {
        request_id: 'request-1',
        status: 'completed',
        item: { role: 'conductor', msg: 'background result' },
      },
    }))

    expect(mocks.notify).toHaveBeenCalledWith('Conductor 任务完成', {
      body: 'background result',
      tag: 'conductor-task-done',
    })
  })

  it('does not subscribe to per-turn Conductor outcomes as workflow completion', () => {
    act(() => mocks.handlers.get('conductor:request_outcome')?.({
      topic: 'conductor:request_outcome',
      ts: Date.now() / 1000,
      payload: {
        request_id: 'request-2',
        status: 'failed',
        phase: 'drain',
        error: 'worker failed',
      },
    }))

    expect(mocks.notify).not.toHaveBeenCalled()
  })
})
