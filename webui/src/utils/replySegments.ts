// A transport event contains cumulative text for ONE stream, not the whole
// logical answer. Keep stream identity so duplicates cannot append text twice.
export interface ReplySegment {
  streamId: string
  content: string
  done: boolean
}

export function updateReplySegments(
  previous: readonly ReplySegment[],
  streamId: string,
  phase: 'started' | 'next' | 'done',
  content?: string,
): ReplySegment[] {
  const index = previous.findIndex((part) => part.streamId === streamId)
  const old = index < 0 ? undefined : previous[index]
  // Late started/next events must not reopen or replace a completed stream.
  if (old?.done && phase !== 'done') return previous.slice()
  const part: ReplySegment = {
    streamId,
    content: phase === 'started' ? (old?.content ?? '') : (content ?? old?.content ?? ''),
    done: phase === 'done' || !!old?.done,
  }
  if (index < 0) return [...previous, part]
  const next = previous.slice()
  next[index] = part
  return next
}

export function replySegmentsContent(parts: readonly ReplySegment[]): string {
  return parts.map((part) => part.content).filter(Boolean).join('\n\n')
}
