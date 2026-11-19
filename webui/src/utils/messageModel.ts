/** Pure canonical message model shared by desktop and Hub. No browser/store state. */
import type { ChatStreamSnapshot, ChatWSOut, ConversationMessage, SessionMessageProjection, PasteAttachment } from '@/api/types'
import { validTurnSegments } from './archiveTurnSegments'
import { replySegmentsTurns, replySegmentsContent, updateReplySegments, type ReplySegment } from './replySegments'
export type ChatMsgRole = 'user' | 'assistant' | 'system'

export interface ChatMsg {
  role: ChatMsgRole
  content: string
  /** Archive-only internal turns, separate from physical reply segments. */
  turnSegments?: string[]
  /** Hub recovery streams share one logical answer; GA turns remain untouched. */
  logicalId?: string
  runId?: string
  outcome?: 'completed' | 'cancelled' | 'failed' | null
  /** Hub recovery status, rendered inside the answer, never part of LLM text. */
  recoveryNotice?: string
  recoveryOffset?: number
  recoveryStreamId?: string
  segments?: ReplySegment[]
  timestamp?: number | null          // epoch milliseconds; null means archive has no real header time
  startedAt?: number | null
  finishedAt?: number | null
  streamId?: string                // matched stream (omitted for system notes)
  source?: string                  // 'user' | 'webui' | 'autonomous' | 'wechat' | 'reflect' | …
  streaming?: boolean              // assistant bubble currently receiving
  /** 用户按了停止（事件驱动的事实）。渲染层据此显示终止提示——
   *  不再把标记拼进 content：内容保持服务端原文，去重/复制/投影不被污染。 */
  stopped?: boolean
  attachments?: PasteAttachment[]  // local-only previews for the user bubble
  pendingWebui?: boolean           // set on local pre-add until `started` arrives
  pendingWebuiId?: string          // identifies the exact optimistic bubble for rollback
}

// Older histories can still contain this source after channel removal.
const HIDDEN_SOURCES = new Set(['wechat'])
const isHiddenSource = (s?: string) => !!s && HIDDEN_SOURCES.has(s)

function parseArchiveTime(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function epochMilliseconds(value?: number): number | null {
  if (!value || !Number.isFinite(value)) return null
  return value < 1e12 ? value * 1000 : value
}

export function belongsToRun(message: ChatMsg, runId?: string): boolean {
  // Transport and logical IDs are only meaningful inside their run.
  return message.runId === runId
}

export function upsertRetryNotice(
  prev: ChatMsg[],
  retryKey: string,
  content: string,
  timestamp?: number,
  retryStreamId?: string,
  runId?: string,
): ChatMsg[] {
  const idx = prev.findIndex((m) => m.role === 'assistant' && belongsToRun(m, runId) && (
    m.logicalId === retryKey || m.streamId === retryKey
    || m.segments?.some((part) => part.streamId === retryKey)
  ))
  const recoveryNotice = content.replace(/^_|_$/g, '')
  if (idx === -1) {
    return [
      ...prev,
      { role: 'assistant', content: '', streamId: retryKey, logicalId: retryKey, runId,
        recoveryNotice, recoveryOffset: 0, recoveryStreamId: retryStreamId, segments: [], timestamp },
    ]
  }
  const next = prev.slice()
  const old = prev[idx]
  const partIndex = retryStreamId ? old.segments?.findIndex((part) => part.streamId === retryStreamId) ?? -1 : -1
  const offset = partIndex >= 0 ? replySegmentsContent(old.segments!.slice(0, partIndex)).length : old.content.length
  next[idx] = { ...old, recoveryNotice,
    recoveryOffset: retryStreamId && old.recoveryStreamId === retryStreamId ? old.recoveryOffset ?? offset : offset,
    recoveryStreamId: retryStreamId,
  }
  return next
}

/** Build the UI msg list from a server snapshot — used on (re)connect. */
export function applySnapshot(streams: ChatStreamSnapshot[]): ChatMsg[] {
  const out: ChatMsg[] = []
  // One reused retry-notice bubble per logical turn: retryKey -> its index in
  // `out` plus the strongest state emitted so far (completed beats ongoing;
  // ties broken by higher attempt).
  const retryNoticeEntries = new Map<string, { idx: number; attempt: number; done: boolean }>()
  const retryNoticeLabel = (s: ChatStreamSnapshot, attempt: number): string =>
    `_自动重试请求${s.done ? '已完成' : '进行中'}（${attempt || '?'}${s.retry_max ? `/${s.retry_max}` : ''}${s.retry_reason ? ` · ${s.retry_reason}` : ''}）。_`
  for (const s of streams) {
    if (isHiddenSource(s.source)) continue
    if (s.source === 'chat_error_retry' || s.source === 'auto_continue') {
      const attempt = s.retry_attempt || 0
      const done = !!s.done
      const retryKey = s.logical_id || s.retry_of || s.stream_id || ''
      const noticeKey = `${s.run_id || "legacy"}:${retryKey}`
      const meta = retryNoticeEntries.get(noticeKey)
      if (!done && (meta === undefined || attempt > meta.attempt)) {
        retryNoticeEntries.set(noticeKey, { idx: 0, attempt, done })
        const withNotice = upsertRetryNotice(out, retryKey, retryNoticeLabel(s, attempt),
          epochMilliseconds(s.started_at) ?? undefined, s.stream_id, s.run_id)
        out.splice(0, out.length, ...withNotice)
      }
      if (s.content || !s.done) {
        const merged = updateLogicalReply(out, {
          type: s.done ? 'done' : 'next',
          stream_id: s.stream_id,
          logical_id: s.logical_id,
          run_id: s.run_id,
          retry_of: s.retry_of,
          source: s.source,
          content: s.content,
          turn_segs: s.turn_segs,
        }, epochMilliseconds(s.done ? s.finished_at : s.started_at) ?? Date.now())
        out.splice(0, out.length, ...merged)
      }
      continue
    }
    if (s.query) {
      out.push({
        role: 'user',
        content: s.query,
        logicalId: s.logical_id, runId: s.run_id,
        streamId: s.stream_id,
        source: s.source,
        timestamp: epochMilliseconds(s.started_at),
      })
    }
    if (s.content || !s.done) {
      out.push({
        role: 'assistant',
        content: s.content,
        logicalId: s.logical_id, runId: s.run_id, outcome: s.outcome,
        turnSegments: validTurnSegments(s.turn_segs, s.content),
        segments: [{ streamId: s.stream_id, content: s.content, done: s.done,
          turnSegments: validTurnSegments(s.turn_segs, s.content) }],
        streamId: s.stream_id,
        source: s.source,
        streaming: !s.done,
        startedAt: epochMilliseconds(s.started_at),
        timestamp: epochMilliseconds(s.done ? s.finished_at : s.started_at),
      })
    }
  }
  return out
}

export function historyToMessages(items: SessionMessageProjection[]): ChatMsg[] {
  const projected: ChatMsg[] = items
    .filter((item) => item.role === 'user' || item.role === 'assistant')
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((item) => ({
      role: item.role,
      content: item.content,
      turnSegments: item.role === 'assistant' ? validTurnSegments(item.turn_segs, item.content) : undefined,
      // The archive id is the stable identity for deduplication on rehydrate.
      streamId: `history:${item.id}`,
      source: 'history',
      logicalId: item.logical_id ?? undefined, runId: item.run_id ?? undefined,
      outcome: item.outcome, stopped: item.outcome === 'cancelled',
      segments: item.run_id && item.role === 'assistant'
        ? [{ streamId: item.stream_id || `history:${item.id}`, content: item.content, done: true, archived: true, turnSegments: validTurnSegments(item.turn_segs, item.content) }] : undefined,
      timestamp: parseArchiveTime(item.timestamp),
    }))

  return coalesceArchiveRuns(projected)
}

export function coalesceArchiveRuns(projected: ChatMsg[]): ChatMsg[] {
  const out: ChatMsg[] = []
  const positions = new Map<string, number>()
  for (const msg of projected) {
    const key = msg.runId ? `${msg.runId}\u0000${msg.role}` : null
    const index = key ? positions.get(key) : undefined
    if (index !== undefined) {
      if (msg.role === 'assistant') {
        const previous = out[index]
        const seen = new Set<string>()
        const segments = [...(previous.segments ?? []), ...(msg.segments ?? [])]
          .filter((part) => {
            if (seen.has(part.streamId)) return false
            seen.add(part.streamId)
            return true
          })
        out[index] = { ...previous, segments, content: replySegmentsContent(segments), turnSegments: replySegmentsTurns(segments) }
      }
      // Continuation prompts belong to the same run, not a new user question.
      continue
    }
    out.push(msg)
    if (key) positions.set(key, out.length - 1)
  }
  return out
}

const ARCHIVE_SNAPSHOT_TIME_TOLERANCE_MS = 2 * 60 * 1000

export function timestampsOverlap(archived: ChatMsg, snapshot: ChatMsg): boolean {
  if (archived.timestamp == null || snapshot.timestamp == null) return true
  return Math.abs(archived.timestamp - snapshot.timestamp) <= ARCHIVE_SNAPSHOT_TIME_TOLERANCE_MS
}

/**
 * Completed streams remain in the backend reconnect snapshot for a while after
 * GA has already persisted the same turn to the native archive.  The two
 * projections have different ids, so identity-only merging would append the
 * answer a second time when a session is revisited.
 *
 * 统一身份锚点（step-3 重构）：快照流与存档消息没有共享 id（GA 存档不记录
 * stream id），但「用户提问」在两侧都是服务端原文、从不被客户端改写——以它
 * 为锚，配时间反证（都存在且相隔超过容忍窗 → 不是同一轮）。回答侧不再要求
 * 文本全等：直播/快照与存档投影的格式化可能漂移，而客户端 UI 状态（停止
 * 标志等）也不该出现在文本里；时间证据不齐（任一侧无头时间）时才退回回答
 * 文本全等作为补充证据。导出仅供测试。
 */
export function removeArchivedSnapshotOverlap(base: ChatMsg[], live: ChatMsg[]): ChatMsg[] {
  const archived = base.filter((msg) => msg.source === 'history')
  const skipped = new Set<number>()
  for (let index = 0; index + 1 < live.length; index += 1) {
    const query = live[index]
    const answer = live[index + 1]
    if (
      query.role !== 'user' || answer.role !== 'assistant'
      || query.streamId == null || query.streamId !== answer.streamId
      || answer.streaming !== false
    ) continue

    for (let historyIndex = archived.length - 2; historyIndex >= 0; historyIndex -= 1) {
      if (pairsDescribeSameTurn(archived[historyIndex], archived[historyIndex + 1], query, answer)) {
        skipped.add(index)
        skipped.add(index + 1)
        break
      }
    }
  }
  return live.filter((_, index) => !skipped.has(index))
}

export function pairsDescribeSameTurn(
  archivedQuery: ChatMsg,
  archivedAnswer: ChatMsg,
  query: ChatMsg,
  answer: ChatMsg,
): boolean {
  if (archivedQuery.role !== 'user' || archivedAnswer.role !== 'assistant') return false
  if (archivedQuery.runId || query.runId) return !!archivedQuery.runId && archivedQuery.runId === query.runId
  if (archivedQuery.logicalId || query.logicalId) return !!archivedQuery.logicalId && archivedQuery.logicalId === query.logicalId
  if (archivedQuery.content !== query.content) return false
  if (!timestampsOverlap(archivedQuery, query) || !timestampsOverlap(archivedAnswer, answer)) return false
  const temporalEvidence = archivedQuery.timestamp != null && query.timestamp != null
    && archivedAnswer.timestamp != null && answer.timestamp != null
  if (!temporalEvidence && archivedAnswer.content !== answer.content) return false
  return true
}

/** Snapshot user/assistant bubbles of one stream share the streamId; the
 *  merge index must key by (streamId, role) or the pushed user bubble gets
 *  overwritten by its own answer (回归：快照里新完成的提问在存档尚未收录的
 *  窗口期内从界面上消失). */
export function livePositionKey(msg: ChatMsg): string | null {
  const identity = msg.runId || msg.logicalId || msg.streamId
  if (!identity) return null
  return `${identity}\u0000${msg.role}`
}

/** Merge a recovery projection, never treating one physical stream as the
 * entire logical answer. Archive keys are provisional: match them only inside
 * this verified run, in order, with nonempty cumulative-content evidence. */
export function mergeRunReply(old: ChatMsg, incoming: ChatMsg): ChatMsg {
  const segments = [...(old.segments ?? [])]
  let archiveCursor = 0
  for (const part of incoming.segments ?? []) {
    let index = segments.findIndex((previous) => previous.streamId === part.streamId)
    if (index < 0 && part.content) {
      index = segments.findIndex((previous, i) => i >= archiveCursor
        && previous.streamId.startsWith('history:') && !!previous.content
        && (part.content.startsWith(previous.content) || previous.content.startsWith(part.content)))
      if (index >= 0) archiveCursor = index + 1
    }
    if (index < 0) segments.push(part)
    else {
      const previous = segments[index]
      // Archive tools/fences differ from live text; stream identity is authoritative.
      const fromArchive = previous.archived || previous.streamId.startsWith('history:')
      const keepPrevious = fromArchive ? !part.content : previous.content.startsWith(part.content)
      segments[index] = { ...part,
        content: keepPrevious ? previous.content : part.content,
        turnSegments: previous.content === part.content
          ? (part.turnSegments ?? previous.turnSegments)
          : keepPrevious ? previous.turnSegments : part.turnSegments,
        archived: keepPrevious ? previous.archived : part.archived,
        // Archive completion is not physical-stream completion for an active run.
        done: part.done || (!fromArchive && previous.done),
      }
    }
  }
  return { ...old, ...incoming, segments, content: replySegmentsContent(segments), turnSegments: replySegmentsTurns(segments) }
}

export function mergeLive(base: ChatMsg[], live: ChatMsg[]): ChatMsg[] {
  const out = [...base]
  // The native archive is written turn-by-turn while a run is still active.
  // Adopt that partial pair in place, rather than rendering it as a stopped
  // history answer alongside a second, live answer. Match the server query
  // and its start time; never infer identity from differently formatted tools.
  const adopted = new Set<ChatMsg>()
  for (let i = 0; i + 1 < live.length; i += 1) {
    const query = live[i]
    const answer = live[i + 1]
    if (query.role !== 'user' || answer.role !== 'assistant' || !answer.streaming
      || !query.streamId || query.streamId !== answer.streamId || query.timestamp == null) continue
    for (let j = out.length - 2; j >= 0; j -= 1) {
      const archivedQuery = out[j]
      const archivedAnswer = out[j + 1]
      if (archivedQuery.source !== 'history' || archivedAnswer.source !== 'history'
        || archivedQuery.role !== 'user' || archivedAnswer.role !== 'assistant'
        || archivedQuery.runId || query.runId || archivedQuery.logicalId || query.logicalId
        || archivedQuery.content !== query.content || archivedQuery.timestamp == null
        || !timestampsOverlap(archivedQuery, query)) continue
      out[j] = { ...archivedQuery, ...query }
      out[j + 1] = { ...archivedAnswer, ...answer }
      adopted.add(query)
      adopted.add(answer)
      break
    }
  }
  const positions = new Map<string, number>()
  out.forEach((m, index) => {
    const key = livePositionKey(m)
    if (key) positions.set(key, index)
  })
  for (const msg of removeArchivedSnapshotOverlap(base, live)) {
    if (adopted.has(msg)) continue
    const key = livePositionKey(msg)
    if (key && positions.has(key)) {
      const index = positions.get(key)!
      // Never let an old partial replace a completed archive message.
      const old = out[index]
      if (old.outcome) continue
      // A stale partial may not shrink a newer cumulative projection.
      if (old.content.startsWith(msg.content) && old.content.length > msg.content.length) continue
      out[index] = old.role === 'assistant' && old.runId && old.runId === msg.runId
        ? mergeRunReply(old, msg) : { ...old, ...msg,
          // Snapshot retries may carry a later query timestamp for the same run.
          timestamp: old.role === 'user' && old.runId && old.runId === msg.runId
            ? Math.min(old.timestamp ?? Infinity, msg.timestamp ?? Infinity) === Infinity
              ? null : Math.min(old.timestamp ?? Infinity, msg.timestamp ?? Infinity)
            : msg.timestamp,
        }
      continue
    }
    out.push(msg)
    if (key) positions.set(key, out.length - 1)
  }
  return orderConversationTurns(out)
}

/** Order whole turns, never individual bubbles by assistant completion time.
 * Known run identity keeps retries and notices with their question. Legacy
 * streams are paired locally, so recycled ids cannot join unrelated turns.
 * Missing-time turns and local pending/system bubbles keep their stable slots.
 */
export function orderConversationTurns(messages: ChatMsg[]): ChatMsg[] {
  type Turn = { messages: ChatMsg[]; anchor?: number }
  const turns: Turn[] = []
  const runs = new Map<string, Turn>()
  let legacy: Turn | undefined
  for (const message of messages) {
    let turn: Turn | undefined
    if (message.runId && !message.pendingWebui) {
      turn = runs.get(message.runId)
      if (!turn) {
        turn = { messages: [] }
        runs.set(message.runId, turn)
        turns.push(turn)
      }
      legacy = undefined
    } else if (message.role === 'assistant' && !message.runId
      && message.source !== 'system' && message.source !== 'runtime_error_notice'
      && legacy && (message.source === 'history'
        || (message.streamId != null && legacy.messages[0].streamId === message.streamId))) {
      turn = legacy
    } else {
      turn = { messages: [] }
      turns.push(turn)
      legacy = message.role === 'user' && !message.runId && !message.pendingWebui ? turn : undefined
    }
    turn.messages.push(message)
    if (message.role === 'user' && !message.pendingWebui
      && message.timestamp != null && Number.isFinite(message.timestamp)) {
      turn.anchor = turn.anchor == null ? message.timestamp : Math.min(turn.anchor, message.timestamp)
    }
  }
  for (const turn of turns) {
    // Answer-only recovery frames still have a genuine stream-start anchor.
    // Never use assistant timestamp here: completed replies carry finish time.
    if (turn.anchor != null) continue
    for (const message of turn.messages) {
      if (message.role === 'assistant' && message.startedAt != null
        && Number.isFinite(message.startedAt) && message.source !== 'system'
        && message.source !== 'runtime_error_notice') {
        turn.anchor = turn.anchor == null ? message.startedAt : Math.min(turn.anchor, message.startedAt)
      }
    }
  }
  const dated = turns.filter((turn) => turn.anchor != null)
    .sort((a, b) => a.anchor! - b.anchor!)
  let index = 0
  const ordered = turns.flatMap((turn) => {
    const selected = turn.anchor == null ? turn : dated[index++]
    // A late question projection must precede its answer in the same run.
    return selected.messages.some((message) => message.role === 'user')
      ? [...selected.messages.filter((message) => message.role === 'user'),
        ...selected.messages.filter((message) => message.role !== 'user')]
      : selected.messages
  })
  return ordered.length === messages.length && ordered.every((message, i) => message === messages[i])
    ? messages : ordered
}

export function mergeSessionSnapshot(base: ChatMsg[], event: Extract<ChatWSOut, { type: 'snapshot' }>): ChatMsg[] {
  // Completed archive text is authoritative; live text must still accept its final frame.
  base = base.map((message) => message.source === 'history'
    ? settleSnapshot([message], event)[0] : message)
  const active = event.active_message
  if (active?.query && active.ts != null) {
    const existing = event.streams?.find((s) => s.stream_id === active.stream_id)
    const streams: ChatStreamSnapshot[] = [...(event.streams ?? []).filter((s) => s.stream_id !== active.stream_id), {
      ...existing,
      run_id: active.run_id || event.run_id || undefined,
      logical_id: active.logical_id || existing?.logical_id,
      retry_of: active.retry_of || existing?.retry_of,
      retry_attempt: active.retry_attempt ?? existing?.retry_attempt,
      retry_max: active.retry_max ?? existing?.retry_max,
      retry_reason: active.retry_reason || existing?.retry_reason,
      stream_id: active.stream_id,
      source: active.source ?? existing?.source ?? 'webui',
      query: active.query,
      started_at: active.ts,
      finished_at: existing?.finished_at ?? 0,
      content: active.content,
      turn_segs: active.turn_segs ?? (active.content === existing?.content ? existing.turn_segs : undefined),
      done: active.done,
    }]
    return orderConversationTurns(settleSnapshot(mergeLive(base, applySnapshot(streams)), event))
  }
  let msgs = event.streams ? mergeLive(base, applySnapshot(event.streams)) : base
  // Query-less adapters can still carry explicit run identity; never infer it.
  if (active) msgs = applyEvent(msgs, {
    type: active.done ? 'done' : 'next', stream_id: active.stream_id, content: active.content,
    turn_segs: active.turn_segs,
    run_id: active.run_id, logical_id: active.logical_id, source: active.source,
    retry_of: active.retry_of,
  })
  return orderConversationTurns(settleSnapshot(msgs, event))
}

export function settleSnapshot(msgs: ChatMsg[], event: Extract<ChatWSOut, { type: 'snapshot' }>): ChatMsg[] {
  const state = { ...event, ...event.runtime }
  // Old servers placed terminal identity only at the top level.
  const completedRunId = event.runtime?.completed_run_id ?? event.completed_run_id
  const outcome = event.runtime?.outcome ?? event.outcome
  return applyEvent(msgs, {
    type: 'session_runtime', session_id: event.session_id || '',
    status: state.status || '', run_id: state.run_id || '', stream_id: state.stream_id || null,
    completed_run_id: completedRunId,
    outcome,
  })
}

// ── store 外的运行时单例 ────────────────────────────────────────────────
// 这些值与 React 渲染无关（abort 句柄/代数/游标/节流清理），不属于视图
// 状态，因此不放进 zustand；但生命周期严格跟随会话：teardown() 与
// dropSessionView() 负责复位。新增跨会话可变量必须登记在此并明确复位点。
type ReplyEvent = Extract<ChatWSOut, { type: 'started' | 'next' | 'done' }>

export function updateLogicalReply(prev: ChatMsg[], evt: ReplyEvent, now: number): ChatMsg[] {
  const sid = evt.stream_id
  const key = evt.logical_id || evt.retry_of || sid
  const idx = prev.findIndex((m) => m.role === 'assistant' && belongsToRun(m, evt.run_id) && (
    !!evt.run_id || m.logicalId === key || m.streamId === key || m.streamId === sid
    || m.segments?.some((part) => part.streamId === sid || part.streamId === evt.retry_of)
  ))
  const old = idx < 0 ? undefined : prev[idx]
  if (old?.outcome) return prev // queued frames cannot resurrect a terminal run
  const initial = old?.segments ?? (old?.streamId ? [{
    streamId: old.streamId, content: old.content, done: !old.streaming && !old.stopped,
  }] : [])
  if (evt.type === 'started' && initial.some((part) => part.streamId === sid)) return prev
  const part = updateReplySegments([], sid, evt.type, 'content' in evt ? evt.content : undefined, evt.turn_segs)
  // Direct cumulative events and snapshots must adopt the same archived segment.
  // Otherwise history:<id> + physical stream produce two overlapping replays.
  const segments = old?.runId
    ? mergeRunReply({ ...old, segments: initial }, { ...old, segments: part }).segments!
    : updateReplySegments(initial, sid, evt.type, 'content' in evt ? evt.content : undefined, evt.turn_segs)
  const latest = segments[segments.length - 1]
  const streaming = !old?.stopped && !latest.done
  const message: ChatMsg = {
    ...old,
    role: 'assistant',
    logicalId: old?.logicalId || key,
    runId: evt.run_id || old?.runId,
    streamId: old?.streamId || sid,
    source: old?.source || evt.source,
    segments,
    content: replySegmentsContent(segments),
    turnSegments: replySegmentsTurns(segments),
    streaming,
    timestamp: old?.timestamp ?? now,
    startedAt: old?.startedAt ?? now,
    finishedAt: streaming ? null : (old?.finishedAt ?? now),
    ...(streaming ? {} : { recoveryNotice: undefined, recoveryOffset: undefined, recoveryStreamId: undefined }),
  }
  if (idx < 0) return [...prev, message]
  const next = prev.slice()
  next[idx] = message
  return next
}

// exported for tests: pure reducer over the message list
export function applyEvent(prev: ChatMsg[], evt: ChatWSOut, abortedStreams = new Map<string, number>()): ChatMsg[] {
  if (evt.type === 'session_runtime') {
    // A stream can finish while its logical run is waiting for continuation.
    // Only the coordinator owns run termination, not a transport stream's done.
    if (evt.status === 'running' && evt.run_id) {
      return prev.map((m) => m.role === 'assistant' && m.runId === evt.run_id && !m.outcome && !m.stopped
        ? { ...m, streaming: true, finishedAt: null } : m)
    }
    if (evt.status !== 'idle' || !evt.completed_run_id || !evt.outcome) return prev
    return prev.map((m) => m.role === 'assistant' && m.runId === evt.completed_run_id ? {
      ...m, streaming: false, recoveryNotice: undefined, recoveryOffset: undefined, recoveryStreamId: undefined, outcome: evt.outcome,
      stopped: evt.outcome === 'cancelled', finishedAt: m.finishedAt ?? Date.now(),
    } : m)
  }
  if ((evt.type === 'next' || evt.type === 'done') && (evt.run_id || evt.logical_id)) {
    if (isHiddenSource(evt.source)) return prev
    return updateLogicalReply(prev, evt, Date.now())
  }
  const msgs = reduceEvent(prev, evt, abortedStreams)
  if (evt.type !== 'started') return msgs
  return msgs.map((m) => m.streamId === evt.stream_id && (!m.runId || belongsToRun(m, evt.run_id)) ? {
    ...m, runId: evt.run_id || m.runId, logicalId: evt.logical_id || m.logicalId,
  } : m)
}

export function reduceEvent(prev: ChatMsg[], evt: ChatWSOut, abortedStreams: Map<string, number>): ChatMsg[] {
  const now = Date.now()
  if (evt.type === 'snapshot') {
    return mergeSessionSnapshot(prev, evt)
  }
  if (evt.type === 'reset') {
    // Server-driven wipe (new conversation / session restore).
    return []
  }
  if (evt.type === 'started') {
    const sid = evt.stream_id
    const source = evt.source ?? 'user'
    const query = evt.query ?? ''
    if (isHiddenSource(source)) return prev
    const retryAttempt = evt.retry_attempt ?? 0
    if (source === 'chat_error_retry' || source === 'auto_continue') {
      const retryKey = evt.logical_id || evt.retry_of || sid
      const reason = evt.retry_reason === 'truncated' ? '截断续接' : '网络重试'
      const note = `_系统${reason}（${retryAttempt || '?'}${evt.retry_max ? `/${evt.retry_max}` : ''}）。_`
      const withNotice = upsertRetryNotice(prev, retryKey, note, now, sid, evt.run_id)
      return updateLogicalReply(withNotice, evt, epochMilliseconds(evt.ts) ?? now)
    }
    if (prev.some((m) => m.role === 'assistant' && belongsToRun(m, evt.run_id) && (
      m.streamId === sid || !!evt.run_id
      || (evt.logical_id && m.logicalId === evt.logical_id)))) {
      return updateLogicalReply(prev, evt, epochMilliseconds(evt.ts) ?? now)
    }
    // 1. If our local pre-add bubble is still pending and source is webui,
    //    adopt this stream_id rather than creating a duplicate.
    if (source === 'webui') {
      const idx = [...prev].reverse().findIndex((m) => m.role === 'user' && m.pendingWebui)
      if (idx !== -1) {
        const realIdx = prev.length - 1 - idx
        const adopted = prev.slice()
        adopted[realIdx] = {
          ...adopted[realIdx],
          streamId: sid,
          runId: evt.run_id, logicalId: evt.logical_id,
          pendingWebui: false,
          // Keep the local identity as a receipt, even after WS adoption.
          pendingWebuiId: adopted[realIdx].pendingWebuiId,
        }
        // Append empty assistant bubble for the streaming reply.
        return [...adopted, { role: 'assistant', content: '', streamId: sid, runId: evt.run_id, logicalId: evt.logical_id, source, streaming: true, timestamp: now, startedAt: epochMilliseconds(evt.ts) ?? now, finishedAt: null }]
      }
    }
    // 2. Fresh stream from another source (or a webui submission whose pre-add
    //    is missing — happens after a tab reload). Add a user + assistant pair.
    const next = prev.slice()
    if (!next.some((m) => m.role === 'user' && belongsToRun(m, evt.run_id) && m.streamId === sid)) {
      next.push({ role: 'user', content: query, streamId: sid, runId: evt.run_id, logicalId: evt.logical_id, source, timestamp: now })
    }
    if (!next.some((m) => m.role === 'assistant' && belongsToRun(m, evt.run_id) && m.streamId === sid)) {
      next.push({ role: 'assistant', content: '', streamId: sid, runId: evt.run_id, logicalId: evt.logical_id, source, streaming: true, timestamp: now, startedAt: epochMilliseconds(evt.ts) ?? now, finishedAt: null })
    }
    return next
  }
  if (evt.type === 'next') {
    if (isHiddenSource(evt.source)) return prev
    return updateLogicalReply(ensureRetryStartNotice(prev, evt), evt, now)
  }
  if (evt.type === 'done') {
    const sid = evt.stream_id
    if (isHiddenSource(evt.source)) return prev
    // 该流已终态：解除 abort 余波压制（之后这条流再来的 error 是真故障）
    abortedStreams.delete(sid)
    const next = ensureRetryStartNotice(prev, evt)
    if (evt.source !== 'system') return updateLogicalReply(next, evt, now)
    // /btw side-question answers come with source='system' — render as system role
    const role = evt.source === 'system' ? 'system' : 'assistant'
    const idx = next.findIndex((m) => (m.role === 'assistant' || m.role === 'system') && m.streamId === sid)
    if (idx === -1) {
      return [...next, { role, content: evt.content, streamId: sid, source: evt.source, streaming: false, timestamp: now, startedAt: now, finishedAt: now }]
    }
    const updated = next.slice()
    // done 的 content 是服务端全量最终文本：无条件整体替换，stopped 事实
    // 标志经展开保留。此前把终止标记拼进 content 再在 done 里拼接保留，
    // 曾把已流出内容重复一遍（回归：cf签到 气泡里出现两个 Turn 1）。
    updated[idx] = { ...updated[idx], content: evt.content, streaming: false, timestamp: now, finishedAt: now }
    return updated
  }
  if (evt.type === 'retry') {
    if (isHiddenSource(evt.source)) return prev
    const reason = evt.reason?.label || evt.retry_reason || '可恢复错误'
    return upsertRetryNotice(
      prev,
      evt.logical_id || evt.stream_id || '',
      `_检测到 ${reason}，正在自动重试（${evt.attempt}/${evt.max_attempts}）。_`,
      now,
      undefined,
      evt.run_id,
    )
  }
  if (evt.type === 'retry_exhausted') {
    if (isHiddenSource(evt.source)) return prev
    const reason = evt.reason?.label || evt.retry_reason || '可恢复错误'
    return upsertRetryNotice(
      prev,
      evt.logical_id || evt.stream_id || '',
      `_检测到 ${reason}，但自动重试已达到上限（${evt.max_attempts}/${evt.max_attempts}）。_`,
      now,
      undefined,
      evt.run_id,
    )
  }
  if (evt.type === 'retry_scheduled') {
    if (isHiddenSource(evt.source)) return prev
    const reason = evt.reason?.label || evt.retry_reason || '可恢复错误'
    const secs = Math.max(1, Math.round(evt.delay_seconds ?? 0))
    return upsertRetryNotice(
      prev,
      evt.logical_id || evt.stream_id || '',
      `_检测到 ${reason}，约 ${secs}s 后自动重试（${evt.attempt}/${evt.max_attempts}）。_`,
      now,
      undefined,
      evt.run_id,
    )
  }
  if (evt.type === 'error') {
    // abort 后 socket 关断的余波（stream_error 等）不是新故障：只结流，不报错。
    // 压制按流持续到该流 done 为止——卡住的工具被停时，余波经常超过数秒才到。
    if (evt.stream_id && abortedStreams.has(evt.stream_id)) {
      return prev.map((m) => (m.streaming ? { ...m, streaming: false, finishedAt: now } : m))
    }
    const noticeId = `${evt.stream_id}:error:${evt.code}`
    const stopped = prev.map((m) =>
      m.streamId === evt.stream_id && m.streaming ? { ...m, streaming: false, finishedAt: now } : m,
    )
    if (stopped.some((m) => m.streamId === noticeId)) return stopped
    return [
      ...stopped,
      {
        role: 'assistant',
        content: `_运行错误（${evt.code}）：${evt.detail || '会话运行失败，请稍后重试。'}_`,
        streamId: noticeId,
        source: 'runtime_error_notice',
        timestamp: now,
      },
    ]
  }
  if (evt.type === 'aborted') {
    // Mark every still-streaming bubble as finished — server confirmed abort.
    // 手动停止是事实状态：置 stopped 标志，不动 content（渲染层负责提示），
    // 并记录被停 stream 以压掉余波 error（保留到该流的 done 到达为止）。
    for (const m of prev) {
      if (m.streaming && m.streamId) abortedStreams.set(m.streamId, Date.now())
    }
    return prev.map((m) => (m.streaming ? { ...m, streaming: false, finishedAt: now, stopped: true } : m))
  }
  if (evt.type === 'rewound') {
    // Server-driven rewind: drop bubbles whose streamId belongs to any removed
    // base sid. Derived ids (e.g. `${sid}:retry:N` for retry-notice bubbles)
    // are matched by prefix so their hint bubbles disappear together.
    const sids = new Set(evt.removed_sids || [])
    if (sids.size === 0) return prev
    return prev.filter((m) => {
      if (!m.streamId) return true
      if (sids.has(m.streamId)) return false
      const base = m.streamId.split(':')[0]
      return !sids.has(base)
    })
  }
  return prev
}

export function ensureRetryStartNotice(prev: ChatMsg[], evt: ChatWSOut): ChatMsg[] {
  if (evt.type !== 'next' && evt.type !== 'done') return prev
  if (evt.source !== 'chat_error_retry' && evt.source !== 'auto_continue') return prev
  // Late cumulative events cannot revive recovery status on a completed stream.
  if (prev.some((m) => belongsToRun(m, evt.run_id) && m.segments?.some((part) => part.streamId === evt.stream_id && part.done))) return prev
  const attempt = evt.retry_attempt ?? 0
  const retryKey = evt.logical_id || evt.retry_of || evt.stream_id || ''
  const reason = evt.retry_reason === 'truncated' ? '截断续接' : '网络重试'
  const note = `_系统${reason}（${attempt || '?'}${evt.retry_max ? `/${evt.retry_max}` : ''}）。_`
  return upsertRetryNotice(prev, retryKey, note, undefined, evt.stream_id, evt.run_id)
}

export function anyStreaming(msgs: ChatMsg[]): boolean {
  return msgs.some((m) => m.streaming)
}
