import { mergeSessionSnapshot } from './messageModel'
import type { ChatWSOut } from '../api/types'
/** Canonical message semantics shared by desktop and Hub transport projections. */
import { parseAssistantTranscript, extractAskUserPayload, renderAskUserPayload } from './assistantTranscript'
import { scanTranscript } from './transcriptProtocol'

export function messagePresentation(content: string, streaming = false, segments?: unknown) {
  return parseAssistantTranscript(content, streaming, segments)
}

/** A field filter, not another interpreter: never infer turns from reduced text. */
export function remoteMessagePresentation(source: Record<string, any>) {
  const content = String(source.content || '')
  const meta: Record<string, any> = { compact: true }
  for (const key of ['id', 'role', 'ordinal', 'timestamp', 'session_id', 'run_id', 'logical_id',
    'stream_id', 'archive_generation', 'outcome', 'attachments', 'artifacts', 'streaming']) {
    if (source[key] !== undefined) meta[key] = source[key]
  }
  if (source.role !== 'assistant') return { ...meta, content }
  const parsed = messagePresentation(content, !!source.streaming, source.turn_segs ?? source.turn_segments)
  const prose = (text: string) => scanTranscript(text).map(node => {
    if (node.kind === 'text' || node.kind === 'code') return node.raw
    if (node.kind === 'tool' && node.complete && node.name?.split('.').at(-1)?.toLowerCase() === 'ask_user') {
      const question = extractAskUserPayload(node.raw)
      return question ? '\n\n' + renderAskUserPayload(question) + '\n\n' : ''
    }
    return ''
  }).join('').trim()
  return { ...meta, content: prose(content), progress: {
    turns: parsed.turns.map(turn => ({ turn: turn.turn, summary: turn.summary, content: prose(turn.content) })),
    turn_count: parsed.turns.length,
    final_body: prose(parsed.finalBody),
    question: parsed.finalAskUser,
  } }
}

export function remoteMessagePage(data: Record<string, any>) {
  return { ...data, presentation_version: 1, items: (data.items || []).map(remoteMessagePresentation) }
}

/** Run exactly the desktop reconnect merge before filtering transport fields. */
export function remoteProgress(frame: Extract<ChatWSOut, { type: 'snapshot' }>) {
  const runtime = frame.runtime || frame
  const sid = frame.session_id
  if (!sid || ('session_id' in runtime && runtime.session_id !== sid) ||
      frame.streams?.some(row => 'session_id' in row && row.session_id !== sid) ||
      (frame.active_message && 'session_id' in frame.active_message && frame.active_message.session_id !== sid)) {
    throw new Error('Snapshot session mismatch')
  }
  const messages = mergeSessionSnapshot([], frame)
  const items = messages.map((message, index) => remoteMessagePresentation({
    id: `${sid}:${message.role}:${message.runId || message.logicalId || message.streamId || index}`,
    session_id: sid, role: message.role, content: message.content,
    run_id: message.runId, logical_id: message.logicalId, stream_id: message.streamId,
    timestamp: message.timestamp, streaming: message.streaming,
    turn_segs: message.turnSegments, outcome: message.outcome,
  }))
  const state: Record<string, unknown> = { session_id: sid }
  for (const key of ['status', 'run_id', 'stream_id', 'completed_run_id', 'outcome', 'error']) {
    if (key in runtime) state[key] = (runtime as unknown as Record<string, unknown>)[key]
  }
  return { type: 'progress', session_id: sid, runtime: state, items, presentation_version: 1, epoch: frame.epoch }
}
