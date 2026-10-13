import { describe, expect, it } from 'vitest'
import { applyEvent, historyToMessages, mergeSessionSnapshot } from './chatStore'

const archived = (contents: string[]) => historyToMessages(contents.map((content, ordinal) => ({
  id: `h${ordinal}`, ordinal, role: 'assistant' as const, content, timestamp: null,
  run_id: 'r', logical_id: 'a', outcome: null,
})))
const frame = (streams: { stream_id: string; content: string; done?: boolean }[]) => ({
  type: 'snapshot' as const, session_id: 's',
  runtime: { status: 'running', run_id: 'r', stream_id: 'a', error: null },
  streams: streams.map((s, i) => ({ ...s, done: s.done ?? false, run_id: 'r', logical_id: 'a',
    source: i ? 'auto_continue' : 'webui', query: i ? '[GA_CONTINUE]' : 'question',
    started_at: i + 1, finished_at: 0 })),
})

describe('review recovery regressions', () => {
  it('settles terminal identity from the actual legacy nested runtime shape', () => {
    const base = applyEvent([], { type: 'started', stream_id: 'a', run_id: 'r', logical_id: 'a', query: 'q' })
    const msgs = mergeSessionSnapshot(base, { type: 'snapshot', session_id: 's',
      completed_run_id: 'r', outcome: 'completed',
      runtime: { status: 'idle', run_id: null, stream_id: null, error: null }, active_message: null })
    expect(msgs.find(m => m.role === 'assistant')).toMatchObject({ streaming: false, outcome: 'completed' })
  })
  it('preserves archived pieces during a partial continuation snapshot and later cumulative updates', () => {
    let msgs = mergeSessionSnapshot(archived(['FIRST']), frame([{ stream_id: 'b', content: 'SECOND' }]))
    expect(msgs.filter(m => m.role === 'assistant')).toHaveLength(1)
    expect(msgs.find(m => m.role === 'assistant')?.content).toBe('FIRST\n\nSECOND')
    msgs = applyEvent(msgs, { type: 'next', stream_id: 'b', run_id: 'r', logical_id: 'a', content: 'SECOND more' })
    expect(msgs.find(m => m.role === 'assistant')?.content).toBe('FIRST\n\nSECOND more')
  })
  it('adopts full snapshot pieces once and remains idempotent', () => {
    const event = frame([{ stream_id: 'a', content: 'FIRST', done: true }, { stream_id: 'b', content: 'SECOND' }])
    let msgs = mergeSessionSnapshot(archived(['FIRST', 'SECOND']), event)
    msgs = mergeSessionSnapshot(msgs, event)
    expect(msgs.filter(m => m.role === 'assistant')).toHaveLength(1)
    expect(msgs.find(m => m.role === 'assistant')?.content).toBe('FIRST\n\nSECOND')
    expect(msgs.find(m => m.role === 'assistant')?.segments?.map(s => s.streamId)).toEqual(['a', 'b'])
  })
  it('keeps archive-only older pieces when live projection capacity evicts them', () => {
    const msgs = mergeSessionSnapshot(archived(['FIRST', 'SECOND']), frame([{ stream_id: 'b', content: 'SECOND more' }]))
    expect(msgs.find(m => m.role === 'assistant')?.content).toBe('FIRST\n\nSECOND more')
  })
  it('preserves archive pieces for direct continuation events without a snapshot', () => {
    const msgs = applyEvent(archived(['FIRST']), { type: 'next', stream_id: 'b', run_id: 'r', logical_id: 'a', content: 'SECOND' })
    expect(msgs.find(m => m.role === 'assistant')?.content).toBe('FIRST\n\nSECOND')
  })
})
