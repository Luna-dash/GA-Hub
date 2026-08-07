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
  static instances: FakeWebSocket[] = []
  readonly url: string
  readyState = FakeWebSocket.OPEN
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(url = '') {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  close() { this.onclose?.() }
  send() {}
  emit(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent)
  }
}

describe('chatStore lifecycle', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
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

  it('rebinds a cached session without replaying archive history', async () => {
    const getHistory = vi.spyOn(api, 'getSessionMessages')
      .mockResolvedValueOnce({
        session_id: 'session-a', archive_bound: true, revision: 'a1',
        items: [{ id: 'a-message', role: 'assistant', content: 'cached session A', ordinal: 0 }],
      })
      .mockResolvedValueOnce({
        session_id: 'session-b', archive_bound: true, revision: 'b1',
        items: [{ id: 'b-message', role: 'assistant', content: 'cached session B', ordinal: 0 }],
      })

    useChatStore.getState().start('session-a')
    await vi.waitFor(() => expect(useChatStore.getState().historyStatus).toBe('ready'))
    useChatStore.getState().start('session-b')
    await vi.waitFor(() => expect(useChatStore.getState().historyStatus).toBe('ready'))

    useChatStore.getState().start('session-a')

    expect(getHistory).toHaveBeenCalledTimes(2)
    expect(useChatStore.getState()).toMatchObject({
      sessionId: 'session-a',
      hydrating: false,
      historyStatus: 'ready',
      msgs: [expect.objectContaining({ content: 'cached session A' })],
    })
  })

  it('keeps cursor updates scoped to the cached session across A/B switches', async () => {
    const getHistory = vi.spyOn(api, 'getSessionMessages')
      .mockResolvedValueOnce({
        session_id: 'session-a', archive_bound: true, revision: 'a1',
        items: [{ id: 'a-message', role: 'assistant', content: 'A history', ordinal: 0 }],
      })
      .mockResolvedValueOnce({
        session_id: 'session-b', archive_bound: true, revision: 'b1',
        items: [{ id: 'b-message', role: 'assistant', content: 'B history', ordinal: 0 }],
      })

    useChatStore.getState().start('session-a')
    await vi.waitFor(() => expect(useChatStore.getState().historyStatus).toBe('ready'))
    useChatStore.getState().start('session-b')
    await vi.waitFor(() => expect(useChatStore.getState().historyStatus).toBe('ready'))
    useChatStore.getState().start('session-a')

    const resumedA = FakeWebSocket.instances.at(-1)!
    expect(resumedA.url).toContain('/session-a')
    resumedA.emit({ type: 'next', stream_id: 'a-live', content: 'A continued' })
    await vi.waitFor(() => expect(useChatStore.getState().msgs.some((m) => m.content === 'A continued')).toBe(true))

    useChatStore.getState().start('session-b')

    expect(getHistory).toHaveBeenCalledTimes(2)
    expect(useChatStore.getState().msgs.map((m) => m.content)).toEqual(['B history'])
    expect(useChatStore.getState().sessionViews['session-a'].msgs.some((m) => m.content === 'A continued')).toBe(true)
  })

  it('flushes a throttled tail into the old session before switching', async () => {
    vi.spyOn(api, 'getSessionMessages')
      .mockResolvedValueOnce({ session_id: 'session-a', archive_bound: true, revision: 'a1', items: [] })
      .mockResolvedValueOnce({ session_id: 'session-b', archive_bound: true, revision: 'b1', items: [] })

    useChatStore.getState().start('session-a')
    await vi.waitFor(() => expect(useChatStore.getState().historyStatus).toBe('ready'))
    const socketA = FakeWebSocket.instances.at(-1)!
    socketA.emit({ type: 'next', stream_id: 'a-live', content: 'first' })
    socketA.emit({ type: 'next', stream_id: 'a-live', content: 'final tail' })

    useChatStore.getState().start('session-b')
    await vi.waitFor(() => expect(useChatStore.getState().historyStatus).toBe('ready'))
    await new Promise((resolve) => setTimeout(resolve, 120))

    expect(useChatStore.getState().msgs).toEqual([])
    expect(useChatStore.getState().sessionViews['session-a'].msgs).toEqual([
      expect.objectContaining({ streamId: 'a-live', content: 'final tail' }),
    ])
  })

  it('does not apply a deferred snapshot after switching sessions', async () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.spyOn(api, 'getSessionMessages')
      .mockResolvedValueOnce({ session_id: 'session-a', archive_bound: true, revision: 'a1', items: [] })
      .mockResolvedValueOnce({ session_id: 'session-b', archive_bound: true, revision: 'b1', items: [] })

    useChatStore.getState().start('session-a')
    await vi.waitFor(() => expect(useChatStore.getState().historyStatus).toBe('ready'))
    FakeWebSocket.instances.at(-1)!.emit({
      type: 'snapshot',
      streams: [{ stream_id: 'a-live', source: 'user', query: '', content: 'late A snapshot', done: false, started_at: 1, finished_at: 0 }],
    })

    useChatStore.getState().start('session-b')
    await vi.waitFor(() => expect(useChatStore.getState().historyStatus).toBe('ready'))
    while (frames.length) frames.shift()!(0)

    expect(useChatStore.getState().msgs).toEqual([])
  })
})
