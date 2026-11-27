export interface SavedScrollPosition {
  key: string
  stuck: boolean
  /** Legacy pixel fallback read only from pre-key Agy storage entries. */
  scrollTop?: number
}

export interface ScrollSnapshot {
  top: number
  height: number
  clientHeight: number
}

export const BOTTOM_PIN_THRESHOLD_PX = 80
export const BOTTOM_CLAMP_TOLERANCE_PX = 2
export const JUMP_TO_BOTTOM_LOCK_MS = 900
export const TURN_NAV_LOCK_MS = 700
export const RESTORE_RECHECK_HORIZON_MS = 1500
export const MAX_SAVED_SCROLL_POSITIONS = 40

/** True when the viewport is within `threshold` px of the bottom edge. */
export function isNearBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold = BOTTOM_PIN_THRESHOLD_PX,
): boolean {
  return scrollHeight - scrollTop - clientHeight < threshold
}

/** True when scrollTop is clamped against the scroller's bottom limit. */
export function isBottomClamped(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  tolerance = BOTTOM_CLAMP_TOLERANCE_PX,
): boolean {
  if (scrollHeight <= 0 || clientHeight <= 0) return false
  const maxTop = Math.max(0, scrollHeight - clientHeight)
  return maxTop - scrollTop <= tolerance
}

/**
 * True when an already laid-out container that was pinned at the bottom grew
 * taller without the reader scrolling upward. Distinguishes async image/markdown
 * expansion from a real upward scroll gesture.
 */
export function didGrowWhilePinnedAtBottom(
  prev: ScrollSnapshot,
  next: ScrollSnapshot,
  threshold = BOTTOM_PIN_THRESHOLD_PX,
): boolean {
  if (prev.height <= 0 || prev.clientHeight <= 0) return false
  if (!isNearBottom(prev.top, prev.height, prev.clientHeight, threshold)) return false
  return next.height > prev.height + 1 && next.top >= prev.top - 2
}

/** Cap persisted per-session scroll positions to the most recent entries. */
export function trimScrollPositions(
  positions: Record<string, SavedScrollPosition>,
  limit = MAX_SAVED_SCROLL_POSITIONS,
): Record<string, SavedScrollPosition> {
  const entries = Object.entries(positions)
  if (entries.length <= limit) return positions
  return Object.fromEntries(entries.slice(entries.length - limit))
}

/** Normalize persisted session scroll state, tolerating legacy pixel entries. */
export function normalizeSavedScrollPosition(raw: unknown): SavedScrollPosition | null {
  if (!raw || typeof raw !== 'object') return null
  const candidate = raw as { key?: unknown; stuck?: unknown; scrollTop?: unknown }
  const stuck = Boolean(candidate.stuck)
  if (typeof candidate.key === 'string') {
    return { key: candidate.key, stuck }
  }
  if (typeof candidate.scrollTop === 'number' && Number.isFinite(candidate.scrollTop)) {
    return { key: '', stuck, scrollTop: candidate.scrollTop }
  }
  return null
}

/** Map the first visible item index to the active turn index. */
export function resolveActiveTurnIndex(
  turnItemIndexes: ReadonlyArray<number>,
  firstVisibleItemIndex: number,
): number {
  if (turnItemIndexes.length === 0) return -1
  let current = 0
  for (let index = 0; index < turnItemIndexes.length; index += 1) {
    if (turnItemIndexes[index] <= firstVisibleItemIndex) current = index
    else break
  }
  return current
}

/** Return the first matching turn element index at or above `offsetPx` from scroller top. */
export function getFirstVisibleDomItemIndex(
  scroller: HTMLElement,
  selector: string,
  offsetPx = 48,
): number {
  const nodes = scroller.querySelectorAll<HTMLElement>(selector)
  if (nodes.length === 0) return 0
  const scrollerRect = scroller.getBoundingClientRect?.()
  const hasLiveRects = Boolean(scrollerRect && scrollerRect.height > 0)
  const threshold = hasLiveRects
    ? scrollerRect.top + scroller.clientTop + offsetPx
    : scroller.scrollTop + offsetPx
  let current = 0
  nodes.forEach((node, idx) => {
    const rect = node.getBoundingClientRect?.()
    const top = hasLiveRects && rect && rect.height > 0 ? rect.top : node.offsetTop
    if (top <= threshold) current = idx
  })
  return current
}

/** Scroll a native DOM scroller so `target` aligns cleanly near the top. */
export function scrollDomItemIntoView(
  scroller: HTMLElement,
  target: HTMLElement,
  behavior: ScrollBehavior,
): void {
  const scrollerRect = scroller.getBoundingClientRect?.()
  const targetRect = target.getBoundingClientRect?.()
  const top = scrollerRect && targetRect && scrollerRect.height > 0 && targetRect.height > 0
    ? Math.max(0, scroller.scrollTop + (targetRect.top - scrollerRect.top - scroller.clientTop) - 16)
    : Math.max(0, target.offsetTop - 16)
  const farJump = Math.abs(top - scroller.scrollTop) > Math.max(scroller.clientHeight * 2.5, 1600)
  const effectiveBehavior: ScrollBehavior = behavior === 'smooth' && farJump ? 'auto' : behavior
  if (typeof scroller.scrollTo === 'function') {
    scroller.scrollTo({ top, behavior: effectiveBehavior })
  } else {
    scroller.scrollTop = top
  }
}
