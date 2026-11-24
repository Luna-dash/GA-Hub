import {
  forwardRef,
  memo,
  type ForwardedRef,
  type ReactElement,
  type Ref,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { markProgrammaticScroll } from '@/utils/programmaticScroll'
import { buildVirtualOffsets, computeVirtualRange, virtualIndexAtOffset } from '@/utils/virtualList'

export interface VirtualMessageListHandle {
  prepareForPrepend: () => boolean
  releasePrependAnchor: () => void
  hasPrependAnchor: () => boolean
  getFirstVisibleIndex: (offset?: number) => number
  scrollToIndex: (index: number, options?: { behavior?: ScrollBehavior; align?: 'start' | 'center' | 'end' }) => void
  getTotalSize: () => number
}

interface Props<T> {
  items: readonly T[]
  itemKey: (item: T, index: number) => string
  estimateSize: (item: T, index: number) => number
  renderItem: (item: T, index: number) => ReactNode
  scrollRef: RefObject<HTMLDivElement>
  pinnedToBottom?: boolean
  overscanPx?: number
  virtualizationThreshold?: number
}

const DEFAULT_OVERSCAN_PX = 900
const DEFAULT_THRESHOLD = 80
const TALL_LIST_PX = 4800

/**
 * A dependency-free variable-height window for the chat transcript.
 *
 * The outer scroll container remains owned by LiveChat so existing sticky
 * notices, utility controls and scroll anchoring keep their semantics. Rows
 * are measured when mounted; unseen rows use a conservative text-based
 * estimate until they enter the overscan window.
 */
export const VirtualMessageList = forwardRef(function VirtualMessageList<T>(
  {
    items,
    itemKey,
    estimateSize,
    renderItem,
    scrollRef,
    pinnedToBottom = false,
    overscanPx = DEFAULT_OVERSCAN_PX,
    virtualizationThreshold = DEFAULT_THRESHOLD,
  }: Props<T>,
  forwardedRef: ForwardedRef<VirtualMessageListHandle>,
) {
  const listRef = useRef<HTMLDivElement>(null)
  const anchorSpaceRef = useRef<HTMLDivElement>(null)
  const measuredSizesRef = useRef(new Map<string, number>())
  const offsetsRef = useRef<number[]>([0])
  const prependAnchorRef = useRef<{ key: string; y: number } | null>(null)
  const hasVirtualizedRef = useRef(false)
  const navTargetRef = useRef<{
    index: number
    align: 'start' | 'center' | 'end'
    toBottom: boolean
    smooth: boolean
    needsRealign: boolean
    until: number
  } | null>(null)
  const pendingScrollDeltaRef = useRef(0)
  const latestMeasureSeqRef = useRef(0)
  const viewportRef = useRef({ scrollTop: 0, height: 0, listTop: 0 })
  const renderedRangeRef = useRef({ start: 0, end: 0 })
  const [, setWindowRange] = useState({ start: 0, end: 0 })
  const [layoutRevision, setLayoutRevision] = useState(0)

  const keys = useMemo(() => {
    const seen = new Map<string, number>()
    return items.map((item, index) => {
      const base = itemKey(item, index)
      const occurrence = seen.get(base) ?? 0
      seen.set(base, occurrence + 1)
      return occurrence === 0 ? base : `${base}#${occurrence}`
    })
  }, [items, itemKey])

  useEffect(() => {
    const active = new Set(keys)
    for (const key of measuredSizesRef.current.keys()) {
      if (!active.has(key)) measuredSizesRef.current.delete(key)
    }
  }, [keys])

  const offsets = useMemo(() => {
    const next = buildVirtualOffsets(items.length, (index) => {
      const key = keys[index]
      return measuredSizesRef.current.get(key) ?? estimateSize(items[index], index)
    })
    offsetsRef.current = next
    // Keep this dependency explicit: ResizeObserver bumps the revision after a
    // row's real height replaces its estimate.
    void layoutRevision
    return next
  }, [estimateSize, items, keys, layoutRevision])

  // A short page can still contain many screens of Markdown. Window it
  // before mounting all of those bubbles, and don't switch back as they measure.
  const virtualized = items.length > virtualizationThreshold
    || (items.length >= 12 && (hasVirtualizedRef.current || offsets[items.length] > TALL_LIST_PX))
  const listTop = listRef.current?.offsetTop ?? viewportRef.current.listTop
  const anchor = prependAnchorRef.current
  const anchorIndex = anchor ? keys.indexOf(anchor.key) : -1
  const pendingDelta = !navTargetRef.current ? pendingScrollDeltaRef.current : 0
  const relativeScrollTop = anchor && anchorIndex >= 0
    ? Math.max(0, offsets[anchorIndex] - anchor.y)
    : Math.max(0, viewportRef.current.scrollTop + pendingDelta - listTop)
  const range = virtualized
    ? computeVirtualRange(offsets, relativeScrollTop, viewportRef.current.height || 640, overscanPx)
    : { start: 0, end: items.length, top: 0, bottom: 0 }
  renderedRangeRef.current = { start: range.start, end: range.end }

  // The wrapper can be shorter than the viewport. Preserve just enough space
  // to hold the anchor at its old y, even when the browser clamps scrollTop.
  const setAnchorSpace = useCallback((top: number) => {
    const scroller = scrollRef.current
    const spacer = anchorSpaceRef.current
    if (!scroller || !spacer) return
    const naturalEnd = spacer.getBoundingClientRect().top - scroller.getBoundingClientRect().top
      - scroller.clientTop + scroller.scrollTop
    const height = Math.max(0, Math.ceil(top + scroller.clientHeight - naturalEnd))
    const next = height ? `${height}px` : ''
    if (spacer.style.height !== next) spacer.style.height = next
  }, [scrollRef])

  const syncViewport = useCallback(() => {
    const scroller = scrollRef.current
    const list = listRef.current
    if (!scroller || !list) return
    const next = {
      scrollTop: scroller.scrollTop,
      height: scroller.clientHeight,
      listTop: list.offsetTop,
    }
    viewportRef.current = next
    if (!virtualized) return
    const nextRange = computeVirtualRange(
      offsetsRef.current,
      Math.max(0, next.scrollTop - next.listTop),
      next.height || 640,
      overscanPx,
    )
    if (nextRange.start !== renderedRangeRef.current.start || nextRange.end !== renderedRangeRef.current.end) {
      setWindowRange({ start: nextRange.start, end: nextRange.end })
    }
  }, [overscanPx, scrollRef, virtualized])

  const restorePrependAnchor = useCallback(() => {
    const scroller = scrollRef.current
    const list = listRef.current
    const pending = prependAnchorRef.current
    if (pending && scroller && list) {
      const row = Array.from(list.children).find((node) => (node as HTMLElement).dataset.chatKey === pending.key)
      if (row) {
        const y = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - scroller.clientTop
        const delta = y - pending.y
        if (Math.abs(delta) >= 0.5) {
          markProgrammaticScroll()
          const target = Math.max(0, scroller.scrollTop + delta)
          scroller.scrollTop = target
          if (scroller.scrollTop < target - 0.5) {
            setAnchorSpace(target)
            scroller.scrollTop = target
          }
        }
      }
    }
  }, [scrollRef, setAnchorSpace])

  const computeTargetTop = useCallback((
    itemTop: number,
    itemBottom: number,
    viewportHeight: number,
    align: 'start' | 'center' | 'end',
  ) => (
    align === 'center'
      ? Math.max(0, itemTop - Math.max(0, (viewportHeight - (itemBottom - itemTop)) / 2))
      : align === 'end'
        ? Math.max(0, itemBottom - viewportHeight)
        : Math.max(0, itemTop - 16)
  ), [])

  const getRowMetrics = useCallback((targetIndex: number) => {
    const scroller = scrollRef.current
    const list = listRef.current
    const fallbackTop = (list?.offsetTop ?? 0) + (offsetsRef.current[targetIndex] ?? 0)
    const fallbackBottom = (list?.offsetTop ?? 0)
      + (offsetsRef.current[targetIndex + 1] ?? offsetsRef.current[targetIndex] ?? 0)
    if (!scroller || !list) {
      return { itemTop: fallbackTop, itemBottom: fallbackBottom, mounted: false }
    }
    const row = list.querySelector<HTMLElement>(`[data-virtual-index="${targetIndex}"]`)
    if (row) {
      const scrollerRect = scroller.getBoundingClientRect?.()
      const rowRect = row.getBoundingClientRect?.()
      if (scrollerRect && rowRect && scrollerRect.height > 0 && rowRect.height > 0) {
        const itemTop = rowRect.top - scrollerRect.top - scroller.clientTop + scroller.scrollTop
        return { itemTop, itemBottom: itemTop + rowRect.height, mounted: true }
      }
      return { itemTop: fallbackTop, itemBottom: fallbackBottom, mounted: true }
    }
    return { itemTop: fallbackTop, itemBottom: fallbackBottom, mounted: false }
  }, [scrollRef])

  useLayoutEffect(() => {
    hasVirtualizedRef.current = virtualized
    if (prependAnchorRef.current && anchorIndex < 0) prependAnchorRef.current = null
    restorePrependAnchor()
    if (layoutRevision < latestMeasureSeqRef.current) return
    const scroller = scrollRef.current
    const pendingDelta = pendingScrollDeltaRef.current
    pendingScrollDeltaRef.current = 0
    const nav = navTargetRef.current
    if (nav && scroller) {
      if (performance.now() >= nav.until) {
        navTargetRef.current = null
      } else if (nav.needsRealign) {
        nav.needsRealign = false
        if (nav.toBottom) {
          const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
          if (Math.abs(scroller.scrollTop - maxTop) >= 1) {
            markProgrammaticScroll()
            scroller.scrollTop = scroller.scrollHeight
          }
        } else {
          const metrics = getRowMetrics(nav.index)
          const top = computeTargetTop(metrics.itemTop, metrics.itemBottom, scroller.clientHeight, nav.align)
          if (Math.abs(scroller.scrollTop - top) >= 2) {
            markProgrammaticScroll()
            scroller.scrollTop = top
          }
        }
      }
    } else if (pendingDelta !== 0 && scroller && !prependAnchorRef.current) {
      markProgrammaticScroll()
      scroller.scrollTop += pendingDelta
    }
    syncViewport()
  }, [anchorIndex, computeTargetTop, getRowMetrics, items, layoutRevision, offsets, restorePrependAnchor, scrollRef, syncViewport, virtualized])

  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    let frame: number | null = null
    const cancelNav = () => {
      navTargetRef.current = null
    }
    const onScroll = () => {
      if (frame !== null) return
      frame = window.requestAnimationFrame(() => {
        frame = null
        // Reclaim any reserve as the reader moves back into the real content,
        // without clamping their current position on the first gesture.
        if (!prependAnchorRef.current && anchorSpaceRef.current?.style.height) {
          setAnchorSpace(scroller.scrollTop)
        }
        syncViewport()
      })
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target === scroller && ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
        cancelNav()
      }
    }
    const onScrollEnd = () => {
      const nav = navTargetRef.current
      if (nav && nav.smooth && !nav.toBottom && !nav.needsRealign) {
        navTargetRef.current = null
      }
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    scroller.addEventListener('wheel', cancelNav, { passive: true })
    scroller.addEventListener('touchstart', cancelNav, { passive: true })
    scroller.addEventListener('pointerdown', cancelNav, { passive: true })
    scroller.addEventListener('keydown', onKeyDown)
    scroller.addEventListener('scrollend', onScrollEnd, { passive: true })
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
        restorePrependAnchor()
        syncViewport()
      })
    resizeObserver?.observe(scroller)
    if (listRef.current) resizeObserver?.observe(listRef.current)
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      scroller.removeEventListener('wheel', cancelNav)
      scroller.removeEventListener('touchstart', cancelNav)
      scroller.removeEventListener('pointerdown', cancelNav)
      scroller.removeEventListener('keydown', onKeyDown)
      scroller.removeEventListener('scrollend', onScrollEnd)
      if (frame !== null) window.cancelAnimationFrame(frame)
      resizeObserver?.disconnect()
    }
  }, [restorePrependAnchor, scrollRef, setAnchorSpace, syncViewport])

  const measureRow = useCallback((key: string, index: number, measured: number) => {
    if (!Number.isFinite(measured) || measured <= 0) return
    const previous = measuredSizesRef.current.get(key)
    if (previous != null && Math.abs(previous - measured) < 0.5) return

    const oldOffsets = offsetsRef.current
    const delta = measured - (previous ?? oldOffsets[index + 1] - oldOffsets[index])
    measuredSizesRef.current.set(key, measured)
    const nextSeq = latestMeasureSeqRef.current + 1
    latestMeasureSeqRef.current = nextSeq

    const scroller = scrollRef.current
    const nav = navTargetRef.current
    const navigating = nav !== null && performance.now() < nav.until
    if (navigating) {
      if (nav.toBottom || (index <= nav.index && Math.abs(delta) >= 1)) {
        nav.needsRealign = true
        nav.smooth = false
      }
      setLayoutRevision(nextSeq)
      return
    }

    const currentListTop = listRef.current?.offsetTop ?? 0
    const currentRelativeTop = Math.max(0, (scroller?.scrollTop ?? 0) - currentListTop)
    const wasAboveViewport = oldOffsets[index] < currentRelativeTop - 1
    const currentlyPinned = scroller
      ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80
      : pinnedToBottom
    if (virtualized && !prependAnchorRef.current && scroller && Math.abs(delta) >= 0.5 && wasAboveViewport && !currentlyPinned) {
      pendingScrollDeltaRef.current += delta
    } else if (virtualized && !prependAnchorRef.current && scroller && Math.abs(delta) >= 0.5 && currentlyPinned && pinnedToBottom) {
      window.requestAnimationFrame(() => {
        if (scrollRef.current === scroller && !prependAnchorRef.current
          && !navTargetRef.current
          && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80 + Math.max(0, delta)) {
          markProgrammaticScroll()
          scroller.scrollTop = scroller.scrollHeight
        }
      })
    }
    setLayoutRevision(nextSeq)
  }, [pinnedToBottom, scrollRef, virtualized])

  useImperativeHandle(forwardedRef, () => ({
    prepareForPrepend: () => {
      pendingScrollDeltaRef.current = 0
      navTargetRef.current = null
      const list = listRef.current
      const scroller = scrollRef.current
      if (!list || !scroller) return false
      const top = scroller.getBoundingClientRect().top + scroller.clientTop
      for (const node of list.children) {
        const rect = node.getBoundingClientRect()
        const key = (node as HTMLElement).dataset.chatKey
        if (rect.top >= top + scroller.clientHeight) break
        if (key && rect.bottom > top) {
          prependAnchorRef.current = { key, y: rect.top - top }
          return true
        }
      }
      return false
    },
    releasePrependAnchor: () => { prependAnchorRef.current = null },
    hasPrependAnchor: () => prependAnchorRef.current !== null,
    getFirstVisibleIndex: (extraOffset = 0) => {
      const scroller = scrollRef.current
      const list = listRef.current
      if (!scroller || !list || items.length === 0) return 0
      const top = Math.max(0, scroller.scrollTop - list.offsetTop + extraOffset)
      return virtualIndexAtOffset(offsetsRef.current, top)
    },
    scrollToIndex: (index, options = {}) => {
      const scroller = scrollRef.current
      const list = listRef.current
      if (!scroller || !list || items.length === 0) return
      prependAnchorRef.current = null
      pendingScrollDeltaRef.current = 0
      if (anchorSpaceRef.current) anchorSpaceRef.current.style.height = ''
      const targetIndex = Math.max(0, Math.min(items.length - 1, index))
      const align = options.align ?? 'start'
      const toBottom = align === 'end' && targetIndex === items.length - 1
      const metrics = getRowMetrics(targetIndex)
      const viewportHeight = scroller.clientHeight
      const computedTop = computeTargetTop(metrics.itemTop, metrics.itemBottom, viewportHeight, align)
      const top = toBottom
        ? Math.max(computedTop, scroller.scrollHeight - viewportHeight, 0)
        : computedTop
      const requestedBehavior = options.behavior ?? 'smooth'
      const farOrUnmeasured = virtualized
        || Math.abs(top - scroller.scrollTop) > Math.max(viewportHeight * 2.5, 1600)
      const effectiveBehavior: ScrollBehavior = requestedBehavior === 'smooth' && farOrUnmeasured
        ? 'auto'
        : requestedBehavior
      navTargetRef.current = {
        index: targetIndex,
        align,
        toBottom,
        smooth: effectiveBehavior === 'smooth',
        needsRealign: virtualized || toBottom,
        until: performance.now() + 900,
      }
      if (virtualized) {
        const nextViewport = {
          scrollTop: top,
          height: viewportHeight,
          listTop: list.offsetTop,
        }
        viewportRef.current = nextViewport
        const nextRange = computeVirtualRange(
          offsetsRef.current,
          Math.max(0, nextViewport.scrollTop - nextViewport.listTop),
          nextViewport.height || 640,
          overscanPx,
        )
        if (nextRange.start !== renderedRangeRef.current.start || nextRange.end !== renderedRangeRef.current.end) {
          setWindowRange({ start: nextRange.start, end: nextRange.end })
        }
      }
      markProgrammaticScroll()
      if (typeof scroller.scrollTo === 'function') {
        scroller.scrollTo({ top, behavior: effectiveBehavior })
      } else {
        scroller.scrollTop = toBottom ? Math.max(top, scroller.scrollHeight) : top
      }
    },
    getTotalSize: () => offsetsRef.current[offsetsRef.current.length - 1] ?? 0,
  }), [computeTargetTop, forwardedRef, getRowMetrics, items.length, overscanPx, scrollRef, virtualized])

  return (
    <>
      <div
        ref={listRef}
        data-chat-virtual-list
        data-virtualized={virtualized ? 'true' : 'false'}
        data-total-count={items.length}
        data-rendered-count={range.end - range.start}
        data-virtual-top={range.top}
        data-virtual-bottom={range.bottom}
        style={virtualized ? { position: 'relative', height: offsets[offsets.length - 1] ?? 0 } : undefined}
      >
        {items.slice(range.start, range.end).map((item, visibleIndex) => {
          const index = range.start + visibleIndex
          const key = keys[index]
          return (
            <MeasuredRow
              key={key}
              rowKey={key}
              item={item}
              index={index}
              isLast={index === items.length - 1}
              top={virtualized ? offsets[index] : undefined}
              virtualized={virtualized}
              renderItem={renderItem}
              onMeasure={measureRow}
            />
          )
        })}
      </div>
      <div ref={anchorSpaceRef} aria-hidden="true" />
    </>
  )
}) as <T>(props: Props<T> & { ref?: Ref<VirtualMessageListHandle> }) => ReactElement

interface RowProps<T> {
  rowKey: string
  item: T
  index: number
  isLast: boolean
  top?: number
  virtualized: boolean
  renderItem: (item: T, index: number) => ReactNode
  onMeasure: (key: string, index: number, measured: number) => void
}

function MeasuredRowInner<T>({ rowKey, item, index, isLast, top, virtualized, renderItem, onMeasure }: RowProps<T>) {
  const nodeRef = useRef<HTMLDivElement>(null)
  const measure = useCallback(() => {
    const node = nodeRef.current
    if (!node) return
    const measured = node.getBoundingClientRect?.().height || node.offsetHeight
    onMeasure(rowKey, index, measured)
  }, [index, onMeasure, rowKey])

  useLayoutEffect(() => {
    measure()
  }, [measure, item])

  useEffect(() => {
    const node = nodeRef.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [measure])

  return (
    <div
      ref={nodeRef}
      data-chat-message
      data-chat-key={rowKey}
      data-virtual-index={index}
      style={virtualized
        ? { position: 'absolute', top, left: 0, right: 0, paddingBottom: isLast ? 0 : '0.5rem' }
        : { paddingBottom: isLast ? 0 : '0.5rem' }}
    >
      {renderItem(item, index)}
    </div>
  )
}

const MeasuredRow = memo(MeasuredRowInner as (props: RowProps<unknown>) => ReactElement) as unknown as <T>(
  props: RowProps<T>,
) => ReactElement
