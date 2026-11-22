import { belongsToRun, upsertRetryNotice, applySnapshot, historyToMessages, coalesceArchiveRuns, timestampsOverlap, removeArchivedSnapshotOverlap, pairsDescribeSameTurn, livePositionKey, mergeRunReply, mergeLive, orderConversationTurns, mergeSessionSnapshot, settleSnapshot, updateLogicalReply, applyEvent as applyMessageEvent, reduceEvent, ensureRetryStartNotice, anyStreaming, type ChatMsg, type ChatMsgRole } from '@/utils/messageModel'
export { historyToMessages, mergeSessionSnapshot, orderConversationTurns } from '@/utils/messageModel'
export type { ChatMsg, ChatMsgRole } from '@/utils/messageModel'
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
import { useDraftStore } from './draftStore'
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
import { type ViewportResumePolicy } from '@/utils/conversationViewport'

interface SessionView {
  msgs: ChatMsg[]
  streaming: boolean
  /** Final landing policy for the next activation of this session. */
  resumePolicy: ViewportResumePolicy
  /** True only after the current history/snapshot/replay projection is complete. */
  projectionReady: boolean
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
  /** Policy used when this session next becomes visible. */
  resumePolicy: ViewportResumePolicy
  /** Cached messages may render before reconnect replay is complete. */
  projectionReady: boolean
  retryPending: boolean           // true while a recoverable error retry is backing off (abortable, but coordinator reports idle)
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
// (autonomous evolution, reflect, /llm internal). Keep legacy IM messages
// out of this transcript so existing history stays scoped to its source.
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
 * Insert or update recovery status inside the explicitly identified answer.
 * Status stays separate from model content and does not create a notice bubble.
 */
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

export function applyEvent(prev: ChatMsg[], evt: ChatWSOut): ChatMsg[] {
  return applyMessageEvent(prev, evt, runtime.abortedStreams)
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

export function prependUniqueHistory(older: ChatMsg[], current: ChatMsg[]): ChatMsg[] {
  const seen = new Set<string>()
  const archive = [...older, ...current.filter((m) => m.source === 'history')].filter((message) => {
    // Grouped runs may overlap but carry additional segments: dedup inside
    // coalesceArchiveRuns rather than throwing away the entire later group.
    if (message.runId || !message.streamId) return true
    const key = `${message.streamId}\u0000${message.role}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return mergeLive(coalesceArchiveRuns(archive), current.filter((m) => m.source !== 'history'))
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

export const useChatStore = create<ChatState>()(subscribeWithSelector((set, get) => ({
  msgs: [],
  conn: 'connecting',
  streaming: false,
  resumePolicy: 'open-latest',
  projectionReady: false,
  retryPending: false,
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
        resumePolicy: current.streaming ? 'follow-latest' : 'restore-position',
        projectionReady: current.projectionReady,
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
      msgs: orderConversationTurns(switching ? (cached?.msgs ?? []) : current.msgs),
      streaming: switching ? (cached?.streaming ?? false) : current.streaming,
      resumePolicy: switching
        ? (cached?.resumePolicy ?? (cached?.streaming ? 'follow-latest' : 'restore-position'))
        : current.resumePolicy,
      projectionReady: false,
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
        msgs = event.type === 'snapshot'
          ? mergeSessionSnapshot(msgs, event)
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
    const handleReadyMessage = (m: ChatWSOut, _deferSnapshot = true) => {
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
            const msgs = mergeSessionSnapshot(st.msgs, m)
            return {
              msgs,
              streaming: anyStreaming(msgs),
            }
          })
          commitCursor(sessionId, m)
        }
        // Apply synchronously before replay_done or newer live frames. Deferring
        // the baseline can otherwise overwrite a next/done that arrived later.
        apply()
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
        set({ sock: null, historyStatus: 'loading_history' })
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
        set((st) => st.sessionId === sessionId ? { projectionReady: true } : st)
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
      view: 'desktop',
      limit: HISTORY_PAGE_LIMIT,
      maxChars: HISTORY_PAGE_MAX_CHARS,
      signal: abort.signal,
    }).then((history) => {
      if (generation !== runtime.historyGeneration || get().sessionId !== sessionId) return
      historyReady = true
      const queued = bufferedEvents.splice(0)
      set((st) => {
        const msgs = mergeLive(historyToMessages(history.items), st.msgs.filter((m) => m.source !== 'history'))
        return {
          msgs,
          streaming: anyStreaming(msgs),
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
        view: 'desktop',
        maxChars: HISTORY_PAGE_MAX_CHARS,
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
   * Pages keep their bounded turn groups; this loop only chains them so a
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
    const removePending = (msgs: ChatMsg[]) => msgs.filter((msg) => !(msg.pendingWebui && msg.pendingWebuiId === stageId))
    const msgs = removePending(st.msgs)
    let changed = msgs.length !== st.msgs.length
    const sessionViews = { ...st.sessionViews }
    for (const [key, view] of Object.entries(sessionViews)) {
      const cachedMsgs = removePending(view.msgs)
      if (cachedMsgs.length !== view.msgs.length) {
        changed = true
        sessionViews[key] = { ...view, msgs: cachedMsgs, streaming: cachedMsgs.some((msg) => msg.streaming || msg.pendingWebui) }
      }
    }
    if (!changed) return st
    return { msgs, sessionViews, streaming: msgs.some((msg) => msg.streaming || msg.pendingWebui) }
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

// A receipt can arrive after the HTTP timeout or after the page unmounts.
// Resolve the retained snapshot in the shared store, not a page-local effect.
useChatStore.subscribe((state) => {
  if (!Object.values(useDraftStore.getState().submissions).some((item) => item.stageId)) return
  for (const message of state.msgs) {
    if (message.pendingWebuiId && !message.pendingWebui && message.streamId) {
      useDraftStore.getState().acceptSubmissionStage(message.pendingWebuiId)
    }
  }
})
