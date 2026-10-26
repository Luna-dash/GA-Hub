import { validTurnSegments } from './archiveTurnSegments'
import { scanTranscript } from './transcriptProtocol'

// A transport event contains cumulative text for ONE stream, not the whole
// logical answer. Keep stream identity so duplicates cannot append text twice.
export interface ReplySegment {
  streamId: string
  content: string
  turnSegments?: string[]
  /** Archive tools may be much longer than their live rendering. */
  archived?: boolean
  done: boolean
}

export function updateReplySegments(
  previous: readonly ReplySegment[],
  streamId: string,
  phase: 'started' | 'next' | 'done',
  content?: string,
  turnSegments?: unknown,
): ReplySegment[] {
  const index = previous.findIndex((part) => part.streamId === streamId)
  const old = index < 0 ? undefined : previous[index]
  // Late started/next events must not reopen or replace a completed stream.
  if (old?.archived && phase === 'started') return previous.slice()
  if (old?.done && !old.archived && phase !== 'done') return previous.slice()
  // Delayed cumulative frames cannot roll back content or trusted boundaries.
  if (old && !old.archived && content !== undefined && old.content !== content
    && old.content.startsWith(content)) return previous.slice()
  const part: ReplySegment = {
    streamId,
    content: phase === 'started' ? (old?.content ?? '') : (content ?? old?.content ?? ''),
    done: phase === 'done' || (!!old?.done && !old.archived),
    turnSegments: validTurnSegments(turnSegments, content ?? old?.content ?? '')
      ?? (content === undefined || content === old?.content ? old?.turnSegments : undefined),
  }
  if (index < 0) return [...previous, part]
  const next = previous.slice()
  next[index] = part
  return next
}

export function replySegmentsContent(parts: readonly ReplySegment[]): string {
  return parts.map((part) => part.content).filter(Boolean).join('\n\n')
}

/** Preserve physical reply boundaries; only legacy pieces guess their turns.
 * Keep original slices and separators so metadata joins to the display text. */
export function replySegmentsTurns(parts: readonly ReplySegment[]): string[] | undefined {
  if (!parts.some(part => validTurnSegments(part.turnSegments, part.content))) return undefined
  const result: string[] = []
  for (const part of parts.filter(part => part.content)) {
    const trusted = validTurnSegments(part.turnSegments, part.content)
    const starts = trusted ? [] : scanTranscript(part.content)
      .filter(node => node.kind === 'turn').map(node => node.start)
    const cuts = [...new Set([0, ...starts, part.content.length])]
    const turns = trusted ?? cuts.slice(0, -1).map((start, i) => part.content.slice(start, cuts[i + 1]))
    if (result.length) turns[0] = '\n\n' + turns[0]
    result.push(...turns)
  }
  return result.length ? result : undefined
}
