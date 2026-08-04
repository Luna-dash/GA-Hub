// chatStore — session-scoped live-chat state shared across page remounts.
//
// LiveChat starts the store for the selected Hub session. A session change
// closes the previous socket and clears its local projection; ordinary SPA
// navigation leaves the selected session connected so its in-memory stream can
// survive a page remount. The socket is receive-only: submit and abort use the
// session HTTP API, while history hydration comes from GA's archive projection.
//
// State model:
//   - msgs is an ordered list of UI bubbles. Each assistant bubble carries
//     its `streamId` so successive {next} chunks can mutate the same
//     bubble. User bubbles do too (so we can disambiguate which user
//     prompt each assistant reply belongs to). webui-source bubbles are
//     pre-added on submit (with image previews) and adopt the streamId
//     when the matching `started` event arrives.

import { create } from 'zustand'
import type { ChatEventCursor, ChatStreamSnapshot, ChatWSOut, SessionMessageProjection } from '@/api/types'
import { api, ChatSocket } from '@/api/client'
import type { PasteAttachment } from '@/components/ImagePasteInput'

export type ChatMsgRole = 'user' | 'assistant' | 'system'

export interface ChatMsg {
  role: ChatMsgRole
  content: string
  streamId?: string                // matched stream (omitted for system notes)
  source?: string                  // 'user' | 'webui' | 'autonomous' | 'wechat' | 'reflect' | …
  streaming?: boolean              // assistant bubble currently receiving
  attachments?: PasteAttachment[]  // local-only previews for the user bubble
  pendingWebui?: boolean           // set on local pre-add until `started` arrives
  pendingWebuiId?: string          // identifies the exact optimistic bubble for rollback
}

interface ChatState {
  msgs: ChatMsg[]
  conn: 'connecting' | 'open' | 'closed'
  streaming: boolean              // true if any stream still receiving
  hydrating: boolean              // legacy alias for historyStatus === 'loading_history'
  historyStatus: 'idle' | 'loading_history' | 'ready' | 'history_error'
  historyError: string | null
  sock: ChatSocket | null
  sessionId: string | null

  start: (sessionId: string) => void
  retryHistory: () => void
  stop: () => void

  /** Stage a local user bubble before LiveChat submits through session HTTP. */
  stageWebui: (text: string, atts: PasteAttachment[]) => string
  /** Remove that exact bubble if HTTP submission fails before server adoption. */
  rollbackWebui: (stageId: string) => void

  /** Wipe local view (used by /new). Doesn't talk to the server. */
  clearLocal: () => void
  /** Push a system / banner bubble (e.g. /new ack, LLM switched, restore notice). */
  pushSystem: (content: string) => void
  /** Clear stale local streaming locks when the backend is already idle. */
  markIdle: () => void
}

// LiveChat shows the user's own webui session + admin-side flows
// (autonomous evolution, reflect, /llm internal). It does NOT show the
// wechat bot — those live in the dedicated WechatBot page so the two
// channels don't pollute each other.
const HIDDEN_SOURCES = new Set(['wechat'])
const isHiddenSource = (s?: string) => !!s && HIDDEN_SOURCES.has(s)

/** Build the UI msg list from a server snapshot — used on (re)connect. */
function applySnapshot(streams: ChatStreamSnapshot[]): ChatMsg[] {
  const out: ChatMsg[] = []
  const seenRetryNotices = new Set<string>()
  for (const s of streams) {
    if (isHiddenSource(s.source)) continue
    if (s.source === 'chat_error_retry') {
      const attempt = s.retry_attempt || 0
      const noticeKey = `${s.logical_id || s.stream_id}:${attempt}`
      if (!seenRetryNotices.has(noticeKey)) {
        seenRetryNotices.add(noticeKey)
        out.push({
          role: 'assistant',
          content: `_自动重试请求${s.done ? '已完成' : '进行中'}（${attempt || '?'}${s.retry_max ? `/${s.retry_max}` : ''}${s.retry_reason ? ` · ${s.retry_reason}` : ''}）。_`,
          streamId: `${s.stream_id}:retry-snapshot`,
          source: 'chat_error_retry_notice',
        })
      }
      if (s.content || !s.done) {
        out.push({
          role: 'assistant',
          content: s.content,
          streamId: s.stream_id,
          source: s.source,
          streaming: !s.done,
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
      })
    }
    if (s.content || !s.done) {
      out.push({
        role: 'assistant',
        content: s.content,
        streamId: s.stream_id,
        source: s.source,
        streaming: !s.done,
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
    }))
}

function mergeLive(base: ChatMsg[], live: ChatMsg[]): ChatMsg[] {
  const out = [...base]
  const positions = new Map(out.map((m, i) => [m.streamId, i]))
  for (const msg of live) {
    if (msg.streamId && positions.has(msg.streamId)) {
      const index = positions.get(msg.streamId)!
      // Never let an old partial replace a completed archive message.
      if (msg.streaming || out[index].streamId?.startsWith('history:') === false) out[index] = msg
      continue
    }
    out.push(msg)
    if (msg.streamId) positions.set(msg.streamId, out.length - 1)
  }
  return out
}

let historyGeneration = 0
let historyAbort: AbortController | null = null
let webuiStageSequence = 0
const sessionCursors = new Map<string, ChatEventCursor>()

function commitCursor(sessionId: string, event: ChatWSOut): void {
  if (typeof event.event_id !== 'number' || !event.epoch) return
  const current = sessionCursors.get(sessionId)
  if (!current || current.epoch !== event.epoch || event.event_id > current.event_id) {
    sessionCursors.set(sessionId, { event_id: event.event_id, epoch: event.epoch })
  }
}

function sessionSocketPath(sessionId: string): string {
  const base = `/ws/sessions/${encodeURIComponent(sessionId)}`
  const cursor = sessionCursors.get(sessionId)
  if (!cursor) return base
  const query = new URLSearchParams({
    after_event_id: String(cursor.event_id),
    epoch: cursor.epoch,
  })
  return `${base}?${query.toString()}`
}

/** Apply a single server event to the message list. */
function applyEvent(prev: ChatMsg[], evt: ChatWSOut): ChatMsg[] {
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
      const noticeId = `${retryKey}:retry:${retryAttempt}`
      const next = prev.filter((m) => m.streamId !== noticeId)
      return [
        ...next,
        { role: 'assistant', content: note, streamId: noticeId, source: 'chat_error_retry_notice' },
        { role: 'assistant', content: '', streamId: sid, source, streaming: true },
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
        return [...adopted, { role: 'assistant', content: '', streamId: sid, source, streaming: true }]
      }
    }
    // 2. Fresh stream from another source (or a webui submission whose pre-add
    //    is missing — happens after a tab reload). Add a user + assistant pair.
    const next = prev.slice()
    if (!next.some((m) => m.role === 'user' && m.streamId === sid)) {
      next.push({ role: 'user', content: query, streamId: sid, source })
    }
    if (!next.some((m) => m.role === 'assistant' && m.streamId === sid)) {
      next.push({ role: 'assistant', content: '', streamId: sid, source, streaming: true })
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
      return [...next, { role: 'assistant', content: evt.content, streamId: sid, source: evt.source, streaming: true }]
    }
    const updated = next.slice()
    updated[idx] = { ...updated[idx], content: evt.content, streaming: true }
    return updated
  }
  if (evt.type === 'done') {
    const sid = evt.stream_id
    if (isHiddenSource(evt.source)) return prev
    const next = ensureRetryStartNotice(prev, evt)
    // /btw side-question answers come with source='system' — render as system role
    const role = evt.source === 'system' ? 'system' : 'assistant'
    const idx = next.findIndex((m) => (m.role === 'assistant' || m.role === 'system') && m.streamId === sid)
    if (idx === -1) {
      return [...next, { role, content: evt.content, streamId: sid, source: evt.source, streaming: false }]
    }
    const updated = next.slice()
    updated[idx] = { ...updated[idx], content: evt.content, streaming: false }
    return updated
  }
  if (evt.type === 'retry') {
    if (isHiddenSource(evt.source)) return prev
    const reason = evt.reason?.label || evt.retry_reason || '可恢复错误'
    const noticeId = `${evt.logical_id || evt.stream_id}:retry:${evt.attempt}`
    const next = prev.filter((m) => m.streamId !== noticeId)
    return [
      ...next,
      {
        role: 'assistant',
        content: `_检测到 ${reason}，正在自动重试（${evt.attempt}/${evt.max_attempts}）。_`,
        streamId: noticeId,
        source: 'chat_error_retry_notice',
      },
    ]
  }
  if (evt.type === 'retry_exhausted') {
    if (isHiddenSource(evt.source)) return prev
    const reason = evt.reason?.label || evt.retry_reason || '可恢复错误'
    return [
      ...prev,
      {
        role: 'assistant',
        content: `_检测到 ${reason}，但自动重试已达到上限（${evt.max_attempts}/${evt.max_attempts}）。_`,
        streamId: `${evt.stream_id}:retry-exhausted`,
        source: 'chat_error_retry_notice',
      },
    ]
  }
  if (evt.type === 'error') {
    const noticeId = `${evt.stream_id}:error:${evt.code}`
    const stopped = prev.map((m) =>
      m.streamId === evt.stream_id && m.streaming ? { ...m, streaming: false } : m,
    )
    if (stopped.some((m) => m.streamId === noticeId)) return stopped
    return [
      ...stopped,
      {
        role: 'assistant',
        content: `_运行错误（${evt.code}）：${evt.detail || '会话运行失败，请稍后重试。'}_`,
        streamId: noticeId,
        source: 'runtime_error_notice',
      },
    ]
  }
  if (evt.type === 'aborted') {
    // Mark every still-streaming bubble as finished — server confirmed abort.
    return prev.map((m) => (m.streaming ? { ...m, streaming: false } : m))
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
  const noticeId = `${evt.logical_id || evt.retry_of || evt.stream_id}:retry:${attempt}`
  if (prev.some((m) => m.streamId === noticeId)) return prev
  const note = `_自动重试请求已开始（${attempt || '?'}${evt.retry_max ? `/${evt.retry_max}` : ''}${evt.retry_reason ? ` · ${evt.retry_reason}` : ''}）。_`
  return [
    ...prev,
    { role: 'assistant', content: note, streamId: noticeId, source: 'chat_error_retry_notice' },
  ]
}

function anyStreaming(msgs: ChatMsg[]): boolean {
  return msgs.some((m) => m.streaming)
}

export const useChatStore = create<ChatState>((set, get) => ({
  msgs: [],
  conn: 'connecting',
  streaming: false,
  hydrating: true,
  historyStatus: 'idle',
  historyError: null,
  sock: null,
  sessionId: null,

  start: (sessionId) => {
    if (get().sock && get().sessionId === sessionId && get().historyStatus !== 'history_error') return
    get().sock?.close()
    if (get().sessionId !== sessionId) set({ msgs: [], streaming: false })
    set({ historyStatus: 'loading_history', historyError: null, hydrating: true })

    const generation = ++historyGeneration
    historyAbort?.abort()
    const abort = new AbortController()
    historyAbort = abort
    let historyReady = false
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
    //   process is killed, pywebview reload-recovers the URL, the new tab
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
    const FLUSH_MS = 100

    const flushNext = () => {
      if (nextTimer != null) {
        window.clearTimeout(nextTimer)
        nextTimer = null
      }
      if (pendingNext.size === 0) return
      const evts = Array.from(pendingNext.values())
      pendingNext.clear()
      lastFlush = Date.now()
      set((st) => {
        let msgs = st.msgs
        for (const e of evts) msgs = applyEvent(msgs, e)
        return { msgs, streaming: anyStreaming(msgs) }
      })
      for (const e of evts) commitCursor(sessionId, e)
    }

    const sock = new ChatSocket(() => sessionSocketPath(sessionId))
    sock.onState = (s) => {
      set({ conn: s })
    }
    const handleReadyMessage = (m: ChatWSOut, deferSnapshot = true) => {
      // Snapshot is large; defer past the next paint so the WebView
      // becomes interactive first (preserved from prior behaviour).
      if (m.type === 'snapshot') {
        devTrace('snapshot', m.type)
        // Drop any in-flight next throttle — the snapshot is the
        // authoritative state.
        pendingNext.clear()
        if (nextTimer != null) { window.clearTimeout(nextTimer); nextTimer = null }
        const apply = () => {
          set((st) => {
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
        sessionCursors.delete(sessionId)
        pendingNext.clear()
        if (nextTimer != null) { window.clearTimeout(nextTimer); nextTimer = null }
        historyReady = false
        sock.close()
        set({ sock: null, hydrating: true, historyStatus: 'loading_history' })
        queueMicrotask(() => {
          if (generation === historyGeneration && get().sessionId === sessionId) get().start(sessionId)
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

      // Any other event (started / done / aborted / reset / error / pong):
      devTrace('live', m.type)
      // flush queued next first so done's final content lands AFTER the
      // most recent streaming chunk, not before.
      if (pendingNext.size > 0) flushNext()
      set((st) => {
        const msgs = applyEvent(st.msgs, m)
        return { msgs, streaming: anyStreaming(msgs) }
      })
      commitCursor(sessionId, m)
    }
    sock.onMessage = (message) => {
      if (!historyReady) {
        bufferedEvents.push(message)
        return
      }
      handleReadyMessage(message)
    }
    sock.open()
    set({ sock, sessionId, conn: 'connecting', hydrating: true })

    void api.getSessionMessages(sessionId, abort.signal).then((history) => {
      if (generation !== historyGeneration || get().sessionId !== sessionId) return
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
        }
      })
      for (const event of queued) handleReadyMessage(event, false)
    }).catch((error: unknown) => {
      if (abort.signal.aborted || generation !== historyGeneration || get().sessionId !== sessionId) return
      historyReady = true
      const queued = bufferedEvents.splice(0)
      set((st) => ({
        msgs: st.msgs,
        streaming: st.streaming,
        hydrating: false,
        historyStatus: 'history_error',
        historyError: error instanceof Error ? error.message : '历史消息加载失败',
      }))
      for (const event of queued) handleReadyMessage(event, false)
    })
  },

  retryHistory: () => {
    const sessionId = get().sessionId
    if (sessionId) get().start(sessionId)
  },

  stop: () => {
    historyGeneration++
    historyAbort?.abort()
    get().sock?.close()
    set({ sock: null, sessionId: null, conn: 'closed', hydrating: false, historyStatus: 'idle', historyError: null })
  },

  stageWebui: (text, atts) => {
    const stageId = `webui-stage-${++webuiStageSequence}`
    const userBubble: ChatMsg = {
      role: 'user', content: text, source: 'webui',
      attachments: atts.length ? atts : undefined,
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

  clearLocal: () => set({ msgs: [], streaming: false }),
  pushSystem: (content) =>
    set((st) => ({ msgs: [...st.msgs, { role: 'assistant', content, source: 'system' }] })),
  markIdle: () =>
    set((st) => ({
      msgs: st.msgs.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
      streaming: false,
    })),
}))
