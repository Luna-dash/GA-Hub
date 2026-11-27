import { ChatUtilityDock, TranscriptUtilityRail, chatTranscriptClass } from './ChatLayout'
import type { FileTransferBoxProps } from './FileTransferBox'
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { ScheduleClockFace, scheduleClockButtonClass } from './ScheduleClockFace'
import type { ScheduledChat } from '@/api/types'
import { useChatStore, type ChatMsg } from '@/stores/chatStore'
import { formatDateTime } from '@/utils/formatTime'
import { useTranscriptViewport } from '@/hooks/useTranscriptViewport'
import { focusChatScrollFromUtilityRail } from '@/utils/utilityRailFocus'
import { useChatPerformanceProbe } from '@/utils/useChatPerformanceProbe'
import { MessageBubble } from './MessageBubble'
import { ConversationCollapseProvider, ConversationCollapseControl } from './ConversationCollapse'
import { ConversationTurnMinimap } from './ConversationTurnMinimap'
import { TranscriptNavDock } from './TranscriptNavDock'
import { VirtualMessageList, type VirtualMessageListHandle } from './VirtualMessageList'
import { Z_LAYERS } from '@/config/zLayers'

// Degraded-landing escape for the projection barrier: if replay_done never
// arrives (e.g. the transport is down and the managed socket keeps retrying),
// declare the barrier failed after this grace period and land with the
// cached view instead of stranding the reader at the top.
const PROJECTION_FAILURE_GRACE_MS = 4000

export interface LiveChatTranscriptHandle {
  /** Preserve the existing send behavior: a local submission follows the tail. */
  pinToBottom: () => void
}

interface LiveChatTranscriptProps {
  sessionId: string | null
  sessionError: string
  fileTransfer?: FileTransferBoxProps
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
    fileTransfer,
    scheduledChats,
    scheduleNow,
    onCancelSchedule,
    onRewind,
  }, forwardedRef) {
    const msgs = useChatStore((state) => state.msgs)
    const streaming = useChatStore((state) => state.streaming)
    const resumePolicy = useChatStore((state) => state.resumePolicy)
    const projectionReady = useChatStore((state) => state.projectionReady)
    const historyStatus = useChatStore((state) => state.historyStatus)
    const historyError = useChatStore((state) => state.historyError)
    const historyHasMore = useChatStore((state) => state.historyHasMore)
    const olderHistoryStatus = useChatStore((state) => state.olderHistoryStatus)
    const olderHistoryError = useChatStore((state) => state.olderHistoryError)
    const retryHistory = useChatStore((state) => state.retryHistory)
    const loadOlderHistory = useChatStore((state) => state.loadOlderHistory)
    const loadingAllHistory = useChatStore((state) => state.loadingAllHistory)
    const allHistoryLoadedItems = useChatStore((state) => state.allHistoryLoadedItems)
    const allHistoryNotice = useChatStore((state) => state.allHistoryNotice)
    const loadAllHistory = useChatStore((state) => state.loadAllHistory)

    // Smart auto-scroll state. Pin only while the user is already near the
    // bottom; otherwise retain their reading position and count new messages.
    const utilityRailRef = useRef<HTMLElement>(null)
    const scrollRef = useRef<HTMLDivElement>(null)
    const [hoveredSchedule, setHoveredSchedule] = useState<{
      task: ScheduledChat
      top: number
      right: number
    } | null>(null)
    const prependingHistoryRef = useRef(false)
    const virtualListRef = useRef<VirtualMessageListHandle>(null)

    const turnCount = useMemo(
      () => msgs.reduce((count, message) => count + (message.role === 'user' ? 1 : 0), 0),
      [msgs],
    )
    const turnMessageIndexes = useMemo(
      () => msgs.flatMap((message, index) => message.role === 'user' ? [index] : []),
      [msgs],
    )
    const minimapTurns = useMemo(
      () => turnMessageIndexes.map((msgIdx, idx) => {
        const msg = msgs[msgIdx]
        const raw = (msg?.content || '').replace(/\s+/g, ' ').trim()
        const snippet = raw.length > 120 ? `${raw.slice(0, 119)}…` : raw
        return {
          id: msg ? chatMessageKey(msg) : `turn-${idx}`,
          index: idx + 1,
          label: snippet || (msg?.attachments?.length ? '（图片或附件消息）' : `第 ${idx + 1} 轮`),
        }
      }),
      [msgs, turnMessageIndexes],
    )

    useChatPerformanceProbe({
      rootRef: scrollRef,
      sessionId,
      historyStatus,
      messages: msgs,
      streaming,
    })

    // Final landing is gated by the projection barrier: cached messages may
    // render, but a running session waits for replay before following latest.
    // Escape hatch: when the barrier never resolves within the grace period
    // (e.g. the transport is down), land with the cached view instead of
    // stranding the reader at the top; a late replay_done keeps that landing
    // (pinning follows live growth, restores keep their anchor).
    const [projectionFailed, setProjectionFailed] = useState(false)
    useEffect(() => {
      setProjectionFailed(false)
      if (!sessionId || projectionReady || historyStatus === 'loading_history') return
      const timer = window.setTimeout(() => setProjectionFailed(true), PROJECTION_FAILURE_GRACE_MS)
      return () => window.clearTimeout(timer)
    }, [sessionId, projectionReady, historyStatus])

    const hasUtilityRail = scheduledChats.length > 0 || turnCount > 0
    const {
      stuckBottom,
      unread,
      activeTurn,
      jumpToBottom,
      collapseToLatest,
      jumpToTurnIndex,
      jumpToTurn,
      followTail,
      invalidateLanding,
    } = useTranscriptViewport({
      sessionId,
      storageKey: 'liveChat.scrollPositions',
      scrollRef,
      utilityRailRef,
      hasUtilityRail,
      resumePolicy,
      hydration: projectionReady
        ? 'ready'
        : (historyStatus === 'loading_history'
          ? 'loading-history'
          : (projectionFailed ? 'failed' : 'replaying')),
      contentRevision: msgs,
      unreadTotalCount: msgs.length,
      unreadMode: 'increment',
      ignoreSavedOnFreshLaunch: true,
      suppressTailFollowRef: prependingHistoryRef,
      recomputeDeps: [turnCount, scheduledChats.length],
      adapter: {
        itemCount: msgs.length,
        getItemKey: (index) => (msgs[index] ? chatMessageKey(msgs[index]) : ''),
        findIndexByKey: (key) => msgs.findIndex((message) => chatMessageKey(message) === key),
        turnItemIndexes: turnMessageIndexes,
        openLatestItemIndex: turnMessageIndexes.at(-1),
        getFirstVisibleIndex: (offsetPx = 48) => virtualListRef.current?.getFirstVisibleIndex(offsetPx) ?? 0,
        scrollToItem: (index, options) => virtualListRef.current?.scrollToIndex(index, options),
        hasPrependAnchor: () => virtualListRef.current?.hasPrependAnchor() ?? false,
        releasePrependAnchor: () => virtualListRef.current?.releasePrependAnchor(),
        isSessionCurrent: () => Boolean(sessionId && useChatStore.getState().sessionId === sessionId),
        onReadingStateChange: (reading) => {
          if (sessionId) useChatStore.getState().setReadingOlderHistory(sessionId, reading)
        },
      },
    })

    useImperativeHandle(forwardedRef, () => ({
      pinToBottom: followTail,
    }), [followTail])

    const captureHistoryAnchor = useCallback(() => {
      prependingHistoryRef.current = true
      if (virtualListRef.current?.prepareForPrepend()) {
        // Do not let a pending initial landing override the reader’s anchor.
        invalidateLanding()
      }
    }, [invalidateLanding])

    const handleLoadOlderHistory = () => loadOlderHistory(captureHistoryAnchor)
    const handleLoadAllHistory = () => loadAllHistory(captureHistoryAnchor)

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
        <div {...(message.role === 'user' ? { 'data-chat-turn': true } : {})}>
          <MessageBubble
            role={role}
            recoveryNotice={message.recoveryNotice}
            recoveryOffset={message.recoveryOffset}
            content={message.content}
            turnSegments={message.turnSegments}
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
      <ConversationCollapseProvider key={sessionId} onAfterCollapse={collapseToLatest}>
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          data-live-chat-scroll
          data-chat-scope
          tabIndex={-1}
          className={chatTranscriptClass}
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
                  title="加载完整历史消息"
                >
                  {loadingAllHistory ? `正在加载全部历史…（已加载 ${allHistoryLoadedItems} 条）` : '加载全部历史'}
                </button>
              </div>
              {allHistoryNotice && <span role="status" className="text-xs text-ink-muted">{allHistoryNotice}</span>}
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
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-line border-t-accent" />
              <div>正在恢复历史对话…</div>
            </div>
          )}
          {!sessionError && historyStatus !== 'loading_history' && msgs.length === 0 && (
            <div className="flex h-full items-center justify-center text-sm text-ink-faint">
              开始一段对话，或粘贴一张图问个问题。
            </div>
          )}
          <VirtualMessageList
            key={sessionId}
            ref={virtualListRef}
            items={msgs}
            scrollRef={scrollRef}
            pinnedToBottom={stuckBottom}
            itemKey={chatMessageKey}
            estimateSize={estimateChatMessageSize}
            renderItem={renderChatMessage}
          />
        </div>

        <ConversationCollapseControl />
        <ChatUtilityDock fileTransfer={fileTransfer}>
          {(scheduledChats.length > 0 || turnCount > 0) && (
            <TranscriptUtilityRail
              railRef={utilityRailRef}
              onPointerDown={(event) => focusChatScrollFromUtilityRail(event, scrollRef.current)}
              topSlot={scheduledChats.length > 0 ? (
                <div data-chat-wheel-independent className="min-h-0 max-h-[42%] w-full space-y-1.5 overflow-y-auto overscroll-contain pr-0.5" aria-label="待发送定时消息">
                  {scheduledChats.map((task) => {
                    const countdown = formatCompactScheduleCountdown(task.scheduled_for, scheduleNow)
                    return (
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
                        className={`${scheduleClockButtonClass} block aspect-square w-full text-accent transition-[background-color,transform] hover:scale-[1.03]`}
                        title="点击取消定时发送"
                        aria-label={`${countdown}后发送；悬停查看消息；点击取消`}
                      >
                        <ScheduleClockFace pending />
                        <span aria-hidden="true" className="absolute inset-x-0 bottom-[17%] whitespace-nowrap text-center text-xs font-semibold leading-none tabular-nums text-ink">
                          {countdown}
                        </span>
                      </button>
                    )
                  })}
                </div>
              ) : undefined}
              minimap={turnCount > 1 ? (
                <ConversationTurnMinimap
                  items={minimapTurns}
                  activeIndex={activeTurn >= 0 ? activeTurn : (stuckBottom ? Math.max(0, turnCount - 1) : 0)}
                  onSelect={jumpToTurnIndex}
                />
              ) : null}
              navDock={turnCount > 0 ? (
                <TranscriptNavDock
                  stuckBottom={stuckBottom}
                  canPrev={activeTurn > 0}
                  canNext={activeTurn >= 0 && activeTurn < turnCount - 1}
                  unread={unread}
                  onJumpToBottom={jumpToBottom}
                  onPrev={() => jumpToTurn(-1)}
                  onNext={() => jumpToTurn(1)}
                />
              ) : null}
            />
          )}
        </ChatUtilityDock>

        {hoveredSchedule && scheduledChats.some((task) => task.id === hoveredSchedule.task.id) && (
          <div
            data-schedule-tooltip
            role="tooltip"
            className="pointer-events-none fixed w-72 -translate-y-1 rounded-xl border border-line bg-bg-card/95 p-3 text-left shadow-xl backdrop-blur"
            style={{ top: Math.max(12, hoveredSchedule.top), right: hoveredSchedule.right, zIndex: Z_LAYERS.tooltip }}
          >
            <div className="mb-2 flex items-center justify-between gap-3 text-xs text-ink-muted">
              <span>{formatCompactScheduleCountdown(hoveredSchedule.task.scheduled_for, scheduleNow)}后发送</span>
              <time>{formatDateTime(hoveredSchedule.task.scheduled_for)}</time>
            </div>
            <p className="max-h-48 overflow-hidden whitespace-pre-wrap break-words text-sm leading-5 text-ink">
              {hoveredSchedule.task.text || '（仅附件）'}
            </p>
            {hoveredSchedule.task.images.length > 0 && (
              <div className="mt-2 text-xs text-ink-muted">附件 {hoveredSchedule.task.images.length} 个</div>
            )}
          </div>
        )}
      </div>
      </ConversationCollapseProvider>
    )
  },
)

function chatMessageKey(message: ChatMsg): string {
  const identity = message.streamId || message.pendingWebuiId
  if (identity) return `${message.runId || "legacy"}:${message.role}:${identity}`
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
  if (message.role === 'user') {
    return Math.min(248, base + Math.min(8, lineCount) * lineHeight + attachmentExtra + 8)
  }
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
