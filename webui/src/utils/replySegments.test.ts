import { describe, expect, it } from 'vitest'
import { replySegmentsContent, replySegmentsTurns, updateReplySegments, type ReplySegment } from './replySegments'

describe('reply stream segments', () => {
  it('replaces cumulative content per stream without losing earlier streams', () => {
    let parts: ReplySegment[] = []
    parts = updateReplySegments(parts, 'original', 'done', 'first')
    parts = updateReplySegments(parts, 'retry', 'next', 'sec')
    parts = updateReplySegments(parts, 'retry', 'next', 'second')
    parts = updateReplySegments(parts, 'retry', 'done', 'second')
    parts = updateReplySegments(parts, 'retry', 'done', 'second')
    expect(replySegmentsContent(parts)).toBe('first\n\nsecond')
    expect(parts).toHaveLength(2)
  })

  it('ignores started and next arriving after done', () => {
    const complete = updateReplySegments([], 's', 'done', 'final')
    const lateStart = updateReplySegments(complete, 's', 'started')
    const lateNext = updateReplySegments(lateStart, 's', 'next', 'partial')
    expect(lateNext).toEqual(complete)
  })

  it('accepts missing started, repeated started and empty recovery output', () => {
    let parts = updateReplySegments([], 'a', 'next', 'kept')
    parts = updateReplySegments(parts, 'a', 'started')
    parts = updateReplySegments(parts, 'b', 'done', '')
    expect(replySegmentsContent(parts)).toBe('kept')
    expect(parts[1].done).toBe(true)
  })

  it('does not mutate the previous projection', () => {
    const before = [{ streamId: 'a', content: 'a', done: false }]
    const after = updateReplySegments(before, 'a', 'done', 'abc')
    expect(before[0].content).toBe('a')
    expect(after[0].content).toBe('abc')
  })
})


describe('native live turn snapshots', () => {
  it('retains trusted boundaries through growth, repeated frames and stale replay', () => {
    const a = 'Turn 1\nTurn 99 is literal\n'
    const b = 'Turn 2\nanswer'
    let parts = updateReplySegments([], 's', 'next', a, [a])
    parts = updateReplySegments(parts, 's', 'next', a + b, [a, b])
    parts = updateReplySegments(parts, 's', 'next', a + b, [a, b])
    parts = updateReplySegments(parts, 's', 'next', a, [a])
    expect(replySegmentsTurns(parts)).toEqual([a, b])
    parts = updateReplySegments(parts, 's', 'done', a + b, [a, b])
    expect(replySegmentsTurns(parts)).toEqual([a, b])
  })
  it('does not mutate metadata when combining retry or continuation streams', () => {
    const a = ['one'], b = ['two']
    let parts = updateReplySegments([], 'original', 'done', 'one', a)
    parts = updateReplySegments(parts, 'retry', 'done', 'two', b)
    expect(replySegmentsTurns(parts)).toEqual(['one', '\n\ntwo'])
    expect(a).toEqual(['one'])
    expect(b).toEqual(['two'])
  })
  it('falls back for legacy or malformed snapshots', () => {
    expect(replySegmentsTurns(updateReplySegments([], 's', 'next', 'body'))).toBeUndefined()
    expect(replySegmentsTurns(updateReplySegments([], 's', 'next', 'body', ['wrong']))).toBeUndefined()
  })
})
