import { describe, expect, it } from 'vitest'
import { applyEvent, historyToMessages, mergeSessionSnapshot, prependUniqueHistory, type ChatMsg } from './chatStore'

describe('logical recovery reply', () => {
  const archivedStream = () => historyToMessages([{
    id: 'archive-a', ordinal: 0, role: 'assistant', run_id: 'run', logical_id: 'a', stream_id: 'a',
    content: '\n\n**LLM Running (Turn 1) ...**\nARCHIVED FULL TOOL OUTPUT', timestamp: null,
  }])

  it('adopts the same physical stream even when archive formatting is longer and not a text prefix', () => {
    const content = '\n**LLM Running (Turn 1) ...**\nLIVE\n**LLM Running (Turn 2) ...**\nNEW'
    const frame = { type: 'snapshot' as const, session_id: 's', runtime: {
      status: 'running' as const, run_id: 'run', stream_id: 'a', error: null,
    }, streams: [{ stream_id: 'a', run_id: 'run', logical_id: 'a', source: 'webui',
      query: '', content, done: false, started_at: 1, finished_at: 0 }] }
    let msgs = mergeSessionSnapshot(archivedStream(), frame)
    msgs = mergeSessionSnapshot(msgs, frame)
    const answer = msgs.find(m => m.role === 'assistant')!
    expect(answer.content).toBe(content)
    expect(answer.segments).toHaveLength(1)
    expect(answer.streaming).toBe(true)
  })

  it('adopts archive identity on direct cumulative events without a snapshot', () => {
    let msgs = applyEvent(archivedStream(), { type: 'next', stream_id: 'a', run_id: 'run',
      logical_id: 'a', content: 'LIVE' })
    msgs = applyEvent(msgs, { type: 'next', stream_id: 'a', run_id: 'run', logical_id: 'a', content: 'LIVE NEXT' })
    expect(msgs[0].content).toBe('LIVE NEXT')
    expect(msgs[0].segments).toHaveLength(1)
    // Replayed shorter transport frames must still not shrink live content.
    msgs = applyEvent(msgs, { type: 'next', stream_id: 'a', run_id: 'run', logical_id: 'a', content: 'LIVE' })
    expect(msgs[0].content).toBe('LIVE NEXT')
  })

  it('retains a different archived physical stream when a continuation restarts turn numbering', () => {
    const msgs = applyEvent(archivedStream(), { type: 'next', stream_id: 'b', run_id: 'run',
      logical_id: 'a', source: 'auto_continue', content: 'SECOND STREAM' })
    expect(msgs[0].content).toBe(archivedStream()[0].content + '\n\nSECOND STREAM')
    expect(msgs[0].segments).toHaveLength(2)
  })

  it('anchors a live retry at its stream boundary and clears it on successful completion', () => {
    let msgs = applyEvent([], { type: 'started', stream_id: 'a', query: 'question' })
    msgs = applyEvent(msgs, { type: 'done', stream_id: 'a', content: 'first' })
    msgs = applyEvent(msgs, { type: 'started', stream_id: 'b', logical_id: 'a', source: 'chat_error_retry' })
    msgs = applyEvent(msgs, { type: 'next', stream_id: 'b', logical_id: 'a', source: 'chat_error_retry', content: 'sec' })
    expect(msgs.find((m) => m.role === 'assistant')?.recoveryOffset).toBe(5)
    msgs = applyEvent(msgs, { type: 'next', stream_id: 'b', logical_id: 'a', source: 'chat_error_retry', content: 'second' })
    expect(msgs.find((m) => m.role === 'assistant')?.recoveryOffset).toBe(5)
    expect(msgs.find((m) => m.role === 'assistant')?.recoveryNotice).toBeTruthy()
    msgs = applyEvent(msgs, { type: 'done', stream_id: 'b', logical_id: 'a', source: 'chat_error_retry', content: 'second' })
    expect(msgs.find((m) => m.role === 'assistant')?.recoveryNotice).toBeUndefined()
    expect(msgs.find((m) => m.role === 'assistant')?.recoveryOffset).toBeUndefined()
    msgs = applyEvent(msgs, { type: 'next', stream_id: 'b', logical_id: 'a', source: 'chat_error_retry', content: 'late' })
    expect(msgs.find((m) => m.role === 'assistant')?.recoveryNotice).toBeUndefined()
    expect(msgs.find((m) => m.role === 'assistant')?.content).toBe('first\n\nsecond')
  })

  it('does not restore transient retry notices in a completed snapshot', () => {
    const msgs = applyEvent([], { type: 'snapshot', streams: [
      { stream_id: 'a', source: 'user', query: 'question', content: 'first', done: true, started_at: 1000, finished_at: 1001 },
      { stream_id: 'b', retry_of: 'a', source: 'chat_error_retry', query: '[GA_CONTINUE]', content: 'second', done: true, retry_attempt: 1, started_at: 1002, finished_at: 1003 },
    ] })
    const reply = msgs.find((m) => m.role === 'assistant')!
    expect(reply.content).toBe('first\n\nsecond')
    expect(reply.streaming).toBe(false)
    expect(reply.recoveryNotice).toBeUndefined()
  })
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


describe('sleep resume authoritative reconciliation', () => {
  it('settles a completed snapshot and ignores queued older stream starts', () => {
    let msgs = applyEvent([], { type: 'started', stream_id: 'a', run_id: 'run', logical_id: 'a', query: 'question' })
    msgs = applyEvent(msgs, { type: 'next', stream_id: 'a', run_id: 'run', content: 'partial' })
    msgs = mergeSessionSnapshot(msgs, { type: 'snapshot', session_id: 's', runtime: {
      status: 'idle', run_id: null, stream_id: null, error: null,
      completed_run_id: 'run', outcome: 'completed',
    }, streams: [{ stream_id: 'a', run_id: 'run', logical_id: 'a', source: 'webui', query: 'question', content: 'complete', done: true, started_at: 1, finished_at: 2 }] })
    const answer = msgs.find((m) => m.role === 'assistant')!
    expect(answer.content).toBe('complete')
    expect(answer.streaming).toBe(false)
    expect(answer.outcome).toBe('completed')
    msgs = applyEvent(msgs, { type: 'started', stream_id: 'a', run_id: 'run', logical_id: 'a', query: 'question' })
    msgs = applyEvent(msgs, { type: 'next', stream_id: 'a', run_id: 'run', content: 'partial' })
    expect(msgs.filter((m) => m.role === 'user')).toHaveLength(1)
    expect(msgs.find((m) => m.role === 'assistant')?.content).toBe('complete')
    expect(msgs.find((m) => m.role === 'assistant')?.streaming).toBe(false)
  })

  it('keeps retrying snapshots non-terminal without a false stop flag', () => {
    const msgs = mergeSessionSnapshot([], { type: 'snapshot', session_id: 's', runtime: {
      status: 'running', run_id: 'run', stream_id: 'a', error: null,
    }, streams: [{ stream_id: 'a', run_id: 'run', logical_id: 'a', source: 'webui', query: 'question', content: 'partial', done: true, started_at: 1, finished_at: 2 }] })
    const answer = msgs.find((m) => m.role === 'assistant')!
    expect(answer.streaming).toBe(true)
    expect(answer.stopped).not.toBe(true)
    expect(answer.outcome).toBeUndefined()
  })

  it('folds authoritative archive continuation pieces but not repeated legacy questions', () => {
    const items = ['question', 'first', 'continue', 'second'].map((content, ordinal) => ({
      id: String(ordinal), ordinal, role: ordinal % 2 === 0 ? 'user' as const : 'assistant' as const, content,
      timestamp: null, run_id: 'run', logical_id: 'a', outcome: 'completed' as const,
    }))
    const msgs = historyToMessages(items)
    expect(msgs).toHaveLength(2)
    expect(msgs[1].content).toBe('first\n\nsecond')
    expect(historyToMessages(items.map((item) => ({ ...item, run_id: undefined, logical_id: undefined })))).toHaveLength(4)
  })
})


describe('logical reply boundary guards', () => {
  it('keeps an already completed live run terminal across stale running snapshots', () => {
    const base: ChatMsg[] = [{ role: 'assistant', content: 'complete', runId: 'r', logicalId: 'a',
      streamId: 'a', source: 'webui', streaming: false, outcome: 'completed' }]
    const msgs = mergeSessionSnapshot(base, { type: 'snapshot', session_id: 's', runtime: {
      status: 'running', run_id: 'r', stream_id: 'a', error: null,
    }, streams: [{ stream_id: 'a', run_id: 'r', logical_id: 'a', source: 'webui',
      content: 'old', query: 'question', done: false, started_at: 1, finished_at: 0 }] })
    const answer = msgs.find((m) => m.role === 'assistant')!
    expect(answer.content).toBe('complete')
    expect(answer.streaming).toBe(false)
    expect(answer.outcome).toBe('completed')
  })

  it('coalesces a run crossing archive pages without dropping or repeating answer pieces', () => {
    const items = ['question', 'first', 'continue', 'second', 'continue again', 'third'].map((content, ordinal) => ({
      id: String(ordinal), ordinal, role: ordinal % 2 === 0 ? 'user' as const : 'assistant' as const,
      content, timestamp: null, run_id: 'r', logical_id: 'a', outcome: 'completed' as const,
    }))
    const later = historyToMessages(items.slice(2))
    let msgs = prependUniqueHistory(historyToMessages(items.slice(0, 4)), later)
    expect(msgs).toHaveLength(2)
    expect(msgs[0].content).toBe('question')
    expect(msgs[1].content).toBe('first\n\nsecond\n\nthird')
    msgs = prependUniqueHistory(historyToMessages(items.slice(0, 4)), msgs)
    expect(msgs).toHaveLength(2)
    expect(msgs[1].content).toBe('first\n\nsecond\n\nthird')
  })
})


describe('structured reconnect and archive parity', () => {
  it('replays retry snapshots without duplicate turns and agrees with terminal history', () => {
    const a = 'Quoted Turn 99 is not a boundary';
    const b = 'retry first';
    const c = 'retry final';
    const snapshot = { type: 'snapshot' as const, streams: [
      { stream_id: 'native-a', run_id: 'native-run', logical_id: 'native-a', source: 'webui',
        query: 'question', content: a, turn_segs: [a], done: true, started_at: 1000, finished_at: 1001 },
      { stream_id: 'native-b', run_id: 'native-run', logical_id: 'native-a', retry_of: 'native-a', source: 'chat_error_retry',
        query: '[GA_CONTINUE]', content: b + c, turn_segs: [b, c], done: true, started_at: 1002, finished_at: 1003 },
    ] };
    let recovered = applyEvent([], snapshot);
    recovered = applyEvent(recovered, snapshot);
    const replies = recovered.filter((m) => m.role === 'assistant');
    expect(recovered.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(replies).toHaveLength(1);
    expect(replies[0].content).toBe(a + '\n\n' + b + c);
    expect(replies[0].turnSegments).toEqual([a, '\n\n' + b, c]);
    expect(replies[0].segments).toHaveLength(2);
    expect(replies[0].streaming).toBe(false);
    const history = historyToMessages([
      { id: 'native-archive-a', ordinal: 0, role: 'assistant', content: a, turn_segs: [a], timestamp: null,
        run_id: 'native-run', logical_id: 'native-a', outcome: 'completed' },
      { id: 'native-archive-b', ordinal: 1, role: 'assistant', content: b + c, turn_segs: [b, c], timestamp: null,
        run_id: 'native-run', logical_id: 'native-a', outcome: 'completed' },
    ]);
    expect(history).toHaveLength(1);
    expect(history[0].content).toBe(replies[0].content);
    expect(history[0].turnSegments).toEqual(replies[0].turnSegments);
  });
});
