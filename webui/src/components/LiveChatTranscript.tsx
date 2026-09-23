import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ScheduledChat } from '@/api/types'
import { useChatStore, type ChatMsg } from '@/stores/chatStore'
import { formatDateTime } from '@/utils/formatTime'
import { readPageState, writePageState } from '@/utils/pageState'
import { lastProgrammaticScrollAt, markProgrammaticScroll } from '@/utils/programmaticScroll'
import { createRafScheduler } from '@/utils/rafScheduler'
import { focusChatScrollFromUtilityRail } from '@/utils/utilityRailFocus'
import { useChatPerformanceProbe } from '@/utils/useChatPerformanceProbe'
import { MessageBubble } from './MessageBubble'
import { VirtualMessageList, type VirtualMessageListHandle } from './VirtualMessageList'
import { Z_LAYERS } from '@/config/zLayers'

// A freshly launched UI lands on the latest turn (its user question at the
// top of the viewport); positions saved by a previous run are ignored. Route
// remounts within the same run still restore the saved reading position.
let freshLaunchPending = true

export interface LiveChatTranscriptHandle {
  /** Preserve the existing send behavior: a local submission follows the tail. */
  pinToBottom: () => void
}

interface LiveChatTranscriptProps {
  sessionId: string | null
  sessionError: string
  scheduledChats: readonly ScheduledChat[]
  scheduleNow: number
  onCancelSchedule: (task: ScheduledChat) => void
  onRewind: (streamId: string) => void
}

/**
 * Owns the high-frequency live projection and its viewport state. Chat chunks
 * update this leaf without re-rendering LiveChat's composer or page chrome.
 */
export const LiveChatTranscript = forwardRef<LiveChatTranscriptHandle, LiveChatTranscriptProps>(
  function LiveChatTranscript({
    sessionId,
    sessionError,
    scheduledChats,
    scheduleNow,
    onCancelSchedule,
    onRewind,
  }, forwardedRef) {
    const msgs = useChatStore((state) => state.msgs)
    const streaming = useChatStore((state) => state.streaming)
    const historyStatus = useChatStore((state) => state.historyStatus)
    const historyError = useChatStore((state) => state.historyError)
    const historyHasMore = useChatStore((state) => state.historyHasMore)
    const olderHistoryStatus = useChatStore((state) => state.olderHistoryStatus)
    const olderHistoryError = useChatStore((state) => state.olderHistoryError)
    const retryHistory = useChatStore((state) => state.retryHistory)
    const loadOlderHistory = useChatStore((state) => state.loadOlderHistory)
    const loadingAllHistory = useChatStore((state) => state.loadingAllHistory)
    const allHistoryLoadedItems = useChatStore((state) => state.allHistoryLoadedItems)
    const loadAllHistory = useChatStore((state) => state.loadAllHistory)

    // Smart auto-scroll state. Pin only while the user is already near the
    // bottom; otherwise retain their reading position and count new messages.
    const scrollRef = useRef<HTMLDivElement>(null)
    const [stuckBottom, setStuckBottom] = useState(true)
    const [unread, setUnread] = useState(0)
    const [activeTurn, setActiveTurn] = useState(-1)
    const [hoveredSchedule, setHoveredSchedule] = useState<{
      task: ScheduledChat
      top: number
      right: number
    } | null>(null)
    const navigationTargetRef = useRef<number | null>(null)
    const prependingHistoryRef = useRef(false)
    const virtualListRef = useRef<VirtualMessageListHandle>(null)

    // Reading-position persistence across route switches. The anchor is the
    // first visible message key, so restores survive estimate-vs-measured
    // height drift after remount.
    const scrollPositionsRef = useRef<Record<string, SavedScrollPosition>>(
      readPageState('liveChat.scrollPositions', {}),
    )
    const restoredSessionsRef = useRef<Set<string>>(new Set())
    // Genuine reader input (wheel / touch / pointer on the scroller) is the
    // only thing allowed to write the saved position; programmatic scrolling
    // (restore aim, pinning, measurement compensation) marks itself in the
    // shared provenance helper instead.
    const lastUserGestureAtRef = useRef(0)
    const restoreGestureMarkRef = useRef(0)
    const aimDeadlineRef = useRef(0)
    const msgsRef = useRef(msgs)
    msgsRef.current = msgs
    const capturePosition = useCallback(() => {
      const el = scrollRef.current
      // Detached DOM reads zeros and would overwrite a good saved position
      // with a bogus stuck=true entry during unmount cleanup.
      if (!sessionId || !el || !el.isConnected || msgs.length === 0) return
      // Session-switch race: the store swaps msgs (and its sessionId) to the
      // next session before this transcript's sessionId prop catches up.
      // Capturing in that window would persist the NEXT session's message
      // key under this session. getState() keeps the check race-free even
      // for leave-captures that run between renders.
      if (useChatStore.getState().sessionId !== sessionId) return
      // The remount commit runs recomputeStuck (and its capture) before the
      // one-shot restore effect scrolls back. Without this gate that early
      // capture clobbers the saved position with the initial (bottom) state.
      if (!restoredSessionsRef.current.has(sessionId)) return
      // Captures during programmatic motion (restore landing, measurement
      // correction, bottom pinning) would persist a position the reader
      // never chose. Only write when the last real gesture is newer than
      // the last programmatic scroll.
      const gestureAt = lastUserGestureAtRef.current
      if (gestureAt === 0 || lastProgrammaticScrollAt() > gestureAt) return
      const index = virtualListRef.current?.getFirstVisibleIndex(48) ?? 0
      const message = msgs[index]
      if (!message) return
      scrollPositionsRef.current[sessionId] = {
        key: chatMessageKey(message),
        stuck: el.scrollHeight - el.scrollTop - el.clientHeight < 80,
      }
      writePageState('liveChat.scrollPositions', trimScrollPositions(scrollPositionsRef.current))
    }, [msgs, sessionId])
    const capturePositionRef = useRef(capturePosition)
    capturePositionRef.current = capturePosition

    // Suppress bottom-pinning during hydration when the user left this
    // session mid-read, so the restore below is not fought by pinning.
    useEffect(() => {
      if (!sessionId) return
      const saved = scrollPositionsRef.current[sessionId]
      if (saved && !saved.stuck) setStuckBottom(false)
    }, [sessionId])

    // Persist the reading position when leaving a session (unmount or
    // in-place switch) and allow restoring it again on return.
    useEffect(() => {
      if (!sessionId) return
      return () => {
        capturePositionRef.current()
        restoredSessionsRef.current.delete(sessionId)
      }
    }, [sessionId])
    const turnCount = useMemo(
      () => msgs.reduce((count, message) => count + (message.role === 'user' ? 1 : 0), 0),
      [msgs],
    )
    const turnMessageIndexes = useMemo(
      () => msgs.flatMap((message, index) => message.role === 'user' ? [index] : []),
      [msgs],
    )
    const turnMessageIndexesRef = useRef<number[]>(turnMessageIndexes)
    turnMessageIndexesRef.current = turnMessageIndexes

    useChatPerformanceProbe({
      rootRef: scrollRef,
      sessionId,
      historyStatus,
      messages: msgs,
      streaming,
    })

    useImperativeHandle(forwardedRef, () => ({
      pinToBottom: () => {
        setStuckBottom(true)
        setUnread(0)
      },
    }), [])

    const recomputeStuck = () => {
      const el = scrollRef.current
      if (!el) return
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight
      const at = dist < 80
      setStuckBottom(at)
      if (at) setUnread(0)

      const turns = turnMessageIndexesRef.current
      if (turns.length === 0) {
        setActiveTurn(-1)
        return
      }
      const navigationTarget = navigationTargetRef.current
      if (navigationTarget !== null && navigationTarget < turns.length) {
        setActiveTurn((previous) => previous === navigationTarget ? previous : navigationTarget)
        return
      }

      let current = at ? turns.length - 1 : 0
      if (!at) {
        const firstVisibleIndex = virtualListRef.current?.getFirstVisibleIndex(48) ?? 0
        for (let index = 0; index < turns.length; index += 1) {
          if (turns[index] <= firstVisibleIndex) current = index
          else break
        }
      }
      setActiveTurn((previous) => previous === current ? previous : current)
      capturePosition()
    }

    useEffect(() => {
      const el = scrollRef.current
      if (!el) return
      recomputeStuck()
      const scrollScheduler = createRafScheduler(recomputeStuck)
      // Real input only: programmatic scrolls never fire these events, so
      // they are the trusted signal that re-arms position capturing.
      const onUserGesture = () => {
        navigationTargetRef.current = null
        lastUserGestureAtRef.current = performance.now()
      }
      el.addEventListener('scroll', scrollScheduler.schedule, { passive: true })
      el.addEventListener('wheel', onUserGesture, { passive: true })
      el.addEventListener('touchstart', onUserGesture, { passive: true })
      el.addEventListener('pointerdown', onUserGesture, { passive: true })
      return () => {
        scrollScheduler.cancel()
        el.removeEventListener('scroll', scrollScheduler.schedule)
        el.removeEventListener('wheel', onUserGesture)
        el.removeEventListener('touchstart', onUserGesture)
        el.removeEventListener('pointerdown', onUserGesture)
      }
    }, [msgs.length, sessionId])

    // Keep the existing prepend anchor and pinned-tail semantics synchronous
    // with layout so the user never sees a one-frame scroll jump.
    const lastLenRef = useRef(0)
    useLayoutEffect(() => {
      const el = scrollRef.current
      if (!el) return
      const grew = msgs.length > lastLenRef.current
      lastLenRef.current = msgs.length
      if (prependingHistoryRef.current) return
      if (stuckBottom) {
        markProgrammaticScroll()
        el.scrollTop = el.scrollHeight
      } else if (grew) {
        setUnread((count) => count + 1)
      }
    }, [msgs, stuckBottom])

    // Aim the viewport at the anchor row and make the landing stick. Row
    // heights above the anchor are still estimates on the first pass; once
    // their measured sizes land, the compensation in VirtualMessageList can
    // nudge the viewport off the anchor (a neighbour becomes first visible).
    // Re-aiming with the converged offsets is deterministic, so verify after
    // measurements settle and re-aim a bounded number of times. Stand down
    // immediately if the reader takes over with a real gesture.
    const aimAtAnchor = useCallback((anchorKey: string | null, fallbackIndex: number, attempt = 0) => {
      const list = virtualListRef.current
      if (!list) return
      const currentMsgs = msgsRef.current
      const index = anchorKey !== null
        ? currentMsgs.findIndex((message) => chatMessageKey(message) === anchorKey)
        : Math.max(0, Math.min(currentMsgs.length - 1, fallbackIndex))
      if (index < 0) return
      markProgrammaticScroll()
      list.scrollToIndex(index, { behavior: 'auto', align: 'start' })
      if (attempt >= 12) return
      const verify = () => {
        if (lastUserGestureAtRef.current !== restoreGestureMarkRef.current) return
        const first = virtualListRef.current?.getFirstVisibleIndex(48) ?? -1
        const firstMessage = currentMsgs[first]
        const anchored = anchorKey !== null
          && firstMessage !== undefined
          && chatMessageKey(firstMessage) === anchorKey
        const landed = anchorKey !== null ? anchored : first === index
        // A first-pass clamp into the "bottom" zone must not be trusted as
        // final: with estimated (unmeasured) row heights the target position
        // is still provisional, and accepting it would strand the viewport
        // at the real bottom once the offsets settle. Keep re-aiming with
        // the fresh offsets; the attempt budget above bounds the effort for
        // targets that genuinely bottom out.
        if (landed) {
          // Rows above the anchor can finish measuring after this verdict
          // (slow markdown/images) and push the anchor off the 48px line.
          // Keep re-checking on a sparse schedule until the settle horizon
          // passes; with settled offsets the re-aim is deterministic and
          // idempotent, so watching costs one no-op scroll at worst.
          if (anchorKey !== null && Date.now() < aimDeadlineRef.current && attempt < 12) {
            setTimeout(() => aimAtAnchor(anchorKey, fallbackIndex, attempt + 1), 250)
          }
          return
        }
        aimAtAnchor(anchorKey, fallbackIndex, attempt + 1)
      }
      // Early passes ride animation frames; later passes give slow rows
      // (markdown, attachments) a beat to measure before the final verdict.
      if (attempt < 3) {
        requestAnimationFrame(() => requestAnimationFrame(verify))
      } else {
        setTimeout(verify, 60)
      }
    }, [])

    // One-shot reading-position restore per hydrated session mount. Anchored
    // to the saved first-visible message key; falls back to default pinning.
    useEffect(() => {
      if (!sessionId || historyStatus === 'loading_history' || msgs.length === 0) return
      if (restoredSessionsRef.current.has(sessionId)) return
      restoredSessionsRef.current.add(sessionId)
      const saved = freshLaunchPending ? null : scrollPositionsRef.current[sessionId]
      freshLaunchPending = false
      restoreGestureMarkRef.current = lastUserGestureAtRef.current
      // Watch the landing until measurement has fully settled so late row
      // growth cannot silently shift the restored viewport off the anchor.
      aimDeadlineRef.current = Date.now() + 1500
      if (saved && !saved.stuck && saved.key) {
        const index = msgs.findIndex((message) => chatMessageKey(message) === saved.key)
        if (index >= 0) {
          aimAtAnchor(saved.key, index)
          setStuckBottom(false)
          return
        }
      }
      // Default landing: the latest turn, starting at its user question. A
      // short turn bottoms out and keeps the tail pinned; a long one leaves
      // the reader mid-turn with the question visible first.
      for (let index = msgs.length - 1; index >= 0; index -= 1) {
        if (msgs[index].role !== 'user') continue
        // Row heights are still estimated on the first pass; scrolling now
        // would clamp into the "pinned" zone near the estimated bottom and
        // measureRow would keep re-pinning to the real bottom. Wait two
        // frames so measurements settle, then land and judge pinning on
        // real metrics.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            aimAtAnchor(null, index)
            const el = scrollRef.current
            if (el) setStuckBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
          })
        })
        return
      }
    }, [sessionId, historyStatus, msgs])

    const handleLoadOlderHistory = useCallback(async () => {
      const el = scrollRef.current
      if (!el || olderHistoryStatus === 'loading') return
      const oldHeight = el.scrollHeight
      const oldTop = el.scrollTop
      prependingHistoryRef.current = true
      try {
        await loadOlderHistory()
      } finally {
        requestAnimationFrame(() => {
          const current = scrollRef.current
          if (current) {
            markProgrammaticScroll()
            current.scrollTop = oldTop + (current.scrollHeight - oldHeight)
          }
          prependingHistoryRef.current = false
        })
      }
    }, [loadOlderHistory, olderHistoryStatus])

    const handleLoadAllHistory = useCallback(async () => {
      const el = scrollRef.current
      if (!el || olderHistoryStatus === 'loading' || loadingAllHistory) return
      prependingHistoryRef.current = true
      // Pages keep prepending for the whole sweep; compensate the scrollTop
      // each frame by exactly how much the content grew, so the reader stays
      // anchored to the same message instead of chasing the new content.
      let lastHeight = el.scrollHeight
      let frame = requestAnimationFrame(function keepAnchor() {
        const current = scrollRef.current
        if (current) {
          const height = current.scrollHeight
          if (height > lastHeight) {
            markProgrammaticScroll()
            current.scrollTop += height - lastHeight
          }
          lastHeight = height
        }
        frame = requestAnimationFrame(keepAnchor)
      })
      try {
        await loadAllHistory()
      } finally {
        cancelAnimationFrame(frame)
        prependingHistoryRef.current = false
      }
    }, [loadAllHistory, olderHistoryStatus, loadingAllHistory])

    const jumpToBottom = () => {
      const el = scrollRef.current
      if (!el) return
      const lastTurn = turnCount - 1
      navigationTargetRef.current = lastTurn >= 0 ? lastTurn : null
      if (lastTurn >= 0) setActiveTurn(lastTurn)
      markProgrammaticScroll()
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
      setUnread(0)
    }

    const jumpToTurn = (direction: -1 | 1) => {
      const el = scrollRef.current
      if (!el || turnCount === 0) return
      const current = activeTurn < 0 ? (stuckBottom ? turnCount - 1 : 0) : activeTurn
      const next = Math.max(0, Math.min(turnCount - 1, current + direction))
      if (next === current) return
      navigationTargetRef.current = next
      setActiveTurn(next)
      const targetIndex = turnMessageIndexesRef.current[next]
      if (targetIndex == null) return
      virtualListRef.current?.scrollToIndex(targetIndex, { behavior: 'smooth', align: 'start' })
    }

    const renderChatMessage = useCallback((message: ChatMsg, index: number) => {
      // system 消息（/btw 回答 role='system'；GA-Hub 通知 source='system'；
      // 自动重试状态 source='chat_error_retry_notice'）保留 system 角色：
      // 琥珀气泡 + "system" 头行，正文不再被塞来源前缀。
      const isSystemBubble = message.role === 'system'
        || message.source === 'system'
        || message.source === 'chat_error_retry_notice'
        || message.source === 'runtime_error_notice'
      const role = (isSystemBubble ? 'system' : message.role) as 'user' | 'assistant' | 'system'
      const tag = !isSystemBubble
        && message.source
        && message.source !== 'webui'
        && message.source !== 'user'
        && message.source !== 'history'
        ? sourceLabel(message.source)
        : undefined
      return (
        <div
          {...(message.role === 'user' ? { 'data-chat-turn': true } : {})}
          style={message.source === 'history'
            ? { contentVisibility: 'auto', containIntrinsicSize: 'auto 120px' }
            : undefined}
        >
          <MessageBubble
            role={role}
            recoveryNotice={message.recoveryNotice}
            content={message.content}
            streaming={message.streaming}
            stopped={role === 'assistant' ? (message.stopped ?? false) : undefined}
            tagLabel={tag}
            timestamp={message.timestamp}
            startedAt={message.startedAt}
            finishedAt={message.finishedAt}
            attachments={message.attachments}
            streamId={role === 'assistant' ? message.streamId : undefined}
            onRewind={role === 'assistant' ? onRewind : undefined}
            askUserDraftKey={sessionId ? `liveChat:${sessionId}` : undefined}
            askUserInteractive={index === msgs.length - 1}
          />
        </div>
      )
    }, [onRewind, sessionId, msgs.length])

    return (
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          data-live-chat-scroll
          tabIndex={-1}
          className="relative min-w-0 flex-1 overflow-x-hidden overflow-y-auto py-4 pl-4 pr-[76px] outline-none [overflow-anchor:none] md:pl-10"
        >
          {historyStatus === 'history_error' && (
            <div className="sticky top-0 z-10 mx-auto flex w-fit max-w-full items-center gap-3 rounded-lg border border-status-danger-line bg-status-danger-soft px-3 py-2 text-sm text-status-danger shadow-sm">
              <span>历史消息加载失败：{historyError || '未知错误'}。实时消息仍可继续接收。</span>
              <button type="button" className="ga-btn shrink-0" onClick={retryHistory}>重试</button>
            </div>
          )}
          {historyStatus === 'ready' && (historyHasMore || olderHistoryStatus === 'error') && (
            <div className="flex flex-col items-center gap-1 pb-2">
              <div className="flex flex-wrap items-center justify-center gap-2">
                <button
                  type="button"
                  className="ga-btn"
                  disabled={olderHistoryStatus === 'loading' || loadingAllHistory}
                  onClick={() => { void handleLoadOlderHistory() }}
                >
                  {olderHistoryStatus === 'loading' ? '正在加载更早消息…' : '加载更早消息'}
                </button>
                <button
                  type="button"
                  className="ga-btn"
                  disabled={olderHistoryStatus === 'loading' || loadingAllHistory}
                  onClick={() => { void handleLoadAllHistory() }}
                  title="从最新一页开始连续加载，直到会话最早一条消息"
                >
                  {loadingAllHistory ? `正在加载全部历史…（已加载 ${allHistoryLoadedItems} 条）` : '加载全部历史'}
                </button>
              </div>
              {olderHistoryStatus === 'error' && (
                <span className="text-xs text-status-danger">{olderHistoryError || '加载失败，请重试'}</span>
              )}
            </div>
          )}
          {sessionError && msgs.length === 0 && (
            <div className="flex h-full items-center justify-center text-sm text-status-danger">会话初始化失败：{sessionError}</div>
          )}
          {!sessionError && historyStatus === 'loading_history' && msgs.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-ink-faint">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-600 border-t-accent" />
              <div>正在恢复历史对话…</div>
            </div>
          )}
          {historyStatus !== 'loading_history' && msgs.length === 0 && (
            <div className="flex h-full items-center justify-center text-sm text-ink-faint">
              开始一段对话，或粘贴一张图问个问题。
            </div>
          )}
          <VirtualMessageList
            ref={virtualListRef}
            items={msgs}
            scrollRef={scrollRef}
            pinnedToBottom={stuckBottom}
            itemKey={chatMessageKey}
            estimateSize={estimateChatMessageSize}
            renderItem={renderChatMessage}
          />
        </div>

        {(scheduledChats.length > 0 || turnCount > 0) && (
          <aside
            className="absolute inset-y-3 right-2 z-10 flex w-14 flex-col gap-2"
            aria-label="对话功能区"
            onPointerDown={(event) => focusChatScrollFromUtilityRail(event, scrollRef.current)}
          >
            {scheduledChats.length > 0 && (
              <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto overscroll-contain pr-0.5" aria-label="待发送定时消息">
                {scheduledChats.map((task) => (
                  <button
                    key={task.id}
                    type="button"
                    onClick={() => onCancelSchedule(task)}
                    onMouseEnter={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect()
                      setHoveredSchedule({ task, top: rect.top, right: window.innerWidth - rect.left + 10 })
                    }}
                    onMouseLeave={() => setHoveredSchedule(null)}
                    onFocus={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect()
                      setHoveredSchedule({ task, top: rect.top, right: window.innerWidth - rect.left + 10 })
                    }}
                    onBlur={() => setHoveredSchedule(null)}
                    className="group relative flex aspect-square w-full shrink-0 items-center justify-center overflow-hidden rounded-lg p-[2px] text-center text-xs font-semibold leading-tight text-accent shadow-sm transition-transform hover:scale-[1.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                    title="点击取消定时发送"
                    aria-label={`${formatCompactScheduleCountdown(task.scheduled_for, scheduleNow)}后发送；悬停查看消息；点击取消`}
                  >
                    <span
                      data-schedule-flow-border
                      aria-hidden="true"
                      className="absolute -inset-5 animate-spin bg-[conic-gradient(from_0deg,transparent_0deg,transparent_205deg,#60a5fa_245deg,#a78bfa_285deg,#f472b6_325deg,transparent_360deg)] motion-reduce:animate-none"
                      style={{ animationDuration: '3s' }}
                    />
                    <span className="relative flex h-full w-full items-center justify-center rounded-[6px] bg-bg-card/95 px-1 backdrop-blur transition-colors group-hover:bg-bg-soft">
                      {formatCompactScheduleCountdown(task.scheduled_for, scheduleNow)}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {/* 底部导航组：仅在离开底部时渲染，保证 上节/下节 在可见期间
                屏幕位置恒定（底部按钮置于其上方，不随 stuckBottom 翻转挤动），
                到达最底后整组隐藏，避免角落误触。 */}
            {turnCount > 0 && !stuckBottom && (
              <div className="mt-auto flex shrink-0 flex-col gap-1.5 text-xs text-ink">
                <button
                  onClick={jumpToBottom}
                  className="min-h-9 rounded-lg border border-line bg-bg-soft/95 px-1 py-1 leading-tight shadow-md backdrop-blur hover:bg-bg-card"
                  title={unread > 0 ? `${unread} 条新消息，跳到最新` : '跳到最新消息'}
                >
                  ↓ {unread > 0 ? unread : '底部'}
                </button>
                <button
                  onClick={() => jumpToTurn(-1)}
                  disabled={activeTurn <= 0}
                  className="h-9 rounded-lg border border-line bg-bg-soft/95 px-1 shadow-md backdrop-blur hover:bg-bg-card disabled:cursor-not-allowed disabled:opacity-35"
                  title="定位到上一轮问答"
                >
                  ↑ 上节
                </button>
                <button
                  onClick={() => jumpToTurn(1)}
                  disabled={activeTurn < 0 || activeTurn >= turnCount - 1}
                  className="h-9 rounded-lg border border-line bg-bg-soft/95 px-1 shadow-md backdrop-blur hover:bg-bg-card disabled:cursor-not-allowed disabled:opacity-35"
                  title="定位到下一轮问答"
                >
                  ↓ 下节
                </button>
              </div>
            )}
          </aside>
        )}

        {hoveredSchedule && scheduledChats.some((task) => task.id === hoveredSchedule.task.id) && (
          <div
            data-schedule-tooltip
            role="tooltip"
            className="pointer-events-none fixed w-72 -translate-y-1 rounded-xl border border-line bg-bg-card/98 p-3 text-left shadow-xl backdrop-blur"
            style={{ top: Math.max(12, hoveredSchedule.top), right: hoveredSchedule.right, zIndex: Z_LAYERS.tooltip }}
          >
            <div className="mb-2 flex items-center justify-between gap-3 text-xs text-text-muted">
              <span>定时发送内容</span>
              <time>{formatDateTime(hoveredSchedule.task.scheduled_for)}</time>
            </div>
            <p className="max-h-48 overflow-hidden whitespace-pre-wrap break-words text-sm leading-5 text-text">
              {hoveredSchedule.task.text || '（仅附件）'}
            </p>
            {hoveredSchedule.task.images.length > 0 && (
              <div className="mt-2 text-xs text-text-muted">附件 {hoveredSchedule.task.images.length} 个</div>
            )}
          </div>
        )}
      </div>
    )
  },
)

interface SavedScrollPosition {
  key: string
  stuck: boolean
}

function trimScrollPositions(
  positions: Record<string, SavedScrollPosition>,
  limit = 40,
): Record<string, SavedScrollPosition> {
  const entries = Object.entries(positions)
  if (entries.length <= limit) return positions
  return Object.fromEntries(entries.slice(entries.length - limit))
}

function chatMessageKey(message: ChatMsg): string {
  const identity = message.streamId || message.pendingWebuiId
  if (identity) return `${message.role}:${identity}`
  const source = `${message.role}|${message.source ?? ''}|${message.timestamp ?? ''}|${message.content.length}|${message.content.slice(0, 256)}|${message.content.slice(-256)}`
  let hash = 2_166_136_261
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    hash ^= source.charCodeAt(cursor)
    hash = Math.imul(hash, 16_777_619)
  }
  return `${message.role}:local:${(hash >>> 0).toString(36)}`
}

function estimateChatMessageSize(message: ChatMsg): number {
  const content = message.content || ''
  const lineCount = content.split('\n').length + Math.ceil(content.length / 90)
  const base = message.role === 'user' ? 52 : 94
  const lineHeight = message.role === 'user' ? 24 : 22
  const attachmentExtra = message.attachments?.length ? 120 : 0
  return Math.min(820, base + Math.min(28, lineCount) * lineHeight + attachmentExtra + 8)
}

function formatCompactScheduleCountdown(scheduledFor: number, now: number): string {
  const minutes = Math.max(0, Math.ceil((scheduledFor * 1000 - now) / 60_000))
  if (minutes < 60) return `${minutes}分`
  const hours = minutes / 60
  if (hours < 24) return `${Number(hours.toFixed(1))}时`
  const days = hours / 24
  return `${Number(days.toFixed(1))}天`
}

function sourceLabel(source: string): string {
  switch (source) {
    case 'autonomous':
    case 'reflect':
      return '🤖 [自主进化触发]'
    case 'feishu':
      return '🪽 [飞书]'
    case 'wechat':
      return '💬 [微信]'
    case 'task':
      return '📋 [任务模式]'
    case 'scheduled_task':
      return '⏰ [定时任务]'
    case 'auto_continue':
      return '🔁 [自动继续]'
    case 'chat_error_retry':
    case 'chat_error_retry_notice':
      return '[自动重试]'
    default:
      return `[${source}]`
  }
}
