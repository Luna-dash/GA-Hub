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
      sessionViews: {},
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

  it('rolls back only the matching pending WebUI message after submit failure', () => {
    const first = useChatStore.getState().stageWebui('keep me', [])
    const second = useChatStore.getState().stageWebui('remove me', [])

    useChatStore.getState().rollbackWebui(second)

    expect(useChatStore.getState().msgs).toEqual([
      expect.objectContaining({ content: 'keep me', pendingWebui: true }),
    ])
    expect(useChatStore.getState().streaming).toBe(true)

    useChatStore.getState().rollbackWebui(first)
    expect(useChatStore.getState().msgs).toEqual([])
    expect(useChatStore.getState().streaming).toBe(false)
  })

  it('does not remove a staged message after the server has adopted it', () => {
    const stageId = useChatStore.getState().stageWebui('accepted', [])
    const staged = useChatStore.getState().msgs[0]
    useChatStore.setState({
      msgs: [{ ...staged, streamId: 'server-stream', pendingWebui: false }],
    })

    useChatStore.getState().rollbackWebui(stageId)

    expect(useChatStore.getState().msgs).toEqual([
      expect.objectContaining({ content: 'accepted', streamId: 'server-stream' }),
    ])
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

  it('restores a cached session immediately while history refresh is pending', async () => {
    const refreshA = deferred<SessionMessagesResponse>()
    vi.spyOn(api, 'getSessionMessages')
      .mockResolvedValueOnce({
        session_id: 'session-a', archive_bound: true, revision: 'a1',
        items: [{ id: 'a-message', role: 'assistant', content: 'cached session A', ordinal: 0 }],
      })
      .mockResolvedValueOnce({ session_id: 'session-b', archive_bound: false, revision: '', items: [] })
      .mockImplementationOnce(() => refreshA.promise)

    useChatStore.getState().start('session-a')
    await vi.waitFor(() => expect(useChatStore.getState().historyStatus).toBe('ready'))
    useChatStore.getState().start('session-b')
    await vi.waitFor(() => expect(useChatStore.getState().historyStatus).toBe('ready'))

    useChatStore.getState().start('session-a')
    expect(useChatStore.getState()).toMatchObject({
      sessionId: 'session-a',
      hydrating: false,
      historyStatus: 'loading_history',
      msgs: [expect.objectContaining({ content: 'cached session A' })],
    })

    refreshA.resolve({ session_id: 'session-a', archive_bound: true, revision: 'a2', items: [] })
    await refreshA.promise
  })

  it('keeps the cached projection when archive history is unavailable', async () => {
    vi.spyOn(api, 'getSessionMessages')
      .mockResolvedValueOnce({
        session_id: 'session-a', archive_bound: true, revision: 'a1',
        items: [{ id: 'a-message', role: 'assistant', content: 'keep cached history', ordinal: 0 }],
      })
      .mockResolvedValueOnce({ session_id: 'session-b', archive_bound: false, revision: '', items: [] })
      .mockRejectedValueOnce(new Error('history_unavailable'))

    useChatStore.getState().start('session-a')
    await vi.waitFor(() => expect(useChatStore.getState().historyStatus).toBe('ready'))
    useChatStore.getState().start('session-b')
    await vi.waitFor(() => expect(useChatStore.getState().historyStatus).toBe('ready'))
    useChatStore.getState().start('session-a')

    await vi.waitFor(() => expect(useChatStore.getState().historyStatus).toBe('history_error'))
    expect(useChatStore.getState()).toMatchObject({
      sessionId: 'session-a',
      hydrating: false,
      msgs: [expect.objectContaining({ content: 'keep cached history' })],
    })
  })
})
