// chatStore — session-scoped live-chat state shared across page remounts.
//
// LiveChat starts the store for the selected Hub session. A session change
// snapshots the old projection and rebinds the cached target projection; its
// cursor socket resumes only missed events. Ordinary SPA navigation leaves the
// selected session connected so its in-memory stream can survive a page
// remount. The socket is receive-only: submit and abort use the session HTTP
// API, while first-load history hydration comes from GA's archive projection.
//
// State model:
//   - msgs is an ordered list of UI bubbles. Each assistant bubble carries
//     its `streamId` so successive {next} chunks can mutate the same
//     bubble. User bubbles do too (so we can disambiguate which user
//     prompt each assistant reply belongs to). webui-source bubbles are
//     pre-added on submit (with image previews) and adopt the streamId
//     when the matching `started` event arrives.

import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type {
  ChatEventCursor,
  ChatStreamSnapshot,
  ChatWSOut,
  ConversationMessage,
  SessionMessageProjection,
} from '@/api/types'
import { api, ChatSocket } from '@/api/client'
import type { PasteAttachment } from '@/api/types'

export type ChatMsgRole = 'user' | 'assistant' | 'system'

export interface ChatMsg {
  role: ChatMsgRole
  content: string
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

interface SessionView {
  msgs: ChatMsg[]
  streaming: boolean
  historyStatus: ChatState['historyStatus']
  historyError: string | null
  historyRevision: string | null
  historyHasMore: boolean
  historyBefore: number | null
  olderHistoryStatus: ChatState['olderHistoryStatus']
  olderHistoryError: string | null
  lastAccessedAt: number
}

interface ChatState {
  msgs: ChatMsg[]
  conn: 'connecting' | 'open' | 'closed'
  streaming: boolean              // true if any stream still receiving
  retryPending: boolean           // true while a recoverable error retry is backing off (abortable, but coordinator reports idle)
  hydrating: boolean              // legacy alias for historyStatus === 'loading_history'
  historyStatus: 'idle' | 'loading_history' | 'ready' | 'history_error'
  historyError: string | null
  historyRevision: string | null
  historyHasMore: boolean
  historyBefore: number | null
  olderHistoryStatus: 'idle' | 'loading' | 'error'
  olderHistoryError: string | null
  /** True while 「加载全部历史」 sweeps every remaining page in the background. */
  loadingAllHistory: boolean
  /** Approximate count of messages added by the full-history sweep. */
  allHistoryLoadedItems: number
  sock: ChatSocket | null
  sessionId: string | null
  /** Per-session in-memory projections make switching instant; WS replay catches them up. */
  sessionViews: Record<string, SessionView>

  start: (sessionId: string, options?: { forceHistory?: boolean }) => void
  retryHistory: () => void
  loadOlderHistory: () => Promise<void>
  /** Page back from the newest edge until the whole archive is loaded. */
  loadAllHistory: () => Promise<void>
  dropSessionView: (sessionId: string) => void
  /**
   * Tear down the live connection and local projection state (session
   * unbind / app-level logout). This does NOT abort a running task —
   * task abort is the session HTTP API (api.abortSession), see LiveChat.
   */
  teardown: () => void

  /** Stage a local user bubble before LiveChat submits through session HTTP. */
  stageWebui: (text: string, atts: PasteAttachment[]) => string
  /** Remove that exact bubble if HTTP submission fails before server adoption. */
  rollbackWebui: (stageId: string) => void

  /** Wipe local view (used by /new). Doesn't talk to the server. */
  clearLocal: () => void
  /**
   * Push a system / banner bubble (e.g. /new ack, LLM switched, import ack).
   * With a key from {@link noticeKeys}, repeated pushes reuse one bubble
   * (id `sys:<key>`) instead of appending.
   */
  pushSystem: (content: string, stableKey?: NoticeKey) => void
  /** Replace the visible transcript after a native conversation restore.
   *
   * No production caller since the restore UI was retired (2026-09-15): an
   * archive now becomes a session of its own and the chat page hydrates it
   * through the ordinary history load. Kept because chatStore.test.ts pins its
   * atomic-replacement semantics. */
  restoreVisibleConversation: (messages: readonly ConversationMessage[], notice: string) => void
}

// LiveChat shows the user's own webui session + admin-side flows
// (autonomous evolution, reflect, /llm internal). It does NOT show the
// wechat bot — those live in the dedicated WechatBot page so the two
// channels don't pollute each other.
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

const RETRY_NOTICE_ID_SUFFIX = ':retry-notice'

/**
 * Reusable ("stable") system-notice bubbles: one key rewrites one bubble in
 * place (streamId `sys:<key>`) instead of appending, so repeating an action
 * never spams duplicates. Register every new key here to keep the full set
 * enumerable and call sites type-checked.
 */
export const noticeKeys = {
  llmSwitch: 'llm-switch',
  llmSwitchFail: 'llm-switch-fail',
  projectSwitchFail: 'project-switch-fail',
  sendBlocked: 'send-blocked',
  sessionCreateFail: 'session-create-fail',
  rollback: 'rollback',
  rollbackBlocked: 'rollback-blocked',
  stopNone: 'stop-none',
} as const

export type NoticeKey = (typeof noticeKeys)[keyof typeof noticeKeys]

/**
 * Insert-or-update the single reusable retry-notice bubble of one logical
 * turn. A stable streamId (no attempt counter) makes every subsequent retry
 * event rewrite the same bubble in place instead of appending new ones.
 */
function upsertRetryNotice(
  prev: ChatMsg[],
  retryKey: string,
  content: string,
  timestamp?: number,
): ChatMsg[] {
  const streamId = `${retryKey}${RETRY_NOTICE_ID_SUFFIX}`
  const idx = prev.findIndex((m) => m.streamId === streamId)
  if (idx === -1) {
    return [
      ...prev,
      { role: 'assistant', content, streamId, source: 'chat_error_retry_notice', timestamp },
    ]
  }
  const next = prev.slice()
  next[idx] = { ...next[idx], content, ...(timestamp !== undefined ? { timestamp } : {}) }
  return next
}

/** Build the UI msg list from a server snapshot — used on (re)connect. */
function applySnapshot(streams: ChatStreamSnapshot[]): ChatMsg[] {
  const out: ChatMsg[] = []
  // One reused retry-notice bubble per logical turn: retryKey -> its index in
  // `out` plus the strongest state emitted so far (completed beats ongoing;
  // ties broken by higher attempt).
  const retryNoticeEntries = new Map<string, { idx: number; attempt: number; done: boolean }>()
  const retryNoticeLabel = (s: ChatStreamSnapshot, attempt: number): string =>
    `_自动重试请求${s.done ? '已完成' : '进行中'}（${attempt || '?'}${s.retry_max ? `/${s.retry_max}` : ''}${s.retry_reason ? ` · ${s.retry_reason}` : ''}）。_`
  for (const s of streams) {
    if (isHiddenSource(s.source)) continue
    if (s.source === 'chat_error_retry') {
      const attempt = s.retry_attempt || 0
      const done = !!s.done
      const retryKey = s.logical_id || s.stream_id || ''
      const meta = retryNoticeEntries.get(retryKey)
      if (meta === undefined) {
        retryNoticeEntries.set(retryKey, { idx: out.length, attempt, done })
        out.push({
          role: 'assistant',
          content: retryNoticeLabel(s, attempt),
          streamId: `${retryKey}:retry-notice`,
          source: 'chat_error_retry_notice',
          timestamp: epochMilliseconds(done ? s.finished_at : s.started_at),
          startedAt: epochMilliseconds(s.started_at),
          finishedAt: done ? epochMilliseconds(s.finished_at) : null,
        })
      } else if (attempt > meta.attempt || (attempt === meta.attempt && done && !meta.done)) {
        // A later attempt (or the completion of the current one) refreshes
        // the hint text in place — newest attempt wins regardless of order.
        retryNoticeEntries.set(retryKey, { ...meta, attempt, done })
        out[meta.idx] = {
          ...out[meta.idx],
          content: retryNoticeLabel(s, attempt),
          timestamp: epochMilliseconds(done ? s.finished_at : s.started_at),
          startedAt: epochMilliseconds(s.started_at),
          finishedAt: done ? epochMilliseconds(s.finished_at) : null,
        }
      }
      if (s.content || !s.done) {
        out.push({
          role: 'assistant',
          content: s.content,
          streamId: s.stream_id,
          source: s.source,
          streaming: !s.done,
          timestamp: epochMilliseconds(s.done ? s.finished_at : s.started_at),
          startedAt: epochMilliseconds(s.started_at),
          finishedAt: s.done ? epochMilliseconds(s.finished_at) : null,
        })
      }
      continue
    }
    if (s.query) {
      out.push({
        role: 'user',
        content: s.query,
        streamId: s.stream_id,
        source: s.source,
        timestamp: epochMilliseconds(s.started_at),
      })
    }
    if (s.content || !s.done) {
      out.push({
        role: 'assistant',
        content: s.content,
        streamId: s.stream_id,
        source: s.source,
        streaming: !s.done,
        timestamp: epochMilliseconds(s.done ? s.finished_at : s.started_at),
      })
    }
  }
  return out
}

function historyToMessages(items: SessionMessageProjection[]): ChatMsg[] {
  return items
    .filter((item) => item.role === 'user' || item.role === 'assistant')
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((item) => ({
      role: item.role,
      content: item.content,
      // The archive id is the stable identity for deduplication on rehydrate.
      streamId: `history:${item.id}`,
      source: 'history',
      timestamp: parseArchiveTime(item.timestamp),
    }))
}

const ARCHIVE_SNAPSHOT_TIME_TOLERANCE_MS = 2 * 60 * 1000

function timestampsOverlap(archived: ChatMsg, snapshot: ChatMsg): boolean {
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

function pairsDescribeSameTurn(
  archivedQuery: ChatMsg,
  archivedAnswer: ChatMsg,
  query: ChatMsg,
  answer: ChatMsg,
): boolean {
  if (archivedQuery.role !== 'user' || archivedAnswer.role !== 'assistant') return false
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
function livePositionKey(msg: ChatMsg): string | null {
  if (!msg.streamId) return null
  return `${msg.streamId}\u0000${msg.role}`
}

function mergeLive(base: ChatMsg[], live: ChatMsg[]): ChatMsg[] {
  const out = [...base]
  const positions = new Map<string, number>()
  out.forEach((m, index) => {
    const key = livePositionKey(m)
    if (key) positions.set(key, index)
  })
  for (const msg of removeArchivedSnapshotOverlap(base, live)) {
    const key = livePositionKey(msg)
    if (key && positions.has(key)) {
      const index = positions.get(key)!
      // Never let an old partial replace a completed archive message.
      if (msg.streaming || out[index].streamId?.startsWith('history:') === false) out[index] = msg
      continue
    }
    out.push(msg)
    if (key) positions.set(key, out.length - 1)
  }
  return out
}

// ── store 外的运行时单例 ────────────────────────────────────────────────
// 这些值与 React 渲染无关（abort 句柄/代数/游标/节流清理），不属于视图
// 状态，因此不放进 zustand；但生命周期严格跟随会话：teardown() 与
// dropSessionView() 负责复位。新增跨会话可变量必须登记在此并明确复位点。
const runtime = {
  /** 递增使 start() 里旧的异步回调（历史加载等）失效 */
  historyGeneration: 0,
  historyAbort: null as AbortController | null,
  olderHistoryAbort: null as AbortController | null,
  /** 当前连接的节流清理器（flush 尾巴 + 定时器），start 切换时先结算 */
  liveCleanup: null as (() => void) | null,
  webuiStageSequence: 0,
  /** 手动停止的痕迹：aborted 时仍在流的 streamId → abort 时刻。压制 abort
   *  引发的 stream_error 余波误报，持续到该流的 done 到达为止（真错误发生
   *  在别的 stream 上不受影响）；teardown/dropSessionView 时清空。 */
  abortedStreams: new Map<string, number>(),
  /** 每会话 WS 游标：跨 teardown 保留，重连只补增量事件 */
  sessionCursors: new Map<string, ChatEventCursor>(),
}

function commitCursor(sessionId: string, event: ChatWSOut): void {
  if (typeof event.event_id !== 'number' || !event.epoch) return
  const current = runtime.sessionCursors.get(sessionId)
  if (!current || current.epoch !== event.epoch || event.event_id > current.event_id) {
    runtime.sessionCursors.set(sessionId, { event_id: event.event_id, epoch: event.epoch })
  }
}

function sessionSocketPath(sessionId: string): string {
  const base = `/ws/sessions/${encodeURIComponent(sessionId)}`
  const cursor = runtime.sessionCursors.get(sessionId)
  if (!cursor) return base
  const query = new URLSearchParams({
    after_event_id: String(cursor.event_id),
    epoch: cursor.epoch,
  })
  return `${base}?${query.toString()}`
}

/** Apply a single server event to the message list. */
// exported for tests: pure reducer over the message list
export function applyEvent(prev: ChatMsg[], evt: ChatWSOut): ChatMsg[] {
  const now = Date.now()
  if (evt.type === 'snapshot') {
    return evt.streams ? applySnapshot(evt.streams) : prev
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
    if (source === 'chat_error_retry') {
      const retryKey = evt.logical_id || evt.retry_of || sid
      const note = `_自动重试请求已开始（${retryAttempt || '?'}${evt.retry_max ? `/${evt.retry_max}` : ''}${evt.retry_reason ? ` · ${evt.retry_reason}` : ''}）。_`
      return [
        ...upsertRetryNotice(prev, retryKey, note, now),
        { role: 'assistant', content: '', streamId: sid, source, streaming: true, timestamp: now, startedAt: epochMilliseconds(evt.ts) ?? now, finishedAt: null },
      ]
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
          pendingWebui: false,
          pendingWebuiId: undefined,
        }
        // Append empty assistant bubble for the streaming reply.
        return [...adopted, { role: 'assistant', content: '', streamId: sid, source, streaming: true, timestamp: now, startedAt: epochMilliseconds(evt.ts) ?? now, finishedAt: null }]
      }
    }
    // 2. Fresh stream from another source (or a webui submission whose pre-add
    //    is missing — happens after a tab reload). Add a user + assistant pair.
    const next = prev.slice()
    if (!next.some((m) => m.role === 'user' && m.streamId === sid)) {
      next.push({ role: 'user', content: query, streamId: sid, source, timestamp: now })
    }
    if (!next.some((m) => m.role === 'assistant' && m.streamId === sid)) {
      next.push({ role: 'assistant', content: '', streamId: sid, source, streaming: true, timestamp: now, startedAt: epochMilliseconds(evt.ts) ?? now, finishedAt: null })
    }
    return next
  }
  if (evt.type === 'next') {
    const sid = evt.stream_id
    if (isHiddenSource(evt.source)) return prev
    const next = ensureRetryStartNotice(prev, evt)
    const idx = next.findIndex((m) => m.role === 'assistant' && m.streamId === sid)
    if (idx === -1) {
      // started not yet seen — create on the fly
      return [...next, { role: 'assistant', content: evt.content, streamId: sid, source: evt.source, streaming: true, timestamp: now, startedAt: now, finishedAt: null }]
    }
    const updated = next.slice()
    updated[idx] = { ...updated[idx], content: evt.content, streaming: updated[idx].stopped ? false : true }
    return updated
  }
  if (evt.type === 'done') {
    const sid = evt.stream_id
    if (isHiddenSource(evt.source)) return prev
    // 该流已终态：解除 abort 余波压制（之后这条流再来的 error 是真故障）
    runtime.abortedStreams.delete(sid)
    const next = ensureRetryStartNotice(prev, evt)
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
    )
  }
  if (evt.type === 'error') {
    // abort 后 socket 关断的余波（stream_error 等）不是新故障：只结流，不报错。
    // 压制按流持续到该流 done 为止——卡住的工具被停时，余波经常超过数秒才到。
    if (evt.stream_id && runtime.abortedStreams.has(evt.stream_id)) {
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
      if (m.streaming && m.streamId) runtime.abortedStreams.set(m.streamId, Date.now())
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

function ensureRetryStartNotice(prev: ChatMsg[], evt: ChatWSOut): ChatMsg[] {
  if (evt.type !== 'next' && evt.type !== 'done') return prev
  if (evt.source !== 'chat_error_retry') return prev
  const attempt = evt.retry_attempt ?? 0
  const retryKey = evt.logical_id || evt.retry_of || evt.stream_id || ''
  const note = `_自动重试请求已开始（${attempt || '?'}${evt.retry_max ? `/${evt.retry_max}` : ''}${evt.retry_reason ? ` · ${evt.retry_reason}` : ''}）。_`
  return upsertRetryNotice(prev, retryKey, note)
}

function anyStreaming(msgs: ChatMsg[]): boolean {
  return msgs.some((m) => m.streaming)
}

const HISTORY_PAGE_LIMIT = 32
const HISTORY_PAGE_MAX_CHARS = 400_000
const HISTORY_PAGE_TURNS = 20
const MAX_CACHED_SESSION_VIEWS = 3
const MAX_CACHED_SESSION_CHARS = 3_000_000

function sessionViewChars(view: SessionView): number {
  return view.msgs.reduce((total, message) => total + message.content.length, 0)
}

function pruneSessionViews(views: Record<string, SessionView>): Record<string, SessionView> {
  const entries = Object.entries(views)
  const protectedEntries = entries.filter(([, view]) => view.streaming)
  const ordinaryEntries = entries
    .filter(([, view]) => !view.streaming)
    .sort(([, left], [, right]) => right.lastAccessedAt - left.lastAccessedAt)

  const kept = new Map(protectedEntries)
  let retainedChars = protectedEntries.reduce((total, [, view]) => total + sessionViewChars(view), 0)
  for (const [sessionId, view] of ordinaryEntries) {
    if (kept.size >= MAX_CACHED_SESSION_VIEWS) break
    const chars = sessionViewChars(view)
    if (chars > MAX_CACHED_SESSION_CHARS || retainedChars + chars > MAX_CACHED_SESSION_CHARS) continue
    kept.set(sessionId, view)
    retainedChars += chars
  }
  return Object.fromEntries(kept)
}

function prependUniqueHistory(older: ChatMsg[], current: ChatMsg[]): ChatMsg[] {
  const seen = new Set<string>()
  return [...older, ...current].filter((message) => {
    if (!message.streamId) return true
    if (seen.has(message.streamId)) return false
    seen.add(message.streamId)
    return true
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

export const useChatStore = create<ChatState>()(subscribeWithSelector((set, get) => ({
  msgs: [],
  conn: 'connecting',
  streaming: false,
  retryPending: false,
  hydrating: true,
  historyStatus: 'idle',
  historyError: null,
  historyRevision: null,
  historyHasMore: false,
  historyBefore: null,
  olderHistoryStatus: 'idle',
  olderHistoryError: null,
  loadingAllHistory: false,
  allHistoryLoadedItems: 0,
  sock: null,
  sessionId: null,
  sessionViews: {},

  start: (sessionId, options) => {
    const forceHistory = options?.forceHistory === true
    let current = get()
    if (!forceHistory && current.sock && current.sessionId === sessionId && current.historyStatus !== 'history_error') return

    // Commit the previous connection's throttled tail while its session is
    // still current, then invalidate every delayed callback it owns.
    runtime.liveCleanup?.()
    runtime.liveCleanup = null
    current = get()
    current.sock?.close()
    runtime.olderHistoryAbort?.abort()
    runtime.olderHistoryAbort = null

    const switching = current.sessionId !== sessionId
    const sessionViews = { ...current.sessionViews }
    if (current.sessionId && switching) {
      const previousView: SessionView = {
        msgs: current.msgs,
        streaming: current.streaming,
        historyStatus: current.historyStatus,
        historyError: current.historyError,
        historyRevision: current.historyRevision,
        historyHasMore: current.historyHasMore,
        historyBefore: current.historyBefore,
        olderHistoryStatus: current.olderHistoryStatus === 'loading' ? 'idle' : current.olderHistoryStatus,
        olderHistoryError: current.olderHistoryError,
        lastAccessedAt: Date.now(),
      }
      sessionViews[current.sessionId] = previousView
    }
    const cached = switching ? sessionViews[sessionId] : undefined
    if (switching) delete sessionViews[sessionId]
    const resumeCachedView = !forceHistory && switching && cached?.historyStatus === 'ready'
    set({
      msgs: switching ? (cached?.msgs ?? []) : current.msgs,
      streaming: switching ? (cached?.streaming ?? false) : current.streaming,
      retryPending: false,
      historyStatus: resumeCachedView ? cached.historyStatus : 'loading_history',
      historyError: resumeCachedView ? cached.historyError : null,
      historyRevision: resumeCachedView ? cached.historyRevision : null,
      historyHasMore: resumeCachedView ? cached.historyHasMore : false,
      historyBefore: resumeCachedView ? cached.historyBefore : null,
      olderHistoryStatus: resumeCachedView ? cached.olderHistoryStatus : 'idle',
      olderHistoryError: resumeCachedView ? cached.olderHistoryError : null,
      loadingAllHistory: false,
      allHistoryLoadedItems: 0,
      sessionViews: pruneSessionViews(sessionViews),
      // Like the Tauri desktop, switching only rebinds the already-live
      // per-session projection.  The cursor WebSocket catches up events that
      // arrived while this session was hidden; archive hydration is only for
      // a session whose projection has never been loaded.
      hydrating: forceHistory || (resumeCachedView ? false : current.msgs.length === 0),
    })

    const generation = ++runtime.historyGeneration
    runtime.historyAbort?.abort()
    const abort = new AbortController()
    runtime.historyAbort = abort
    let historyReady = resumeCachedView
    const bufferedEvents: ChatWSOut[] = []

    const devTrace = (source: 'hydrate' | 'snapshot' | 'replay' | 'live', eventType: string) => {
      if (import.meta.env.DEV) {
        console.debug(`[chat:${source}]`, { sessionId, eventType })
      }
    }

    const replayEvents = (base: ChatMsg[], events: ChatWSOut[]): ChatMsg[] => {
      devTrace('hydrate', 'history_replay')
      let msgs = base
      for (const event of events) {
        // A session snapshot describes live streams, not archived scrollback.
        msgs = event.type === 'snapshot' && event.streams
          ? mergeLive(msgs, applySnapshot(event.streams))
          : applyEvent(msgs, event)
      }
      return msgs
    }

    // Coalesce chat:next bursts. Background:
    //   When the agent streams a long markdown answer, the backend emits a
    //   {type:'next', content: <cumulative-so-far>} every ~50 ms. Without
    //   throttling, each one triggers set() → React re-render →
    //   ReactMarkdown re-parses the entire (growing) bubble. Past ~50 KB
    //   the WKWebView renderer falls behind its GPU watchdog, the WebKit
    //   process is killed, the desktop shell reload-recovers the URL, the new tab
    //   reconnects → snapshot replays the same in-flight stream → crashes
    //   again. From the user's POV the connection-status badge cycles
    //   "连接中…/断开" and 停止/LLM-切换 buttons are unclickable because
    //   React never reaches an idle frame.
    //
    //   Strategy: leading-edge + trailing flush, 100 ms quiet window.
    //   First next of a quiet period applies immediately so streaming
    //   feels live. Subsequent ones in the next 100 ms are merged
    //   keyed by stream_id — content is cumulative so we keep only
    //   the newest. Non-next events (snapshot/started/done/aborted/reset)
    //   flush pending nexts first then apply, ensuring 'done' always
    //   lands AFTER the latest visible content.
    const pendingNext: Map<string, ChatWSOut & { type: 'next' }> = new Map()
    let nextTimer: number | null = null
    let lastFlush = 0
    let active = true
    const FLUSH_MS = 100

    const flushNext = (force = false) => {
      if (nextTimer != null) {
        window.clearTimeout(nextTimer)
        nextTimer = null
      }
      if ((!active && !force) || pendingNext.size === 0) return
      const evts = Array.from(pendingNext.values())
      pendingNext.clear()
      lastFlush = Date.now()
      set((st) => {
        if (st.sessionId !== sessionId) return st
        let msgs = st.msgs
        for (const e of evts) msgs = applyEvent(msgs, e)
        return { msgs, streaming: anyStreaming(msgs) }
      })
      for (const e of evts) commitCursor(sessionId, e)
    }

    runtime.liveCleanup = () => {
      flushNext(true)
      active = false
      if (nextTimer != null) { window.clearTimeout(nextTimer); nextTimer = null }
      pendingNext.clear()
    }

    const sock = new ChatSocket(() => sessionSocketPath(sessionId))
    sock.onState = (s) => {
      if (active && get().sessionId === sessionId) set({ conn: s })
    }
    const handleReadyMessage = (m: ChatWSOut, deferSnapshot = true) => {
      if (!active || get().sessionId !== sessionId) return
      // Snapshot is large; defer past the next paint so the WebView
      // becomes interactive first (preserved from prior behaviour).
      if (m.type === 'snapshot') {
        devTrace('snapshot', m.type)
        // Drop any in-flight next throttle — the snapshot is the
        // authoritative state.
        pendingNext.clear()
        if (nextTimer != null) { window.clearTimeout(nextTimer); nextTimer = null }
        const apply = () => {
          if (!active || get().sessionId !== sessionId) return
          set((st) => {
            if (st.sessionId !== sessionId) return st
            let msgs = m.streams ? mergeLive(st.msgs, applySnapshot(m.streams)) : st.msgs
            if (m.active_message) {
              const activeEvent: ChatWSOut = m.active_message.done
                ? { type: 'done', stream_id: m.active_message.stream_id, content: m.active_message.content }
                : { type: 'next', stream_id: m.active_message.stream_id, content: m.active_message.content }
              msgs = applyEvent(msgs, activeEvent)
            }
            return {
              msgs,
              streaming: anyStreaming(msgs),
              hydrating: false,
            }
          })
          commitCursor(sessionId, m)
        }
        if (deferSnapshot && typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => requestAnimationFrame(apply))
        } else if (deferSnapshot) {
          setTimeout(apply, 0)
        } else {
          apply()
        }
        return
      }

      if (m.type === 'next') {
        pendingNext.set(m.stream_id, m)
        const since = Date.now() - lastFlush
        if (since >= FLUSH_MS) {
          flushNext()
        } else if (nextTimer == null) {
          nextTimer = window.setTimeout(flushNext, FLUSH_MS - since)
        }
        return
      }

      if (m.type === 'resync_required') {
        runtime.sessionCursors.delete(sessionId)
        pendingNext.clear()
        if (nextTimer != null) { window.clearTimeout(nextTimer); nextTimer = null }
        historyReady = false
        sock.close()
        set({ sock: null, hydrating: true, historyStatus: 'loading_history' })
        queueMicrotask(() => {
          if (generation === runtime.historyGeneration && get().sessionId === sessionId) get().start(sessionId)
        })
        return
      }

      // replay_done is the ordering barrier: all replayed events have been
      // applied before this frame is accepted as the reconnect boundary.
      if (m.type === 'replay_done') {
        devTrace('replay', m.type)
        if (pendingNext.size > 0) flushNext()
        commitCursor(sessionId, m)
        return
      }

      if (m.type === 'rewound') {
        // The event's stream ids can immediately remove live snapshots, but
        // archive-hydrated bubbles use independent `history:*` identities.
        // Commit this cursor first, then force a fresh archive projection so
        // every tab converges on the rewritten GA native log.
        if (pendingNext.size > 0) flushNext()
        set((st) => {
          const msgs = applyEvent(st.msgs, m)
          return { msgs, streaming: anyStreaming(msgs) }
        })
        commitCursor(sessionId, m)
        queueMicrotask(() => {
          if (active && get().sessionId === sessionId) get().retryHistory()
        })
        return
      }

      // Any other event (started / done / aborted / reset / error / pong):
      devTrace('live', m.type)
      // flush queued next first so done's final content lands AFTER the
      // most recent streaming chunk, not before.
      if (pendingNext.size > 0) flushNext()
      set((st) => {
        const msgs = applyEvent(st.msgs, m)
        // Track the server-side error-retry backoff so the UI can keep the
        // stop action available while the coordinator reports the run idle.
        let retryPending = st.retryPending
        if (m.type === 'retry_scheduled') retryPending = true
        else if (m.type === 'retry' || m.type === 'retry_exhausted' || m.type === 'done' || m.type === 'aborted' || m.type === 'started') retryPending = false
        return { msgs, streaming: anyStreaming(msgs), retryPending }
      })
      commitCursor(sessionId, m)
    }
    sock.onMessage = (message) => {
      if (!active || get().sessionId !== sessionId) return
      if (!historyReady) {
        bufferedEvents.push(message)
        return
      }
      handleReadyMessage(message)
    }
    sock.open()
    set({ sock, sessionId, conn: 'connecting' })

    if (!resumeCachedView) void api.getSessionMessages(sessionId, {
      limit: HISTORY_PAGE_LIMIT,
      maxChars: HISTORY_PAGE_MAX_CHARS,
      signal: abort.signal,
    }).then((history) => {
      if (generation !== runtime.historyGeneration || get().sessionId !== sessionId) return
      historyReady = true
      const queued = bufferedEvents.splice(0)
      set(() => {
        const msgs = historyToMessages(history.items)
        return {
          msgs,
          streaming: anyStreaming(msgs),
          hydrating: false,
          historyStatus: 'ready',
          historyError: null,
          historyRevision: history.revision ?? null,
          historyHasMore: history.has_more ?? false,
          historyBefore: history.next_before ?? null,
          olderHistoryStatus: 'idle',
          olderHistoryError: null,
        }
      })
      for (const event of queued) handleReadyMessage(event, false)
    }).catch((error: unknown) => {
      if (abort.signal.aborted || generation !== runtime.historyGeneration || get().sessionId !== sessionId) return
      historyReady = true
      const queued = bufferedEvents.splice(0)
      set((st) => ({
        msgs: st.msgs,
        streaming: st.streaming,
        hydrating: false,
        historyStatus: 'history_error',
        historyError: error instanceof Error ? error.message : '历史消息加载失败',
        historyRevision: null,
        historyHasMore: false,
        historyBefore: null,
        olderHistoryStatus: 'idle',
        olderHistoryError: null,
      }))
      for (const event of queued) handleReadyMessage(event, false)
    })
  },

  retryHistory: () => {
    const current = get()
    if (current.sessionId && current.historyStatus !== 'loading_history') {
      current.start(current.sessionId, { forceHistory: true })
    }
  },

  loadOlderHistory: async () => {
    const current = get()
    if (
      !current.sessionId
      || current.historyStatus !== 'ready'
      || !current.historyHasMore
      || current.historyBefore == null
      || current.olderHistoryStatus === 'loading'
    ) return

    const sessionId = current.sessionId
    const before = current.historyBefore
    runtime.olderHistoryAbort?.abort()
    const abort = new AbortController()
    runtime.olderHistoryAbort = abort
    set({ olderHistoryStatus: 'loading', olderHistoryError: null })

    try {
      const history = await api.getSessionMessages(sessionId, {
        before,
        turns: HISTORY_PAGE_TURNS,
        signal: abort.signal,
      })
      if (abort.signal.aborted || get().sessionId !== sessionId) return

      const revision = history.revision ?? null
      if (get().historyRevision !== revision) {
        set({ olderHistoryStatus: 'idle', olderHistoryError: null })
        queueMicrotask(() => {
          if (get().sessionId === sessionId) get().start(sessionId, { forceHistory: true })
        })
        return
      }

      const older = historyToMessages(history.items)
      set((state) => {
        if (state.sessionId !== sessionId) return state
        return {
          msgs: prependUniqueHistory(older, state.msgs),
          historyHasMore: history.has_more ?? false,
          historyBefore: history.next_before ?? null,
          olderHistoryStatus: 'idle',
          olderHistoryError: null,
        }
      })
    } catch (error: unknown) {
      if (abort.signal.aborted || get().sessionId !== sessionId) return
      set({
        olderHistoryStatus: 'error',
        olderHistoryError: error instanceof Error ? error.message : '更早的历史消息加载失败',
      })
    } finally {
      if (runtime.olderHistoryAbort === abort) runtime.olderHistoryAbort = null
    }
  },

  /**
   * Walk the turn-based pages back to the very start of the archive.
   * Pages keep their day-snapped boundaries; this loop only chains them so a
   * long session needs one click instead of dozens. Stops on session switch,
   * fatal errors, or when the cursor reaches the beginning.
   */
  loadAllHistory: async () => {
    const current = get()
    if (
      !current.sessionId
      || current.historyStatus !== 'ready'
      || !current.historyHasMore
      || current.historyBefore == null
      || current.olderHistoryStatus === 'loading'
      || current.loadingAllHistory
    ) return

    const sessionId = current.sessionId
    const deadline = Date.now() + 5 * 60_000
    let stalled = 0
    set({ loadingAllHistory: true, allHistoryLoadedItems: 0, olderHistoryError: null })

    try {
      for (let step = 0; step < 600; step += 1) {
        const state = get()
        if (state.sessionId !== sessionId || Date.now() > deadline) return
        if (state.historyStatus === 'history_error') return
        if (state.historyStatus !== 'ready') {
          // A newer revision raced a page and restarted hydration — wait it out.
          await delay(250)
          continue
        }
        if (!state.historyHasMore || state.historyBefore == null) return

        const beforeCount = state.msgs.length
        const revisionBefore = state.historyRevision
        await get().loadOlderHistory()

        const after = get()
        if (after.sessionId !== sessionId) return
        if (after.olderHistoryStatus === 'error' || after.historyStatus === 'history_error') {
          stalled += 1
          if (stalled >= 3) return
          await delay(750)
          continue
        }
        if (after.historyRevision !== revisionBefore) {
          stalled += 1
          if (stalled >= 3) return
          await delay(900)
          continue
        }
        const added = Math.max(0, after.msgs.length - beforeCount)
        if (added === 0 && after.historyHasMore && after.historyBefore != null) {
          stalled += 1
          if (stalled >= 3) return
          await delay(400)
          continue
        }
        stalled = 0
        set((st) => (
          st.sessionId === sessionId
            ? { allHistoryLoadedItems: st.allHistoryLoadedItems + added }
            : {}
        ))
      }
    } finally {
      if (get().sessionId === sessionId) set({ loadingAllHistory: false })
    }
  },

  dropSessionView: (sessionId) => {
    runtime.sessionCursors.delete(sessionId)
    const current = get()
    const sessionViews = { ...current.sessionViews }
    delete sessionViews[sessionId]
    if (current.sessionId !== sessionId) {
      set({ sessionViews })
      return
    }

    runtime.historyGeneration++
    runtime.historyAbort?.abort()
    runtime.olderHistoryAbort?.abort()
    runtime.olderHistoryAbort = null
    runtime.liveCleanup?.()
    runtime.liveCleanup = null
    runtime.abortedStreams.clear()
    current.sock?.close()
    set({
      msgs: [],
      conn: 'closed',
      streaming: false,
      hydrating: false,
      historyStatus: 'idle',
      historyError: null,
      historyRevision: null,
      historyHasMore: false,
      historyBefore: null,
      olderHistoryStatus: 'idle',
      olderHistoryError: null,
      loadingAllHistory: false,
      allHistoryLoadedItems: 0,
      sock: null,
      sessionId: null,
      sessionViews,
    })
  },

  /**
   * Tear down the live connection and local projection state (session
   * unbind / app-level logout). This does NOT abort a running task —
   * task abort is the session HTTP API (api.abortSession), see LiveChat.
   */
  teardown: () => {
    runtime.historyGeneration++
    runtime.historyAbort?.abort()
    runtime.olderHistoryAbort?.abort()
    runtime.olderHistoryAbort = null
    runtime.liveCleanup?.()
    runtime.liveCleanup = null
    runtime.abortedStreams.clear()
    get().sock?.close()
    set({
      sock: null,
      sessionId: null,
      conn: 'closed',
      hydrating: false,
      historyStatus: 'idle',
      historyError: null,
      historyRevision: null,
      historyHasMore: false,
      historyBefore: null,
      olderHistoryStatus: 'idle',
      olderHistoryError: null,
      loadingAllHistory: false,
      allHistoryLoadedItems: 0,
    })
  },

  stageWebui: (text, atts) => {
    const stageId = `webui-stage-${++runtime.webuiStageSequence}`
    const userBubble: ChatMsg = {
      role: 'user', content: text, source: 'webui',
      attachments: atts.length ? atts : undefined,
      timestamp: Date.now(),
      pendingWebui: true,
      pendingWebuiId: stageId,
    }
    set((st) => ({ msgs: [...st.msgs, userBubble], streaming: true }))
    return stageId
  },

  rollbackWebui: (stageId) => set((st) => {
    const msgs = st.msgs.filter((msg) => !(msg.pendingWebui && msg.pendingWebuiId === stageId))
    if (msgs.length === st.msgs.length) return st
    return {
      msgs,
      streaming: msgs.some((msg) => msg.streaming || msg.pendingWebui),
    }
  }),

  clearLocal: () => set({
    msgs: [],
    streaming: false,
    historyRevision: null,
    historyHasMore: false,
    historyBefore: null,
    olderHistoryStatus: 'idle',
    olderHistoryError: null,
    loadingAllHistory: false,
    allHistoryLoadedItems: 0,
  }),
  pushSystem: (content, stableKey) =>
    set((st) => {
      if (!stableKey) {
        return { msgs: [...st.msgs, { role: 'assistant', content, source: 'system', timestamp: Date.now() }] }
      }
      // Reusable notice: same category of action rewrites one bubble in place.
      const streamId = `sys:${stableKey}`
      const idx = st.msgs.findIndex((m) => m.streamId === streamId)
      if (idx === -1) {
        return { msgs: [...st.msgs, { role: 'assistant', content, streamId, source: 'system', timestamp: Date.now() }] }
      }
      const next = st.msgs.slice()
      next[idx] = { ...next[idx], content, timestamp: Date.now() }
      return { msgs: next }
    }),
  restoreVisibleConversation: (messages, notice) => set({
    msgs: [
      ...messages
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .map((message) => ({ role: message.role, content: message.content })),
      { role: 'assistant', content: notice, source: 'system', timestamp: Date.now() },
    ],
    streaming: false,
    historyRevision: null,
    historyHasMore: false,
    historyBefore: null,
    olderHistoryStatus: 'idle',
    olderHistoryError: null,
    loadingAllHistory: false,
    allHistoryLoadedItems: 0,
  }),
})))
