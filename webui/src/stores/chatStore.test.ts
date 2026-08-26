import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/api/client'
import type { ConversationMessage, SessionMessagesResponse } from '@/api/types'
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
      historyRevision: null,
      historyHasMore: false,
      historyBefore: null,
      olderHistoryStatus: 'idle',
      olderHistoryError: null,
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

  it('restores a filtered transcript and banner with one store notification', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_234)
    useChatStore.setState({
      msgs: [{ role: 'assistant', content: 'stale' }],
      streaming: true,
      historyRevision: 'old-revision',
      historyHasMore: true,
      historyBefore: 42,
      olderHistoryStatus: 'error',
      olderHistoryError: 'old error',
    })
    const listener = vi.fn()
    const unsubscribe = useChatStore.subscribe(listener)
    const restored = [
      { role: 'assistant', content: 'answer first' },
      { role: 'tool', content: 'must stay hidden' },
      { role: 'user', content: 'question second' },
    ] as unknown as ConversationMessage[]

    useChatStore.getState().restoreVisibleConversation(restored, '_restored_')
    unsubscribe()

    expect(listener).toHaveBeenCalledTimes(1)
    expect(useChatStore.getState()).toMatchObject({
      msgs: [
        { role: 'assistant', content: 'answer first' },
        { role: 'user', content: 'question second' },
        { role: 'assistant', content: '_restored_', source: 'system', timestamp: 1_234 },
      ],
      streaming: false,
      historyRevision: null,
      historyHasMore: false,
      historyBefore: null,
      olderHistoryStatus: 'idle',
      olderHistoryError: null,
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

  it('does not duplicate a completed stream already present in archive history', async () => {
    vi.spyOn(api, 'getSessionMessages').mockResolvedValue({
      session_id: 'session-a', archive_bound: true, revision: 'a1',
      items: [
        { id: 'question', role: 'user', content: 'same question', ordinal: 0 },
        { id: 'answer', role: 'assistant', content: 'same answer', ordinal: 1 },
      ],
    })

    useChatStore.getState().start('session-a')
    await vi.waitFor(() => expect(useChatStore.getState().historyStatus).toBe('ready'))
    FakeWebSocket.instances.at(-1)!.emit({
      type: 'snapshot',
      streams: [{
        stream_id: 'completed-stream', source: 'user', query: 'same question',
        content: 'same answer', done: true, started_at: 1, finished_at: 2,
      }],
    })

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(useChatStore.getState().msgs.map((message) => message.content)).toEqual([
      'same question',
      'same answer',
    ])
  })

  it('keeps a newer identical completed turn when its timestamps do not overlap history', async () => {
    vi.spyOn(api, 'getSessionMessages').mockResolvedValue({
      session_id: 'session-a', archive_bound: true, revision: 'a1',
      items: [
        { id: 'old-question', role: 'user', content: 'repeat', ordinal: 0, timestamp: '2026-08-09 08:00:00' },
        { id: 'old-answer', role: 'assistant', content: 'repeat answer', ordinal: 1, timestamp: '2026-08-09 08:00:01' },
      ],
    })

    useChatStore.getState().start('session-a')
    await vi.waitFor(() => expect(useChatStore.getState().historyStatus).toBe('ready'))
    FakeWebSocket.instances.at(-1)!.emit({
      type: 'snapshot', streams: [{
        stream_id: 'new-stream', source: 'webui', query: 'repeat',
        content: 'repeat answer', done: true,
        started_at: Date.parse('2026-08-09T09:00:00'),
        finished_at: Date.parse('2026-08-09T09:00:01'),
      }],
    })

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(useChatStore.getState().msgs.map((message) => message.content)).toEqual([
      'repeat', 'repeat answer', 'repeat answer',
    ])
  })

  it('keeps an active snapshot even when its text matches archived history', async () => {
    vi.spyOn(api, 'getSessionMessages').mockResolvedValue({
      session_id: 'session-a', archive_bound: true, revision: 'a1',
      items: [
        { id: 'old-question', role: 'user', content: 'repeat', ordinal: 0 },
        { id: 'old-answer', role: 'assistant', content: 'partial', ordinal: 1 },
      ],
    })

    useChatStore.getState().start('session-a')
    await vi.waitFor(() => expect(useChatStore.getState().historyStatus).toBe('ready'))
    FakeWebSocket.instances.at(-1)!.emit({
      type: 'snapshot', streams: [{
        stream_id: 'active-stream', source: 'webui', query: 'repeat',
        content: 'partial', done: false, started_at: 2, finished_at: 0,
      }],
    })

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(useChatStore.getState().msgs).toHaveLength(3)
    expect(useChatStore.getState().msgs.at(-1)).toMatchObject({
      role: 'assistant', content: 'partial', streaming: true,
    })
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

  it('requests a bounded latest-history page on first hydration', async () => {
    const getHistory = vi.spyOn(api, 'getSessionMessages').mockResolvedValue({
      session_id: 'session-a', archive_bound: true, revision: 'a1',
      items: [], total: 0, has_more: false, next_before: null,
    })

    useChatStore.getState().start('session-a')
    await vi.waitFor(() => expect(useChatStore.getState().historyStatus).toBe('ready'))

    expect(getHistory).toHaveBeenCalledWith('session-a', expect.objectContaining({
      limit: 32,
      maxChars: 400_000,
      signal: expect.any(AbortSignal),
    }))
  })

  it('prepends older history without duplicating the current page', async () => {
    const getHistory = vi.spyOn(api, 'getSessionMessages')
      .mockResolvedValueOnce({
        session_id: 'session-a', archive_bound: true, revision: 'a1', total: 4,
        has_more: true, next_before: 2,
        items: [
          { id: 'question-2', role: 'user', content: 'newer question', ordinal: 2 },
          { id: 'answer-2', role: 'assistant', content: 'newer answer', ordinal: 3 },
        ],
      })
      .mockResolvedValueOnce({
        session_id: 'session-a', archive_bound: true, revision: 'a1', total: 4,
        has_more: false, next_before: null,
        items: [
          { id: 'question-1', role: 'user', content: 'older question', ordinal: 0 },
          { id: 'answer-1', role: 'assistant', content: 'older answer', ordinal: 1 },
        ],
      })

    useChatStore.getState().start('session-a')
    await vi.waitFor(() => expect(useChatStore.getState().historyBefore).toBe(2))
    await useChatStore.getState().loadOlderHistory()

    expect(getHistory).toHaveBeenLastCalledWith('session-a', expect.objectContaining({ before: 2 }))
    expect(useChatStore.getState().msgs.map((message) => message.content)).toEqual([
      'older question', 'older answer', 'newer question', 'newer answer',
    ])
    expect(useChatStore.getState()).toMatchObject({
      historyHasMore: false,
      historyBefore: null,
      olderHistoryStatus: 'idle',
    })
  })

  it('bounds inactive session projections and never caches the active session', async () => {
    vi.spyOn(api, 'getSessionMessages').mockImplementation(async (sessionId) => ({
      session_id: sessionId, archive_bound: true, revision: `${sessionId}-revision`,
      items: [{ id: `${sessionId}-message`, role: 'assistant', content: sessionId, ordinal: 0 }],
      total: 1, has_more: false, next_before: null,
    }))

    for (const sessionId of ['session-a', 'session-b', 'session-c', 'session-d', 'session-e']) {
      useChatStore.getState().start(sessionId)
      await vi.waitFor(() => {
        expect(useChatStore.getState()).toMatchObject({ sessionId, historyStatus: 'ready' })
      })
      await new Promise((resolve) => setTimeout(resolve, 2))
    }

    const cachedIds = Object.keys(useChatStore.getState().sessionViews)
    expect(cachedIds).toHaveLength(3)
    expect(cachedIds).not.toContain('session-e')
    expect(cachedIds).not.toContain('session-a')
  })

  it('drops a deleted current session before another switch can cache it again', async () => {
    vi.spyOn(api, 'getSessionMessages').mockImplementation(async (sessionId) => ({
      session_id: sessionId, archive_bound: true, revision: `${sessionId}-revision`,
      items: [], total: 0, has_more: false, next_before: null,
    }))

    useChatStore.getState().start('session-a')
    await vi.waitFor(() => expect(useChatStore.getState().historyStatus).toBe('ready'))
    useChatStore.getState().dropSessionView('session-a')
    useChatStore.getState().start('session-b')
    await vi.waitFor(() => expect(useChatStore.getState().historyStatus).toBe('ready'))

    expect(useChatStore.getState().sessionViews['session-a']).toBeUndefined()
  })
})


describe('chat_error_retry notice bubble reuse', () => {
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
      historyRevision: null,
      historyHasMore: false,
      historyBefore: null,
      olderHistoryStatus: 'idle',
      olderHistoryError: null,
      sock: null,
      sessionId: null,
      sessionViews: {},
    })
  })

  afterEach(() => {
    useChatStore.getState().stop()
    vi.unstubAllGlobals()
  })

  function notices() {
    return useChatStore.getState().msgs.filter((m) => m.source === 'chat_error_retry_notice')
  }

  it('reuses one bubble across multiple live retries instead of appending', async () => {
    vi.spyOn(api, 'getSessionMessages').mockResolvedValue({
      session_id: 'session-retry',
      archive_bound: true,
      revision: 'r1',
      items: [],
    })
    useChatStore.getState().start('session-retry')
    await vi.waitFor(() => expect(useChatStore.getState().historyStatus).toBe('ready'))

    const sock = FakeWebSocket.instances.at(-1)!
    sock.emit({ type: 'started', stream_id: 'r-a1', source: 'chat_error_retry', logical_id: 'turn-1', retry_attempt: 1, retry_max: 3, retry_reason: 'timeout' } as never)
    sock.emit({ type: 'done', stream_id: 'r-a1', source: 'chat_error_retry', logical_id: 'turn-1', retry_attempt: 1, retry_max: 3, content: '' } as never)
    sock.emit({ type: 'retry', stream_id: 'turn-1', source: 'chat_error_retry', logical_id: 'turn-1', attempt: 2, max_attempts: 3, retry_reason: 'timeout' } as never)
    sock.emit({ type: 'started', stream_id: 'r-a2', source: 'chat_error_retry', logical_id: 'turn-1', retry_attempt: 2, retry_max: 3, retry_reason: 'timeout' } as never)
    sock.emit({ type: 'retry_exhausted', stream_id: 'turn-1', source: 'chat_error_retry', logical_id: 'turn-1', max_attempts: 3, retry_reason: 'timeout' } as never)

    const list = notices()
    expect(list).toHaveLength(1)
    expect(list[0].streamId).toBe('turn-1:retry-notice')
    expect(list[0].content).toContain('上限（3/3）')
    expect(list[0].content).toContain('timeout')
  })

  it('merges same-turn retry streams from a snapshot into a single bubble', async () => {
    vi.spyOn(api, 'getSessionMessages').mockResolvedValue({
      session_id: 'session-snap',
      archive_bound: true,
      revision: 's1',
      items: [],
    })
    useChatStore.getState().start('session-snap')
    await vi.waitFor(() => expect(useChatStore.getState().historyStatus).toBe('ready'))

    FakeWebSocket.instances.at(-1)!.emit({
      type: 'snapshot',
      streams: [
        { stream_id: 'q1', source: 'webui', query: 'hello', content: 'world', done: true, started_at: 1_000, finished_at: 2_000 },
        { stream_id: 'sr-a1', source: 'chat_error_retry', query: '', content: '', done: true, started_at: 3_000, finished_at: 4_000, logical_id: 'turn-9', retry_attempt: 1, retry_max: 3, retry_reason: 'connection' },
        { stream_id: 'sr-a2', source: 'chat_error_retry', query: '', content: '', done: false, started_at: 5_000, finished_at: 0, logical_id: 'turn-9', retry_attempt: 2, retry_max: 3, retry_reason: 'connection' },
      ],
    } as never)

    // Snapshot application is deferred past the next paint in the store.
    await vi.waitFor(() => expect(notices()).toHaveLength(1))
    const list = notices()
    expect(list).toHaveLength(1)
    expect(list[0].streamId).toBe('turn-9:retry-notice')
    expect(list[0].content).toContain('进行中（2/3 · connection）')
    // The ongoing retry stream itself still renders its own content bubble.
    expect(
      useChatStore.getState().msgs.some((m) => m.streamId === 'sr-a2' && m.streaming),
    ).toBe(true)
  })

  it('keeps separate bubbles for different logical turns', async () => {
    vi.spyOn(api, 'getSessionMessages').mockResolvedValue({
      session_id: 'session-two',
      archive_bound: true,
      revision: 't1',
      items: [],
    })
    useChatStore.getState().start('session-two')
    await vi.waitFor(() => expect(useChatStore.getState().historyStatus).toBe('ready'))

    const sock = FakeWebSocket.instances.at(-1)!
    sock.emit({ type: 'retry', stream_id: 't-a', source: 'chat_error_retry', logical_id: 'turn-a', attempt: 1, max_attempts: 3, retry_reason: 'server' } as never)
    sock.emit({ type: 'retry', stream_id: 't-b', source: 'chat_error_retry', logical_id: 'turn-b', attempt: 1, max_attempts: 3, retry_reason: 'ssl' } as never)

    const list = notices()
    expect(list.map((m) => m.streamId)).toEqual(['turn-a:retry-notice', 'turn-b:retry-notice'])
  })
})


describe('pushSystem stable bubbles', () => {
  it('reuses one bubble per stableKey while plain pushes keep appending', () => {
    useChatStore.setState({ msgs: [] })
    const { pushSystem } = useChatStore.getState()
    pushSystem('_已切换到 [1] gpt-x_', 'llm-switch')
    pushSystem('_已切换到 [2] claude-y_', 'llm-switch')
    pushSystem('_一次性提示，不合并_')
    pushSystem('_切换项目失败：boom_', 'project-switch-fail')
    pushSystem('_再次切换项目失败：bam_', 'project-switch-fail')

    const msgs = useChatStore.getState().msgs
    expect(msgs).toHaveLength(3)
    expect(msgs.map((m) => m.streamId)).toEqual(['sys:llm-switch', undefined, 'sys:project-switch-fail'])
    expect(msgs[0].content).toBe('_已切换到 [2] claude-y_')
    expect(msgs[0].source).toBe('system')
    expect(msgs[2].content).toBe('_再次切换项目失败：bam_')
  })
})
