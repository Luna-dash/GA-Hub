import { describe, expect, it } from 'vitest'
import { replySegmentsContent, updateReplySegments, type ReplySegment } from './replySegments'

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
