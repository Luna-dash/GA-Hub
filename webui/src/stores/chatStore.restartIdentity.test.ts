import { describe, expect, it } from 'vitest'
import { applyEvent, historyToMessages, mergeSessionSnapshot } from './chatStore'

const history = (run: string, answer: string, outcome: 'completed' | null = null) => historyToMessages([
  { id: `${run}:q`, ordinal: 0, role: 'user' as const, content: 'question', timestamp: null, run_id: run, logical_id: 's00000001', stream_id: 's00000001', outcome },
  { id: `${run}:a`, ordinal: 1, role: 'assistant' as const, content: answer, timestamp: null, run_id: run, logical_id: 's00000001', stream_id: 's00000001', outcome },
])
const started = (run: string, query = '继续') => ({ type: 'started' as const, stream_id: 's00000001', logical_id: 's00000001', run_id: run, query, source: 'webui' })

describe('cross-restart identity and replay', () => {
  it('adopts pending continue into a new run without changing the interrupted answer', () => {
    let msgs = history('old', 'OLD INTERRUPTED')
    msgs.push({ role: 'user', content: '继续', pendingWebui: true, pendingWebuiId: 'local' })
    msgs = applyEvent(msgs, started('new'))
    expect(msgs[2]).toMatchObject({ pendingWebui: false, runId: 'new' })
    msgs = applyEvent(msgs, { ...started('new'), type: 'done', content: 'NEW ANSWER' })
    expect(msgs.filter(m => m.role === 'assistant').map(m => m.content)).toEqual(['OLD INTERRUPTED', 'NEW ANSWER'])
    expect(msgs[0].runId).toBe('old')
    expect(msgs[1].runId).toBe('old')
    msgs = applyEvent(msgs, started('new'))
    expect(msgs).toHaveLength(4)
  })

  it('does not lose a new run when an older colliding run was completed', () => {
    let msgs = applyEvent(history('old', 'OLD', 'completed'), started('new'))
    msgs = applyEvent(msgs, { ...started('new'), type: 'next', content: 'NEW' })
    expect(msgs.filter(m => m.role === 'assistant').map(m => m.content)).toEqual(['OLD', 'NEW'])
  })

  it('adopts the archived first physical stream for cumulative direct events instead of appending a second replay', () => {
    const msgs = applyEvent(history('r', 'FIRST partial'), { ...started('r'), type: 'next', content: 'FIRST partial more' })
    expect(msgs[1].content).toBe('FIRST partial more')
    expect(msgs[1].segments?.map(p => p.streamId)).toEqual(['s00000001'])
  })

  it('uses completed archive text once despite different live tool serialization', () => {
    const archive = 'SUMMARY\n🛠️ Tool: `code_run`  📥 args:\n```text\n{}\n```\nFINAL'
    const frame = { type: 'snapshot' as const, session_id: 's', streams: [{
      stream_id: 's00000001', logical_id: 's00000001', run_id: 'r', query: 'question', source: 'webui',
      content: 'SUMMARY\n🛠️ code_run({})\nFINAL', done: true, started_at: 1, finished_at: 2,
    }], runtime: { status: 'idle' as const, run_id: null, stream_id: null, error: null, completed_run_id: 'r', outcome: 'completed' as const } }
    let msgs = mergeSessionSnapshot(history('r', archive, 'completed'), frame)
    msgs = mergeSessionSnapshot(msgs, frame)
    expect(msgs.filter(m => m.role === 'assistant')).toHaveLength(1)
    expect(msgs[1].content).toBe(archive)
  })

  it('keeps a genuinely different continuation segment in the same run', () => {
    const msgs = applyEvent(history('r', 'FIRST'), { ...started('r'), type: 'next', stream_id: 'b', source: 'auto_continue', content: 'SECOND' })
    expect(msgs[1].content).toBe('FIRST\n\nSECOND')
  })

  it('keeps retry notices inside their run even when logical IDs collide', () => {
    const retry = { ...started('new'), stream_id: 'b', source: 'auto_continue', retry_of: 's00000001' }
    const msgs = applyEvent(history('old', 'OLD'), retry)
    expect(msgs[1].recoveryNotice).toBeUndefined()
    expect(msgs.find(m => m.runId === 'new')?.recoveryNotice).toBeTruthy()
  })
})
