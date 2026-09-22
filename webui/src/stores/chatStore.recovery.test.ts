import { describe, expect, it } from 'vitest'
import { applyEvent, type ChatMsg } from './chatStore'

describe('logical recovery reply', () => {
  it('attaches snapshot status through retry_of without leaking it into content', () => {
    const msgs = applyEvent([], { type: 'snapshot', streams: [
      { stream_id: 'a', source: 'user', query: 'question', content: 'first', done: true, started_at: 1000, finished_at: 1001 },
      { stream_id: 'b', retry_of: 'a', source: 'chat_error_retry', query: '[GA_CONTINUE]', content: 'second', done: false, started_at: 1002, finished_at: 0 },
    ] })
    const replies = msgs.filter((m) => m.role === 'assistant')
    expect(replies).toHaveLength(1)
    expect(replies[0].streamId).toBe('a')
    expect(replies[0].recoveryNotice).toBeTruthy()
    expect(replies[0].content).toBe('first\n\nsecond')
    expect(replies[0].streaming).toBe(true)
    expect(msgs.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['question'])
  })
  it('replays recovery streams in one reply without exposing injected queries', () => {
    const msgs = applyEvent([], { type: 'snapshot', streams: [
      { stream_id: 'a', source: 'user', query: 'question', content: 'first', done: true, started_at: 1000, finished_at: 1001 },
      { stream_id: 'b', logical_id: 'a', source: 'auto_continue', query: '[GA_CONTINUE]', content: 'second', done: true, started_at: 1002, finished_at: 1003 },
      { stream_id: 'c', logical_id: 'a', source: 'chat_error_retry', query: '[GA_CONTINUE]', content: 'third', done: false, started_at: 1004, finished_at: 0 },
    ] })
    expect(msgs.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['question'])
    const replies = msgs.filter((m) => m.segments)
    expect(replies).toHaveLength(1)
    expect(replies[0].streamId).toBe('a')
    expect(replies[0].content).toBe('first\n\nsecond\n\nthird')
    expect(replies[0].streaming).toBe(true)
  })
  it('keeps the original bubble and cumulative content across recovery streams', () => {
    let msgs: ChatMsg[] = []
    msgs = applyEvent(msgs, { type: 'started', stream_id: 'a', query: 'question' })
    msgs = applyEvent(msgs, { type: 'done', stream_id: 'a', content: 'first' })
    msgs = applyEvent(msgs, { type: 'started', stream_id: 'b', logical_id: 'a', source: 'auto_continue' })
    msgs = applyEvent(msgs, { type: 'next', stream_id: 'b', logical_id: 'a', source: 'auto_continue', content: 'sec' })
    msgs = applyEvent(msgs, { type: 'done', stream_id: 'b', logical_id: 'a', source: 'auto_continue', content: 'second' })
    const replies = msgs.filter((m) => m.segments)
    expect(replies).toHaveLength(1)
    expect(replies[0].streamId).toBe('a')
    expect(replies[0].content).toBe('first\n\nsecond')
    expect(replies[0].streaming).toBe(false)
    expect(msgs.filter((m) => m.role === 'user')).toHaveLength(1)
    msgs = applyEvent(msgs, { type: 'next', stream_id: 'b', content: 'late' })
    expect(msgs.find((m) => m.segments)?.content).toBe('first\n\nsecond')
    expect(msgs.find((m) => m.segments)?.streaming).toBe(false)
  })
})
