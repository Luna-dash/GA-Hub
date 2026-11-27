import {
  type MutableRefObject,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { routeChatWheel } from '@/utils/chatWheel'
import {
  decideViewportAction,
  type ViewportHydrationPhase,
  type ViewportResumePolicy,
} from '@/utils/conversationViewport'
import { readPageState, writePageState } from '@/utils/pageState'
import { lastProgrammaticScrollAt, markProgrammaticScroll } from '@/utils/programmaticScroll'
import { createRafScheduler } from '@/utils/rafScheduler'
import {
  didGrowWhilePinnedAtBottom,
  isBottomClamped,
  isNearBottom,
  JUMP_TO_BOTTOM_LOCK_MS,
  normalizeSavedScrollPosition,
  resolveActiveTurnIndex,
  RESTORE_RECHECK_HORIZON_MS,
  type SavedScrollPosition,
  type ScrollSnapshot,
  trimScrollPositions,
  TURN_NAV_LOCK_MS,
} from '@/utils/transcriptViewport'

// Fresh app launches land on the latest turn once; positions persisted from a
// prior run are ignored for that initial landing, while intra-run switches
// restore each session's saved anchor.
const freshLaunchPendingScopes = new Set<string>(['liveChat.scrollPositions'])

export interface TranscriptViewportAdapter {
  itemCount: number
  getItemKey: (index: number) => string
  findIndexByKey: (key: string) => number
  turnItemIndexes: ReadonlyArray<number>
  /** Target item index when landing in `'open-latest'` mode (defaults to last item). */
  openLatestItemIndex?: number
  getFirstVisibleIndex: (offsetPx?: number) => number
  scrollToItem: (index: number, options: { behavior: ScrollBehavior; align: 'start' | 'end' }) => void
  hasPrependAnchor?: () => boolean
  releasePrependAnchor?: () => void
  /** Guard async landing/capture against stale session closures. */
  isSessionCurrent?: () => boolean
  onReadingStateChange?: (readingOlderHistory: boolean) => void
}

export interface UseTranscriptViewportOptions {
  sessionId: string | null
  storageKey: string
  scrollRef: RefObject<HTMLDivElement>
  utilityRailRef: RefObject<HTMLElement>
  hasUtilityRail: boolean
  resumePolicy: ViewportResumePolicy
  hydration: ViewportHydrationPhase
  /** Token whose reference/value change triggers tail-follow when pinned. */
  contentRevision: unknown
  /** Logical item/turn count used to track unread additions while unpinned. */
  unreadTotalCount: number
  /** How unread increments when `unreadTotalCount` advances while unpinned. */
  unreadMode?: 'delta' | 'increment'
  ignoreSavedOnFreshLaunch?: boolean
  /** Virtualized scrollers wait 2 animation frames for measured heights before bottom landing; native DOM scrollers can land synchronously. */
  deferInitialLanding?: boolean
  suppressTailFollowRef?: MutableRefObject<boolean>
  recomputeDeps?: ReadonlyArray<unknown>
  adapter: TranscriptViewportAdapter
}

export interface TranscriptViewportController {
  stuckBottom: boolean
  stuckBottomRef: MutableRefObject<boolean>
  unread: number
  activeTurn: number
  jumpToBottom: () => void
  collapseToLatest: () => void
  jumpToTurnIndex: (turnIndex: number) => void
  jumpToTurn: (direction: -1 | 1) => void
  followTail: () => void
  pinScrollToBottom: () => void
  invalidateLanding: () => void
}

/**
 * Unified viewport state machine shared by Chat and Agy transcripts.
 *
 * Coordinates initial hydration landing, key-based anchor persistence,
 * height-growth bottom protection, turn navigation locks, and wheel/keyboard
 * user-gesture provenance without scattered per-page patches.
 */
export function useTranscriptViewport({
  sessionId,
  storageKey,
  scrollRef,
  utilityRailRef,
  hasUtilityRail,
  resumePolicy,
  hydration,
  contentRevision,
  unreadTotalCount,
  unreadMode = 'increment',
  ignoreSavedOnFreshLaunch = false,
  deferInitialLanding = true,
  suppressTailFollowRef,
  recomputeDeps = [],
  adapter,
}: UseTranscriptViewportOptions): TranscriptViewportController {
  const [stuckBottom, setStuckBottom] = useState(true)
  const stuckBottomRef = useRef(true)
  const [unread, setUnread] = useState(0)
  const [activeTurn, setActiveTurn] = useState(-1)
  const activeTurnRef = useRef(-1)

  const navigationTargetRef = useRef<number | null>(null)
  const navigationLockUntilRef = useRef(0)
  const jumpingToBottomUntilRef = useRef(0)
  const initialLandingPendingRef = useRef(false)
  const lastObservedScrollRef = useRef<ScrollSnapshot>({ top: 0, height: 0, clientHeight: 0 })
  const lastUserGestureAtRef = useRef(0)
  const viewportIntentVersionRef = useRef(0)
  const aimDeadlineRef = useRef(0)
  const restoredSessionsRef = useRef<Set<string>>(new Set())
  const seenUnreadTotalRef = useRef(0)

  const scrollPositionsRef = useRef<Record<string, SavedScrollPosition>>(
    readPageState(storageKey, {}),
  )

  const adapterRef = useRef(adapter)
  adapterRef.current = adapter

  const setStuckState = useCallback((next: boolean) => {
    stuckBottomRef.current = next
    setStuckBottom(next)
  }, [])

  const updateActiveTurn = useCallback((next: number) => {
    activeTurnRef.current = next
    setActiveTurn((previous) => (previous === next ? previous : next))
  }, [])

  const recordScrollSnapshot = useCallback((el: HTMLDivElement) => {
    lastObservedScrollRef.current = {
      top: el.scrollTop,
      height: el.scrollHeight,
      clientHeight: el.clientHeight,
    }
  }, [])

  const isCurrentSession = useCallback((expectedSessionId: string | null): boolean => {
    if (!expectedSessionId) return false
    const guard = adapterRef.current.isSessionCurrent
    return guard ? guard() : true
  }, [])

  const capturePosition = useCallback((knownFirstVisible?: number) => {
    const el = scrollRef.current
    const currentAdapter = adapterRef.current
    if (!sessionId || !el || !el.isConnected || currentAdapter.itemCount === 0) return
    if (!isCurrentSession(sessionId)) return
    if (!restoredSessionsRef.current.has(sessionId)) return
    const gestureAt = lastUserGestureAtRef.current
    if (gestureAt === 0 || lastProgrammaticScrollAt() > gestureAt) return
    const index = knownFirstVisible ?? currentAdapter.getFirstVisibleIndex(48)
    const nextKey = currentAdapter.getItemKey(index)
    if (!nextKey) return
    const nextStuck = isNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight)
    const previous = normalizeSavedScrollPosition(scrollPositionsRef.current[sessionId])
    if (previous?.key === nextKey && previous?.stuck === nextStuck) return
    scrollPositionsRef.current[sessionId] = { key: nextKey, stuck: nextStuck }
    writePageState(storageKey, trimScrollPositions(scrollPositionsRef.current))
  }, [isCurrentSession, scrollRef, sessionId, storageKey])

  const capturePositionRef = useRef(capturePosition)
  capturePositionRef.current = capturePosition

  const commitNavigation = useCallback((index: number, stuck: boolean) => {
    if (!sessionId || !isCurrentSession(sessionId)) return
    const currentAdapter = adapterRef.current
    viewportIntentVersionRef.current += 1
    currentAdapter.releasePrependAnchor?.()
    initialLandingPendingRef.current = false
    lastUserGestureAtRef.current = 0
    restoredSessionsRef.current.add(sessionId)
    freshLaunchPendingScopes.delete(storageKey)
    const el = scrollRef.current
    if (el) recordScrollSnapshot(el)
    const key = index >= 0 && index < currentAdapter.itemCount ? currentAdapter.getItemKey(index) : ''
    scrollPositionsRef.current[sessionId] = { key, stuck }
    writePageState(storageKey, trimScrollPositions(scrollPositionsRef.current))
    currentAdapter.onReadingStateChange?.(!stuck)
    setStuckState(stuck)
    setUnread(0)
    if (stuck) seenUnreadTotalRef.current = unreadTotalCount
  }, [isCurrentSession, recordScrollSnapshot, scrollRef, sessionId, setStuckState, storageKey, unreadTotalCount])

  const followTail = useCallback(() => {
    commitNavigation(adapterRef.current.itemCount - 1, true)
  }, [commitNavigation])

  const pinScrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el || !stuckBottomRef.current) return
    markProgrammaticScroll()
    el.scrollTop = el.scrollHeight
    recordScrollSnapshot(el)
  }, [recordScrollSnapshot, scrollRef])

  const invalidateLanding = useCallback(() => {
    viewportIntentVersionRef.current += 1
    initialLandingPendingRef.current = false
  }, [])

  // Suppress tail-pinning during hydration when the user left this session mid-read.
  useEffect(() => {
    if (!sessionId) return
    const saved = normalizeSavedScrollPosition(scrollPositionsRef.current[sessionId])
    if (saved && !saved.stuck) setStuckState(false)
  }, [sessionId, setStuckState])

  // Persist reading position on leave/switch and clear session-scoped flags.
  useEffect(() => {
    if (!sessionId) return
    return () => {
      capturePositionRef.current()
      viewportIntentVersionRef.current += 1
      initialLandingPendingRef.current = false
      lastObservedScrollRef.current = { top: 0, height: 0, clientHeight: 0 }
      restoredSessionsRef.current.delete(sessionId)
    }
  }, [sessionId])

  const recompute = useCallback(() => {
    const el = scrollRef.current
    if (!el || initialLandingPendingRef.current) return
    const currentAdapter = adapterRef.current
    const now = performance.now()
    const nextSnapshot: ScrollSnapshot = {
      top: el.scrollTop,
      height: el.scrollHeight,
      clientHeight: el.clientHeight,
    }
    const prevSnapshot = lastObservedScrollRef.current
    const grewAtBottom = didGrowWhilePinnedAtBottom(prevSnapshot, nextSnapshot)
    lastObservedScrollRef.current = nextSnapshot
    const at = isNearBottom(nextSnapshot.top, nextSnapshot.height, nextSnapshot.clientHeight)

    if (jumpingToBottomUntilRef.current > now) {
      if (!at) {
        markProgrammaticScroll()
        el.scrollTop = el.scrollHeight
        recordScrollSnapshot(el)
      }
      return
    }
    if (stuckBottomRef.current && !at && grewAtBottom) {
      markProgrammaticScroll()
      el.scrollTop = el.scrollHeight
      recordScrollSnapshot(el)
      return
    }

    currentAdapter.onReadingStateChange?.(!at)
    setStuckState(at)
    if (at) {
      setUnread(0)
      seenUnreadTotalRef.current = unreadTotalCount
    }

    const turns = currentAdapter.turnItemIndexes
    if (turns.length === 0) {
      updateActiveTurn(-1)
      return
    }
    const navigationTarget = navigationTargetRef.current
    if (navigationTarget !== null && navigationTarget < turns.length && now < navigationLockUntilRef.current) {
      updateActiveTurn(navigationTarget)
      return
    }
    navigationTargetRef.current = null
    navigationLockUntilRef.current = 0

    let current = at ? turns.length - 1 : 0
    let firstVisibleIndex: number | undefined
    if (!at) {
      firstVisibleIndex = currentAdapter.getFirstVisibleIndex(48)
      current = resolveActiveTurnIndex(turns, firstVisibleIndex)
    }
    updateActiveTurn(current)
    capturePosition(firstVisibleIndex)
  }, [capturePosition, recordScrollSnapshot, scrollRef, setStuckState, unreadTotalCount, updateActiveTurn])

  const recomputeRef = useRef(recompute)
  recomputeRef.current = recompute

  const disarmLocksOnUserGesture = useCallback(() => {
    adapterRef.current.releasePrependAnchor?.()
    initialLandingPendingRef.current = false
    navigationTargetRef.current = null
    navigationLockUntilRef.current = 0
    jumpingToBottomUntilRef.current = 0
    viewportIntentVersionRef.current += 1
    lastUserGestureAtRef.current = performance.now()
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const scrollScheduler = createRafScheduler(() => recomputeRef.current())
    const onScrollEnd = () => {
      const now = performance.now()
      if (now < jumpingToBottomUntilRef.current || now < navigationLockUntilRef.current) return
      navigationTargetRef.current = null
      navigationLockUntilRef.current = 0
      jumpingToBottomUntilRef.current = 0
      scrollScheduler.schedule()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target === el && ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
        disarmLocksOnUserGesture()
      }
    }
    el.addEventListener('scroll', scrollScheduler.schedule, { passive: true })
    el.addEventListener('scrollend', onScrollEnd, { passive: true })
    el.addEventListener('wheel', disarmLocksOnUserGesture, { passive: true })
    el.addEventListener('touchstart', disarmLocksOnUserGesture, { passive: true })
    el.addEventListener('pointerdown', disarmLocksOnUserGesture, { passive: true })
    el.addEventListener('keydown', onKeyDown)
    return () => {
      scrollScheduler.cancel()
      el.removeEventListener('scroll', scrollScheduler.schedule)
      el.removeEventListener('scrollend', onScrollEnd)
      el.removeEventListener('wheel', disarmLocksOnUserGesture)
      el.removeEventListener('touchstart', disarmLocksOnUserGesture)
      el.removeEventListener('pointerdown', disarmLocksOnUserGesture)
      el.removeEventListener('keydown', onKeyDown)
    }
  }, [disarmLocksOnUserGesture, scrollRef, sessionId])

  useEffect(() => {
    const el = scrollRef.current
    const utilityRail = utilityRailRef.current
    if (!el || !utilityRail || !hasUtilityRail) return
    const onWheel = (event: WheelEvent) => routeChatWheel(event, el, disarmLocksOnUserGesture)
    utilityRail.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => {
      utilityRail.removeEventListener('wheel', onWheel, { capture: true })
    }
  }, [disarmLocksOnUserGesture, hasUtilityRail, scrollRef, sessionId, utilityRailRef])

  useEffect(() => {
    recomputeRef.current()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapter.itemCount, adapter.turnItemIndexes.length, sessionId, ...recomputeDeps])

  // Follow the tail on ordinary updates after initial landing has settled.
  const lastRevisionRef = useRef(contentRevision)
  const lastUnreadTotalRef = useRef(0)
  useLayoutEffect(() => {
    const el = scrollRef.current
    const changed = contentRevision !== lastRevisionRef.current
    lastRevisionRef.current = contentRevision
    const prevTotal = lastUnreadTotalRef.current
    lastUnreadTotalRef.current = unreadTotalCount
    const grew = unreadTotalCount > prevTotal
    if (!el || !changed) return
    if (suppressTailFollowRef?.current) {
      suppressTailFollowRef.current = false
      seenUnreadTotalRef.current = unreadTotalCount
      return
    }
    if (adapterRef.current.hasPrependAnchor?.()) return
    if (!sessionId || !restoredSessionsRef.current.has(sessionId) || initialLandingPendingRef.current) return
    if (stuckBottom) {
      markProgrammaticScroll()
      el.scrollTop = el.scrollHeight
      recordScrollSnapshot(el)
      seenUnreadTotalRef.current = unreadTotalCount
      setUnread(0)
    } else if (grew) {
      if (unreadMode === 'delta') {
        setUnread(Math.max(0, unreadTotalCount - seenUnreadTotalRef.current))
      } else {
        setUnread((count) => count + 1)
      }
    }
  }, [contentRevision, recordScrollSnapshot, scrollRef, sessionId, stuckBottom, suppressTailFollowRef, unreadMode, unreadTotalCount])

  const aimAtAnchor = useCallback((
    anchorKey: string | null,
    fallbackIndex: number,
    attempt: number,
    session: string,
    version: number,
    onSettled?: () => void,
  ) => {
    const currentAdapter = adapterRef.current
    if (!isCurrentSession(session) || viewportIntentVersionRef.current !== version) return
    if (currentAdapter.itemCount === 0) return
    const resolved = anchorKey !== null
      ? currentAdapter.findIndexByKey(anchorKey)
      : Math.max(0, Math.min(currentAdapter.itemCount - 1, fallbackIndex))
    if (resolved < 0) return
    markProgrammaticScroll()
    currentAdapter.scrollToItem(resolved, { behavior: 'auto', align: 'start' })
    if (attempt >= 12) {
      onSettled?.()
      return
    }
    const verify = () => {
      if (!isCurrentSession(session) || viewportIntentVersionRef.current !== version) return
      const latestAdapter = adapterRef.current
      const first = latestAdapter.getFirstVisibleIndex(48)
      const firstKey = first >= 0 && first < latestAdapter.itemCount ? latestAdapter.getItemKey(first) : ''
      const anchored = anchorKey !== null && firstKey === anchorKey
      const el = scrollRef.current
      const clamped = Boolean(
        el
        && isBottomClamped(el.scrollTop, el.scrollHeight, el.clientHeight)
        && first >= 0
        && first <= resolved,
      )
      const landed = (anchorKey !== null ? anchored : first === resolved) || (attempt >= 1 && clamped)
      if (landed) {
        onSettled?.()
        if (anchorKey !== null && Date.now() < aimDeadlineRef.current && attempt < 12) {
          setTimeout(() => {
            if (!isCurrentSession(session) || viewportIntentVersionRef.current !== version) return
            const checkAdapter = adapterRef.current
            const latestFirst = checkAdapter.getFirstVisibleIndex(48)
            const latestKey = latestFirst >= 0 && latestFirst < checkAdapter.itemCount
              ? checkAdapter.getItemKey(latestFirst)
              : ''
            if (latestKey === anchorKey) return
            aimAtAnchor(anchorKey, fallbackIndex, attempt + 1, session, version, onSettled)
          }, 250)
        }
        return
      }
      aimAtAnchor(anchorKey, fallbackIndex, attempt + 1, session, version, onSettled)
    }
    if (attempt < 3) {
      requestAnimationFrame(() => requestAnimationFrame(verify))
    } else {
      setTimeout(verify, 60)
    }
  }, [isCurrentSession, scrollRef])

  // Initial landing gated by `decideViewportAction`.
  useEffect(() => {
    const currentAdapter = adapterRef.current
    const action = decideViewportAction({
      resumePolicy,
      hydration,
      hasMessages: currentAdapter.itemCount > 0,
    })
    if (action === 'wait' || !sessionId) return
    if (restoredSessionsRef.current.has(sessionId)) return
    restoredSessionsRef.current.add(sessionId)

    const ignoreSaved = ignoreSavedOnFreshLaunch && freshLaunchPendingScopes.has(storageKey)
    const saved = ignoreSaved
      ? null
      : normalizeSavedScrollPosition(scrollPositionsRef.current[sessionId])
    if (ignoreSavedOnFreshLaunch) freshLaunchPendingScopes.delete(storageKey)

    const version = viewportIntentVersionRef.current
    aimDeadlineRef.current = Date.now() + RESTORE_RECHECK_HORIZON_MS
    seenUnreadTotalRef.current = unreadTotalCount

    const landAtBottom = (lastIndex: number) => {
      if (!isCurrentSession(sessionId) || viewportIntentVersionRef.current !== version) return
      initialLandingPendingRef.current = false
      markProgrammaticScroll()
      adapterRef.current.scrollToItem(lastIndex, { behavior: 'auto', align: 'end' })
      const el = scrollRef.current
      if (el) recordScrollSnapshot(el)
      setStuckState(true)
      setUnread(0)
      seenUnreadTotalRef.current = unreadTotalCount
      updateActiveTurn(adapterRef.current.turnItemIndexes.length - 1)
    }

    if (action === 'follow-latest' || (action === 'restore-position' && (!saved || saved.stuck))) {
      const lastIndex = currentAdapter.itemCount - 1
      if (!deferInitialLanding) {
        landAtBottom(lastIndex)
        return
      }
      initialLandingPendingRef.current = true
      requestAnimationFrame(() => requestAnimationFrame(() => landAtBottom(lastIndex)))
      return
    }

    if (action === 'restore-position' && saved && !saved.stuck) {
      if (saved.key) {
        const index = currentAdapter.findIndexByKey(saved.key)
        if (index >= 0) {
          initialLandingPendingRef.current = false
          aimAtAnchor(saved.key, index, 0, sessionId, version)
          currentAdapter.onReadingStateChange?.(true)
          setStuckState(false)
          return
        }
      } else if (typeof saved.scrollTop === 'number') {
        const el = scrollRef.current
        if (el) {
          initialLandingPendingRef.current = false
          markProgrammaticScroll()
          el.scrollTop = saved.scrollTop
          recordScrollSnapshot(el)
          currentAdapter.onReadingStateChange?.(true)
          setStuckState(false)
          recomputeRef.current()
          return
        }
      }
    }

    // `'open-latest'` (or saved anchor missing): land on the latest turn's start
    // when provided, otherwise fall back to the bottom of the transcript.
    const targetIndex = currentAdapter.openLatestItemIndex
    if (targetIndex != null && targetIndex >= 0 && targetIndex < currentAdapter.itemCount) {
      initialLandingPendingRef.current = true
      setStuckState(false)
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!isCurrentSession(sessionId) || viewportIntentVersionRef.current !== version) return
        aimAtAnchor(null, targetIndex, 0, sessionId, version, () => {
          if (!isCurrentSession(sessionId) || viewportIntentVersionRef.current !== version) return
          initialLandingPendingRef.current = false
          const el = scrollRef.current
          if (el) {
            recordScrollSnapshot(el)
            const at = isNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight)
            adapterRef.current.onReadingStateChange?.(!at)
            setStuckState(at)
          }
        })
      }))
      return
    }

    const lastIndex = currentAdapter.itemCount - 1
    if (!deferInitialLanding) {
      landAtBottom(lastIndex)
      return
    }
    initialLandingPendingRef.current = true
    requestAnimationFrame(() => requestAnimationFrame(() => landAtBottom(lastIndex)))
  }, [
    adapter.itemCount,
    aimAtAnchor,
    deferInitialLanding,
    hydration,
    ignoreSavedOnFreshLaunch,
    isCurrentSession,
    recordScrollSnapshot,
    resumePolicy,
    scrollRef,
    sessionId,
    setStuckState,
    storageKey,
    unreadTotalCount,
    updateActiveTurn,
  ])

  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const currentAdapter = adapterRef.current
    followTail()
    const lastTurn = currentAdapter.turnItemIndexes.length - 1
    navigationTargetRef.current = lastTurn >= 0 ? lastTurn : null
    navigationLockUntilRef.current = performance.now() + JUMP_TO_BOTTOM_LOCK_MS
    jumpingToBottomUntilRef.current = performance.now() + JUMP_TO_BOTTOM_LOCK_MS
    if (lastTurn >= 0) updateActiveTurn(lastTurn)
    markProgrammaticScroll()
    if (currentAdapter.itemCount > 0) {
      currentAdapter.scrollToItem(currentAdapter.itemCount - 1, { behavior: 'auto', align: 'end' })
    }
    el.scrollTop = el.scrollHeight
    recordScrollSnapshot(el)
    requestAnimationFrame(() => {
      if (isCurrentSession(sessionId) && jumpingToBottomUntilRef.current > performance.now()) {
        markProgrammaticScroll()
        el.scrollTop = el.scrollHeight
        recordScrollSnapshot(el)
      }
    })
    setUnread(0)
    seenUnreadTotalRef.current = unreadTotalCount
  }, [followTail, isCurrentSession, recordScrollSnapshot, scrollRef, sessionId, unreadTotalCount, updateActiveTurn])

  const collapseToLatest = useCallback(() => {
    const currentAdapter = adapterRef.current
    navigationTargetRef.current = null
    navigationLockUntilRef.current = 0
    jumpingToBottomUntilRef.current = 0
    followTail()
    updateActiveTurn(currentAdapter.turnItemIndexes.length - 1)
    const el = scrollRef.current
    if (!el) return
    markProgrammaticScroll()
    if (currentAdapter.itemCount > 0) {
      currentAdapter.scrollToItem(currentAdapter.itemCount - 1, { behavior: 'instant', align: 'end' })
    }
    el.scrollTop = el.scrollHeight
    recordScrollSnapshot(el)
    requestAnimationFrame(() => {
      if (isCurrentSession(sessionId) && stuckBottomRef.current && scrollRef.current === el) {
        markProgrammaticScroll()
        el.scrollTop = el.scrollHeight
        recordScrollSnapshot(el)
      }
    })
  }, [followTail, isCurrentSession, recordScrollSnapshot, scrollRef, sessionId, updateActiveTurn])

  const jumpToTurnIndex = useCallback((turnIndex: number) => {
    const el = scrollRef.current
    const currentAdapter = adapterRef.current
    const turns = currentAdapter.turnItemIndexes
    if (!el || turns.length === 0) return
    const clamped = Math.max(0, Math.min(turns.length - 1, turnIndex))
    navigationTargetRef.current = clamped
    navigationLockUntilRef.current = performance.now() + TURN_NAV_LOCK_MS
    jumpingToBottomUntilRef.current = 0
    updateActiveTurn(clamped)
    const targetIndex = turns[clamped]
    if (targetIndex == null) return
    commitNavigation(targetIndex, false)
    currentAdapter.scrollToItem(targetIndex, { behavior: 'smooth', align: 'start' })
  }, [commitNavigation, scrollRef, updateActiveTurn])

  const jumpToTurn = useCallback((direction: -1 | 1) => {
    const el = scrollRef.current
    const turnCount = adapterRef.current.turnItemIndexes.length
    if (!el || turnCount === 0) return
    const currentTurn = activeTurnRef.current
    const current = currentTurn < 0 ? (stuckBottomRef.current ? turnCount - 1 : 0) : currentTurn
    const next = Math.max(0, Math.min(turnCount - 1, current + direction))
    if (next === current) return
    jumpToTurnIndex(next)
  }, [jumpToTurnIndex, scrollRef])

  return {
    stuckBottom,
    stuckBottomRef,
    unread,
    activeTurn,
    jumpToBottom,
    collapseToLatest,
    jumpToTurnIndex,
    jumpToTurn,
    followTail,
    pinScrollToBottom,
    invalidateLanding,
  }
}

/** Test-only helper to restore fresh-launch state between isolated test mounts. */
export function resetTranscriptFreshLaunchForTests(storageKey = 'liveChat.scrollPositions'): void {
  freshLaunchPendingScopes.add(storageKey)
}
