import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/api/client'
import type { SessionMessagesResponse } from '@/api/types'
import { useChatStore } from './chatStore'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

class FakeWebSocket {
  static readonly OPEN = 1
  readyState = FakeWebSocket.OPEN
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  close() { this.onclose?.() }
  send() {}
}

describe('chatStore lifecycle', () => {
  beforeEach(() => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    useChatStore.setState({
      msgs: [],
      conn: 'connecting',
      streaming: false,
      hydrating: true,
      historyStatus: 'idle',
      historyError: null,
      sock: null,
      sessionId: null,
    })
  })

  afterEach(() => {
    useChatStore.getState().stop()
    vi.unstubAllGlobals()
  })

  it('leaves hydration when the active session is stopped', () => {
    useChatStore.setState({
      hydrating: true,
      historyStatus: 'loading_history',
      sessionId: 'session-a',
    })

    useChatStore.getState().stop()

    expect(useChatStore.getState()).toMatchObject({
      sessionId: null,
      conn: 'closed',
      historyStatus: 'idle',
      hydrating: false,
    })
  })

  it('ignores stale history after switching sessions', async () => {
    const first = deferred<SessionMessagesResponse>()
    const second = deferred<SessionMessagesResponse>()
    vi.spyOn(api, 'getSessionMessages').mockImplementation((sessionId) =>
      sessionId === 'session-a' ? first.promise : second.promise,
    )

    useChatStore.getState().start('session-a')
    useChatStore.getState().start('session-b')

    second.resolve({
      session_id: 'session-b',
      archive_bound: true,
      revision: 'b1',
      items: [{ id: 'b-message', role: 'assistant', content: 'new session', ordinal: 1 }],
    })
    await second.promise
    await vi.waitFor(() => expect(useChatStore.getState().historyStatus).toBe('ready'))

    first.resolve({
      session_id: 'session-a',
      archive_bound: true,
      revision: 'a1',
      items: [{ id: 'a-message', role: 'assistant', content: 'stale session', ordinal: 1 }],
    })
    await first.promise
    await Promise.resolve()

    expect(useChatStore.getState()).toMatchObject({
      sessionId: 'session-b',
      historyStatus: 'ready',
      msgs: [expect.objectContaining({ content: 'new session' })],
    })
  })
})
