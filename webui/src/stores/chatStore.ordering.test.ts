import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/api/client'
import { historyToMessages, mergeSessionSnapshot, orderConversationTurns, prependUniqueHistory, useChatStore, type ChatMsg } from './chatStore'

const turn = (run: string, start: number, finish = start + 10): ChatMsg[] => [
  { role: 'user', content: `${run}:q`, runId: run, timestamp: start },
  { role: 'assistant', content: `${run}:a`, runId: run, timestamp: finish },
]
const questions = (msgs: ChatMsg[]) => msgs.filter(m => m.role === 'user').map(m => m.content)
const snapshot = { type: 'snapshot' as const, streams: [] }

describe('conversation turn ordering', () => {
  afterEach(() => { useChatStore.getState().teardown(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('repairs a disordered cached projection even with an empty snapshot', () => {
    const msgs = mergeSessionSnapshot([...turn('new', 20), ...turn('old', 10)], snapshot)
    expect(questions(msgs)).toEqual(['old:q', 'new:q'])
    expect(msgs.map(m => m.content)).toEqual(['old:q', 'old:a', 'new:q', 'new:a'])
  })

  it('uses question start, not answer completion, and does not mutate inputs', () => {
    const msgs = [...turn('new', 20, 25), ...turn('old', 10, 100)]
    const before = [...msgs]
    expect(orderConversationTurns(msgs).map(m => m.content)).toEqual(['old:q', 'old:a', 'new:q', 'new:a'])
    expect(msgs).toEqual(before)
    const sorted = orderConversationTurns(msgs)
    expect(orderConversationTurns(sorted)).toBe(sorted)
  })

  it('keeps retries and run-scoped notices with their question without merging runs', () => {
    const [query, answer] = turn('old', 10)
    const note: ChatMsg = { role: 'assistant', content: 'retry', source: 'system', runId: 'old', timestamp: 50 }
    const retry: ChatMsg = { role: 'assistant', content: 'retry answer', runId: 'old', timestamp: 60 }
    const msgs = orderConversationTurns([answer, ...turn('new', 20), query, note, retry])
    expect(msgs.map(m => m.content)).toEqual(['old:q', 'old:a', 'retry', 'retry answer', 'new:q', 'new:a'])
    expect(msgs.filter(m => m.runId === 'new')).toHaveLength(2)
  })

  it('keeps the first question anchor when a same-run snapshot carries a later timestamp', () => {
    const msgs = mergeSessionSnapshot([...turn('new', 20_000), ...turn('old', 10_000)], {
      type: 'snapshot', streams: [{ stream_id: 'retry', run_id: 'old', query: 'old:q', source: 'webui',
        content: 'old:a', done: false, started_at: 30, finished_at: 0 }],
    })
    expect(questions(msgs)).toEqual(['old:q', 'new:q'])
    expect(msgs[0].timestamp).toBe(10_000)
  })

  it('orders answer-only snapshots by stream start rather than completion', () => {
    const msgs = mergeSessionSnapshot([], { type: 'snapshot', streams: [
      { stream_id: 'new', run_id: 'new', source: 'webui', query: '', content: 'new:a', done: true, started_at: 20, finished_at: 25 },
      { stream_id: 'old', run_id: 'old', source: 'webui', query: '', content: 'old:a', done: true, started_at: 10, finished_at: 100 },
    ] })
    expect(msgs.map(m => m.content)).toEqual(['old:a', 'new:a'])
  })

  it('pairs legacy history locally rather than joining recycled stream ids', () => {
    const old = turn('old', 10, 100).map(m => ({ ...m, runId: undefined, source: 'history', streamId: `history:${m.content}` }))
    const newer = turn('new', 20, 25).map(m => ({ ...m, runId: undefined, source: 'webui', streamId: 's00000001' }))
    expect(orderConversationTurns([...newer, ...old]).map(m => m.content)).toEqual(['old:q', 'old:a', 'new:q', 'new:a'])
  })

  it('keeps missing-time turns, global notices and pending questions in stable slots', () => {
    const unknown = turn('unknown', 0).map(m => ({ ...m, timestamp: undefined }))
    const notice: ChatMsg = { role: 'assistant', content: 'notice', source: 'system', timestamp: 999 }
    const pending: ChatMsg = { role: 'user', content: 'queued', pendingWebui: true, timestamp: 1 }
    const msgs = orderConversationTurns([...turn('new', 20), ...unknown, notice, ...turn('old', 10), pending])
    expect(msgs.map(m => m.content)).toEqual(['old:q', 'old:a', 'unknown:q', 'unknown:a', 'notice', 'new:q', 'new:a', 'queued'])
    expect(msgs.at(-1)).toBe(pending)
  })

  it('preserves equal-time turn order and does not use NaN as a sorting key', () => {
    const msgs = [...turn('first', 10), ...turn('second', 10), ...turn('invalid', NaN)]
    expect(orderConversationTurns(msgs)).toBe(msgs)
  })

  it('orders old snapshot streams before the running task and preserves final text', () => {
    const base = turn('current', 30)
    base[1] = { ...base[1], streaming: true }
    const msgs = mergeSessionSnapshot(base, { type: 'snapshot', streams: [{
      run_id: 'old', stream_id: 's00000001', logical_id: 's00000001', source: 'webui',
      query: 'old:q', content: 'old:a', started_at: 0.01, finished_at: 0.1, done: true,
    }] })
    expect(questions(msgs)).toEqual(['old:q', 'current:q'])
    expect(msgs.at(-1)).toMatchObject({ runId: 'current', content: 'current:a', streaming: true })
  })

  it('orders older pagination together with live turns and deduplicates archive overlap', () => {
    const archive = (run: string, time: string) => historyToMessages([
      { role: 'user', id: `${run}:q`, content: `${run}:q`, ordinal: 0, timestamp: time, run_id: run },
      { role: 'assistant', id: `${run}:a`, content: `${run}:a`, ordinal: 1, timestamp: time, run_id: run },
    ])
    const old = archive('old', '2026-10-13 11:00:00')
    const newer = archive('new', '2026-10-13 12:00:00')
    const current = turn('current', new Date('2026-10-13T13:00:00').getTime())
    const msgs = prependUniqueHistory([...old, ...newer], [...newer, ...current])
    expect(questions(msgs)).toEqual(['old:q', 'new:q', 'current:q'])
    expect(msgs).toHaveLength(6)
  })

  it('repairs cached session on switch before any socket snapshot arrives', () => {
    class Socket { close() {} }
    vi.stubGlobal('WebSocket', Socket)
    useChatStore.setState({ sessionId: null, sock: null, msgs: [], sessionViews: {
      cached: { msgs: [...turn('new', 20), ...turn('old', 10)], streaming: false, resumePolicy: 'restore-position', projectionReady: true,
        historyStatus: 'ready', historyError: null, historyRevision: 'rev', historyHasMore: false, historyBefore: null,
        olderHistoryStatus: 'idle', olderHistoryError: null, lastAccessedAt: 1 },
    } })
    const history = vi.spyOn(api, 'getSessionMessages')
    useChatStore.getState().start('cached')
    expect(questions(useChatStore.getState().msgs)).toEqual(['old:q', 'new:q'])
    expect(history).not.toHaveBeenCalled()
  })
})
